/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
import type { LfgStore } from "../src/runtime/contracts";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import {
  applyLfgCounterTemplate,
  LfgConfigError,
  LfgService,
  resetLfgCounterRenameStateForTests,
} from "../src/services/lfg-service";
import type { LfgApplication, LfgConfig, LfgPost, LfgVoiceChannel } from "../src/types";
import { GuildResourceValidationError } from "../src/discord/guild-resource-validator";
import {
  createStaticGuildResourceValidator,
  testChannel,
} from "./helpers/guild-resource-validator";
import { createServiceFactory } from "../src/runtime/service-factory";
import { createComponentIdSigner } from "../src/security/component-id-signer";
import { verifySensitiveComponentId } from "../src/security/sensitive-component-ids";
import type { RuntimeStores } from "../src/runtime/app-types";
import type { ProductAnalyticsEvent } from "../src/product-analytics";

test("LFG disable blocks new posts, preserves existing posts and settings, and can be reversed", async () => {
  const store = createStore();
  const previous = structuredClone(store.config);
  const posts = structuredClone(store.posts);
  const deleted: string[] = [];
  const service = new LfgService(store, {
    ...createDiscordStub(),
    async deleteChannelMessage(channelId, messageId) {
      deleted.push(`${channelId}/${messageId}`);
    },
  });
  const result = await service.disable("guild-1");
  assert.equal(result.noticeRemoved, true);
  assert.deepEqual(deleted, ["lfg-channel-1/notice-1"]);
  assert.deepEqual(store.config, {
    ...previous,
    enabled: false,
    noticeMessageId: null,
    updatedAtMs: result.config.updatedAtMs,
  });
  assert.deepEqual(store.posts, posts);
  const input = {
    guildId: "guild-1",
    channelId: "lfg-channel-1",
    ownerId: "new-owner",
    ownerDisplayName: "New owner",
    serverId: "namalsk",
    whenPlay: "Tonight",
    lookingFor: "Squad",
    extraInfo: "",
  };
  await assert.rejects(service.createPost(input), /LFG is disabled/);
  await assert.rejects(service.createPost({ ...input, scope: "clan" }), /LFG is disabled/);
  await service.disable("guild-1");
  assert.equal(deleted.length, 1);
  await service.updateConfig(result.config);
  await assert.rejects(service.createPost(input), /LFG is disabled/);
  await service.setupNotice("guild-1", "lfg-channel-1");
  const created = await service.createPost(input);
  assert.equal(created.active, true);
  await service.closePost({ guildId: "guild-1", postId: "post-1", closedByUserId: "admin" });
  assert.equal(store.posts[0]?.active, false);
});

test("LFG stays disabled when noticeboard cleanup fails", async () => {
  const store = createStore();
  const service = new LfgService(store, {
    ...createDiscordStub(),
    async deleteChannelMessage() {
      throw new Error("Missing permissions");
    },
  });
  assert.equal((await service.disable("guild-1")).noticeRemoved, false);
  assert.equal(store.config.noticeChannelId, "lfg-channel-1");
  assert.equal(store.config.enabled, false);
});

test("an LFG post already publishing when disabled does not recreate the noticeboard", async () => {
  const store = createStore({ posts: [] });
  let createdMessages = 0;
  const service = new LfgService(store, {
    ...createDiscordStub(),
    async createChannelMessage(channelId) {
      createdMessages += 1;
      await service.disable("guild-1");
      return { id: "post-message", channel_id: channelId, content: "" };
    },
  });
  await service.createPost({
    guildId: "guild-1",
    channelId: "lfg-channel-1",
    ownerId: "owner-1",
    ownerDisplayName: "Owner",
    serverId: "namalsk",
    whenPlay: "Tonight",
    lookingFor: "Squad",
    extraInfo: "",
  });
  assert.equal(createdMessages, 1);
  assert.equal(store.config.noticeChannelId, "lfg-channel-1");
  assert.equal(store.config.enabled, false);
});

test("LfgService.processDueExpiries closes expired posts in place by default", async () => {
  const store = createStore();
  const editedMessages: Array<{ channelId: string; messageId: string; body: unknown }> = [];
  const service = new LfgService(store, {
    async createChannelMessage() {
      throw new Error("unexpected create message");
    },
    async editChannelMessage(channelId, messageId, body) {
      editedMessages.push({ channelId, messageId, body });
      return { id: messageId, channel_id: channelId, content: "" };
    },
    async deleteChannelMessage() {
      throw new Error("unexpected delete message");
    },
    async createUserDmMessage() {
      throw new Error("unexpected dm");
    },
    async addGuildMemberRole() {
      throw new Error("unexpected add role");
    },
    async removeGuildMemberRole() {
      throw new Error("unexpected remove role");
    },
    async modifyChannel() {},
  });

  await service.processDueExpiries(1_000);

  assert.equal(store.posts[0]?.active, false);
  assert.equal(store.posts[0]?.closedByUserId, "lfg-expiry");
  assert.equal(editedMessages.length, 1);
  const message = editedMessages[0]?.body as {
    components: Array<{ components: Array<{ disabled: boolean }> }>;
  };
  assert.equal(
    message.components[0]?.components.every((component) => component.disabled),
    true,
  );
});

test("LfgService.renewPost extends from the current expiry time", async () => {
  const baseNow = Date.UTC(2026, 0, 1, 12, 0, 0);
  const originalDateNow = Date.now;
  Date.now = () => baseNow;

  try {
    const store = createStore({
      post: createPost({
        expiresAtMs: baseNow + 60 * 60 * 1000,
        renewalsCount: 1,
      }),
    });
    const service = new LfgService(store, createDiscordStub());

    const renewed = await service.renewPost({
      guildId: "guild-1",
      postId: "post-1",
      userId: "owner-1",
    });

    assert.equal(renewed.expiresAtMs, baseNow + 25 * 60 * 60 * 1000);
    assert.equal(renewed.renewalsCount, 2);
    assert.equal(renewed.reminderSentAtMs, null);
  } finally {
    Date.now = originalDateNow;
  }
});

