/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { GuildResourceValidationError } from "../src/discord/guild-resource-validator";
import { createDefaultMarketplaceConfig } from "../src/marketplace-config";
import { MarketplaceService } from "../src/services/marketplace-service";
import {
  createStaticGuildResourceValidator,
  testChannel,
} from "./helpers/guild-resource-validator";
import { createProductionRuntimeStores } from "./support/production-runtime-stores";

function createValidator() {
  return createStaticGuildResourceValidator({
    guilds: {
      "guild-1": { channels: [testChannel("own-text", 0, "guild-1")], roles: [] },
      "guild-2": { channels: [testChannel("foreign-text", 0, "guild-2")], roles: [] },
    },
  });
}

function createDiscordCounter() {
  let calls = 0;
  return {
    api: {
      async createChannelMessage(channelId: string) {
        calls += 1;
        return { id: "message-1", channel_id: channelId, content: "" };
      },
      async editChannelMessage(channelId: string, messageId: string) {
        calls += 1;
        return { id: messageId, channel_id: channelId, content: "" };
      },
      async deleteChannelMessage() {
        calls += 1;
      },
      async createUserDmMessage(userId: string) {
        calls += 1;
        return { id: "dm-1", channel_id: userId, content: "" };
      },
    },
    calls: () => calls,
  };
}

test("Marketplace disable preserves settings, blocks open forms and allows re-enabling", async () => {
  const fixture = createProductionRuntimeStores();
  const discord = createDiscordCounter();
  try {
    const previous = {
      ...createDefaultMarketplaceConfig("guild-1"),
      noticeChannelId: "own-text",
      noticeMessageId: "notice-1",
      serverChoiceEnabled: false,
    };
    await fixture.stores.marketplace.upsertMarketplaceConfig(previous);
    const service = new MarketplaceService(fixture.stores.marketplace, discord.api);
    const { config, noticeRemoved } = await service.disable("guild-1");
    assert.equal(noticeRemoved, true);
    assert.equal(discord.calls(), 1);
    assert.deepEqual(await service.getConfig("guild-1"), {
      ...previous,
      enabled: false,
      noticeMessageId: null,
      flowUpdatedAtMs: config.flowUpdatedAtMs,
      updatedAtMs: config.updatedAtMs,
    });
    const input = {
      guildId: "guild-1",
      channelId: "own-text",
      ownerId: "owner-1",
      ownerDisplayName: "Owner",
      tradeType: "have" as const,
      serverId: "",
      have: "Sword",
      want: "Shield",
      extra: "",
    };
    await assert.rejects(service.createPost(input), /Marketplace is disabled/);
    assert.equal(discord.calls(), 1);
    assert.deepEqual(await service.listPosts("guild-1"), []);
    await service.disable("guild-1");
    assert.equal(discord.calls(), 1);
    await service.updateConfig(config);
    await assert.rejects(service.createPost(input), /Marketplace is disabled/);
    await service.setupNotice("guild-1", "own-text");
    const post = await service.createPost(input);
    await service.disable("guild-1");
    assert.equal((await service.listPosts("guild-1"))[0]?.active, true);
    await service.closePost({ guildId: "guild-1", postId: post.id, closedByUserId: "owner-1" });
    assert.equal((await service.listPosts("guild-1"))[0]?.active, false);
  } finally {
    fixture.close();
  }
});

test("Marketplace stays disabled when noticeboard cleanup fails", async () => {
  const fixture = createProductionRuntimeStores();
  try {
    await fixture.stores.marketplace.upsertMarketplaceConfig({
      ...createDefaultMarketplaceConfig("guild-1"),
      noticeChannelId: "own-text",
      noticeMessageId: "notice-1",
    });
    const service = new MarketplaceService(fixture.stores.marketplace, {
      ...createDiscordCounter().api,
      async deleteChannelMessage() {
        throw new Error("Missing permissions");
      },
    });
    assert.equal((await service.disable("guild-1")).noticeRemoved, false);
    assert.equal((await service.getConfig("guild-1")).noticeChannelId, "own-text");
    assert.equal((await service.getConfig("guild-1")).enabled, false);
  } finally {
    fixture.close();
  }
});

