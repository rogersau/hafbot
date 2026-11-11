/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import {
  ManagedMessageError,
  ManagedMessageService,
  handleManagedMessageCanonicalDelete,
  validateManagedMessage,
  type ManagedMessageDiscordAdapter,
  type ManagedMessageGuildResourcesAdapter,
} from "../src/services/managed-message-service";
import { DiscordApiError } from "../src/discord/client";
import type { ManagedMessage, ManagedMessageAnnouncement, ManagedMessageEmbed } from "../src/types";
import type { PublicManagedMediaStore } from "../src/managed-media";
import { afterStoreSeed, createProductionRuntimeStores } from "./support/production-runtime-stores";

function createService(
  options: {
    messages?: ManagedMessage[];
    discord?: Partial<ManagedMessageDiscordAdapter>;
    guildResources?: Partial<ManagedMessageGuildResourcesAdapter>;
    upsert?: (message: ManagedMessage) => Promise<void>;
    entitlementTier?: "free" | "premium" | "premium_plus";
    auditEnabled?: boolean;
    managedMedia?: PublicManagedMediaStore;
  } = {},
) {
  const fixture = createProductionRuntimeStores();
  const entitlementTier = options.entitlementTier ?? "free";
  if (entitlementTier !== "free") {
    fixture.database.execRaw(
      `INSERT INTO guild_entitlements (guild_id, plan, updated_at_ms) VALUES ('guild-1', '${entitlementTier}', 1)`,
    );
  }
  const rawStore = fixture.stores.managedMessages;
  const store = afterStoreSeed(
    options.upsert
      ? new Proxy(rawStore, {
          get(target, property, receiver) {
            if (property === "upsert") return options.upsert;
            return Reflect.get(target, property, receiver);
          },
        })
      : rawStore,
    Promise.all((options.messages ?? []).map((message) => rawStore.upsert(message))),
  );
  const discordCalls: Array<{ operation: string; body?: unknown; messageId?: string }> = [];
  let nextMessageNumber = (options.messages?.length ?? 0) + 1;
  const discord: ManagedMessageDiscordAdapter = {
    async create(_channelId, body) {
      discordCalls.push({ operation: "create", body });
      return { id: `discord-${nextMessageNumber++}` };
    },
    async edit(_channelId, messageId, body) {
      discordCalls.push({ operation: "edit", messageId, body });
    },
    async delete(_channelId, messageId) {
      discordCalls.push({ operation: "delete", messageId });
    },
    ...options.discord,
  };
  const guildResources: ManagedMessageGuildResourcesAdapter = {
    async read() {
      return { textChannelIds: ["channel-1"], roleIds: ["role-1"] };
    },
    ...options.guildResources,
  };
  const auditReady = options.auditEnabled
    ? fixture.stores.guildAuditLog.upsertConfig({
        guildId: "guild-1",
        auditChannelId: "audit-channel-1",
        groupChannelIds: {},
        eventStates: { groups: {}, overrides: {} },
        updatedAtMs: 0,
      })
    : Promise.resolve();
  const audit = afterStoreSeed(fixture.stores.guildAuditLog, auditReady);
  return {
    service: new ManagedMessageService({
      store,
      guildEntitlements: fixture.stores.guildEntitlements,
      guildAuditLog: audit,
      discordBotToken: "token",
      discord,
      guildResources,
      managedMedia: options.managedMedia,
    }),
    discordCalls,
    store,
    audit,
    fixture,
  };
}

const managedMediaUrl =
  "https://example.com/managed-media/guild-1/00000000-0000-0000-0000-000000000001.png";

function createManagedMediaProbe() {
  const deleted: string[] = [];
  const store: PublicManagedMediaStore = {
    async putImage() {},
    async getImage() {
      return null;
    },
    async deleteImage({ filename }) {
      deleted.push(filename);
    },
  };
  return { store, deleted };
}

function createFailingManagedMediaProbe() {
  const deleted: string[] = [];
  let failuresRemaining = 1;
  const store: PublicManagedMediaStore = {
    async putImage() {},
    async getImage() {
      return null;
    },
    async deleteImage({ filename }) {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new Error("R2 unavailable");
      }
      deleted.push(filename);
    },
  };
  return { store, deleted };
}

function input(overrides: Partial<Parameters<ManagedMessageService["save"]>[0]> = {}) {
  return {
    guildId: "guild-1",
    internalName: "rules",
    channelId: "channel-1",
    embeds: [embed()],
    announcement: announcement(),
    ...overrides,
  };
}

test("Save Draft persists Managed Message content without publishing to Discord", async () => {
  const { service, discordCalls } = createService();

  const draft = await service.saveDraft(input());

  assert.equal(draft.status, "draft");
  assert.equal(draft.internalName, "rules");
  const persisted = (await service.listDrafts("guild-1"))[0];
  assert.equal(persisted?.id, draft.id);
  assert.equal(persisted?.status, "draft");
  assert.equal(persisted?.embeds[0]?.description, "Read these rules.");
  assert.deepEqual(discordCalls, []);
});

