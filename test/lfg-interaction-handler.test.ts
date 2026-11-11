import assert from "node:assert/strict";
import test from "node:test";

import { DiscordApiError } from "../src/discord/client";
import type { DiscordInteraction } from "../src/runtime/app-types";
import { handleInteractionRequest } from "../src/runtime/interaction-handler";
import {
  createComponentIdSigner,
  type ComponentIdSigner,
} from "../src/security/component-id-signer";
import { verifySensitiveComponentId } from "../src/security/sensitive-component-ids";
import {
  handleLfgComponentInteraction,
  handleLfgModalSubmitInteraction,
} from "../src/runtime/lfg-interaction-handler";
import { LfgService, type LfgDiscordApi } from "../src/services/lfg-service";
import type { LfgPost } from "../src/types";
import { createProductionRuntimeStores } from "./support/production-runtime-stores";
import { interactionServices } from "./support/handler-services";

async function configuredFixture() {
  const fixture = createProductionRuntimeStores();
  await fixture.stores.lfg.upsertLfgConfig({
    ...(await new LfgService(fixture.stores.lfg, createDiscord()).getConfig("guild-1")),
    noticeChannelId: "noticeboard",
  });
  return fixture;
}

function interaction(customId: string, type = 3): DiscordInteraction {
  return {
    type,
    guild_id: "guild-1",
    channel_id: "noticeboard",
    member: { user: { id: "owner-1", username: "Owner" } },
    data: { custom_id: customId },
  };
}

function createDiscord(): LfgDiscordApi {
  return {
    async createChannelMessage(channelId) {
      return { id: "published-message", channel_id: channelId, content: "" };
    },
    async editChannelMessage(channelId, messageId) {
      return { id: messageId, channel_id: channelId, content: "" };
    },
    async deleteChannelMessage() {},
    async createUserDmMessage() {
      return { id: "dm-message", channel_id: "dm-channel", content: "" };
    },
    async addGuildMemberRole() {},
    async removeGuildMemberRole() {},
    async modifyChannel() {},
  };
}

function activePost(overrides: Partial<LfgPost> = {}): LfgPost {
  return {
    guildId: "guild-1",
    id: "existing-post",
    ownerId: "owner-1",
    ownerDisplayName: "Owner",
    serverId: "dayz",
    serverLabel: "DayZ",
    whenPlay: "Tonight",
    lookingFor: "Squad",
    extraInfo: "",
    channelId: "post-channel",
    messageId: "post-message",
    active: true,
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
    reminderSentAtMs: null,
    renewedAtMs: null,
    renewalsCount: 0,
    closedAtMs: null,
    closedByUserId: null,
    ...overrides,
  };
}

for (const scope of ["public", "clan"] as const) {
  test(`LFG ${scope} active-post blocker links to the existing post's channel`, async (t) => {
    const fixture = await configuredFixture();
    try {
      const channelId = scope === "clan" ? "private-clan-text" : "post-channel";
      await fixture.stores.lfg.createLfgPost(activePost({ channelId, scope }));
      const fetch = t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
        assert.equal(
          String(input),
          `https://discord.com/api/v10/channels/${channelId}/messages/post-message`,
        );
        return Response.json({ id: "post-message", channel_id: channelId });
      });
      const response = await handleLfgComponentInteraction(
        interaction(scope === "clan" ? "lfg:create-clan" : "lfg:create"),
        fixture.stores,
        "token",
        new LfgService(fixture.stores.lfg, createDiscord()),
      );
      assert.deepEqual(await response.json(), {
        type: 4,
        data: {
          flags: 64,
          content:
            "You already have an active LFG post. Please close it before creating another." +
            `\n\n[View post](https://discord.com/channels/guild-1/${channelId}/post-message)`,
        },
      });
      assert.equal(fetch.mock.callCount(), 1);
    } finally {
      fixture.close();
    }
  });

  test(`LFG ${scope} creation links to the published post`, async () => {
    const fixture = await configuredFixture();
    try {
      const service = new LfgService(fixture.stores.lfg, createDiscord(), undefined, {
        async readMembership() {
          return { clanId: "clan-1", rank: "member" };
        },
        async readClan() {
          return {
            id: "clan-1",
            tag: "CLAN",
            lifecycleState: "active",
            textChannelId: "private-clan-text",
            voiceChannelId: "private-clan-voice",
            clanLfgLeadershipOnly: false,
          };
        },
        async isPublicAttributionEnabled() {
          return false;
        },
      });
      await fixture.stores.lfg.upsertLfgConfig({
        ...(await service.getConfig("guild-1")),
        serverOptions: [{ id: "dayz", label: "DayZ", emoji: null }],
      });

      const response = await handleLfgModalSubmitInteraction(
        interaction(scope === "clan" ? "lfg:modal-clan:dayz" : "lfg:modal:dayz", 5),
        fixture.stores,
        service,
      );
      const post = await fixture.stores.lfg.readActiveLfgPostByOwner("guild-1", "owner-1");
      assert.equal(post?.channelId, scope === "clan" ? "private-clan-text" : "noticeboard");
      assert.equal(post?.messageId, "published-message");
      assert.deepEqual(await response.json(), {
        type: 4,
        data: {
          flags: 64,
          content:
            "LFG post created." +
            `\n\n[View post](https://discord.com/channels/guild-1/${post!.channelId}/published-message)`,
        },
      });
    } finally {
      fixture.close();
    }
  });
}

