/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createSqliteImageRulesStore } from "./support/sqlite/runtime/sqlite-image-rules-store";
import type { ImageRulesConfig } from "../src/types";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("createSqliteImageRulesStore reads, writes, updates, and deletes config", async () => {
  const database = new SqliteD1Database();
  const store = createSqliteImageRulesStore(database as unknown as D1Database);

  assert.equal(await store.readConfig("guild-1"), null);

  const config: ImageRulesConfig = {
    guildId: "guild-1",
    enabled: true,
    topicDescription: "DayZ screenshots",
    autoDeleteThreshold: 0.85,
    modReviewThreshold: 0.65,
    targetChannelIds: ["channel-1"],
    excludedRoleIds: ["role-1"],
    modQueueChannelId: "queue-channel-1",
    modRoleIds: ["mod-role-1"],
    pingOnQueuePost: true,
    reactOnTopic: true,
    auditOnTopic: true,
    dryRun: false,
    createdAtMs: 100,
    updatedAtMs: 100,
  };

  await store.upsertConfig(config);
  assert.deepEqual(await store.readConfig("guild-1"), config);

  const updated: ImageRulesConfig = {
    ...config,
    enabled: false,
    topicDescription: "",
    updatedAtMs: 200,
  };
  await store.upsertConfig(updated);
  assert.deepEqual(await store.readConfig("guild-1"), updated);

  await store.deleteConfig("guild-1");
  assert.equal(await store.readConfig("guild-1"), null);
  assert.equal(database.execCalls, 0);
});

test("createSqliteImageRulesStore returns the same instance per database", async () => {
  const database = new SqliteD1Database();
  const first = createSqliteImageRulesStore(database as unknown as D1Database);
  const second = createSqliteImageRulesStore(database as unknown as D1Database);
  assert.strictEqual(first, second);
});

test("createSqliteImageRulesStore defaults missing rows", async () => {
  const database = new SqliteD1Database();
  const store = createSqliteImageRulesStore(database as unknown as D1Database);

  await store.upsertConfig({
    guildId: "guild-default",
    enabled: false,
    topicDescription: "",
    autoDeleteThreshold: 0.85,
    modReviewThreshold: 0.65,
    targetChannelIds: [],
    excludedRoleIds: [],
    modQueueChannelId: null,
    modRoleIds: [],
    pingOnQueuePost: true,
    reactOnTopic: false,
    auditOnTopic: false,
    dryRun: false,
    createdAtMs: 1,
    updatedAtMs: 1,
  });

  const row = await store.readConfig("guild-default");
  assert.equal(row?.enabled, false);
  assert.equal(row?.topicDescription, "");
  assert.deepEqual(row?.targetChannelIds, []);
  assert.equal(row?.modQueueChannelId, null);
  assert.equal(row?.reactOnTopic, false);
  assert.equal(row?.auditOnTopic, false);
  assert.equal(row?.dryRun, false);
});

test("createSqliteImageRulesStore creates mod queue items", async () => {
  const database = new SqliteD1Database();
  const store = createSqliteImageRulesStore(database as unknown as D1Database);

  const item = await store.createModQueueItem({
    guildId: "guild-1",
    channelId: "channel-1",
    messageId: "message-1",
    authorId: "user-1",
    imageUrl: "https://cdn.example.test/image.png",
    topicDescription: "DayZ screenshots",
    offTopicConfidence: 0.7,
    onTopicConfidence: 0.3,
    status: "pending",
    queueChannelId: "queue-channel-1",
    queueMessageId: null,
    createdAtMs: 100,
    updatedAtMs: 100,
    decidedByUserId: null,
    decidedAtMs: null,
    failureReason: null,
    restoreClaimToken: null,
    restoreClaimExpiresAtMs: null,
    restoredMessageId: null,
  });

  assert.match(item.id, /^[0-9a-f-]{36}$/i);
  assert.equal(item.status, "pending");
  assert.equal(item.queueChannelId, "queue-channel-1");
  const duplicate = await store.createModQueueItem({
    ...buildQueueItemInput("message-1"),
    guildId: "guild-1",
    channelId: "channel-1",
  });
  assert.equal(duplicate.id, item.id);
  const concurrent = await Promise.all([
    store.createModQueueItem({
      ...buildQueueItemInput("message-concurrent"),
      guildId: "guild-1",
      channelId: "channel-1",
    }),
    store.createModQueueItem({
      ...buildQueueItemInput("message-concurrent"),
      guildId: "guild-1",
      channelId: "channel-1",
    }),
  ]);
  assert.equal(concurrent[0]?.id, concurrent[1]?.id);
  assert.equal(database.execCalls, 0);
});