test("Managed Message draft media is retired on replacement and explicit deletion", async () => {
  const media = createManagedMediaProbe();
  const { service } = createService({ managedMedia: media.store });
  await service.registerMediaAsset("guild-1", "00000000-0000-0000-0000-000000000001.png");
  const draft = await service.saveDraft(
    input({ embeds: [{ description: "with image", imageUrl: managedMediaUrl, fields: [] }] }),
  );
  await service.saveDraft(input({ id: draft.id }));
  assert.deepEqual(media.deleted, ["00000000-0000-0000-0000-000000000001.png"]);

  await service.registerMediaAsset("guild-1", "00000000-0000-0000-0000-000000000001.png");
  const withImage = await service.saveDraft(
    input({
      id: draft.id,
      embeds: [{ description: "with image", imageUrl: managedMediaUrl, fields: [] }],
    }),
  );
  await service.deleteDraft("guild-1", withImage.id);
  assert.deepEqual(media.deleted, [
    "00000000-0000-0000-0000-000000000001.png",
    "00000000-0000-0000-0000-000000000001.png",
  ]);
});

test("Managed media retirement retains pending assets for a later retry", async () => {
  const media = createFailingManagedMediaProbe();
  const { service, fixture } = createService({ managedMedia: media.store });
  const filename = "00000000-0000-0000-0000-000000000001.png";
  await service.registerMediaAsset("guild-1", filename);
  const draft = await service.saveDraft(
    input({ embeds: [{ description: "with image", imageUrl: managedMediaUrl, fields: [] }] }),
  );

  await assert.rejects(service.saveDraft(input({ id: draft.id })), /R2 unavailable/);
  assert.deepEqual(
    fixture.database.query<{ filename: string; status: string }>(
      "SELECT filename, status FROM managed_message_media_assets WHERE guild_id='guild-1'",
    ),
    [{ filename, status: "pending_deletion" }],
  );

  await service.saveDraft(input({ id: draft.id }));
  assert.deepEqual(media.deleted, [filename]);
  assert.deepEqual(
    fixture.database.query<{ filename: string }>(
      "SELECT filename FROM managed_message_media_assets WHERE guild_id='guild-1'",
    ),
    [],
  );
});

test("Managed Message deletion retries pending media after remote cleanup fails", async () => {
  const media = createFailingManagedMediaProbe();
  const { service, fixture } = createService({ managedMedia: media.store });
  const filename = "00000000-0000-0000-0000-000000000001.png";
  await service.registerMediaAsset("guild-1", filename);
  const draft = await service.saveDraft(
    input({ embeds: [{ description: "with image", imageUrl: managedMediaUrl, fields: [] }] }),
  );

  await assert.rejects(service.deleteDraft("guild-1", draft.id), /R2 unavailable/);
  assert.deepEqual(
    fixture.database.query<{ filename: string; status: string }>(
      "SELECT filename, status FROM managed_message_media_assets WHERE guild_id='guild-1'",
    ),
    [{ filename, status: "pending_deletion" }],
  );

  assert.equal(await service.deleteDraft("guild-1", draft.id), false);
  assert.deepEqual(media.deleted, [filename]);
  assert.deepEqual(
    fixture.database.query<{ filename: string }>(
      "SELECT filename FROM managed_message_media_assets WHERE guild_id='guild-1'",
    ),
    [],
  );
});

test("Managed Message publication transfers media ownership without retiring the published image", async () => {
  const media = createManagedMediaProbe();
  const { service } = createService({ managedMedia: media.store });
  await service.registerMediaAsset("guild-1", "00000000-0000-0000-0000-000000000001.png");
  const draft = await service.saveDraft(
    input({ embeds: [{ description: "with image", imageUrl: managedMediaUrl, fields: [] }] }),
  );
  const published = await service.publishDraftNow("guild-1", draft.id);
  assert.deepEqual(media.deleted, []);
  await service.delete("guild-1", published.id);
  assert.deepEqual(media.deleted, ["00000000-0000-0000-0000-000000000001.png"]);
});

test("Publish Now turns a Managed Message Draft into one canonical Managed Message", async () => {
  const { service, discordCalls } = createService();
  const draft = await service.saveDraft(input());

  const message = await service.publishDraftNow("guild-1", draft.id, "admin-1");

  assert.equal(message.status, "published");
  assert.equal(message.messageId, "discord-1");
  assert.deepEqual(await service.listDrafts("guild-1"), []);
  assert.deepEqual(
    discordCalls.map((call) => call.operation),
    ["create"],
  );
});