for (const missing of [{ messageId: null }, { channelId: "" }]) {
  test(`LFG active-post blocker omits the link when ${Object.keys(missing)[0]} is missing`, async (t) => {
    const fixture = await configuredFixture();
    try {
      await fixture.stores.lfg.createLfgPost(activePost(missing));
      const fetch = t.mock.method(globalThis, "fetch", async () =>
        assert.fail("missing targets must not be fetched"),
      );
      const response = await handleLfgComponentInteraction(
        interaction("lfg:create"),
        fixture.stores,
        "token",
        new LfgService(fixture.stores.lfg, createDiscord()),
      );
      assert.deepEqual(await response.json(), {
        type: 4,
        data: {
          flags: 64,
          content: "You already have an active LFG post. Please close it before creating another.",
        },
      });
      assert.equal(fetch.mock.callCount(), 0);
    } finally {
      fixture.close();
    }
  });
}

for (const status of [404, 403, 500]) {
  test(`LFG active-post blocker omits the link when Discord returns ${status}`, async (t) => {
    const fixture = await configuredFixture();
    try {
      await fixture.stores.lfg.createLfgPost(activePost());
      t.mock.method(globalThis, "fetch", async () =>
        Response.json({ message: "Unavailable" }, { status }),
      );
      const response = await handleLfgComponentInteraction(
        interaction("lfg:create"),
        fixture.stores,
        "token",
        new LfgService(fixture.stores.lfg, createDiscord()),
      );
      assert.deepEqual(await response.json(), {
        type: 4,
        data: {
          flags: 64,
          content: "You already have an active LFG post. Please close it before creating another.",
        },
      });
    } finally {
      fixture.close();
    }
  });
}

test("LFG creation does not link to a closed or deleted post", async () => {
  const fixture = await configuredFixture();
  try {
    await fixture.stores.lfg.createLfgPost(activePost({ active: false, messageId: null }));
    const service = new LfgService(fixture.stores.lfg, createDiscord());
    const response = await handleLfgComponentInteraction(
      interaction("lfg:create"),
      fixture.stores,
      "token",
      service,
    );
    const body = (await response.json()) as { data: { content: string } };
    assert.doesNotMatch(body.data.content, /View post|already have an active/);
  } finally {
    fixture.close();
  }
});

test("LFG active-post lookup preserves Discord rate-limit handling", async (t) => {
  const fixture = await configuredFixture();
  try {
    await fixture.stores.lfg.createLfgPost(activePost());
    t.mock.method(globalThis, "fetch", async () =>
      Response.json({ retry_after: 60 }, { status: 429 }),
    );
    await assert.rejects(
      handleLfgComponentInteraction(
        interaction("lfg:create"),
        fixture.stores,
        "token",
        new LfgService(fixture.stores.lfg, createDiscord()),
      ),
      (error: unknown) => error instanceof DiscordApiError && error.status === 429,
    );
  } finally {
    fixture.close();
  }
});