test("createSqliteImageRulesStore fences restore claims and terminal outcomes", async () => {
  const database = new SqliteD1Database();
  const store = createSqliteImageRulesStore(database as unknown as D1Database);

  const restoredItem = await store.createModQueueItem(buildQueueItemInput("message-restore"));
  await store.setModQueueItemQueueMessage(
    restoredItem.id,
    "queue-channel-1",
    "queue-message-1",
    150,
  );
  const withQueueMessage = await store.readModQueueItem(restoredItem.id);
  assert.equal(withQueueMessage?.queueMessageId, "queue-message-1");
  assert.equal(withQueueMessage?.updatedAtMs, 150);

  const [firstClaim, secondClaim] = await Promise.all([
    store.claimModQueueItemRestore(restoredItem.id, "claim-1", "moderator-1", 200, 60_000),
    store.claimModQueueItemRestore(restoredItem.id, "claim-2", "moderator-2", 200, 60_000),
  ]);
  assert.equal([firstClaim, secondClaim].filter(Boolean).length, 1);
  const winningClaimToken = firstClaim ? "claim-1" : "claim-2";
  const winningActorUserId = firstClaim ? "moderator-1" : "moderator-2";
  const winningClaim = firstClaim ?? secondClaim;
  assert.equal(winningClaim?.status, "pending");
  assert.equal(winningClaim?.restoreClaimToken, winningClaimToken);
  assert.equal(winningClaim?.decidedByUserId, winningActorUserId);
  assert.equal(winningClaim?.decidedAtMs, 200);

  const conflictingApproval = await store.markModQueueItemApproved(
    restoredItem.id,
    "moderator-approve",
    201,
  );
  assert.equal(conflictingApproval, null);

  const staleCompletion = await store.markModQueueItemRestored(
    restoredItem.id,
    winningClaimToken === "claim-1" ? "claim-2" : "claim-1",
    "moderator-stale",
    "restored-stale",
    250,
  );
  assert.equal(staleCompletion, null);

  const recoveredClaim = await store.claimModQueueItemRestore(
    restoredItem.id,
    "claim-recovery",
    "moderator-recovery",
    60_201,
    60_000,
  );
  assert.equal(recoveredClaim?.status, "pending");
  assert.equal(recoveredClaim?.restoreClaimToken, "claim-recovery");
  assert.equal(recoveredClaim?.decidedByUserId, winningActorUserId);
  assert.equal(recoveredClaim?.decidedAtMs, 200);

  const restored = await store.markModQueueItemRestored(
    restoredItem.id,
    "claim-recovery",
    winningActorUserId,
    "restored-message-1",
    60_202,
  );
  assert.equal(restored?.status, "restored");
  assert.equal(restored?.decidedByUserId, winningActorUserId);
  assert.equal(restored?.decidedAtMs, 60_202);
  assert.equal(restored?.restoredMessageId, "restored-message-1");

  const failedItem = await store.createModQueueItem(buildQueueItemInput("message-failed"));
  const failedClaim = await store.claimModQueueItemRestore(
    failedItem.id,
    "claim-failed",
    "moderator-2",
    300,
    60_000,
  );
  assert.equal(failedClaim?.status, "pending");
  const failed = await store.markModQueueItemRestoreFailed(
    failedItem.id,
    "claim-failed",
    "moderator-2",
    "Discord API error",
    301,
  );
  assert.equal(failed?.status, "restore_failed");
  assert.equal(failed?.failureReason, "Discord API error");

  const retryClaim = await store.claimModQueueItemRestore(
    failedItem.id,
    "claim-retry",
    "moderator-3",
    302,
    60_000,
  );
  assert.equal(retryClaim, null);

  const stale = await store.markModQueueItemApproved(restoredItem.id, "moderator-3", 400);
  assert.equal(stale, null);
});

function buildQueueItemInput(messageId: string) {
  return {
    guildId: "guild-1",
    channelId: "channel-1",
    messageId,
    authorId: "user-1",
    imageUrl: "https://cdn.example.test/image.png",
    topicDescription: "DayZ screenshots",
    offTopicConfidence: 0.7,
    onTopicConfidence: 0.3,
    status: "pending" as const,
    queueChannelId: "queue-channel-1",
    queueMessageId: null,
    createdAtMs: 100,
    updatedAtMs: 100,
    decidedByUserId: null,
    decidedAtMs: null,
    failureReason: null,
    restoreClaimToken: null,
    restoreClaimExpiresAtMs: null,
    restoredMessageId: null,
  };
}
