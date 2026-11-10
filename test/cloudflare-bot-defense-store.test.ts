/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createCloudflareBotDefenseStore } from "../src/runtime/cloudflare-bot-defense-store";
import type { BotDefenseConfig } from "../src/types";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("createCloudflareBotDefenseStore reads, writes, updates, and deletes config", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareBotDefenseStore(database as unknown as D1Database);

  const defaultConfig = await store.readConfig("guild-1");
  assert.equal(defaultConfig?.guildId, "guild-1");
  assert.equal(defaultConfig?.honeypotEnabled, false);
  assert.equal(defaultConfig?.honeypotWarnUser, false);
  assert.equal(defaultConfig?.honeypotDeleteMessage, false);
  assert.equal(defaultConfig?.rateEnabled, false);
  assert.equal(defaultConfig?.rateWarnUser, false);
  assert.equal(defaultConfig?.rateDeleteMessage, false);
  assert.equal(defaultConfig?.rateChannelThreshold, 5);
  assert.equal(defaultConfig?.rateWindowSeconds, 60);

  const config: BotDefenseConfig = {
    guildId: "guild-1",
    honeypotEnabled: true,
    honeypotWarnUser: true,
    honeypotDeleteMessage: true,
    rateEnabled: true,
    rateWarnUser: false,
    rateDeleteMessage: true,
    honeypotChannelIds: ["channel-1"],
    rateChannelThreshold: 10,
    rateWindowSeconds: 120,
    excludedRoleIds: ["role-1"],
    modRoleIds: ["mod-role-1"],
    modQueueChannelId: "queue-channel-1",
    pingOnQueuePost: false,
    createdAtMs: 100,
    updatedAtMs: 100,
  };

  await store.upsertConfig(config);
  assert.deepEqual(await store.readConfig("guild-1"), config);

  await assert.rejects(
    store.upsertConfig({
      ...config,
      honeypotChannelIds: Array.from({ length: 11 }, (_, index) => `channel-${index + 1}`),
    }),
    /no more than 10 honeypot channels/i,
  );
  assert.deepEqual(await store.readConfig("guild-1"), config);

  const updated: BotDefenseConfig = { ...config, honeypotEnabled: false, updatedAtMs: 200 };
  await store.upsertConfig(updated);
  assert.deepEqual(await store.readConfig("guild-1"), updated);

  await store.deleteConfig("guild-1");
  const afterDelete = await store.readConfig("guild-1");
  assert.equal(afterDelete?.guildId, "guild-1");
  assert.equal(afterDelete?.honeypotEnabled, false);
  assert.equal(database.execCalls, 0);
});

test("createCloudflareBotDefenseStore returns the same instance per database", async () => {
  const database = new SqliteD1Database();
  const first = createCloudflareBotDefenseStore(database as unknown as D1Database);
  const second = createCloudflareBotDefenseStore(database as unknown as D1Database);
  assert.strictEqual(first, second);
});

test("openBotFlag inserts only when no open flag and member is not confirmed", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareBotDefenseStore(database as unknown as D1Database);

  const evidence = { kind: "honeypot" as const, channelId: "channel-1", messageId: "msg-1" };
  const first = await store.openBotFlag("guild-1", "user-1", "honeypot", evidence);
  assert.ok(first);
  assert.equal(first?.status, "open");
  assert.equal(first?.queueMessageId, null);

  const second = await store.openBotFlag("guild-1", "user-1", "rate", {
    kind: "rate" as const,
    channelIds: ["channel-2"],
    channelCount: 5,
    windowSeconds: 60,
  });
  assert.equal(second, null);

  await store.resolveBotFlag("guild-1", "user-1", first!.createdAtMs, "confirmed", "moderator-1");
  const confirmed = await store.readOpenBotFlag("guild-1", "user-1");
  assert.equal(confirmed, null);
  assert.equal(await store.isConfirmedMember("guild-1", "user-1"), true);

  const reflag = await store.openBotFlag("guild-1", "user-1", "honeypot", evidence);
  assert.equal(reflag, null);
});

