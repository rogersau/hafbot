/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import { createCloudflareMentionProtectionStore } from "../src/runtime/cloudflare-mention-protection-store";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("Mention Protection action claims recover a stale lease but stop after three attempts", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareMentionProtectionStore(database as unknown as D1Database);

  assert.equal(await store.claimAction("guild-1", "message-1", "delete", 100_000), "claimed");
  assert.equal(await store.claimAction("guild-1", "message-1", "delete", 100_001), "deferred");
  assert.equal(await store.claimAction("guild-1", "message-1", "delete", 160_001), "claimed");
  await store.recordActionOutcome({
    guildId: "guild-1",
    messageId: "message-1",
    action: "delete",
    status: "failed",
    retryable: true,
    updatedAtMs: 160_002,
  });
  assert.equal(await store.claimAction("guild-1", "message-1", "delete", 160_003), "claimed");
  await store.recordActionOutcome({
    guildId: "guild-1",
    messageId: "message-1",
    action: "delete",
    status: "failed",
    retryable: true,
    updatedAtMs: 160_004,
  });
  assert.equal(await store.claimAction("guild-1", "message-1", "delete", 160_005), "satisfied");
});

test("Mention Burst excludes future observations during out-of-order delivery", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareMentionProtectionStore(database as unknown as D1Database);

  await store.recordBurstMessage({
    guildId: "guild-1",
    userId: "user-1",
    messageId: "future",
    messageTimestampMs: 200,
    windowMs: 50,
  });
  const count = await store.recordBurstMessage({
    guildId: "guild-1",
    userId: "user-1",
    messageId: "older",
    messageTimestampMs: 100,
    windowMs: 50,
  });

  assert.equal(count, 1);
});