test("Schedule atomically saves current draft content for one future Publish", async () => {
  const { service, discordCalls } = createService();
  const scheduledAtMs = Date.now() + 60_000;

  const draft = await service.scheduleDraft(input(), scheduledAtMs, "admin-1");

  assert.equal(draft.status, "scheduled");
  assert.equal(draft.scheduledAtMs, scheduledAtMs);
  assert.deepEqual(discordCalls, []);
  await assert.rejects(
    service.scheduleDraft({ ...input(), id: draft.id }, Date.now() - 1),
    /future/i,
  );
});

test("Cancel and Delete remove a Scheduled Publish without publishing", async () => {
  const { service, discordCalls } = createService();
  const scheduled = await service.scheduleDraft(input(), Date.now() + 60_000);

  const cancelled = await service.cancelScheduledDraft("guild-1", scheduled.id, "admin-1");
  assert.equal(cancelled.status, "draft");
  assert.equal(cancelled.scheduledAtMs, null);

  const rescheduled = await service.scheduleDraft(
    { ...input(), id: scheduled.id },
    Date.now() + 120_000,
  );
  await service.deleteDraft("guild-1", rescheduled.id, "admin-1");

  assert.deepEqual(await service.listDrafts("guild-1"), []);
  assert.deepEqual(discordCalls, []);
});

test("scheduled processing publishes due drafts only using latest saved content", async () => {
  const { service, discordCalls } = createService();
  const firstInstant = Date.now() + 60_000;
  const due = await service.scheduleDraft(input(), firstInstant);
  await service.saveDraft({
    ...input(),
    id: due.id,
    embeds: [{ description: "Latest saved content", fields: [] }],
  });
  await service.scheduleDraft({ ...input(), internalName: "later" }, firstInstant + 60_000);

  const result = await service.processScheduledDrafts(firstInstant);

  assert.deepEqual(result, { published: 1, failed: 0, retrying: 0 });
  assert.equal(discordCalls.length, 1);
  assert.match(JSON.stringify(discordCalls[0]?.body), /Latest saved content/);
  assert.equal((await service.listDrafts("guild-1")).length, 1);
});

test("scheduled processing retries transient delivery and then retains a Failed draft", async () => {
  const { service } = createService({
    discord: {
      async create() {
        throw new DiscordApiError("Discord unavailable", 503, "unavailable");
      },
    },
  });
  const firstInstant = Date.now() + 60_000;
  await service.scheduleDraft(input(), firstInstant);

  assert.deepEqual(await service.processScheduledDrafts(firstInstant), {
    published: 0,
    failed: 0,
    retrying: 1,
  });
  const firstRetry = (await service.listDrafts("guild-1"))[0];
  assert.equal(firstRetry?.status, "scheduled");
  assert.equal(firstRetry?.attemptCount, 1);

  await service.processScheduledDrafts(firstRetry?.scheduledAtMs ?? 0);
  const secondRetry = (await service.listDrafts("guild-1"))[0];
  assert.equal(secondRetry?.attemptCount, 2);
  assert.deepEqual(await service.processScheduledDrafts(secondRetry?.scheduledAtMs ?? 0), {
    published: 0,
    failed: 1,
    retrying: 0,
  });

  const failed = (await service.listDrafts("guild-1"))[0];
  assert.equal(failed?.status, "failed");
  assert.match(failed?.failureReason ?? "", /Discord unavailable/);
});

test("manually rescheduling resets the automatic publication retry budget", async () => {
  const { service } = createService({
    discord: {
      async create() {
        throw new DiscordApiError("Discord unavailable", 503, "unavailable");
      },
    },
  });
  const firstInstant = Date.now() + 60_000;
  const scheduled = await service.scheduleDraft(input(), firstInstant);
  await service.processScheduledDrafts(firstInstant);
  assert.equal((await service.listDrafts("guild-1"))[0]?.attemptCount, 1);

  const rescheduled = await service.scheduleDraft(
    { ...input(), id: scheduled.id },
    firstInstant + 600_000,
  );

  assert.equal(rescheduled.attemptCount, 0);
});

test("Free Guild entitlement counts drafts and published Managed Messages together", async () => {
  const { service, discordCalls } = createService();
  await service.saveDraft(input({ internalName: "one" }));
  await service.saveDraft(input({ internalName: "two" }));
  await service.saveDraft(input({ internalName: "three" }));

  await assert.rejects(service.save(input({ internalName: "four" })), /up to 3 combined/i);
  assert.deepEqual(discordCalls, []);
});

function embed(overrides: Partial<ManagedMessageEmbed> = {}): ManagedMessageEmbed {
  return { description: "Read these rules.", fields: [], ...overrides };
}

function announcement(
  overrides: Partial<ManagedMessageAnnouncement> = {},
): ManagedMessageAnnouncement {
  return { roleIds: [], everyone: false, here: false, notifyOnCreate: false, ...overrides };
}