test("LfgService.sendDueRenewalReminders DMs posts expiring within one hour and marks them reminded", async () => {
  const dms: Array<{ userId: string; body: unknown }> = [];
  const store = createStore({
    post: createPost({ expiresAtMs: 59 * 60 * 1000, reminderSentAtMs: null }),
  });
  const service = new LfgService(store, {
    ...createDiscordStub(),
    async createUserDmMessage(userId, body) {
      dms.push({ userId, body });
      return { id: "dm-1", channel_id: "dm-channel", content: "" };
    },
  });

  await service.sendDueRenewalReminders(0);

  assert.equal(dms.length, 1);
  assert.equal(dms[0]?.userId, "owner-1");
  const body = dms[0]?.body as { allowed_mentions?: unknown } | undefined;
  assert.deepEqual(body?.allowed_mentions, {
    parse: [],
  });
  assert.equal(store.posts[0]?.reminderSentAtMs, 0);
});

test("LfgService.editPost updates the existing active post in place", async () => {
  const editedMessages: Array<{ channelId: string; messageId: string; body: unknown }> = [];
  const store = createStore();
  const service = new LfgService(store, {
    ...createDiscordStub(),
    async editChannelMessage(channelId, messageId, body) {
      editedMessages.push({ channelId, messageId, body });
      return { id: messageId, channel_id: channelId, content: "" };
    },
  });

  const updated = await service.editPost({
    guildId: "guild-1",
    postId: "post-1",
    ownerId: "owner-1",
    serverId: "chernarus",
    whenPlay: "Tomorrow",
    lookingFor: "Squad",
    extraInfo: "Bring ammo",
  });

  assert.equal(updated.id, "post-1");
  assert.equal(updated.serverId, "chernarus");
  assert.equal(updated.whenPlay, "Tomorrow");
  assert.equal(store.posts.length, 1);
  assert.equal(editedMessages.length, 1);
});

test("LfgService.editPost accepts a server id that is no longer in config", async () => {
  const store = createStore({
    config: createConfig({ serverOptions: [{ id: "namalsk", label: "Namalsk", emoji: "🧊" }] }),
  });
  const service = new LfgService(store, createDiscordStub());

  const updated = await service.editPost({
    guildId: "guild-1",
    postId: "post-1",
    ownerId: "owner-1",
    serverId: "chernarus",
    whenPlay: "Tomorrow",
    lookingFor: "Squad",
    extraInfo: "Bring ammo",
  });

  assert.equal(updated.serverId, "chernarus");
  assert.equal(updated.serverLabel, "chernarus");
});

test("LfgService.editPost does not re-ping the notification role", async () => {
  const editedMessages: Array<{ body: unknown }> = [];
  const store = createStore({ config: createConfig({ notificationRoleId: "role-1" }) });
  const service = new LfgService(store, {
    ...createDiscordStub(),
    async editChannelMessage(_channelId, messageId, body) {
      editedMessages.push({ body });
      return { id: messageId, channel_id: "lfg-channel-1", content: "" };
    },
  });

  await service.editPost({
    guildId: "guild-1",
    postId: "post-1",
    ownerId: "owner-1",
    serverId: "namalsk",
    whenPlay: "Tomorrow",
    lookingFor: "Squad",
    extraInfo: "Bring ammo",
  });

  const editedBody = editedMessages[0]?.body as { allowed_mentions?: unknown } | undefined;
  assert.deepEqual(editedBody?.allowed_mentions, {
    parse: [],
  });
});

test("LfgService.notifyOwner DMs the owner with controlled mention access for the interested user", async () => {
  const dms: Array<{ userId: string; body: unknown }> = [];
  const events: ProductAnalyticsEvent[] = [];
  const store = createStore();
  const service = new LfgService(
    store,
    {
      ...createDiscordStub(),
      async createUserDmMessage(userId, body) {
        dms.push({ userId, body });
        return { id: "dm-1", channel_id: "dm-channel", content: body.content ?? "" };
      },
    },
    undefined,
    undefined,
    undefined,
    { report: async (event) => void events.push(event) },
  );

  await service.notifyOwner({
    guildId: "guild-1",
    postId: "post-1",
    interestedUserId: "interested-1",
    interestedUserDisplayName: "Interested",
  });

  assert.equal(dms[0]?.userId, "owner-1");
  const body = dms[0]?.body as { content?: string; allowed_mentions?: unknown };
  assert.match(body.content ?? "", /User: <@interested-1> \(Interested\)/);
  assert.doesNotMatch(body.content ?? "", /\nID:/);
  assert.deepEqual(body.allowed_mentions, { parse: [], users: ["interested-1"] });
  assert.deepEqual(events, [
    {
      name: "feature_outcome",
      insertionId: events[0]!.insertionId,
      guildId: "guild-1",
      feature: "lfg",
      action: "lfg_participation_changed",
      status: "success",
      reasonCode: undefined,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /owner-1|interested-1|post-1/);
});

test("LfgService.notifyOwner reports a coded failure after both DM attempts fail", async () => {
  const events: ProductAnalyticsEvent[] = [];
  const service = new LfgService(
    createStore(),
    {
      ...createDiscordStub(),
      async createUserDmMessage() {
        throw new Error("DM rejected");
      },
    },
    undefined,
    undefined,
    undefined,
    { report: async (event) => void events.push(event) },
  );

  const result = await service.notifyOwner({
    guildId: "guild-1",
    postId: "post-1",
    interestedUserId: "interested-1",
    interestedUserDisplayName: "Interested",
  });

  assert.deepEqual(result, { dmSent: false });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    name: "feature_outcome",
    insertionId: events[0]!.insertionId,
    guildId: "guild-1",
    feature: "lfg",
    action: "lfg_participation_changed",
    status: "failure",
    reasonCode: "discord_rejected",
  });
});

test("LfgService.notifyOwner retries without mentions when the first DM payload is rejected", async () => {
  const dms: Array<{ userId: string; body: unknown }> = [];
  const store = createStore();
  const service = new LfgService(store, {
    ...createDiscordStub(),
    async createUserDmMessage(userId, body) {
      dms.push({ userId, body });
      const payload = body as { allowed_mentions?: { users?: string[] } } | undefined;
      if (Array.isArray(payload?.allowed_mentions?.users)) {
        throw new Error("Cannot mention this user in DM payload");
      }
      return { id: "dm-1", channel_id: "dm-channel", content: body.content ?? "" };
    },
  });

  const result = await service.notifyOwner({
    guildId: "guild-1",
    postId: "post-1",
    interestedUserId: "interested-1",
    interestedUserDisplayName: "Interested",
  });

  assert.equal(result.dmSent, true);
  assert.equal(dms.length, 2);

  const fallbackBody = dms[1]?.body as { content?: string; allowed_mentions?: unknown };
  assert.match(fallbackBody.content ?? "", /User: Interested\nID: interested-1/);
  assert.doesNotMatch(fallbackBody.content ?? "", /<@interested-1>/);
  assert.deepEqual(fallbackBody.allowed_mentions, { parse: [] });
});

