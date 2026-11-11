/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createSqliteReactionLimitStore } from "./support/sqlite/runtime/sqlite-reaction-limit-store";
import type { ReactionLimitConfig } from "../src/types";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("createSqliteReactionLimitStore reads and upserts limit config", async () => {
  const database = new SqliteD1Database();
  const store = createSqliteReactionLimitStore(database as unknown as D1Database);
  const config: ReactionLimitConfig = {
    guildId: "guild-1",
    limitsEnabled: true,
    maxReactionsPerMessage: 10,
    maxReactionsPerUserPerMessage: 3,
    breachThreshold: 2,
    breachRoleId: "role-1",
    breachRoleDurationMs: null,
    breachDmText: "Please slow down with reactions.",
    channelMode: "exclude",
    channelIds: ["channel-1", "channel-2"],
  };

  assert.equal(await store.readReactionLimitConfig("guild-1"), null);

  await store.upsertReactionLimitConfig(config);

  assert.deepEqual(await store.readReactionLimitConfig("guild-1"), config);
  assert.equal(database.execCalls, 0);

  await store.readReactionLimitConfig("guild-2");

  assert.equal(database.execCalls, 0);
});

test("createSqliteReactionLimitStore defaults legacy config rows to all channels", async () => {
  const database = new SqliteD1Database();
  await database
    .prepare(
      "INSERT INTO reaction_limit_configs(guild_id, limits_enabled, max_reactions_per_message) VALUES(?, ?, ?)",
    )
    .bind("guild-legacy", 1, 10)
    .run();
  const store = createSqliteReactionLimitStore(database as unknown as D1Database);

  assert.deepEqual(await store.readReactionLimitConfig("guild-legacy"), {
    guildId: "guild-legacy",
    limitsEnabled: true,
    maxReactionsPerMessage: 10,
    maxReactionsPerUserPerMessage: null,
    breachThreshold: null,
    breachRoleId: null,
    breachRoleDurationMs: null,
    breachDmText: null,
    channelMode: "include",
    channelIds: [],
  });
});

test("createSqliteReactionLimitStore increments and clears guild breach counters", async () => {
  const database = new SqliteD1Database();
  const store = createSqliteReactionLimitStore(database as unknown as D1Database);

  assert.equal(await store.incrementBreachCounter("guild-1", "user-1"), 1);
  assert.equal(await store.incrementBreachCounter("guild-1", "user-1"), 2);
  assert.equal(await store.incrementBreachCounter("guild-1", "user-2"), 1);
  assert.equal(await store.incrementBreachCounter("guild-2", "user-1"), 1);

  assert.deepEqual(await store.readBreachCounters("guild-1"), [
    { guildId: "guild-1", userId: "user-1", breachCount: 2 },
    { guildId: "guild-1", userId: "user-2", breachCount: 1 },
  ]);

  await store.resetBreachCounter("guild-1", "user-1");

  assert.deepEqual(await store.readBreachCounters("guild-1"), [
    { guildId: "guild-1", userId: "user-2", breachCount: 1 },
  ]);

  await store.resetAllBreachCounters("guild-1");

  assert.deepEqual(await store.readBreachCounters("guild-1"), []);
  assert.deepEqual(await store.readBreachCounters("guild-2"), [
    { guildId: "guild-2", userId: "user-1", breachCount: 1 },
  ]);
});

test("createSqliteReactionLimitStore increments message reaction counters", async () => {
  const database = new SqliteD1Database();
  const store = createSqliteReactionLimitStore(database as unknown as D1Database);
  const oldestFreshTimestamp = Date.now();

  assert.equal(await store.incrementMessageReactionCount("guild-1", "channel-1", "message-1"), 1);
  assert.equal(await store.incrementMessageReactionCount("guild-1", "channel-1", "message-1"), 2);
  assert.equal(
    await store.incrementUserMessageReactionCount("guild-1", "channel-1", "message-1", "user-1"),
    1,
  );
  assert.equal(
    await store.incrementUserMessageReactionCount("guild-1", "channel-1", "message-1", "user-1"),
    2,
  );
  assert.equal(await store.purgeExpiredCounters(oldestFreshTimestamp), 0);
});

test("createSqliteReactionLimitStore deletes counters not touched since the cutoff", async () => {
  const database = new SqliteD1Database();
  const store = createSqliteReactionLimitStore(database as unknown as D1Database);

  await database
    .prepare(
      "INSERT INTO reaction_limit_message_reaction_counts(guild_id, channel_id, message_id, reaction_count, updated_at_ms) VALUES(?, ?, ?, ?, ?)",
    )
    .bind("guild-1", "channel-1", "message-oldest", 4, 500)
    .run();
  await database
    .prepare(
      "INSERT INTO reaction_limit_message_reaction_counts(guild_id, channel_id, message_id, reaction_count, updated_at_ms) VALUES(?, ?, ?, ?, ?)",
    )
    .bind("guild-1", "channel-1", "message-old", 3, 1000)
    .run();
  await database
    .prepare(
      "INSERT INTO reaction_limit_message_reaction_counts(guild_id, channel_id, message_id, reaction_count, updated_at_ms) VALUES(?, ?, ?, ?, ?)",
    )
    .bind("guild-1", "channel-1", "message-new", 1, 2000)
    .run();
  await database
    .prepare(
      "INSERT INTO reaction_limit_user_message_reaction_counts(guild_id, channel_id, message_id, user_id, reaction_count, updated_at_ms) VALUES(?, ?, ?, ?, ?, ?)",
    )
    .bind("guild-1", "channel-1", "message-oldest", "user-1", 3, 500)
    .run();
  await database
    .prepare(
      "INSERT INTO reaction_limit_user_message_reaction_counts(guild_id, channel_id, message_id, user_id, reaction_count, updated_at_ms) VALUES(?, ?, ?, ?, ?, ?)",
    )
    .bind("guild-1", "channel-1", "message-old", "user-1", 2, 1000)
    .run();
  await database
    .prepare(
      "INSERT INTO reaction_limit_user_message_reaction_counts(guild_id, channel_id, message_id, user_id, reaction_count, updated_at_ms) VALUES(?, ?, ?, ?, ?, ?)",
    )
    .bind("guild-1", "channel-1", "message-new", "user-1", 1, 2000)
    .run();

  assert.equal(await store.purgeExpiredCounters(1500, 1), 2);
  assert.equal(await store.purgeExpiredCounters(1500, 1), 2);

  const remainingMessages = await database
    .prepare("SELECT message_id FROM reaction_limit_message_reaction_counts")
    .all<{ message_id: string }>();
  assert.deepEqual(
    remainingMessages.results.map((row) => row.message_id),
    ["message-new"],
  );
  const remainingUsers = await database
    .prepare("SELECT message_id FROM reaction_limit_user_message_reaction_counts")
    .all<{ message_id: string }>();
  assert.deepEqual(
    remainingUsers.results.map((row) => row.message_id),
    ["message-new"],
  );
});
