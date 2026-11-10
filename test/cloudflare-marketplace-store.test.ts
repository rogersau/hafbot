/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createCloudflareMarketplaceStore } from "../src/runtime/cloudflare-marketplace-store";
import type { MarketplaceBusinessLog, MarketplaceConfig, MarketplacePost } from "../src/types";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("createCloudflareMarketplaceStore upserts and reads Marketplace config", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareMarketplaceStore(database as unknown as D1Database);

  const initialConfig: MarketplaceConfig = {
    guildId: "guild-1",
    noticeChannelId: "notice-1",
    noticeMessageId: "notice-message-1",
    logChannelId: "log-1",
    noticeEmbed: {
      title: "Trade here",
      description: "Community listings",
      color: 0xff6600,
      buttonLabel: "Create listing",
      buttonEmoji: "🛒",
    },
    serverChoiceEnabled: false,
    serverOptions: [{ id: "namalsk", label: "Namalsk", emoji: null }],
    additionalChoicesEnabled: true,
    additionalChoices: [
      {
        id: "listing-type",
        label: "Listing type",
        options: [{ id: "vehicle", label: "Vehicle", emoji: "🚙" }],
      },
    ],
    flowUpdatedAtMs: 100,
    updatedAtMs: 100,
  };
  const updatedConfig: MarketplaceConfig = {
    ...initialConfig,
    noticeMessageId: "notice-message-2",
    serverOptions: [
      { id: "namalsk", label: "Namalsk", emoji: null },
      { id: "chernarus", label: "Chernarus", emoji: "🌲" },
    ],
    updatedAtMs: 200,
  };

  assert.equal(await store.readMarketplaceConfig("guild-1"), null);

  await store.upsertMarketplaceConfig(initialConfig);
  assert.deepEqual(await store.readMarketplaceConfig("guild-1"), initialConfig);

  await store.upsertMarketplaceConfig(updatedConfig);
  assert.deepEqual(await store.readMarketplaceConfig("guild-1"), updatedConfig);
  const refresh = {
    guildId: "guild-1",
    channelId: updatedConfig.noticeChannelId!,
    previousMessageId: updatedConfig.noticeMessageId,
    expectedUpdatedAtMs: updatedConfig.updatedAtMs,
    messageId: "refreshed-notice",
    updatedAtMs: 400,
  };
  assert.equal(await store.refreshMarketplaceNotice({ ...refresh, guildId: "missing" }), false);
  assert.equal(
    await store.refreshMarketplaceNotice({ ...refresh, channelId: "another-channel" }),
    false,
  );
  assert.equal(
    await store.refreshMarketplaceNotice({ ...refresh, previousMessageId: "another-message" }),
    false,
  );
  assert.equal(await store.refreshMarketplaceNotice({ ...refresh, expectedUpdatedAtMs: 0 }), false);
  assert.equal(await store.refreshMarketplaceNotice(refresh), true);
  assert.deepEqual(await store.readMarketplaceConfig("guild-1"), {
    ...updatedConfig,
    noticeMessageId: "refreshed-notice",
    updatedAtMs: 400,
  });
  assert.equal(await store.refreshMarketplaceNotice(refresh), false);
  // The null-channel disable transition wins even when the timestamp is unchanged.
  await store.upsertMarketplaceConfig({
    ...updatedConfig,
    noticeChannelId: null,
    noticeMessageId: null,
  });
  assert.equal(await store.refreshMarketplaceNotice(refresh), false);
  assert.equal((await store.readMarketplaceConfig("guild-1"))?.noticeChannelId, null);
  await store.upsertMarketplaceConfig({ ...updatedConfig, noticeMessageId: null });
  assert.equal(await store.refreshMarketplaceNotice({ ...refresh, previousMessageId: null }), true);
  assert.equal(database.execCalls, 0);
});