test("LfgService does not post Guild Audit Log fallback when the event is disabled", async () => {
  const channelMessages: Array<{ channelId: string; body: unknown }> = [];
  const store = createStore({ config: createConfig({ approvalAuditChannelId: null }) });
  const service = new LfgService(
    store,
    {
      ...createDiscordStub(),
      async createChannelMessage(channelId, body) {
        channelMessages.push({ channelId, body });
        return { id: `message-${channelMessages.length}`, channel_id: channelId, content: "" };
      },
    },
    {
      async readConfig() {
        return {
          guildId: "guild-1",
          auditChannelId: "audit-channel-1",
          groupChannelIds: {},
          eventStates: { groups: { lfg: false }, overrides: {} },
          updatedAtMs: 0,
        };
      },
      async upsertConfig() {},
    },
  );

  await service.createPost({
    guildId: "guild-1",
    channelId: "lfg-channel-1",
    ownerId: "owner-new",
    ownerDisplayName: "Owner",
    serverId: "namalsk",
    whenPlay: "Tonight",
    lookingFor: "Two players",
    extraInfo: "Bring food",
  });

  assert.deepEqual(
    channelMessages.map((call) => call.channelId),
    ["lfg-channel-1", "lfg-channel-1"],
  );
});

test("LfgService.updateCounterChannel counts every active post", async () => {
  resetLfgCounterRenameStateForTests();
  const renamedChannels: Array<{ name: string }> = [];
  const posts = Array.from({ length: 101 }, (_, index) =>
    createPost({ id: `post-${index}`, ownerId: `owner-${index}` }),
  );
  const store = createStore({
    config: createConfig({ counterVoiceChannelId: "voice-1" }),
    posts,
  });
  const service = new LfgService(store, {
    ...createDiscordStub(),
    async modifyChannel(_channelId, body) {
      renamedChannels.push({ name: body.name });
    },
  });

  await service.updateCounterChannel("guild-1");

  assert.deepEqual(renamedChannels, [{ name: "LFG (101)" }]);
});

test("applyLfgCounterTemplate replaces every count placeholder", () => {
  assert.equal(applyLfgCounterTemplate("Open LFGs: {count} | {count}", 12), "Open LFGs: 12 | 12");
});

test("LfgService.updateCounterChannel uses the configured counter format", async () => {
  resetLfgCounterRenameStateForTests();
  const renamedChannels: Array<{ channelId: string; name: string }> = [];
  const store = createStore({
    config: createConfig({
      counterVoiceChannelId: "voice-custom",
      counterDisplayFormat: "Open squads: {count}",
    }),
    posts: [createPost(), createPost({ id: "post-2", ownerId: "owner-2" })],
  });
  const service = new LfgService(store, {
    ...createDiscordStub(),
    async modifyChannel(channelId, body) {
      renamedChannels.push({ channelId, name: body.name });
    },
  });

  await service.updateCounterChannel("guild-1");

  assert.deepEqual(renamedChannels, [{ channelId: "voice-custom", name: "Open squads: 2" }]);
});

test("LfgService.submitApplication stores a pending application message", async () => {
  const baseNow = Date.UTC(2026, 0, 1, 12, 0, 0);
  const originalDateNow = Date.now;
  Date.now = () => baseNow;

  try {
    const store = createStore({ applications: [] });
    const service = new LfgService(store, createDiscordStub());

    await service.submitApplication({
      guildId: "guild-1",
      postId: "post-1",
      applicantId: "applicant-1",
      applicantDisplayName: "Applicant",
      message: " I can run support. ",
    });

    assert.deepEqual(store.applications, [
      {
        guildId: "guild-1",
        postId: "post-1",
        applicantId: "applicant-1",
        applicantDisplayName: "Applicant",
        message: "I can run support.",
        status: "pending",
        createdAtMs: baseNow,
        updatedAtMs: baseNow,
        reviewedByUserId: null,
        reviewedAtMs: null,
      },
    ]);
  } finally {
    Date.now = originalDateNow;
  }
});

test("LfgService.submitApplication blocks duplicate pending applications", async () => {
  const store = createStore({
    applications: [createApplication({ applicantId: "applicant-1", status: "pending" })],
  });
  const service = new LfgService(store, createDiscordStub());

  await assert.rejects(
    service.submitApplication({
      guildId: "guild-1",
      postId: "post-1",
      applicantId: "applicant-1",
      applicantDisplayName: "Applicant",
      message: "Still interested.",
    }),
    (error) =>
      error instanceof LfgConfigError &&
      error.message === "You already have a pending application for this post.",
  );
  assert.equal(store.applications.length, 1);
});

test("LfgService.startApplication blocks rejected applicants from reapplying", async () => {
  const store = createStore({
    applications: [createApplication({ applicantId: "applicant-1", status: "rejected" })],
  });
  const service = new LfgService(store, createDiscordStub());

  await assert.rejects(
    service.startApplication({
      guildId: "guild-1",
      postId: "post-1",
      applicantId: "applicant-1",
    }),
    (error) =>
      error instanceof LfgConfigError &&
      error.message === "You cannot reapply to this LFG post after being rejected.",
  );
});

test("LfgService.submitApplication DMs the poster with review actions", async () => {
  const dms: Array<{ userId: string; body: unknown }> = [];
  const store = createStore({ applications: [] });
  const service = new LfgService(store, {
    ...createDiscordStub(),
    async createUserDmMessage(userId, body) {
      dms.push({ userId, body });
      return { id: "dm-1", channel_id: "dm-channel", content: body.content ?? "" };
    },
  });

  await service.submitApplication({
    guildId: "guild-1",
    postId: "post-1",
    applicantId: "applicant-1",
    applicantDisplayName: "Applicant",
    message: "I can run support.",
  });

  assert.equal(dms.length, 1);
  assert.equal(dms[0]?.userId, "owner-1");
  const body = dms[0]?.body as {
    content?: string;
    components?: Array<{ components: Array<{ custom_id: string }> }>;
  };
  assert.match(body.content ?? "", /Applicant/);
  assert.match(body.content ?? "", /I can run support\./);
  assert.deepEqual(
    body.components?.[0]?.components.map((component) => component.custom_id),
    [
      "lfg:application-accept:guild-1:post-1:applicant-1",
      "lfg:application-reject:guild-1:post-1:applicant-1",
    ],
  );
});