interface CloseResponse {
  type: number;
  data: {
    flags?: number;
    content: string;
    components?: Array<{ components: Array<{ custom_id: string; label: string }> }>;
  };
}

async function closeFixture(postOverrides: Partial<LfgPost> = {}, signer?: ComponentIdSigner) {
  const fixture = await configuredFixture();
  const deletedChannels: string[] = [];
  const editedMessages: string[] = [];
  const post = activePost(postOverrides);
  await fixture.stores.lfg.createLfgPost(post);
  if (post.scope !== "clan") {
    await fixture.stores.lfg.upsertLfgVoiceChannel({
      guildId: post.guildId,
      postId: post.id,
      channelId: "temporary-voice",
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    });
  }
  const discord = createDiscord();
  discord.deleteChannel = async (channelId) => {
    deletedChannels.push(channelId);
  };
  discord.editChannelMessage = async (channelId, messageId) => {
    editedMessages.push(messageId);
    return { id: messageId, channel_id: channelId, content: "" };
  };
  const service = new LfgService(fixture.stores.lfg, discord);
  const componentIdSigner =
    signer ?? createComponentIdSigner({ currentSecret: "lfg-test-component-signing-secret-32" });
  async function dispatch(
    customId: string,
    overrides: Partial<DiscordInteraction> = {},
  ): Promise<CloseResponse> {
    const response = await handleInteractionRequest(
      new Request("https://example.com/interactions", {
        method: "POST",
        headers: {
          "x-signature-ed25519": "test",
          "x-signature-timestamp": String(Math.floor(Date.now() / 1000)),
        },
        body: JSON.stringify({ ...interaction(customId), ...overrides }),
      }),
      {
        discordPublicKey: "test",
        discordBotToken: "token",
        stores: fixture.stores,
        gateway: { async start() {}, async status() {} },
        verifyDiscordRequest: async () => true,
        services: interactionServices({ lfgService: service }),
        componentIdSigner,
      },
    );
    assert.equal(response.status, 200);
    return response.json() as Promise<CloseResponse>;
  }
  return { ...fixture, post, dispatch, componentIdSigner, deletedChannels, editedMessages };
}

function closeButton(body: CloseResponse, label: string) {
  const button = body.data.components
    ?.flatMap((row) => row.components)
    .find((button) => button.label === label);
  assert.ok(button, `${label} control exists`);
  return button.custom_id;
}

test("LFG Close asks privately, routes signed confirmation, and deletes the temporary voice channel only once", async () => {
  const fixture = await closeFixture();
  try {
    const prompt = await fixture.dispatch(`lfg:close:${fixture.post.id}`);
    assert.equal(prompt.type, 4);
    assert.equal(prompt.data.flags, 64);
    assert.match(prompt.data.content, /temporary private voice room.*deleted, disconnecting/);
    assert.match(prompt.data.content, /Cancel/);
    assert.equal((await fixture.stores.lfg.readLfgPost("guild-1", fixture.post.id))?.active, true);
    assert.deepEqual(fixture.deletedChannels, []);
    assert.deepEqual(fixture.editedMessages, []);
    const confirm = closeButton(prompt, "Close post");
    const cancel = closeButton(prompt, "Cancel");
    for (const [customId, purpose] of [
      [confirm, "lfg-close-confirm"],
      [cancel, "lfg-close-cancel"],
    ]) {
      assert.ok(customId.length <= 100);
      const verification = await verifySensitiveComponentId(customId, fixture.componentIdSigner, {
        interactionGuildId: "guild-1",
        actorUserId: "owner-1",
      });
      assert.equal(verification.kind, "valid");
      assert.ok("purpose" in verification && verification.purpose === purpose);
    }
    const result = await fixture.dispatch(confirm);
    assert.deepEqual(result, { type: 7, data: { content: "LFG post closed.", components: [] } });
    const closed = await fixture.stores.lfg.readLfgPost("guild-1", fixture.post.id);
    assert.equal(closed?.active, false);
    assert.equal(closed?.closedByUserId, "owner-1");
    assert.deepEqual(fixture.deletedChannels, ["temporary-voice"]);
    assert.deepEqual(fixture.editedMessages, ["post-message"]);
    assert.equal(await fixture.stores.lfg.readLfgVoiceChannel("guild-1", fixture.post.id), null);
    assert.match((await fixture.dispatch(confirm)).data.content, /already closed/);
    assert.deepEqual(fixture.deletedChannels, ["temporary-voice"]);
  } finally {
    fixture.close();
  }
});