test("ManagedMessageService creates a canonical message with notifications suppressed by default", async () => {
  const { service, store, discordCalls } = createService();

  const saved = await service.save(input());

  assert.equal(saved.status, "published");
  assert.equal((await store.listByGuild("guild-1"))[0]?.messageId, saved.messageId);
  assert.deepEqual(discordCalls[0]?.body, {
    embeds: [{ description: "Read these rules.", fields: [] }],
    allowed_mentions: { parse: [] },
  });
});

test("ManagedMessageService publishes and removes URL-only link buttons", async () => {
  const { service, discordCalls } = createService();

  const saved = await service.save(
    input({
      buttons: [
        { label: " Support ", url: " https://example.com/support ", emoji: " 🔗 " },
        { label: "Rules", url: "https://example.com/rules" },
      ],
    }),
  );

  assert.deepEqual(saved.buttons, [
    { label: "Support", url: "https://example.com/support", emoji: "🔗" },
    { label: "Rules", url: "https://example.com/rules" },
  ]);
  assert.deepEqual(discordCalls[0]?.body, {
    embeds: [{ description: "Read these rules.", fields: [] }],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 5,
            label: "Support",
            url: "https://example.com/support",
            emoji: { name: "🔗" },
          },
          { type: 2, style: 5, label: "Rules", url: "https://example.com/rules" },
        ],
      },
    ],
    allowed_mentions: { parse: [] },
  });

  await service.save(input({ id: saved.id, buttons: [] }));
  assert.deepEqual(discordCalls[1]?.body, {
    embeds: [{ description: "Read these rules.", fields: [] }],
    components: [],
    allowed_mentions: { parse: [] },
  });
});

test("ManagedMessageService permits only configured targets on an initial announcement", async () => {
  const { service, discordCalls } = createService();

  await service.save(
    input({
      announcement: announcement({ roleIds: ["role-1"], everyone: true, notifyOnCreate: true }),
    }),
  );

  assert.deepEqual(discordCalls[0]?.body, {
    content: "📣 <@&role-1> @everyone",
    embeds: [{ description: "Read these rules.", fields: [] }],
    allowed_mentions: { parse: ["everyone"], roles: ["role-1"] },
  });
});

test("ManagedMessageService updates the canonical message in place and suppresses notifications", async () => {
  const { service, discordCalls } = createService();
  const created = await service.save(input());

  await service.save(
    input({
      id: created.id,
      internalName: "updated-rules",
      embeds: [embed({ description: "Updated." })],
    }),
  );

  assert.deepEqual(
    discordCalls.map((call) => call.operation),
    ["create", "edit"],
  );
  const editCall = discordCalls[1];
  assert.ok(editCall);
  assert.equal(editCall.messageId, created.messageId);
  assert.deepEqual((editCall.body as { allowed_mentions?: unknown }).allowed_mentions, {
    parse: [],
  });
});

test("ManagedMessageService preserves multi-embed and field ordering", async () => {
  const { service, discordCalls } = createService();

  await service.save(
    input({
      embeds: [
        embed({
          description: "First embed",
          fields: [
            { name: "First field", value: "1", inline: false },
            { name: "Second field", value: "2", inline: true },
          ],
        }),
        embed({ description: "Second embed" }),
      ],
    }),
  );

  const createCall = discordCalls[0];
  assert.ok(createCall);
  assert.deepEqual(
    (createCall.body as { embeds: Array<{ description: string; fields: unknown[] }> }).embeds,
    [
      {
        description: "First embed",
        fields: [
          { name: "First field", value: "1", inline: false },
          { name: "Second field", value: "2", inline: true },
        ],
      },
      { description: "Second embed", fields: [] },
    ],
  );
});

test("ManagedMessageService enforces Guild-unique names and immutable destinations", async () => {
  const { service, discordCalls } = createService();
  const first = await service.save(input());
  await service.save(input({ internalName: "announcements" }));

  await assert.rejects(
    service.save(input({ internalName: "RULES" })),
    /Internal name must be unique within this Guild/,
  );
  await assert.rejects(
    service.save(input({ id: first.id, channelId: "channel-2" })),
    /destination channel is not a text channel in this Guild|destination channel cannot change/,
  );
  assert.equal(discordCalls.length, 2);
});

test("ManagedMessageService repairs a Missing message only when Save is called", async () => {
  const existing: ManagedMessage = {
    id: "managed-1",
    guildId: "guild-1",
    internalName: "rules",
    channelId: "channel-1",
    messageId: "deleted-message",
    embeds: [embed()],
    announcement: announcement(),
    status: "missing",
    createdAtMs: 1,
    updatedAtMs: 1,
  };
  const { service, store, discordCalls } = createService({ messages: [existing] });

  const repaired = await service.save(input({ id: existing.id }));

  assert.equal(repaired.status, "published");
  assert.notEqual(repaired.messageId, existing.messageId);
  assert.deepEqual(
    discordCalls.map((call) => call.operation),
    ["create"],
  );
  assert.equal((await store.listByGuild("guild-1"))[0]?.status, "published");
});