test("LfgService delivers production-length application review IDs through the signed DM adapter", async () => {
  const guildId = "1234567890123456789";
  const ownerId = "1234567890123456789";
  const applicantId = "9876543210987654321";
  const postId = `1760000000000-${ownerId}`;
  const store = createStore({
    applications: [],
    post: createPost({ guildId, id: postId, ownerId }),
  });
  const signer = createComponentIdSigner({
    currentSecret: "component-id-signing-secret-for-production-tests",
  });
  const services = createServiceFactory({
    stores: { lfg: store } as unknown as RuntimeStores,
    discordBotToken: "token",
    componentIdSigner: signer,
  });
  const originalFetch = globalThis.fetch;
  const captured: {
    messageBody: { components?: Array<{ components?: Array<{ custom_id?: string }> }> } | null;
  } = { messageBody: null };
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/users/@me/channels")) return Response.json({ id: "dm-channel" });
    if (url.endsWith("/channels/dm-channel/messages")) {
      captured.messageBody = JSON.parse(String(init?.body)) as typeof captured.messageBody;
      return Response.json({ id: "dm-message", channel_id: "dm-channel", content: "" });
    }
    throw new Error(`Unexpected Discord request: ${url}`);
  };

  try {
    await services.lfgService.submitApplication({
      guildId,
      postId,
      applicantId,
      applicantDisplayName: "Applicant",
      message: "I can run support.",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const customIds = captured.messageBody?.components?.[0]?.components
    ?.map((component) => component.custom_id)
    .filter((customId): customId is string => typeof customId === "string");
  assert.equal(customIds?.length, 2);
  assert.equal(
    customIds?.every((customId) => customId.length <= 100),
    true,
  );
  assert.deepEqual(
    await verifySensitiveComponentId(customIds?.[0] ?? "", signer, { actorUserId: ownerId }),
    {
      kind: "valid",
      purpose: "lfg-application-accept",
      customId: `lfg:application-accept:${guildId}:${postId}:${applicantId}`,
    },
  );
});

test("LfgService.reviewApplication accepts a pending applicant and records audit", async () => {
  const baseNow = Date.UTC(2026, 0, 1, 12, 0, 0);
  const originalDateNow = Date.now;
  Date.now = () => baseNow;
  const dms: Array<{ userId: string; body: unknown }> = [];
  const auditMessages: Array<{ channelId: string; body: unknown }> = [];

  try {
    const store = createStore({
      config: createConfig({ approvalAuditChannelId: "audit-channel-1" }),
      applications: [createApplication({ applicantId: "applicant-1", status: "pending" })],
    });
    const service = new LfgService(store, {
      ...createDiscordStub(),
      async createUserDmMessage(userId, body) {
        dms.push({ userId, body });
        return { id: "dm-1", channel_id: "dm-channel", content: body.content ?? "" };
      },
      async createChannelMessage(channelId, body) {
        auditMessages.push({ channelId, body });
        return { id: "audit-1", channel_id: channelId, content: body.content ?? "" };
      },
    });

    await service.reviewApplication({
      guildId: "guild-1",
      postId: "post-1",
      applicantId: "applicant-1",
      actorId: "owner-1",
      outcome: "accepted",
    });

    assert.equal(store.applications[0]?.status, "accepted");
    assert.equal(store.applications[0]?.reviewedByUserId, "owner-1");
    assert.equal(store.applications[0]?.reviewedAtMs, baseNow);
    assert.equal(dms[0]?.userId, "applicant-1");
    const dmBody = dms[0]?.body as { content?: string } | undefined;
    assert.match(dmBody?.content ?? "", /accepted/);
    assert.equal(auditMessages[0]?.channelId, "audit-channel-1");
    assert.match(JSON.stringify(auditMessages[0]?.body), /I can run support\./);
  } finally {
    Date.now = originalDateNow;
  }
});

test("LfgService.reviewApplication posts standardized application audit embeds", async () => {
  const baseNow = Date.UTC(2026, 0, 1, 12, 0, 0);
  const originalDateNow = Date.now;
  Date.now = () => baseNow;
  const auditMessages: Array<{ channelId: string; body: unknown }> = [];

  try {
    const store = createStore({
      config: createConfig({ approvalAuditChannelId: "audit-channel-1" }),
      applications: [createApplication({ applicantId: "applicant-1", status: "pending" })],
    });
    const service = new LfgService(store, {
      ...createDiscordStub(),
      async createChannelMessage(channelId, body) {
        auditMessages.push({ channelId, body });
        return { id: "audit-1", channel_id: channelId, content: body.content ?? "" };
      },
    });

    await service.reviewApplication({
      guildId: "guild-1",
      postId: "post-1",
      applicantId: "applicant-1",
      actorId: "owner-1",
      outcome: "accepted",
    });

    assert.equal(auditMessages[0]?.channelId, "audit-channel-1");
    const body = auditMessages[0]?.body as {
      content?: string;
      allowed_mentions?: unknown;
      embeds?: Array<{
        title?: string;
        description?: string;
        color?: number;
        footer?: { text: string };
        timestamp?: string;
        fields?: Array<{ name: string; value: string; inline?: boolean }>;
      }>;
    };
    const embed = body.embeds?.[0];

    assert.deepEqual(body.allowed_mentions, { parse: [] });
    assert.equal(body.content, undefined);
    assert.equal(embed?.title, "LFG application Accepted");
    assert.equal(embed?.color, 0x57f287);
    assert.equal(embed?.description, undefined);
    assert.deepEqual(embed?.footer, { text: "hafbot.xyz" });
    assert.equal(embed?.timestamp, new Date(baseNow).toISOString());
    assert.deepEqual(embed?.fields, [
      { name: "Post", value: "post-1", inline: false },
      { name: "Applicant", value: "<@applicant-1>\nID: applicant-1", inline: false },
      { name: "Actor", value: "<@owner-1>\nID: owner-1", inline: false },
      { name: "Message", value: "I can run support.", inline: false },
    ]);
  } finally {
    Date.now = originalDateNow;
  }
});

test("LfgService.reviewApplication creates a private voice channel for the first accepted applicant", async () => {
  const createdChannels: Array<{
    guildId: string;
    name: string;
    parentId: string;
    ownerUserId: string;
    acceptedUserIds: string[];
  }> = [];
  const store = createStore({
    config: createConfig({ approvalVoiceCategoryId: "voice-category-1" }),
    applications: [createApplication({ applicantId: "applicant-1", status: "pending" })],
  });
  const service = new LfgService(store, {
    ...createDiscordStub(),
    async createPrivateVoiceChannel(input) {
      createdChannels.push(input);
      return { id: "voice-channel-1" };
    },
  });

  await service.reviewApplication({
    guildId: "guild-1",
    postId: "post-1",
    applicantId: "applicant-1",
    actorId: "owner-1",
    outcome: "accepted",
  });

  assert.deepEqual(createdChannels, [
    {
      guildId: "guild-1",
      name: "lfg-owner-applicant",
      parentId: "voice-category-1",
      ownerUserId: "owner-1",
      acceptedUserIds: ["applicant-1"],
    },
  ]);
  assert.equal(store.voiceChannels[0]?.channelId, "voice-channel-1");
});

test("LfgService.reviewApplication adds later accepted applicants to the existing private voice channel", async () => {
  const createdChannels: Array<unknown> = [];
  const updatedChannels: Array<{
    guildId: string;
    channelId: string;
    ownerUserId: string;
    acceptedUserIds: string[];
  }> = [];
  const store = createStore({
    config: createConfig({ approvalVoiceCategoryId: "voice-category-1" }),
    applications: [
      createApplication({ applicantId: "applicant-1", status: "accepted" }),
      createApplication({
        applicantId: "applicant-2",
        applicantDisplayName: "Second",
        status: "pending",
      }),
    ],
    voiceChannels: [
      {
        guildId: "guild-1",
        postId: "post-1",
        channelId: "voice-channel-1",
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    ],
  });
  const service = new LfgService(store, {
    ...createDiscordStub(),
    async createPrivateVoiceChannel(input) {
      createdChannels.push(input);
      return { id: "voice-channel-2" };
    },
    async updatePrivateVoiceChannelAccess(input) {
      updatedChannels.push(input);
    },
  });

  await service.reviewApplication({
    guildId: "guild-1",
    postId: "post-1",
    applicantId: "applicant-2",
    actorId: "owner-1",
    outcome: "accepted",
  });

  assert.deepEqual(createdChannels, []);
  assert.deepEqual(updatedChannels, [
    {
      guildId: "guild-1",
      channelId: "voice-channel-1",
      ownerUserId: "owner-1",
      acceptedUserIds: ["applicant-2", "applicant-1"],
    },
  ]);
});

test("LfgService.closePost deletes the mapped private voice channel", async () => {
  const deletedChannels: string[] = [];
  const store = createStore({
    voiceChannels: [
      {
        guildId: "guild-1",
        postId: "post-1",
        channelId: "voice-channel-1",
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    ],
  });
  const service = new LfgService(store, {
    ...createDiscordStub(),
    async deleteChannel(channelId) {
      deletedChannels.push(channelId);
    },
  });

  await service.closePost({ guildId: "guild-1", postId: "post-1", closedByUserId: "owner-1" });

  assert.deepEqual(deletedChannels, ["voice-channel-1"]);
  assert.deepEqual(store.voiceChannels, []);
});

test("LfgService.deletePrivateVoiceChannelForDiscordChannel removes an empty mapped channel", async () => {
  const deletedChannels: string[] = [];
  const store = createStore({
    voiceChannels: [
      {
        guildId: "guild-1",
        postId: "post-1",
        channelId: "voice-channel-1",
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    ],
  });
  const service = new LfgService(store, {
    ...createDiscordStub(),
    async deleteChannel(channelId) {
      deletedChannels.push(channelId);
    },
  });

  await service.deletePrivateVoiceChannelForDiscordChannel("voice-channel-1");

  assert.deepEqual(deletedChannels, ["voice-channel-1"]);
  assert.deepEqual(store.voiceChannels, []);
});

test("LfgService.reviewApplication recreates a missing mapped private voice channel", async () => {
  const createdChannels: Array<unknown> = [];
  const store = createStore({
    config: createConfig({ approvalVoiceCategoryId: "voice-category-1" }),
    applications: [
      createApplication({ applicantId: "applicant-1", status: "accepted" }),
      createApplication({
        applicantId: "applicant-2",
        applicantDisplayName: "Second",
        status: "pending",
      }),
    ],
    voiceChannels: [
      {
        guildId: "guild-1",
        postId: "post-1",
        channelId: "missing-channel-1",
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    ],
  });
  const service = new LfgService(store, {
    ...createDiscordStub(),
    async updatePrivateVoiceChannelAccess() {
      throw { status: 404 };
    },
    async createPrivateVoiceChannel(input) {
      createdChannels.push(input);
      return { id: "voice-channel-2" };
    },
  });

  await service.reviewApplication({
    guildId: "guild-1",
    postId: "post-1",
    applicantId: "applicant-2",
    actorId: "owner-1",
    outcome: "accepted",
  });

  assert.equal(store.voiceChannels[0]?.channelId, "voice-channel-2");
  assert.equal(createdChannels.length, 1);
});

test("LfgService.updateConfig queues a counter rename when the format changes", async () => {
  resetLfgCounterRenameStateForTests();
  const renamedChannels: Array<{ channelId: string; name: string }> = [];
  const store = createStore({
    config: createConfig({
      counterVoiceChannelId: "voice-format",
      counterDisplayFormat: "LFG ({count})",
    }),
    posts: [createPost(), createPost({ id: "post-2", ownerId: "owner-2" })],
  });
  const service = new LfgService(store, {
    ...createDiscordStub(),
    async modifyChannel(channelId, body) {
      renamedChannels.push({ channelId, name: body.name });
    },
  });

  await service.updateConfig({
    ...(await service.getConfig("guild-1")),
    counterDisplayFormat: "Open squads: {count}",
  });

  assert.deepEqual(renamedChannels, [{ channelId: "voice-format", name: "Open squads: 2" }]);
});

test("LfgService.updateCounterChannel renames immediately when outside cooldown", async () => {
  resetLfgCounterRenameStateForTests();
  const renamedChannels: Array<{ channelId: string; name: string }> = [];
  const store = createStore({
    config: createConfig({ counterVoiceChannelId: "voice-1" }),
    posts: [createPost(), createPost({ id: "post-2", ownerId: "owner-2" })],
  });
  const service = new LfgService(store, {
    ...createDiscordStub(),
    async modifyChannel(channelId, body) {
      renamedChannels.push({ channelId, name: body.name });
    },
  });

  await service.updateCounterChannel("guild-1");

  assert.deepEqual(renamedChannels, [{ channelId: "voice-1", name: "LFG (2)" }]);
});

test("LfgService.updateCounterChannel queues one rename and drops stale counts in favor of the latest", async () => {
  resetLfgCounterRenameStateForTests();
  const baseTime = Date.UTC(2026, 0, 1, 12, 0, 0);
  const originalDateNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  const waitUntils: Promise<unknown>[] = [];
  const timers: Array<() => void> = [];
  const renamedChannels: Array<{ channelId: string; name: string }> = [];
  const store = createStore({
    config: createConfig({ counterVoiceChannelId: "voice-queue" }),
    posts: [createPost()],
  });
  const service = new LfgService(store, {
    ...createDiscordStub(),
    async modifyChannel(channelId, body) {
      renamedChannels.push({ channelId, name: body.name });
    },
    waitUntil(promise) {
      waitUntils.push(promise);
    },
  });

  let now = baseTime;
  Date.now = () => now;
  globalThis.setTimeout = ((callback: TimerHandler) => {
    timers.push(() => {
      if (typeof callback === "function") {
        callback();
      }
    });
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;

  try {
    await service.updateCounterChannel("guild-1");
    assert.deepEqual(renamedChannels, [{ channelId: "voice-queue", name: "LFG (1)" }]);

    renamedChannels.length = 0;
    store.posts.push(createPost({ id: "post-2", ownerId: "owner-2" }));
    now += 60_000;
    await service.updateCounterChannel("guild-1");

    store.posts.push(createPost({ id: "post-3", ownerId: "owner-3" }));
    await service.updateCounterChannel("guild-1");

    assert.deepEqual(renamedChannels, []);
    assert.equal(timers.length, 1);

    timers[0]?.();
    await Promise.all(waitUntils);

    assert.deepEqual(renamedChannels, [{ channelId: "voice-queue", name: "LFG (3)" }]);
  } finally {
    Date.now = originalDateNow;
    globalThis.setTimeout = originalSetTimeout;
    resetLfgCounterRenameStateForTests();
  }
});

test("LfgService.processDueExpiries deletes expired posts when configured", async () => {
  resetLfgCounterRenameStateForTests();
  const deletedMessages: Array<{ channelId: string; messageId: string }> = [];
  const service = new LfgService(
    createStore({
      config: createConfig({ expiryAction: "delete" }),
    }),
    {
      ...createDiscordStub(),
      async deleteChannelMessage(channelId, messageId) {
        deletedMessages.push({ channelId, messageId });
      },
    },
  );

  await service.processDueExpiries(1_000);

  assert.deepEqual(deletedMessages, [{ channelId: "lfg-channel-1", messageId: "message-1" }]);
});

test("LfgService.processDueExpiries leaves expired posts alone when configured", async () => {
  resetLfgCounterRenameStateForTests();
  const store = createStore({
    config: createConfig({ expiryAction: "nothing" }),
  });
  const editedMessages: unknown[] = [];
  const deletedMessages: unknown[] = [];
  const service = new LfgService(store, {
    ...createDiscordStub(),
    async editChannelMessage(_channelId, _messageId, body) {
      editedMessages.push(body);
      return { id: "message-1", channel_id: "lfg-channel-1", content: "" };
    },
    async deleteChannelMessage() {
      deletedMessages.push(true);
    },
  });

  await service.processDueExpiries(1_000);

  assert.equal(store.posts[0]?.active, true);
  assert.deepEqual(editedMessages, []);
  assert.deepEqual(deletedMessages, []);
});

test("LfgService.processDueExpiries updates the counter after deleting expired posts", async () => {
  resetLfgCounterRenameStateForTests();
  const renamedChannels: Array<{ channelId: string; name: string }> = [];
  const store = createStore({
    config: createConfig({ expiryAction: "delete", counterVoiceChannelId: "voice-2" }),
    posts: [
      createPost({ id: "post-1", expiresAtMs: 100 }),
      createPost({ id: "post-2", ownerId: "owner-2", expiresAtMs: 10_000 }),
    ],
  });
  const service = new LfgService(store, {
    ...createDiscordStub(),
    async deleteChannelMessage() {},
    async modifyChannel(channelId, body) {
      renamedChannels.push({ channelId, name: body.name });
    },
  });

  await service.processDueExpiries(1_000);

  assert.deepEqual(renamedChannels, [{ channelId: "voice-2", name: "LFG (1)" }]);
});

test("LfgService uses the authoritative Clan Management attribution setting", async () => {
  const store = createStore({ posts: [] });
  let attributionEnabled = false;
  const service = new LfgService(store, createDiscordStub(), undefined, {
    async readMembership() {
      return { clanId: "clan-1", rank: "member" };
    },
    async readClan() {
      return {
        id: "clan-1",
        tag: "ALPHA",
        lifecycleState: "active",
        textChannelId: "clan-text",
        voiceChannelId: "clan-voice",
        clanLfgLeadershipOnly: false,
      };
    },
    async isPublicAttributionEnabled() {
      return attributionEnabled;
    },
  });

  const withoutAttribution = await service.createPost({
    guildId: "guild-1",
    channelId: "public-lfg",
    ownerId: "owner-1",
    ownerDisplayName: "Owner",
    serverId: "namalsk",
    whenPlay: "Tonight",
    lookingFor: "Two players",
    extraInfo: "",
  });
  assert.equal(withoutAttribution.clanTag, null);

  await service.closePost({
    guildId: "guild-1",
    postId: withoutAttribution.id,
    closedByUserId: "owner-1",
  });
  attributionEnabled = true;
  const withAttribution = await service.createPost({
    guildId: "guild-1",
    channelId: "public-lfg",
    ownerId: "owner-1",
    ownerDisplayName: "Owner",
    serverId: "namalsk",
    whenPlay: "Tomorrow",
    lookingFor: "Two players",
    extraInfo: "",
  });
  assert.equal(withAttribution.clanTag, "ALPHA");
});

test("LfgService rejects foreign configuration resources before persistence", async () => {
  const store = createStore({ config: createConfig({ noticeChannelId: "own-text" }) });
  let discordCalls = 0;
  const service = new LfgService(
    store,
    {
      ...createDiscordStub(),
      async createChannelMessage() {
        discordCalls += 1;
        return { id: "message", channel_id: "foreign-text", content: "" };
      },
    },
    undefined,
    undefined,
    createStaticGuildResourceValidator({
      guilds: {
        "guild-1": { channels: [testChannel("own-text", 0, "guild-1")], roles: [] },
        "guild-2": { channels: [testChannel("foreign-text", 0, "guild-2")], roles: [] },
      },
    }),
  );

  await assert.rejects(
    service.updateConfig({ ...store.config, noticeChannelId: "foreign-text" }),
    GuildResourceValidationError,
  );
  assert.equal(store.config.noticeChannelId, "own-text");
  assert.equal(discordCalls, 0);
});

test("LfgService rejects a foreign publish channel before Discord or persistence", async () => {
  const store = createStore({
    config: createConfig({ noticeChannelId: null, noticeMessageId: null }),
  });
  let discordCalls = 0;
  const service = new LfgService(
    store,
    {
      ...createDiscordStub(),
      async createChannelMessage() {
        discordCalls += 1;
        return { id: "message", channel_id: "foreign-text", content: "" };
      },
    },
    undefined,
    undefined,
    createStaticGuildResourceValidator({
      guilds: {
        "guild-1": { channels: [testChannel("own-text", 0, "guild-1")], roles: [] },
        "guild-2": { channels: [testChannel("foreign-text", 0, "guild-2")], roles: [] },
      },
    }),
  );

  await assert.rejects(
    service.setupNotice("guild-1", "foreign-text"),
    GuildResourceValidationError,
  );
  assert.equal(discordCalls, 0);
  assert.equal(store.config.noticeChannelId, null);
  assert.equal(store.config.noticeMessageId, null);
});

test("LfgService leaves an expired post active when its persisted channel is stale", async () => {
  const post = createPost({ channelId: "foreign-text", messageId: "message-1", expiresAtMs: 1 });
  const store = createStore({ post });
  let discordCalls = 0;
  const service = new LfgService(
    store,
    {
      ...createDiscordStub(),
      async editChannelMessage() {
        discordCalls += 1;
        return { id: "message-1", channel_id: "foreign-text", content: "" };
      },
      async deleteChannelMessage() {
        discordCalls += 1;
      },
    },
    undefined,
    undefined,
    createStaticGuildResourceValidator({
      guilds: {
        "guild-1": { channels: [testChannel("own-text", 0, "guild-1")], roles: [] },
        "guild-2": { channels: [testChannel("foreign-text", 0, "guild-2")], roles: [] },
      },
    }),
  );

  await service.processDueExpiries(1_000);
  assert.equal(post.active, true);
  assert.equal(post.closedAtMs, null);
  assert.equal(discordCalls, 0);
});

test("LfgService rejects a stale persisted channel before close persistence", async () => {
  const post = createPost({ channelId: "foreign-text", messageId: "message-1" });
  const store = createStore({ post });
  let discordCalls = 0;
  const service = new LfgService(
    store,
    {
      ...createDiscordStub(),
      async editChannelMessage() {
        discordCalls += 1;
        return { id: "message-1", channel_id: "foreign-text", content: "" };
      },
    },
    undefined,
    undefined,
    createStaticGuildResourceValidator({
      guilds: {
        "guild-1": { channels: [testChannel("own-text", 0, "guild-1")], roles: [] },
        "guild-2": { channels: [testChannel("foreign-text", 0, "guild-2")], roles: [] },
      },
    }),
  );

  await assert.rejects(
    service.closePost({ guildId: "guild-1", postId: post.id, closedByUserId: "owner-1" }),
    GuildResourceValidationError,
  );
  assert.equal(post.active, true);
  assert.equal(post.closedAtMs, null);
  assert.equal(discordCalls, 0);
});

test("LfgService rejects a stale persisted channel before edit persistence", async () => {
  const post = createPost({ channelId: "foreign-text", messageId: "message-1" });
  const store = createStore({ post });
  let discordCalls = 0;
  const service = new LfgService(
    store,
    {
      ...createDiscordStub(),
      async editChannelMessage() {
        discordCalls += 1;
        return { id: "message-1", channel_id: "foreign-text", content: "" };
      },
    },
    undefined,
    undefined,
    createStaticGuildResourceValidator({
      guilds: {
        "guild-1": { channels: [testChannel("own-text", 0, "guild-1")], roles: [] },
        "guild-2": { channels: [testChannel("foreign-text", 0, "guild-2")], roles: [] },
      },
    }),
  );

  await assert.rejects(
    service.editPost({
      guildId: "guild-1",
      postId: post.id,
      ownerId: post.ownerId,
      serverId: "chernarus",
      whenPlay: "Tomorrow",
      lookingFor: "Squad",
      extraInfo: "Updated",
    }),
    GuildResourceValidationError,
  );
  assert.equal(store.posts[0]?.whenPlay, "Tonight");
  assert.equal(store.posts[0]?.serverId, "namalsk");
  assert.equal(discordCalls, 0);
});

test("LfgService rejects a stale persisted channel before renew persistence", async () => {
  const post = createPost({ channelId: "foreign-text", messageId: "message-1" });
  const store = createStore({ post });
  let discordCalls = 0;
  const service = new LfgService(
    store,
    {
      ...createDiscordStub(),
      async editChannelMessage() {
        discordCalls += 1;
        return { id: "message-1", channel_id: "foreign-text", content: "" };
      },
    },
    undefined,
    undefined,
    createStaticGuildResourceValidator({
      guilds: {
        "guild-1": { channels: [testChannel("own-text", 0, "guild-1")], roles: [] },
        "guild-2": { channels: [testChannel("foreign-text", 0, "guild-2")], roles: [] },
      },
    }),
  );

  await assert.rejects(
    service.renewPost({ guildId: "guild-1", postId: post.id, userId: post.ownerId }),
    GuildResourceValidationError,
  );
  assert.equal(store.posts[0]?.renewalsCount, 0);
  assert.equal(store.posts[0]?.renewedAtMs, null);
  assert.equal(discordCalls, 0);
});

function createStore(options?: {
  config?: LfgConfig;
  post?: LfgPost;
  posts?: LfgPost[];
  applications?: LfgApplication[];
  voiceChannels?: LfgVoiceChannel[];
}) {
  const config = options?.config ?? createConfig();
  const posts = options?.posts ?? [options?.post ?? createPost()];
  const applications = options?.applications ?? [];
  const voiceChannels = options?.voiceChannels ?? [];

  return {
    config,
    posts,
    applications,
    voiceChannels,
    async readLfgConfig() {
      return config;
    },
    async upsertLfgConfig(nextConfig: LfgConfig) {
      Object.assign(config, nextConfig);
    },
    async refreshLfgNotice(input: Parameters<LfgStore["refreshLfgNotice"]>[0]) {
      if (
        config.guildId !== input.guildId ||
        config.noticeChannelId !== input.channelId ||
        config.noticeMessageId !== input.previousMessageId ||
        config.updatedAtMs !== input.expectedUpdatedAtMs
      )
        return false;
      Object.assign(config, { noticeMessageId: input.messageId, updatedAtMs: input.updatedAtMs });
      return true;
    },
    async listLfgPosts(_guildId: string, options?: { activeOnly?: boolean }) {
      return options?.activeOnly ? posts.filter((post) => post.active) : posts;
    },
    async countActiveLfgPosts() {
      return posts.filter((post) => post.active).length;
    },
    async readLfgPost(_guildId: string, postId: string) {
      return posts.find((post) => post.id === postId) ?? null;
    },
    async readActiveLfgPostByOwner(_guildId: string, ownerId: string) {
      return posts.find((post) => post.ownerId === ownerId && post.active) ?? null;
    },
    async createLfgPost(post: LfgPost) {
      posts.push(post);
    },
    async updateLfgPostMessage(body: { postId: string; messageId: string }) {
      const post = posts.find((entry) => entry.id === body.postId);
      if (post) post.messageId = body.messageId;
    },
    async updateLfgPost(post: LfgPost) {
      const index = posts.findIndex((entry) => entry.id === post.id);
      if (index >= 0) posts[index] = post;
    },
    async closeLfgPost(body: { postId: string; closedByUserId: string; closedAtMs: number }) {
      const post = posts.find((entry) => entry.id === body.postId);
      if (!post) throw new Error("missing post");
      post.active = false;
      post.closedByUserId = body.closedByUserId;
      post.closedAtMs = body.closedAtMs;
      return post;
    },
    async createLfgApplication(application: LfgApplication) {
      applications.push(application);
    },
    async readLfgApplication(_guildId: string, postId: string, applicantId: string) {
      return (
        applications.find(
          (application) => application.postId === postId && application.applicantId === applicantId,
        ) ?? null
      );
    },
    async listLfgApplicationsForPost(
      _guildId: string,
      postId: string,
      options?: { status?: string },
    ) {
      return applications.filter(
        (application) =>
          application.postId === postId &&
          (!options?.status || application.status === options.status),
      );
    },
    async updateLfgApplication(application: LfgApplication) {
      const index = applications.findIndex(
        (entry) =>
          entry.postId === application.postId && entry.applicantId === application.applicantId,
      );
      if (index >= 0) applications[index] = application;
    },
    async readLfgVoiceChannel(_guildId: string, postId: string) {
      return voiceChannels.find((channel) => channel.postId === postId) ?? null;
    },
    async readLfgVoiceChannelByChannelId(channelId: string) {
      return voiceChannels.find((channel) => channel.channelId === channelId) ?? null;
    },
    async upsertLfgVoiceChannel(channel: LfgVoiceChannel) {
      const index = voiceChannels.findIndex((entry) => entry.postId === channel.postId);
      if (index >= 0) {
        voiceChannels[index] = channel;
      } else {
        voiceChannels.push(channel);
      }
    },
    async deleteLfgVoiceChannel(_guildId: string, postId: string) {
      const index = voiceChannels.findIndex((channel) => channel.postId === postId);
      if (index >= 0) voiceChannels.splice(index, 1);
    },
    async listDueLfgPostExpiries(nowMs: number) {
      return posts.filter(
        (post) => post.active && (post.expiresAtMs ?? Number.MAX_SAFE_INTEGER) <= nowMs,
      );
    },
    async listDueLfgRenewalReminders(nowMs: number) {
      return posts.filter(
        (post) =>
          post.active &&
          post.reminderSentAtMs === null &&
          post.expiresAtMs !== null &&
          post.expiresAtMs > nowMs &&
          post.expiresAtMs <= nowMs + 60 * 60 * 1000,
      );
    },
  };
}

function createConfig(overrides: Partial<LfgConfig> = {}): LfgConfig {
  return {
    guildId: "guild-1",
    noticeChannelId: "lfg-channel-1",
    noticeMessageId: "notice-1",
    notificationRoleId: null,
    counterVoiceChannelId: null,
    counterDisplayFormat: "LFG ({count})",
    approvalFlowEnabled: false,
    approvalAuditChannelId: null,
    approvalVoiceCategoryId: null,
    expiryAction: "close",
    expiryDurationHours: 24,
    serverOptions: [
      { id: "namalsk", label: "Namalsk", emoji: "🧊" },
      { id: "chernarus", label: "Chernarus", emoji: "🌲" },
    ],
    updatedAtMs: 1,
    ...overrides,
  };
}

function createPost(overrides: Partial<LfgPost> = {}): LfgPost {
  return {
    guildId: "guild-1",
    id: "post-1",
    ownerId: "owner-1",
    ownerDisplayName: "Owner",
    serverId: "namalsk",
    serverLabel: "Namalsk",
    whenPlay: "Tonight",
    lookingFor: "Duo",
    extraInfo: "Bring meds",
    channelId: "lfg-channel-1",
    messageId: "message-1",
    active: true,
    createdAtMs: 1,
    expiresAtMs: 500,
    reminderSentAtMs: null,
    renewedAtMs: null,
    renewalsCount: 0,
    closedAtMs: null,
    closedByUserId: null,
    ...overrides,
  };
}

function createApplication(overrides: Partial<LfgApplication> = {}): LfgApplication {
  return {
    guildId: "guild-1",
    postId: "post-1",
    applicantId: "applicant-1",
    applicantDisplayName: "Applicant",
    message: "I can run support.",
    status: "pending",
    createdAtMs: 1,
    updatedAtMs: 1,
    reviewedByUserId: null,
    reviewedAtMs: null,
    ...overrides,
  };
}

function createDiscordStub() {
  return {
    async createChannelMessage() {
      return { id: "message-1", channel_id: "lfg-channel-1", content: "" };
    },
    async editChannelMessage(channelId: string, messageId: string) {
      return { id: messageId, channel_id: channelId, content: "" };
    },
    async deleteChannelMessage() {},
    async createUserDmMessage() {
      return { id: "dm-1", channel_id: "dm-channel", content: "" };
    },
    async addGuildMemberRole() {},
    async removeGuildMemberRole() {},
    async modifyChannel() {},
  };
}