test("LFG Cancel dismisses the private prompt without closing the post or deleting its voice channel", async () => {
  const fixture = await closeFixture();
  try {
    const prompt = await fixture.dispatch(`lfg:close:${fixture.post.id}`);
    const result = await fixture.dispatch(closeButton(prompt, "Cancel"));
    assert.deepEqual(result, {
      type: 7,
      data: { content: "Cancelled. The LFG post is still open.", components: [] },
    });
    assert.equal((await fixture.stores.lfg.readLfgPost("guild-1", fixture.post.id))?.active, true);
    assert.ok(await fixture.stores.lfg.readLfgVoiceChannel("guild-1", fixture.post.id));
    assert.deepEqual(fixture.deletedChannels, []);
    assert.deepEqual(fixture.editedMessages, []);
  } finally {
    fixture.close();
  }
});

test("LFG close confirmation rejects another actor, another Guild, tampering, and unsigned controls", async () => {
  const fixture = await closeFixture();
  try {
    const outsider = { member: { permissions: "0", user: { id: "outsider" } } };
    assert.match(
      (await fixture.dispatch(`lfg:close:${fixture.post.id}`, outsider)).data.content,
      /Only the original poster or admins/,
    );
    const prompt = await fixture.dispatch(`lfg:close:${fixture.post.id}`);
    for (const label of ["Close post", "Cancel"]) {
      const signed = closeButton(prompt, label);
      assert.match((await fixture.dispatch(signed, outsider)).data.content, /no longer available/);
      assert.match(
        (await fixture.dispatch(signed, { guild_id: "other-guild" })).data.content,
        /no longer available/,
      );
      const tampered = signed.slice(0, -1) + (signed.endsWith("a") ? "b" : "a");
      assert.match((await fixture.dispatch(tampered)).data.content, /no longer available/);
    }
    for (const action of ["close-confirm", "close-cancel"]) {
      assert.match(
        (await fixture.dispatch(`lfg:${action}:${fixture.post.id}`)).data.content,
        /no longer available/,
      );
    }
    assert.equal((await fixture.stores.lfg.readLfgPost("guild-1", fixture.post.id))?.active, true);
    assert.deepEqual(fixture.deletedChannels, []);
  } finally {
    fixture.close();
  }
});

test("LFG confirmation rechecks the current owner before closing", async (t) => {
  const fixture = await closeFixture();
  try {
    const prompt = await fixture.dispatch(`lfg:close:${fixture.post.id}`);
    // Ownership has no public mutation API; change the read boundary after issuing the prompt.
    t.mock.method(fixture.stores.lfg, "readLfgPost", async () => ({
      ...fixture.post,
      ownerId: "another-owner",
    }));
    const denied = await fixture.dispatch(closeButton(prompt, "Close post"));
    assert.match(denied.data.content, /Only the original poster or admins/);
    assert.deepEqual(fixture.deletedChannels, []);
    assert.deepEqual(fixture.editedMessages, []);
  } finally {
    fixture.close();
  }
});

test("LFG confirmation rechecks current staff permission before closing", async () => {
  const fixture = await closeFixture();
  try {
    const staff = { member: { permissions: "8192", user: { id: "staff-1" } } };
    const prompt = await fixture.dispatch(`lfg:close:${fixture.post.id}`, staff);
    const denied = await fixture.dispatch(closeButton(prompt, "Close post"), {
      member: { permissions: "0", user: { id: "staff-1" } },
    });
    assert.match(denied.data.content, /Only the original poster or admins/);
    assert.deepEqual(fixture.deletedChannels, []);
    assert.equal((await fixture.stores.lfg.readLfgPost("guild-1", fixture.post.id))?.active, true);
    const confirmed = await fixture.dispatch(closeButton(prompt, "Close post"), staff);
    assert.equal(confirmed.type, 7);
    assert.deepEqual(fixture.deletedChannels, ["temporary-voice"]);
  } finally {
    fixture.close();
  }
});