test("createCloudflareMarketplaceStore creates, lists, updates, and closes Marketplace Posts", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareMarketplaceStore(database as unknown as D1Database);
  const olderPost = createPost({ id: "post-1", ownerId: "owner-1", createdAtMs: 100 });
  const newerPost = createPost({
    id: "post-2",
    ownerId: "owner-2",
    tradeType: "want",
    createdAtMs: 200,
  });

  await store.createMarketplacePost(olderPost);
  await store.createMarketplacePost(newerPost);
  await store.updateMarketplacePostMessage({
    guildId: "guild-1",
    postId: "post-1",
    messageId: "message-1",
  });

  assert.deepEqual(await store.readMarketplacePost("guild-1", "post-1"), {
    ...olderPost,
    messageId: "message-1",
  });
  assert.deepEqual(await store.readActiveMarketplacePostByOwner("guild-1", "owner-1"), {
    ...olderPost,
    messageId: "message-1",
  });
  assert.deepEqual(await store.listMarketplacePosts("guild-1"), [
    newerPost,
    { ...olderPost, messageId: "message-1" },
  ]);

  const closed = await store.closeMarketplacePost({
    guildId: "guild-1",
    postId: "post-1",
    closedByUserId: "owner-1",
    closedAtMs: 300,
  });

  assert.deepEqual(closed, {
    ...olderPost,
    messageId: "message-1",
    active: false,
    closedAtMs: 300,
    closedByUserId: "owner-1",
  });
  assert.deepEqual(await store.readActiveMarketplacePostByOwner("guild-1", "owner-1"), null);
  assert.deepEqual(await store.listMarketplacePosts("guild-1", { activeOnly: true }), [newerPost]);
  await assert.rejects(
    () =>
      store.closeMarketplacePost({
        guildId: "guild-1",
        postId: "post-1",
        closedByUserId: "owner-1",
        closedAtMs: 400,
      }),
    /Marketplace post is already closed or missing/,
  );
  assert.equal(database.execCalls, 0);
});

test("createCloudflareMarketplaceStore creates and lists Marketplace trade logs", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareMarketplaceStore(database as unknown as D1Database);
  const olderLog = createLog({
    id: "log-1",
    timestampMs: 100,
    dmSent: false,
    dmError: "DM blocked",
  });
  const newerLog = createLog({ id: "log-2", timestampMs: 200, messageId: null });

  await store.createMarketplaceLog(olderLog);
  await store.createMarketplaceLog(newerLog);

  assert.deepEqual(await store.listMarketplaceLogs("guild-1"), [newerLog, olderLog]);
  assert.deepEqual(await store.listMarketplaceLogs("guild-1", 1), [newerLog]);
  assert.equal(database.execCalls, 0);
});

test("createCloudflareMarketplaceStore prunes old Marketplace trade logs per guild", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareMarketplaceStore(database as unknown as D1Database);
  const otherGuildLog = createLog({ guildId: "guild-2", id: "other-guild-log" });

  await store.createMarketplaceLog(otherGuildLog);
  for (let index = 1; index <= 1001; index += 1) {
    await store.createMarketplaceLog(createLog({ id: `guild-1-log-${index}`, timestampMs: index }));
  }

  const replacementForPrunedLog = createLog({
    id: "guild-1-log-1",
    timestampMs: 2000,
    messageId: "replacement-message",
  });
  await store.createMarketplaceLog(replacementForPrunedLog);

  assert.deepEqual(await store.listMarketplaceLogs("guild-1", 1), [replacementForPrunedLog]);
  assert.deepEqual(await store.listMarketplaceLogs("guild-2"), [otherGuildLog]);
  assert.equal(database.execCalls, 0);
});

function createPost(overrides: Partial<MarketplacePost> = {}): MarketplacePost {
  return {
    guildId: "guild-1",
    id: "post-1",
    ownerId: "owner-1",
    ownerDisplayName: "Owner",
    tradeType: "have",
    serverId: "namalsk",
    serverLabel: "Namalsk",
    additionalChoices: [
      {
        choiceId: "listing-type",
        choiceLabel: "Listing type",
        optionId: "vehicle",
        optionLabel: "Vehicle",
      },
    ],
    have: "M4A1",
    want: "NVGs",
    extra: "safe zone",
    channelId: "channel-1",
    messageId: null,
    active: true,
    createdAtMs: 100,
    closedAtMs: null,
    closedByUserId: null,
    ...overrides,
  };
}

function createLog(overrides: Partial<MarketplaceBusinessLog> = {}): MarketplaceBusinessLog {
  return {
    guildId: "guild-1",
    id: "log-1",
    timestampMs: 100,
    buyerId: "buyer-1",
    buyerDisplayName: "Buyer",
    sellerId: "owner-1",
    postId: "post-1",
    channelId: "channel-1",
    messageId: "message-1",
    tradeType: "have",
    serverLabel: "Namalsk",
    dmSent: true,
    dmError: null,
    have: "M4A1",
    want: "NVGs",
    ...overrides,
  };
}