test("ManagedMessageService suppresses notifications when repairing changed announcement targets", async () => {
  const existing: ManagedMessage = {
    id: "managed-1",
    guildId: "guild-1",
    internalName: "rules",
    channelId: "channel-1",
    messageId: "deleted-message",
    embeds: [embed()],
    announcement: announcement(),
    status: "missing",
    createdAtMs: 1,
    updatedAtMs: 1,
  };
  const { service, discordCalls } = createService({ messages: [existing] });

  await service.save(
    input({
      id: existing.id,
      announcement: announcement({ roleIds: ["role-1"], everyone: true, notifyOnCreate: true }),
    }),
  );

  assert.deepEqual(discordCalls[0]?.body, {
    content: "📣 <@&role-1> @everyone",
    embeds: [{ description: "Read these rules.", fields: [] }],
    components: [],
    allowed_mentions: { parse: [] },
  });
});

test("ManagedMessageService deletes an already-missing record without a Discord call", async () => {
  const existing: ManagedMessage = {
    id: "managed-1",
    guildId: "guild-1",
    internalName: "rules",
    channelId: "channel-1",
    messageId: "deleted-message",
    embeds: [embed()],
    announcement: announcement(),
    status: "missing",
    createdAtMs: 1,
    updatedAtMs: 1,
  };
  const { service, store, discordCalls } = createService({ messages: [existing] });

  assert.equal(await service.delete("guild-1", existing.id), true);
  assert.deepEqual(await store.listByGuild("guild-1"), []);
  assert.deepEqual(discordCalls, []);
});

test("ManagedMessageService treats Discord not-found as an idempotent delete without restoring the record", async () => {
  const existing: ManagedMessage = {
    id: "managed-1",
    guildId: "guild-1",
    internalName: "rules",
    channelId: "channel-1",
    messageId: "deleted-message",
    embeds: [embed()],
    announcement: announcement(),
    status: "published",
    createdAtMs: 1,
    updatedAtMs: 1,
  };
  const { service, store } = createService({
    messages: [existing],
    discord: {
      async delete() {
        throw new DiscordApiError("not found", 404, "Unknown Message");
      },
    },
  });

  assert.equal(await service.delete("guild-1", existing.id), true);
  assert.deepEqual(await store.listByGuild("guild-1"), []);
});

test("ManagedMessageService rejects destination channels and announcement roles outside the Guild", async () => {
  const { service, discordCalls } = createService();

  await assert.rejects(
    service.save(input({ channelId: "other-guild-channel" })),
    /destination channel is not a text channel in this Guild/,
  );
  await assert.rejects(
    service.save(input({ announcement: announcement({ roleIds: ["other-guild-role"] }) })),
    /announcement role is not in this Guild/,
  );
  assert.deepEqual(discordCalls, []);
});

test("ManagedMessageService allows premium Guilds to exceed the free-tier count", async () => {
  const messages = [0, 1, 2].map((index) => ({
    id: `managed-${index}`,
    guildId: "guild-1",
    internalName: `message-${index}`,
    channelId: "channel-1",
    messageId: `discord-${index}`,
    embeds: [embed()],
    announcement: announcement(),
    status: "published" as const,
    createdAtMs: index,
    updatedAtMs: index,
  }));
  const { service, store } = createService({ messages, entitlementTier: "premium" });

  await service.save(input({ internalName: "fourth" }));

  assert.equal(await store.countByGuild("guild-1"), 4);
});

test("ManagedMessageService removes a newly posted message when persistence fails", async () => {
  const { service, discordCalls } = createService({
    upsert: async () => {
      throw new Error("database unavailable");
    },
  });

  await assert.rejects(service.save(input()), /database unavailable/);
  assert.deepEqual(
    discordCalls.map((call) => call.operation),
    ["create", "delete"],
  );
});

test("ManagedMessageService rolls back the message row when media reference persistence fails", async () => {
  const media = createManagedMediaProbe();
  const { service, discordCalls, fixture } = createService({ managedMedia: media.store });
  await service.registerMediaAsset("guild-1", "00000000-0000-0000-0000-000000000001.png");
  fixture.database.execRaw(`
    CREATE TRIGGER fail_managed_message_media_ref_insert
    BEFORE INSERT ON managed_message_media_refs
    BEGIN
      SELECT RAISE(ABORT, 'media reference write failed');
    END
  `);

  await assert.rejects(
    service.save(
      input({ embeds: [{ description: "with image", imageUrl: managedMediaUrl, fields: [] }] }),
    ),
    /media reference write failed/,
  );

  assert.deepEqual(
    discordCalls.map((call) => call.operation),
    ["create", "delete"],
  );
  assert.deepEqual(await service.list("guild-1"), []);
  assert.deepEqual(fixture.database.query("SELECT * FROM managed_message_media_refs"), []);
  assert.deepEqual(media.deleted, []);
});