test("a Marketplace post already publishing when disabled does not recreate the noticeboard", async () => {
  const fixture = createProductionRuntimeStores();
  try {
    await fixture.stores.marketplace.upsertMarketplaceConfig({
      ...createDefaultMarketplaceConfig("guild-1"),
      noticeChannelId: "own-text",
      serverChoiceEnabled: false,
    });
    let createdMessages = 0;
    const service = new MarketplaceService(fixture.stores.marketplace, {
      ...createDiscordCounter().api,
      async createChannelMessage(channelId) {
        createdMessages += 1;
        await service.disable("guild-1");
        return { id: "post-message", channel_id: channelId, content: "" };
      },
    });
    await service.createPost({
      guildId: "guild-1",
      channelId: "own-text",
      ownerId: "owner-1",
      ownerDisplayName: "Owner",
      tradeType: "have",
      serverId: "",
      have: "Sword",
      want: "Shield",
      extra: "",
    });
    assert.equal(createdMessages, 1);
    assert.equal((await service.getConfig("guild-1")).noticeChannelId, "own-text");
    assert.equal((await service.getConfig("guild-1")).enabled, false);
  } finally {
    fixture.close();
  }
});

test("MarketplaceService rejects foreign configuration resources before persistence", async () => {
  const fixture = createProductionRuntimeStores();
  const discord = createDiscordCounter();
  try {
    const service = new MarketplaceService(
      fixture.stores.marketplace,
      discord.api,
      undefined,
      createValidator(),
    );
    const config = {
      ...createDefaultMarketplaceConfig("guild-1"),
      noticeChannelId: "foreign-text",
    };

    await assert.rejects(service.updateConfig(config), GuildResourceValidationError);
    assert.equal(await fixture.stores.marketplace.readMarketplaceConfig("guild-1"), null);
    assert.equal(discord.calls(), 0);
  } finally {
    fixture.close();
  }
});

test("MarketplaceService rejects a foreign publish channel before Discord or persistence", async () => {
  const fixture = createProductionRuntimeStores();
  const discord = createDiscordCounter();
  try {
    const service = new MarketplaceService(
      fixture.stores.marketplace,
      discord.api,
      undefined,
      createValidator(),
    );

    await assert.rejects(
      service.setupNotice("guild-1", "foreign-text"),
      GuildResourceValidationError,
    );
    assert.equal(await fixture.stores.marketplace.readMarketplaceConfig("guild-1"), null);
    assert.equal(discord.calls(), 0);
  } finally {
    fixture.close();
  }
});

test("MarketplaceService rejects a stale persisted channel before close persistence", async () => {
  const fixture = createProductionRuntimeStores();
  const discord = createDiscordCounter();
  const post = {
    guildId: "guild-1",
    id: "post-1",
    ownerId: "owner-1",
    ownerDisplayName: "Owner",
    tradeType: "have" as const,
    serverId: "server-1",
    serverLabel: "Server",
    additionalChoices: [],
    have: "Item",
    want: "Credits",
    extra: "",
    channelId: "foreign-text",
    messageId: "message-1",
    active: true,
    createdAtMs: 1,
    closedAtMs: null,
    closedByUserId: null,
  };
  try {
    await fixture.stores.marketplace.createMarketplacePost(post);
    const service = new MarketplaceService(
      fixture.stores.marketplace,
      discord.api,
      undefined,
      createValidator(),
    );

    await assert.rejects(
      service.closePost({ guildId: "guild-1", postId: post.id, closedByUserId: "owner-1" }),
      GuildResourceValidationError,
    );
    assert.deepEqual(
      await fixture.stores.marketplace.readMarketplacePost("guild-1", post.id),
      post,
    );
    assert.equal(discord.calls(), 0);
  } finally {
    fixture.close();
  }
});