test("resolveBotFlag allows exactly one concurrent resolution to win", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareBotDefenseStore(database as unknown as D1Database);

  const opened = await store.openBotFlag("guild-1", "user-1", "honeypot", {
    kind: "honeypot",
    channelId: "channel-1",
    messageId: "msg-1",
  });
  assert.ok(opened);

  const results = await Promise.all([
    store.resolveBotFlag("guild-1", "user-1", opened.createdAtMs, "confirmed", "moderator-confirm"),
    store.resolveBotFlag("guild-1", "user-1", opened.createdAtMs, "dismissed", "moderator-dismiss"),
  ]);
  const winners = results.filter((result) => result !== null);

  assert.equal(winners.length, 1);
  assert.equal(results.filter((result) => result === null).length, 1);
  assert.ok(winners[0]);

  const [row] = database.query<{
    status: string;
    resolvedByDiscordUserId: string | null;
  }>(
    "SELECT status, resolved_by_discord_user_id AS resolvedByDiscordUserId FROM bot_flags WHERE guild_id = ? AND user_id = ?",
    "guild-1",
    "user-1",
  );
  assert.equal(row?.status, winners[0].status);
  assert.equal(row?.resolvedByDiscordUserId, winners[0].resolvedByDiscordUserId);
});

test("dismissed members can be re-flagged", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareBotDefenseStore(database as unknown as D1Database);

  const evidence = { kind: "honeypot" as const, channelId: "channel-1", messageId: "msg-1" };
  const first = await store.openBotFlag("guild-1", "user-1", "honeypot", evidence);
  assert.ok(first);
  await store.resolveBotFlag("guild-1", "user-1", first!.createdAtMs, "dismissed", "moderator-1");

  const second = await store.openBotFlag("guild-1", "user-1", "rate", {
    kind: "rate" as const,
    channelIds: ["channel-2"],
    channelCount: 5,
    windowSeconds: 60,
  });
  assert.ok(second);
  assert.equal(second?.detectorType, "rate");
  assert.ok(second.createdAtMs > first!.createdAtMs);
});

test("concurrent first trips and dismissed re-trips each have exactly one flag opener", async (t) => {
  const database = new SqliteD1Database();
  t.after(() => database.close());
  const store = createCloudflareBotDefenseStore(database as unknown as D1Database);
  const evidence = {
    kind: "rate" as const,
    channelIds: ["a", "b"],
    channelCount: 2,
    windowSeconds: 60,
    matchKind: "image-attachments" as const,
    attachmentCount: 4,
  };
  for (let generation = 0; generation < 2; generation += 1) {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => store.openBotFlag("guild", "user", "rate", evidence)),
    );
    const winners = results.filter((result) => result !== null);
    assert.equal(winners.length, 1);
    assert.deepEqual((await store.readOpenBotFlag("guild", "user"))?.evidence, evidence);
    await store.resolveBotFlag("guild", "user", winners[0].createdAtMs, "dismissed", "moderator");
  }
});

test("rate window ignores future rows and includes the exact trailing-window boundary", async (t) => {
  const database = new SqliteD1Database();
  t.after(() => database.close());
  const store = createCloudflareBotDefenseStore(database as unknown as D1Database);
  await store.recordRateMessage("guild", "user", "old", "images", 999);
  await store.recordRateMessage("guild", "user", "boundary", "images", 1000);
  await store.recordRateMessage("guild", "user", "now", "images", 2000);
  await store.recordRateMessage("guild", "user", "future", "images", 2001);
  assert.deepEqual(
    new Set(await store.listMatchingMessageChannelsInWindow("guild", "user", "images", 1000, 2000)),
    new Set(["boundary", "now"]),
  );
});