test("ManagedMessageService reports failed creation compensation without claiming success", async () => {
  const { service } = createService({
    upsert: async () => {
      throw new Error("database unavailable");
    },
    discord: {
      async delete() {
        throw new Error("Discord unavailable");
      },
    },
  });

  await assert.rejects(
    service.save(input()),
    /creation failed and Discord compensation also failed.*database unavailable.*Discord unavailable/,
  );
});

test("ManagedMessageService restores previous live content when update persistence fails", async () => {
  let shouldFail = false;
  const existing: ManagedMessage = {
    id: "managed-1",
    guildId: "guild-1",
    internalName: "rules",
    channelId: "channel-1",
    messageId: "discord-1",
    embeds: [embed({ description: "Original" })],
    announcement: announcement(),
    status: "published",
    createdAtMs: 1,
    updatedAtMs: 1,
  };
  const { service, discordCalls } = createService({
    messages: [existing],
    upsert: async () => {
      if (shouldFail) throw new Error("database unavailable");
    },
  });
  shouldFail = true;

  await assert.rejects(
    service.save(input({ id: existing.id, embeds: [embed({ description: "Changed" })] })),
    /database unavailable/,
  );
  assert.deepEqual(
    discordCalls.map((call) => call.operation),
    ["edit", "edit"],
  );
  const restoreCall = discordCalls[1];
  assert.ok(restoreCall);
  assert.equal(
    (restoreCall.body as { embeds: Array<{ description: string }> }).embeds[0]?.description,
    "Original",
  );
});

test("ManagedMessageService reports failed update compensation without claiming success", async () => {
  const existing: ManagedMessage = {
    id: "managed-1",
    guildId: "guild-1",
    internalName: "rules",
    channelId: "channel-1",
    messageId: "discord-1",
    embeds: [embed({ description: "Original" })],
    announcement: announcement(),
    status: "published",
    createdAtMs: 1,
    updatedAtMs: 1,
  };
  let editCalls = 0;
  const { service } = createService({
    messages: [existing],
    upsert: async () => {
      throw new Error("database unavailable");
    },
    discord: {
      async edit() {
        editCalls += 1;
        if (editCalls === 2) throw new Error("Discord unavailable");
      },
    },
  });

  await assert.rejects(
    service.save(input({ id: existing.id, embeds: [embed({ description: "Changed" })] })),
    /restoring the previous Discord content also failed.*database unavailable.*Discord unavailable/,
  );
});