test("LFG confirmation rechecks active state and does not delete voice resources for a stale click", async () => {
  const fixture = await closeFixture();
  try {
    const prompt = await fixture.dispatch(`lfg:close:${fixture.post.id}`);
    await fixture.stores.lfg.closeLfgPost({
      guildId: "guild-1",
      postId: fixture.post.id,
      closedByUserId: "another-action",
      closedAtMs: Date.now(),
    });
    for (const label of ["Close post", "Cancel"]) {
      assert.match(
        (await fixture.dispatch(closeButton(prompt, label))).data.content,
        /already closed/,
      );
    }
    assert.ok(await fixture.stores.lfg.readLfgVoiceChannel("guild-1", fixture.post.id));
    assert.deepEqual(fixture.deletedChannels, []);
    assert.deepEqual(fixture.editedMessages, []);
  } finally {
    fixture.close();
  }
});

test("LFG confirmation expires without deleting the temporary voice channel", async () => {
  let now = Date.now();
  const signer = createComponentIdSigner(
    { currentSecret: "lfg-test-component-signing-secret-32" },
    { now: () => now },
  );
  const fixture = await closeFixture({}, signer);
  try {
    const prompt = await fixture.dispatch(`lfg:close:${fixture.post.id}`);
    now += 11 * 60 * 1000;
    assert.match(
      (await fixture.dispatch(closeButton(prompt, "Close post"))).data.content,
      /no longer available/,
    );
    assert.equal((await fixture.stores.lfg.readLfgPost("guild-1", fixture.post.id))?.active, true);
    assert.deepEqual(fixture.deletedChannels, []);
  } finally {
    fixture.close();
  }
});

test("Clan-only LFG confirmation preserves the Clan's persistent private voice channel", async () => {
  const fixture = await closeFixture({
    scope: "clan",
    clanId: "clan-1",
    persistentVoiceChannelId: "clan-voice",
  });
  try {
    const prompt = await fixture.dispatch(`lfg:close:${fixture.post.id}`);
    assert.match(prompt.data.content, /Clan's persistent private voice room will stay available/);
    assert.doesNotMatch(prompt.data.content, /will be deleted/);
    const result = await fixture.dispatch(closeButton(prompt, "Close post"));
    assert.equal(result.type, 7);
    const post = await fixture.stores.lfg.readLfgPost("guild-1", fixture.post.id);
    assert.equal(post?.active, false);
    assert.equal(post?.persistentVoiceChannelId, "clan-voice");
    assert.deepEqual(fixture.deletedChannels, []);
  } finally {
    fixture.close();
  }
});

test("disabled LFG rejects stale creation buttons and modal submissions", async () => {
  const fixture = await configuredFixture();
  try {
    const service = new LfgService(fixture.stores.lfg, createDiscord());
    await service.disable("guild-1");
    for (const id of [
      "lfg:create",
      "lfg:create-clan",
      "lfg:server:dayz",
      "lfg:server-clan:dayz",
      "lfg:toggle-alerts",
    ]) {
      const response = await handleLfgComponentInteraction(
        interaction(id),
        fixture.stores,
        "token",
        service,
      );
      assert.equal(
        ((await response.json()) as CloseResponse).data.content,
        "LFG is disabled in this server.",
      );
    }
    for (const id of ["lfg:modal:dayz", "lfg:modal-clan:dayz"]) {
      const response = await handleLfgModalSubmitInteraction(
        interaction(id, 5),
        fixture.stores,
        service,
      );
      assert.equal(
        ((await response.json()) as CloseResponse).data.content,
        "LFG is disabled in this server.",
      );
    }
    assert.deepEqual(await fixture.stores.lfg.listLfgPosts("guild-1"), []);
  } finally {
    fixture.close();
  }
});