test("rate window store groups matching messages by distinct channel and expires old rows", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareBotDefenseStore(database as unknown as D1Database);

  await store.recordRateMessage("guild-1", "user-1", "channel-1", "message-a", 1000);
  await store.recordRateMessage("guild-1", "user-1", "channel-2", "message-a", 2000);
  await store.recordRateMessage("guild-1", "user-1", "channel-3", "message-b", 2500);
  await store.recordRateMessage("guild-1", "user-1", "channel-1", "message-a", 3000);

  const channels = await store.listMatchingMessageChannelsInWindow(
    "guild-1",
    "user-1",
    "message-a",
    5000,
    4000,
  );
  assert.deepEqual(new Set(channels), new Set(["channel-1", "channel-2"]));

  const expired = await store.listMatchingMessageChannelsInWindow(
    "guild-1",
    "user-1",
    "message-a",
    1000,
    6000,
  );
  assert.deepEqual(expired, []);
});

test("setBotFlagQueueMessage stores the queue message id", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareBotDefenseStore(database as unknown as D1Database);

  const evidence = { kind: "honeypot" as const, channelId: "channel-1", messageId: "msg-1" };
  const opened = await store.openBotFlag("guild-1", "user-1", "honeypot", evidence);
  assert.ok(opened);
  await store.setBotFlagQueueMessage(
    "guild-1",
    "user-1",
    opened.createdAtMs,
    "queue-message-1",
    150,
  );
  const flag = await store.readOpenBotFlag("guild-1", "user-1");
  assert.equal(flag?.queueMessageId, "queue-message-1");
});

test("listOpenBotFlagsMissingQueueMessage returns only stranded open flags past the grace period", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareBotDefenseStore(database as unknown as D1Database);

  const stranded = await store.openBotFlag("guild-1", "user-stranded", "honeypot", {
    kind: "honeypot",
    channelId: "channel-1",
    messageId: "msg-1",
  });
  assert.ok(stranded);
  await database
    .prepare("UPDATE bot_flags SET created_at_ms = ? WHERE guild_id = ? AND user_id = ?")
    .bind(1000, "guild-1", "user-stranded")
    .run();

  const delivered = await store.openBotFlag("guild-1", "user-delivered", "rate", {
    kind: "rate",
    channelIds: ["channel-2"],
    channelCount: 5,
    windowSeconds: 60,
  });
  assert.ok(delivered);
  await database
    .prepare(
      "UPDATE bot_flags SET created_at_ms = ?, queue_message_id = ? WHERE guild_id = ? AND user_id = ?",
    )
    .bind(1100, "queue-message-1", "guild-1", "user-delivered")
    .run();

  const fresh = await store.openBotFlag("guild-1", "user-fresh", "honeypot", {
    kind: "honeypot",
    channelId: "channel-1",
    messageId: "msg-3",
  });
  assert.ok(fresh);
  await database
    .prepare("UPDATE bot_flags SET created_at_ms = ? WHERE guild_id = ? AND user_id = ?")
    .bind(5000, "guild-1", "user-fresh")
    .run();

  await store.openBotFlag("guild-2", "user-resolved", "honeypot", {
    kind: "honeypot",
    channelId: "channel-1",
    messageId: "msg-4",
  });
  await database
    .prepare(
      "UPDATE bot_flags SET created_at_ms = ?, status = 'dismissed' WHERE guild_id = ? AND user_id = ?",
    )
    .bind(1200, "guild-2", "user-resolved")
    .run();

  const strandedFlags = await store.listOpenBotFlagsMissingQueueMessage(6000, 2000, 10);
  assert.deepEqual(
    strandedFlags.map((flag) => [flag.guildId, flag.userId]),
    [["guild-1", "user-stranded"]],
  );

  await store.setBotFlagQueueMessage(
    "guild-1",
    "user-stranded",
    1000,
    "queue-message-repair",
    6100,
  );
  assert.deepEqual(await store.listOpenBotFlagsMissingQueueMessage(6000, 2000, 10), []);
});