test("ManagedMessageService emits every lifecycle audit event without copying embed content", async () => {
  const originalFetch = globalThis.fetch;
  const auditBodies: Array<{
    embeds: Array<{ title: string; fields: Array<{ name: string; value: string }> }>;
  }> = [];
  globalThis.fetch = async (_input, init) => {
    auditBodies.push(JSON.parse(String(init?.body)));
    return Response.json({ id: "audit-message" });
  };
  try {
    const { service, store, audit } = createService({ auditEnabled: true });
    const created = await service.save(input(), "actor-create");
    await service.save(
      input({ id: created.id, embeds: [embed({ description: "Updated" })] }),
      "actor-update",
    );
    await handleManagedMessageCanonicalDelete(
      { guildId: "guild-1", channelId: "channel-1", messageId: created.messageId },
      { store, guildAuditLog: audit, discordBotToken: "token" },
    );
    await service.save(input({ id: created.id }), "actor-repair");
    await service.delete("guild-1", created.id, "actor-delete");

    assert.deepEqual(
      auditBodies.map((body) => body.embeds[0]?.title),
      [
        "Managed Message Created",
        "Managed Message Updated",
        "Managed Message Deleted Outside HAF",
        "Managed Message Repaired",
        "Managed Message Deleted",
      ],
    );
    for (const body of auditBodies) {
      const fields = body.embeds[0]?.fields ?? [];
      assert.equal(fields.find((field) => field.name === "Internal Name")?.value, "rules");
      assert.equal(fields.find((field) => field.name === "Channel")?.value, "<#channel-1>");
      assert.match(fields.find((field) => field.name === "Message ID")?.value ?? "", /^discord-/);
    }
    for (const index of [0, 1, 3, 4]) {
      assert.ok(auditBodies[index]?.embeds[0]?.fields.some((field) => field.name === "Actor"));
    }
    assert.equal(
      auditBodies[2]?.embeds[0]?.fields.some((field) => field.name === "Actor"),
      false,
    );
    assert.doesNotMatch(JSON.stringify(auditBodies), /Read these rules\.|"value":"Updated"/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Managed Message Draft lifecycle audits meaningful actions but not routine saves", async () => {
  const originalFetch = globalThis.fetch;
  const titles: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { embeds: Array<{ title: string }> };
    titles.push(body.embeds[0]?.title ?? "");
    return Response.json({ id: "audit-message" });
  };
  try {
    const { service } = createService({ auditEnabled: true });
    const saved = await service.saveDraft(input());
    const scheduled = await service.scheduleDraft(
      { ...input(), id: saved.id },
      Date.now() + 60_000,
      "actor-schedule",
    );
    await service.scheduleDraft(
      { ...input(), id: scheduled.id },
      Date.now() + 120_000,
      "actor-reschedule",
    );
    await service.cancelScheduledDraft("guild-1", scheduled.id, "actor-cancel");
    await service.publishDraftNow("guild-1", scheduled.id, "actor-publish");
    const disposable = await service.saveDraft(input({ internalName: "disposable" }));
    await service.deleteDraft("guild-1", disposable.id, "actor-delete");

    assert.deepEqual(titles, [
      "Managed Message Scheduled",
      "Managed Message Rescheduled",
      "Managed Message Schedule Cancelled",
      "Managed Message Published",
      "Managed Message Draft Deleted",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ManagedMessageService enforces the free-tier limit while counting Missing records", async () => {
  const messages = [0, 1, 2].map((index) => ({
    id: `managed-${index}`,
    guildId: "guild-1",
    internalName: `message-${index}`,
    channelId: "channel-1",
    messageId: `discord-${index}`,
    embeds: [embed()],
    announcement: announcement(),
    status: index === 0 ? ("missing" as const) : ("published" as const),
    createdAtMs: index,
    updatedAtMs: index,
  }));
  const { service, discordCalls } = createService({ messages });

  await assert.rejects(service.save(input({ internalName: "fourth" })), /up to 3 combined/);
  assert.equal(discordCalls.length, 0);
});

test("validateManagedMessage enforces Discord embed boundaries", () => {
  assert.doesNotThrow(() => validateManagedMessage(input({ embeds: [embed()] })));
  assert.doesNotThrow(() =>
    validateManagedMessage(input({ embeds: Array.from({ length: 10 }, () => embed()) })),
  );
  assert.throws(
    () => validateManagedMessage(input({ embeds: Array.from({ length: 11 }, () => embed()) })),
    /between 1 and 10/,
  );
  assert.doesNotThrow(() =>
    validateManagedMessage(
      input({
        embeds: [
          embed({
            fields: Array.from({ length: 25 }, (_, index) => ({
              name: `field-${index}`,
              value: "v",
              inline: false,
            })),
          }),
        ],
      }),
    ),
  );
  assert.throws(
    () => validateManagedMessage(input({ embeds: [] })),
    (error: unknown) =>
      error instanceof ManagedMessageError && /between 1 and 10/.test(error.message),
  );
  assert.throws(
    () => validateManagedMessage(input({ embeds: [embed({ description: "x".repeat(4097) })] })),
    /description cannot exceed 4096/,
  );
  assert.throws(
    () =>
      validateManagedMessage(
        input({
          embeds: [
            embed({
              fields: Array.from({ length: 26 }, () => ({ name: "n", value: "v", inline: false })),
            }),
          ],
        }),
      ),
    /more than 25 fields/,
  );
  assert.throws(
    () =>
      validateManagedMessage(input({ embeds: [embed({ imageUrl: "ftp://example.com/image" })] })),
    /valid HTTP or HTTPS URL/,
  );
  assert.doesNotThrow(() =>
    validateManagedMessage(
      input({
        embeds: [
          embed({ description: "a".repeat(4096) }),
          embed({ description: "b".repeat(1904) }),
        ],
      }),
    ),
  );
  assert.throws(
    () =>
      validateManagedMessage(
        input({
          embeds: [
            embed({ description: "a".repeat(4096) }),
            embed({ description: "b".repeat(1905) }),
          ],
        }),
      ),
    /combined text.*6,000/i,
  );
});

test("validateManagedMessage enforces Discord link button boundaries", () => {
  assert.doesNotThrow(() =>
    validateManagedMessage(
      input({ buttons: [{ label: "Support", url: "https://example.com/support" }] }),
    ),
  );
  assert.throws(
    () =>
      validateManagedMessage(
        input({
          buttons: Array.from({ length: 6 }, () => ({ label: "Link", url: "https://example.com" })),
        }),
      ),
    /more than 5 link buttons/,
  );
  assert.throws(
    () =>
      validateManagedMessage(input({ buttons: [{ label: "Link", url: "javascript:alert(1)" }] })),
    /valid HTTP or HTTPS URL/,
  );
  assert.throws(
    () => validateManagedMessage(input({ buttons: [{ label: "", url: "https://example.com" }] })),
    /needs a label/,
  );
});

test("Unpublish retains content and media, ignores the intentional Gateway deletion, and can republish quietly", async () => {
  const { service, store, discordCalls } = createService();
  const published = await service.save(
    input({
      announcement: { roleIds: ["role-1"], everyone: false, here: false, notifyOnCreate: true },
    }),
  );
  const unpublished = await service.unpublish("guild-1", published.id);
  assert.equal(unpublished.status, "unpublished");
  assert.deepEqual(unpublished.embeds, JSON.parse(JSON.stringify(published.embeds)));
  assert.equal(await store.countByGuild("guild-1"), 1);
  assert.equal(
    await store.markMissingByCanonicalMessage("guild-1", published.channelId, published.messageId),
    null,
  );
  await service.unpublish("guild-1", published.id);
  assert.equal(discordCalls.filter((call) => call.operation === "delete").length, 1);
  const edited = await service.save(input({ id: published.id }));
  assert.equal(edited.status, "unpublished");
  assert.equal(discordCalls.filter((call) => call.operation === "create").length, 1);
  const restored = await service.save(input({ id: published.id }), undefined, true);
  assert.equal(restored.id, published.id);
  assert.equal(restored.status, "published");
  assert.notEqual(restored.messageId, published.messageId);
  const lastCreate = discordCalls.at(-1);
  assert.ok(lastCreate);
  assert.deepEqual((lastCreate.body as { allowed_mentions: unknown }).allowed_mentions, {
    parse: [],
  });
});

test("Unpublish retains a retryable removal phase when Discord removal fails", async () => {
  const { service } = createService({
    discord: {
      async delete() {
        throw new Error("Discord unavailable");
      },
    },
  });
  const published = await service.save(input());
  await assert.rejects(service.unpublish("guild-1", published.id), /Discord unavailable/);
  assert.equal((await service.get("guild-1", published.id))?.status, "unpublishing");
  assert.equal((await service.get("guild-1", published.id))?.messageId, published.messageId);
});

for (const boundary of ["before-discord", "after-discord"] as const) {
  for (const recovery of ["retry", "publish", "delete"] as const) {
    test(`Unpublish interrupted ${boundary} resumes safely through ${recovery}`, async () => {
      let rawStore!: ReturnType<typeof createProductionRuntimeStores>["stores"]["managedMessages"];
      let interrupted = false;
      const live = new Set<string>();
      const effects: string[] = [];
      let sequence = 0;
      const harness = createService({
        discord: {
          async create() {
            const id = `publication-${++sequence}`;
            effects.push(`create:${id}`);
            live.add(id);
            return { id };
          },
          async delete(_channelId, id) {
            effects.push(`delete:${id}`);
            if (!live.delete(id))
              throw new DiscordApiError("Unknown Message", 404, "Unknown Message");
          },
        },
        async upsert(message) {
          if (!interrupted && boundary === "after-discord" && message.status === "unpublished") {
            interrupted = true;
            throw new Error("Interrupted before completion checkpoint");
          }
          await rawStore.upsert(message);
          if (!interrupted && boundary === "before-discord" && message.status === "unpublishing") {
            interrupted = true;
            throw new Error("Interrupted after intent checkpoint");
          }
        },
      });
      rawStore = harness.fixture.stores.managedMessages;
      try {
        const published = await harness.service.save(input());
        await assert.rejects(harness.service.unpublish("guild-1", published.id), /Interrupted/);
        const pending = await rawStore.readById("guild-1", published.id);
        assert.equal(pending?.status, "unpublishing");
        assert.equal(pending?.messageId, published.messageId);
        assert.equal(live.has(published.messageId), boundary === "before-discord");
        assert.equal(
          await rawStore.markMissingByCanonicalMessage(
            "guild-1",
            published.channelId,
            published.messageId,
          ),
          null,
        );
        if (recovery === "retry") {
          assert.equal(
            (await harness.service.unpublish("guild-1", published.id)).status,
            "unpublished",
          );
          assert.equal(live.size, 0);
        } else if (recovery === "publish") {
          const replacement = await harness.service.save(
            input({ id: published.id }),
            undefined,
            true,
          );
          assert.deepEqual([...live], [replacement.messageId]);
          assert.notEqual(replacement.messageId, published.messageId);
          assert.ok(
            effects.indexOf(`delete:${published.messageId}`) <
              effects.indexOf(`create:${replacement.messageId}`),
          );
        } else {
          assert.equal(await harness.service.delete("guild-1", published.id), true);
          assert.equal(await rawStore.readById("guild-1", published.id), null);
          assert.equal(live.size, 0);
        }
      } finally {
        harness.fixture.close();
      }
    });
  }
}
