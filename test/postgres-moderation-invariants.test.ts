import assert from "node:assert/strict";
import test from "node:test";
import type {
  BotDefenseConfig,
  BotDefenseEvidence,
  BotFlag,
  ImageRulesConfig,
  ImageRulesModQueueItem,
  MentionProtectionClaimInput,
  MentionProtectionConfig,
  MentionProtectionDetection,
} from "../src/types";
import { createPostgresBotDefenseStore } from "../src/runtime/postgres/postgres-bot-defense-store";
import type { PostgresDatabaseCapability } from "../src/runtime/postgres/postgres-capability";
import { createPostgresImageRulesStore } from "../src/runtime/postgres/postgres-image-rules-store";
import { createPostgresMentionProtectionStore } from "../src/runtime/postgres/postgres-mention-protection-store";
import { withFreshPostgres } from "./support/postgres";

const postgresOnly = {
  skip: process.env.TEST_POSTGRES_URL ? false : "TEST_POSTGRES_URL is not configured",
};

test(
  "native PostgreSQL Image Rules preserve configuration isolation, queue deduplication and restore fencing",
  postgresOnly,
  async () => {
    await withFreshPostgres(async (database) => {
      await verifyImageRulesConfig(database);
      await verifyImageRulesModQueue(database);
      await verifyImageRulesRestoreFencing(database);
    });
  },
);

test(
  "native PostgreSQL Bot Defense preserves configuration isolation, flag deduplication and rate windows",
  postgresOnly,
  async () => {
    await withFreshPostgres(async (database) => {
      await verifyBotDefenseConfig(database);
      await verifyBotDefenseFlagDeduplication(database);
      await verifyBotDefenseRateWindow(database);
    });
  },
);

test(
  "native PostgreSQL Mention Protection replaces configuration and clears burst windows atomically",
  postgresOnly,
  async () => {
    await withFreshPostgres(async (database) => {
      await verifyMentionProtectionConfig(database);
    });
  },
);

test(
  "native PostgreSQL Mention Protection rolls back failed configuration clears",
  postgresOnly,
  async () => {
    await withFreshPostgres(async (database) => {
      await verifyMentionProtectionConfigRollback(database);
    });
  },
);

test(
  "native PostgreSQL Mention Protection burst recording waits for configuration replacement",
  postgresOnly,
  async () => {
    await withFreshPostgres(async (database) => {
      await verifyMentionProtectionConfigConcurrency(database);
    });
  },
);

test(
  "native PostgreSQL Mention Protection deduplicates concurrent burst messages per member",
  postgresOnly,
  async () => {
    await withFreshPostgres(async (database) => {
      await verifyMentionProtectionBurstWindow(database);
      await verifyMentionProtectionBurstUserConcurrency(database);
    });
  },
);

test(
  "native PostgreSQL Mention Protection preserves breach escalation and action claim fencing",
  postgresOnly,
  async () => {
    await withFreshPostgres(async (database) => {
      await verifyMentionProtectionBreachDeduplication(database);
      await verifyMentionProtectionActionFencing(database);
    });
  },
);

async function verifyImageRulesConfig(database: PostgresDatabaseCapability): Promise<void> {
  const store = createPostgresImageRulesStore(database);
  assert.equal(await store.readConfig("guild-image-a"), null);

  const first = imageRulesConfig("guild-image-a");
  const second = imageRulesConfig("guild-image-b", {
    topicDescription: "Other topic",
    targetChannelIds: ["other-channel"],
    updatedAtMs: 150,
  });
  await store.upsertConfig(first);
  await store.upsertConfig(second);
  assert.deepEqual(await store.readConfig(first.guildId), first);
  assert.deepEqual(await store.readConfig(second.guildId), second);

  const replacement: ImageRulesConfig = {
    ...first,
    enabled: false,
    topicDescription: "",
    autoDeleteThreshold: 0.9,
    modReviewThreshold: 0.7,
    targetChannelIds: [],
    excludedRoleIds: [],
    modQueueChannelId: null,
    modRoleIds: [],
    pingOnQueuePost: false,
    reactOnTopic: false,
    auditOnTopic: true,
    dryRun: true,
    updatedAtMs: 200,
  };
  await store.upsertConfig(replacement);
  assert.deepEqual(await store.readConfig(first.guildId), replacement);
  assert.deepEqual(await store.readConfig(second.guildId), second);

  await store.deleteConfig(first.guildId);
  assert.equal(await store.readConfig(first.guildId), null);
  assert.deepEqual(await store.readConfig(second.guildId), second);
}

async function verifyImageRulesModQueue(database: PostgresDatabaseCapability): Promise<void> {
  const store = createPostgresImageRulesStore(database);
  const [left, right] = await Promise.all([
    store.createModQueueItem(imageQueueItem("guild-image-a", "channel-1", "message-1")),
    store.createModQueueItem(imageQueueItem("guild-image-a", "channel-1", "message-1")),
  ]);
  assert.equal(left.id, right.id);
  assert.equal(left.status, "pending");

  const duplicate = await store.createModQueueItem({
    ...imageQueueItem("guild-image-a", "channel-1", "message-1"),
    topicDescription: "A conflicting duplicate",
    imageUrl: "https://cdn.example.test/other.png",
  });
  assert.equal(duplicate.id, left.id);
  assert.equal(duplicate.topicDescription, left.topicDescription);
  assert.equal(duplicate.imageUrl, left.imageUrl);
  assert.deepEqual(await store.readModQueueItem(left.id), left);

  const otherChannel = await store.createModQueueItem(
    imageQueueItem("guild-image-a", "channel-2", "message-1"),
  );
  const otherGuild = await store.createModQueueItem(
    imageQueueItem("guild-image-b", "channel-1", "message-1"),
  );
  assert.notEqual(otherChannel.id, left.id);
  assert.notEqual(otherGuild.id, left.id);
  assert.equal((await store.readModQueueItem(otherChannel.id))?.guildId, "guild-image-a");
  assert.equal((await store.readModQueueItem(otherGuild.id))?.guildId, "guild-image-b");

  const counts = await database.query<{ count: number }>(
    "SELECT COUNT(*)::INTEGER AS count FROM image_rules_mod_queue_items WHERE guild_id = $1",
    ["guild-image-a"],
  );
  assert.equal(counts[0]?.count, 2);
}

async function verifyImageRulesRestoreFencing(database: PostgresDatabaseCapability): Promise<void> {
  const store = createPostgresImageRulesStore(database);
  const leaseMs = 60_000;
  const ungated = await store.createModQueueItem(
    imageQueueItem("guild-image-a", "channel-1", "message-ungated"),
  );
  const ungatedClaim = await store.claimModQueueItemRestore(
    ungated.id,
    "claim-once",
    "moderator-0",
    1,
    leaseMs,
  );
  assert.equal(ungatedClaim?.restoreClaimToken, "claim-once");

  const concurrent = await store.createModQueueItem(
    imageQueueItem("guild-image-a", "channel-1", "message-concurrent"),
  );
  const concurrentClaims = await Promise.all([
    store.claimModQueueItemRestore(concurrent.id, "claim-left", "moderator-left", 6_000, leaseMs),
    store.claimModQueueItemRestore(concurrent.id, "claim-right", "moderator-right", 6_000, leaseMs),
  ]);
  const winners = concurrentClaims.filter(
    (claim): claim is ImageRulesModQueueItem => claim !== null,
  );
  assert.equal(winners.length, 1);
  const winner = winners[0]!;
  assert.equal(
    (await store.readModQueueItem(concurrent.id))?.restoreClaimToken,
    winner.restoreClaimToken,
  );

  assert.equal(
    await store.claimModQueueItemRestore(
      concurrent.id,
      "claim-during-lease",
      "moderator-2",
      6_001,
      leaseMs,
    ),
    null,
  );
  assert.equal(await store.markModQueueItemApproved(concurrent.id, "moderator-3", 6_002), null);
  assert.equal(
    await store.markModQueueItemRestored(
      concurrent.id,
      winner.restoreClaimToken === "claim-left" ? "claim-right" : "claim-left",
      "moderator-stale",
      "restored-stale",
      6_003,
    ),
    null,
  );

  const recovered = await store.claimModQueueItemRestore(
    concurrent.id,
    "claim-recovered",
    "moderator-recovered",
    6_000 + leaseMs + 1,
    leaseMs,
  );
  assert.equal(recovered?.restoreClaimToken, "claim-recovered");
  assert.equal(recovered?.decidedByUserId, winner.decidedByUserId);
  assert.equal(recovered?.decidedAtMs, winner.decidedAtMs);
  assert.equal(
    await store.markModQueueItemRestored(
      concurrent.id,
      winner.restoreClaimToken!,
      "moderator-stale",
      "restored-stale",
      6_100,
    ),
    null,
  );
  const restored = await store.markModQueueItemRestored(
    concurrent.id,
    "claim-recovered",
    "moderator-recovered",
    "restored-message-1",
    6_101,
  );
  assert.equal(restored?.status, "restored");
  assert.equal(restored?.decidedByUserId, "moderator-recovered");
  assert.equal(restored?.restoredMessageId, "restored-message-1");
  assert.equal(restored?.decidedAtMs, 6_101);
  assert.equal(
    await store.claimModQueueItemRestore(
      concurrent.id,
      "claim-after-restore",
      "moderator-4",
      7_000,
      leaseMs,
    ),
    null,
  );
  assert.equal(await store.markModQueueItemApproved(concurrent.id, "moderator-4", 7_001), null);

  const failed = await store.createModQueueItem(
    imageQueueItem("guild-image-a", "channel-1", "message-failed"),
  );
  assert.equal(
    (await store.claimModQueueItemRestore(failed.id, "claim-failed", "moderator-5", 8_000, leaseMs))
      ?.restoreClaimToken,
    "claim-failed",
  );
  assert.equal(
    await store.markModQueueItemRestoreFailed(
      failed.id,
      "wrong-claim",
      "moderator-5",
      "wrong token",
      8_001,
    ),
    null,
  );
  const failedResult = await store.markModQueueItemRestoreFailed(
    failed.id,
    "claim-failed",
    "moderator-5",
    "Discord API error",
    8_002,
  );
  assert.equal(failedResult?.status, "restore_failed");
  assert.equal(failedResult?.failureReason, "Discord API error");
  assert.equal(
    await store.claimModQueueItemRestore(failed.id, "claim-retry", "moderator-6", 8_003, leaseMs),
    null,
  );
}

async function verifyBotDefenseConfig(database: PostgresDatabaseCapability): Promise<void> {
  const store = createPostgresBotDefenseStore(database);
  const defaults = await store.readConfig("guild-bot-a");
  assert.equal(defaults?.guildId, "guild-bot-a");
  assert.equal(defaults?.honeypotEnabled, false);
  assert.equal(defaults?.rateEnabled, false);
  assert.equal(defaults?.rateChannelThreshold, 5);
  assert.equal(defaults?.rateWindowSeconds, 60);
  assert.equal(defaults?.pingOnQueuePost, true);

  const first = botDefenseConfig("guild-bot-a");
  const second = botDefenseConfig("guild-bot-b", {
    honeypotChannelIds: ["other-honeypot"],
    updatedAtMs: 150,
  });
  await store.upsertConfig(first);
  await store.upsertConfig(second);
  assert.deepEqual(await store.readConfig(first.guildId), first);
  assert.deepEqual(await store.readConfig(second.guildId), second);

  await assert.rejects(
    store.upsertConfig({
      ...first,
      honeypotChannelIds: Array.from({ length: 11 }, (_, index) => `channel-${index + 1}`),
      updatedAtMs: 180,
    }),
    /no more than 10 honeypot channels/i,
  );
  assert.deepEqual(await store.readConfig(first.guildId), first);

  const replacement: BotDefenseConfig = {
    ...first,
    honeypotEnabled: false,
    rateEnabled: false,
    rateChannelThreshold: 20,
    rateWindowSeconds: 300,
    updatedAtMs: 200,
  };
  await store.upsertConfig(replacement);
  assert.deepEqual(await store.readConfig(first.guildId), replacement);
  assert.deepEqual(await store.readConfig(second.guildId), second);

  await store.deleteConfig(first.guildId);
  const afterDelete = await store.readConfig(first.guildId);
  assert.equal(afterDelete?.guildId, first.guildId);
  assert.equal(afterDelete?.honeypotEnabled, false);
  assert.equal(afterDelete?.rateChannelThreshold, 5);
  assert.deepEqual(await store.readConfig(second.guildId), second);
}

async function verifyBotDefenseFlagDeduplication(
  database: PostgresDatabaseCapability,
): Promise<void> {
  const store = createPostgresBotDefenseStore(database);
  const honeypotEvidence: BotDefenseEvidence = {
    kind: "honeypot",
    channelId: "channel-1",
    messageId: "message-1",
  };

  const opens = await Promise.all(
    Array.from({ length: 6 }, () =>
      store.openBotFlag("guild-bot-flags", "user-open", "honeypot", honeypotEvidence),
    ),
  );
  const opened = singleWinner(opens);
  assert.equal(opened.status, "open");
  assert.deepEqual(opened.evidence, honeypotEvidence);
  assert.equal(
    await store.openBotFlag("guild-bot-flags", "user-open", "rate", rateEvidence()),
    null,
  );
  assert.equal(
    (await store.readOpenBotFlag("guild-bot-flags", "user-open"))?.guildId,
    "guild-bot-flags",
  );
  assert.equal(
    await store.readOpenBotFlag("guild-bot-flags", "user-open", opened.createdAtMs - 1),
    null,
  );

  const siblingGuild = await store.openBotFlag(
    "guild-bot-flags-other",
    "user-open",
    "honeypot",
    honeypotEvidence,
  );
  assert.equal(siblingGuild?.guildId, "guild-bot-flags-other");

  await store.setBotFlagQueueMessage(
    "guild-bot-flags",
    "user-open",
    opened.createdAtMs - 1,
    "queue-wrong-generation",
    150,
  );
  assert.equal((await store.readOpenBotFlag("guild-bot-flags", "user-open"))?.queueMessageId, null);
  await store.setBotFlagQueueMessage(
    "guild-bot-flags",
    "user-open",
    opened.createdAtMs,
    "queue-message-1",
    151,
  );
  assert.equal(
    (await store.readOpenBotFlag("guild-bot-flags", "user-open"))?.queueMessageId,
    "queue-message-1",
  );

  const resolving = await openFlag(store, "guild-bot-flags", "user-resolve");
  const resolutions = await Promise.all([
    store.resolveBotFlag(
      "guild-bot-flags",
      "user-resolve",
      resolving.createdAtMs,
      "confirmed",
      "moderator-confirm",
    ),
    store.resolveBotFlag(
      "guild-bot-flags",
      "user-resolve",
      resolving.createdAtMs,
      "dismissed",
      "moderator-dismiss",
    ),
  ]);
  const resolved = singleWinner(resolutions);
  const resolutionRow = await database.query<{
    status: string;
    resolved_by_discord_user_id: string | null;
  }>(
    `SELECT status, resolved_by_discord_user_id FROM bot_flags
     WHERE guild_id = $1 AND user_id = $2`,
    ["guild-bot-flags", "user-resolve"],
  );
  assert.equal(resolutionRow[0]?.status, resolved.status);
  assert.equal(resolutionRow[0]?.resolved_by_discord_user_id, resolved.resolvedByDiscordUserId);
  assert.equal(
    await store.isConfirmedMember("guild-bot-flags", "user-resolve"),
    resolved.status === "confirmed",
  );
  assert.equal(await store.readOpenBotFlag("guild-bot-flags", "user-resolve"), null);

  const dismissed = await openFlag(store, "guild-bot-flags", "user-dismissed");
  assert.equal(
    (
      await store.resolveBotFlag(
        "guild-bot-flags",
        "user-dismissed",
        dismissed.createdAtMs,
        "dismissed",
        "moderator-dismiss",
      )
    )?.status,
    "dismissed",
  );
  const refopens = await Promise.all(
    Array.from({ length: 6 }, () =>
      store.openBotFlag("guild-bot-flags", "user-dismissed", "rate", rateEvidence()),
    ),
  );
  const reopened = singleWinner(refopens);
  assert.ok(reopened.createdAtMs > dismissed.createdAtMs);
  assert.equal(reopened.detectorType, "rate");
  assert.deepEqual(reopened.evidence, rateEvidence());
  assert.equal(reopened.queueMessageId, null);
  assert.equal(
    await store.resolveBotFlag(
      "guild-bot-flags",
      "user-dismissed",
      dismissed.createdAtMs,
      "confirmed",
      "moderator-stale",
    ),
    null,
  );
  assert.equal(
    (
      await store.resolveBotFlag(
        "guild-bot-flags",
        "user-dismissed",
        reopened.createdAtMs,
        "confirmed",
        "moderator-current",
      )
    )?.status,
    "confirmed",
  );
  assert.equal(await store.isConfirmedMember("guild-bot-flags", "user-dismissed"), true);
  assert.equal(
    await store.openBotFlag("guild-bot-flags", "user-dismissed", "honeypot", honeypotEvidence),
    null,
  );

  await verifyBotDefenseStrandedFlags(store, database);
}

async function verifyBotDefenseStrandedFlags(
  store: ReturnType<typeof createPostgresBotDefenseStore>,
  database: PostgresDatabaseCapability,
): Promise<void> {
  const guildId = "guild-bot-stranded";
  const stranded = await openFlag(store, guildId, "user-stranded");
  const delivered = await openFlag(store, guildId, "user-delivered");
  const fresh = await openFlag(store, guildId, "user-fresh");
  const dismissed = await openFlag(store, guildId, "user-dismissed");
  await store.resolveBotFlag(
    guildId,
    "user-dismissed",
    dismissed.createdAtMs,
    "dismissed",
    "moderator-dismiss",
  );
  await database.execute(
    `UPDATE bot_flags SET created_at_ms = 1000 WHERE guild_id = $1 AND user_id = $2`,
    [guildId, stranded.userId],
  );
  await database.execute(
    `UPDATE bot_flags
     SET created_at_ms = 1100, queue_message_id = 'queue-message-1'
     WHERE guild_id = $1 AND user_id = $2`,
    [guildId, delivered.userId],
  );
  await database.execute(
    `UPDATE bot_flags SET created_at_ms = 5000 WHERE guild_id = $1 AND user_id = $2`,
    [guildId, fresh.userId],
  );
  await database.execute(
    `UPDATE bot_flags SET created_at_ms = 1200 WHERE guild_id = $1 AND user_id = $2`,
    [guildId, dismissed.userId],
  );

  const listStranded = async () =>
    (await store.listOpenBotFlagsMissingQueueMessage(6_000, 2_000, 10)).filter(
      (flag) => flag.guildId === guildId,
    );
  assert.deepEqual(
    (await listStranded()).map((flag) => flag.userId),
    [stranded.userId],
  );
  await store.setBotFlagQueueMessage(guildId, stranded.userId, 1_000, "queue-repair", 6_100);
  assert.deepEqual(await listStranded(), []);
}

async function verifyBotDefenseRateWindow(database: PostgresDatabaseCapability): Promise<void> {
  const store = createPostgresBotDefenseStore(database);
  const guildId = "guild-bot-rate";
  const userId = "user-rate";
  await store.recordRateMessage(guildId, userId, "old", "images", 999);
  await store.recordRateMessage(guildId, userId, "boundary", "images", 1_000);
  await store.recordRateMessage(guildId, userId, "boundary", "images", 1_500);
  await store.recordRateMessage(guildId, userId, "now", "images", 2_000);
  await store.recordRateMessage(guildId, userId, "future", "images", 2_001);
  await store.recordRateMessage(guildId, userId, "other-fingerprint", "text", 1_500);
  await store.recordRateMessage("guild-bot-rate-other", userId, "other-guild", "images", 1_500);

  assert.deepEqual(
    new Set(
      await store.listMatchingMessageChannelsInWindow(guildId, userId, "images", 1_000, 2_000),
    ),
    new Set(["boundary", "now"]),
  );
  const remaining = await database.query<{ message_timestamp_ms: string }>(
    `SELECT message_timestamp_ms FROM bot_defense_rate_window_events
     WHERE guild_id = $1
     ORDER BY message_timestamp_ms`,
    [guildId],
  );
  assert.deepEqual(
    remaining.map((row) => Number(row.message_timestamp_ms)),
    [1_000, 1_500, 1_500, 2_000, 2_001],
  );

  assert.deepEqual(
    await store.listMatchingMessageChannelsInWindow(guildId, userId, "images", 500, 6_000),
    [],
  );
  const cleared = await database.query<{ count: number }>(
    `SELECT COUNT(*)::INTEGER AS count FROM bot_defense_rate_window_events
     WHERE guild_id = $1`,
    [guildId],
  );
  assert.equal(cleared[0]?.count, 0);
  const otherGuild = await database.query<{ count: number }>(
    `SELECT COUNT(*)::INTEGER AS count FROM bot_defense_rate_window_events
     WHERE guild_id = $1`,
    ["guild-bot-rate-other"],
  );
  assert.equal(otherGuild[0]?.count, 1);
}

async function verifyMentionProtectionConfig(database: PostgresDatabaseCapability): Promise<void> {
  const store = createPostgresMentionProtectionStore(database);
  const defaults = await store.readConfig("guild-mention-a");
  assert.equal(defaults?.guildId, "guild-mention-a");
  assert.equal(defaults?.massMentionThreshold, 5);
  assert.equal(defaults?.burstWindowSeconds, 10);

  const first = mentionProtectionConfig("guild-mention-a");
  const second = mentionProtectionConfig("guild-mention-b", {
    adminEnabled: false,
    spamEnabled: false,
    channelIds: ["other-channel"],
    updatedAtMs: 150,
  });
  await store.upsertConfig(first);
  await store.upsertConfig(second);
  assert.deepEqual(await store.readConfig(first.guildId), first);
  assert.deepEqual(await store.readConfig(second.guildId), second);

  await store.recordBurstMessage({
    guildId: first.guildId,
    userId: "user-1",
    messageId: "message-1",
    messageTimestampMs: 1_000,
    windowMs: 1_000,
  });
  await store.recordBurstMessage({
    guildId: second.guildId,
    userId: "user-1",
    messageId: "message-1",
    messageTimestampMs: 1_000,
    windowMs: 1_000,
  });

  const replacement: MentionProtectionConfig = {
    ...first,
    spamEnabled: false,
    burstMessageThreshold: first.burstMessageThreshold + 1,
    updatedAtMs: 200,
  };
  await store.upsertConfig(replacement);
  assert.deepEqual(await store.readConfig(first.guildId), replacement);
  assert.deepEqual(await store.readConfig(second.guildId), second);
  assert.equal(await countBurstRows(database, first.guildId), 0);
  assert.equal(await countBurstRows(database, second.guildId), 1);

  await store.recordBurstMessage({
    guildId: first.guildId,
    userId: "user-1",
    messageId: "message-2",
    messageTimestampMs: 2_000,
    windowMs: 1_000,
  });
  await store.upsertConfig({
    ...replacement,
    adminInitialResponse: {
      reply: false,
      delete: true,
      restriction: { type: "timeout", durationMs: 120_000 },
    },
    updatedAtMs: 300,
  });
  assert.equal(await countBurstRows(database, first.guildId), 1);

  await store.clearBurstWindow(first.guildId);
  assert.equal(await countBurstRows(database, first.guildId), 0);
  await store.recordBurstMessage({
    guildId: first.guildId,
    userId: "user-1",
    messageId: "message-3",
    messageTimestampMs: 3_000,
    windowMs: 1_000,
  });
  await store.deleteConfig(first.guildId);
  assert.equal(await countBurstRows(database, first.guildId), 0);
  assert.equal(
    await store.readConfig(first.guildId).then((config) => config?.guildId),
    first.guildId,
  );
  assert.deepEqual(await store.readConfig(second.guildId), second);
}

async function verifyMentionProtectionConfigRollback(
  database: PostgresDatabaseCapability,
): Promise<void> {
  const store = createPostgresMentionProtectionStore(database);
  const guildId = "guild-mention-rollback";
  const config = mentionProtectionConfig(guildId);
  await store.upsertConfig(config);
  await store.recordBurstMessage({
    guildId,
    userId: "user-1",
    messageId: "message-1",
    messageTimestampMs: 1_000,
    windowMs: 1_000,
  });

  await database.execute(`
    CREATE FUNCTION haf_test_reject_burst_delete() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.guild_id = 'guild-mention-rollback' THEN
        RAISE EXCEPTION 'forced burst clear failure';
      END IF;
      RETURN OLD;
    END;
    $$
  `);
  await database.execute(`
    CREATE TRIGGER haf_test_reject_burst_delete
    BEFORE DELETE ON mention_protection_burst_events
    FOR EACH ROW EXECUTE FUNCTION haf_test_reject_burst_delete()
  `);
  try {
    await assertRejectsWithMessage(
      store.upsertConfig({
        ...config,
        spamEnabled: false,
        burstMessageThreshold: 9,
        updatedAtMs: 400,
      }),
      /forced burst clear failure/,
    );
    assert.deepEqual(await store.readConfig(guildId), config);
    assert.equal(await countBurstRows(database, guildId), 1);

    await assertRejectsWithMessage(store.deleteConfig(guildId), /forced burst clear failure/);
    assert.deepEqual(await store.readConfig(guildId), config);
    assert.equal(await countBurstRows(database, guildId), 1);
  } finally {
    await database.execute(
      "DROP TRIGGER IF EXISTS haf_test_reject_burst_delete ON mention_protection_burst_events",
    );
    await database.execute("DROP FUNCTION IF EXISTS haf_test_reject_burst_delete()");
  }

  await store.deleteConfig(guildId);
  assert.equal(await countBurstRows(database, guildId), 0);
}

async function verifyMentionProtectionConfigConcurrency(
  database: PostgresDatabaseCapability,
): Promise<void> {
  const store = createPostgresMentionProtectionStore(database);
  const guildId = "guild-mention-config-race";
  const otherGuildId = "guild-mention-config-race-other";
  const config = mentionProtectionConfig(guildId);
  await store.upsertConfig(config);
  await store.upsertConfig(mentionProtectionConfig(otherGuildId));
  await store.recordBurstMessage({
    guildId,
    userId: "user-race",
    messageId: "old-message",
    messageTimestampMs: 1_000,
    windowMs: 1_000,
  });
  await store.recordBurstMessage({
    guildId: otherGuildId,
    userId: "user-race",
    messageId: "other-message",
    messageTimestampMs: 1_000,
    windowMs: 1_000,
  });
  await database.execute(`
    CREATE FUNCTION haf_test_pause_mention_config() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.guild_id = 'guild-mention-config-race' THEN
        PERFORM pg_advisory_xact_lock(73938211, 1);
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await database.execute(`
    CREATE TRIGGER haf_test_pause_mention_config
    BEFORE UPDATE ON mention_protection_configs
    FOR EACH ROW EXECUTE FUNCTION haf_test_pause_mention_config()
  `);
  let releaseGate!: () => void;
  let markGateReady!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const gateReady = new Promise<void>((resolve) => {
    markGateReady = resolve;
  });
  const blocker = database.transaction(async (transaction) => {
    await transaction.query("SELECT pg_advisory_xact_lock(73938211, 1)");
    markGateReady();
    await gate;
  });
  let update: Promise<void> | undefined;
  let burst: Promise<number> | undefined;
  let stopWaiting = false;
  let waiting: Promise<boolean> | undefined;
  try {
    await Promise.race([gateReady, blocker]);
    update = store.upsertConfig({
      ...config,
      burstMessageThreshold: config.burstMessageThreshold + 1,
      updatedAtMs: 200,
    });
    await waitForMentionStoreLock(database, "config");
    burst = store.recordBurstMessage({
      guildId,
      userId: "user-race",
      messageId: "new-message",
      messageTimestampMs: 1_100,
      windowMs: 1_000,
    });
    waiting = waitForMentionStoreLock(database, "burst", () => stopWaiting);
    const outcome = await Promise.race([
      burst.then(() => "completed"),
      waiting.then(() => "blocked"),
    ]);
    stopWaiting = true;
    await waiting;
    assert.equal(outcome, "blocked", "Burst recording must wait for configuration replacement");
  } finally {
    stopWaiting = true;
    releaseGate();
    await Promise.allSettled([blocker, update, burst, waiting]);
    await database.execute(
      "DROP TRIGGER IF EXISTS haf_test_pause_mention_config ON mention_protection_configs",
    );
    await database.execute("DROP FUNCTION IF EXISTS haf_test_pause_mention_config()");
  }
  await update;
  assert.equal(await burst, 1);
  assert.equal(await countBurstRows(database, guildId), 1);
  const remaining = await database.query<{ message_id: string; message_timestamp_ms: string }>(
    `SELECT message_id, message_timestamp_ms FROM mention_protection_burst_events
     WHERE guild_id = $1`,
    [guildId],
  );
  assert.deepEqual(
    remaining.map((row) => [row.message_id, Number(row.message_timestamp_ms)]),
    [["new-message", 1_100]],
  );
  assert.equal(await countBurstRows(database, otherGuildId), 1);
}

async function waitForMentionStoreLock(
  database: PostgresDatabaseCapability,
  operation: "config" | "burst",
  cancelled: () => boolean = () => false,
): Promise<boolean> {
  const predicate =
    operation === "config"
      ? "query ILIKE '%insert into%' AND query ILIKE '%mention_protection_configs%'"
      : "(query ILIKE '%mention_protection_burst_events%' OR query ILIKE '%pg_advisory_xact_lock_shared%')";
  const deadline = Date.now() + 5_000;
  while (!cancelled() && Date.now() < deadline) {
    const rows = await database.query<{ blocked: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_stat_activity
         WHERE datname = current_database()
           AND pid <> pg_backend_pid()
           AND state = 'active'
           AND wait_event_type = 'Lock'
           AND ${predicate}
       ) AS blocked`,
    );
    if (rows[0]?.blocked) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (cancelled()) return false;
  throw new Error(`Expected concurrent Mention Protection ${operation} operation to wait`);
}

async function verifyMentionProtectionBurstWindow(
  database: PostgresDatabaseCapability,
): Promise<void> {
  const store = createPostgresMentionProtectionStore(database);
  const guildId = "guild-mention-burst";
  const userId = "user-burst";
  assert.equal(
    await store.recordBurstMessage({
      guildId,
      userId,
      messageId: "future",
      messageTimestampMs: 200,
      windowMs: 50,
    }),
    1,
  );
  assert.equal(
    await store.recordBurstMessage({
      guildId,
      userId,
      messageId: "older",
      messageTimestampMs: 100,
      windowMs: 50,
    }),
    1,
  );
  assert.equal(
    await store.recordBurstMessage({
      guildId,
      userId,
      messageId: "older",
      messageTimestampMs: 100,
      windowMs: 50,
    }),
    1,
  );

  const counts = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      store.recordBurstMessage({
        guildId: "guild-mention-burst-concurrent",
        userId: "user-concurrent",
        messageId: `message-${index}`,
        messageTimestampMs: 1_000,
        windowMs: 1_000,
      }),
    ),
  );
  assert.deepEqual(
    [...counts].sort((left, right) => left - right),
    [1, 2, 3, 4, 5],
  );
  assert.equal(await countBurstRows(database, "guild-mention-burst-concurrent"), 5);

  await store.clearBurstWindow(guildId);
  assert.equal(await countBurstRows(database, guildId), 0);
}

async function verifyMentionProtectionBurstUserConcurrency(
  database: PostgresDatabaseCapability,
): Promise<void> {
  const store = createPostgresMentionProtectionStore(database);
  const guildId = "guild-mention-burst-users";
  await database.execute(`
    CREATE FUNCTION haf_test_pause_mention_burst() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.guild_id = 'guild-mention-burst-users' AND NEW.user_id = 'user-blocked' THEN
        PERFORM pg_advisory_xact_lock(73938212, 1);
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await database.execute(`
    CREATE TRIGGER haf_test_pause_mention_burst
    BEFORE INSERT ON mention_protection_burst_events
    FOR EACH ROW EXECUTE FUNCTION haf_test_pause_mention_burst()
  `);
  let releaseGate!: () => void;
  let markGateReady!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const gateReady = new Promise<void>((resolve) => {
    markGateReady = resolve;
  });
  const blocker = database.transaction(async (transaction) => {
    await transaction.query("SELECT pg_advisory_xact_lock(73938212, 1)");
    markGateReady();
    await gate;
  });
  let blocked: Promise<number> | undefined;
  try {
    await Promise.race([gateReady, blocker]);
    blocked = store.recordBurstMessage({
      guildId,
      userId: "user-blocked",
      messageId: "message-blocked",
      messageTimestampMs: 1_000,
      windowMs: 1_000,
    });
    await waitForMentionBurstInsertLock(database);
    const parallel = await Promise.race([
      store.recordBurstMessage({
        guildId,
        userId: "user-parallel",
        messageId: "message-parallel",
        messageTimestampMs: 1_000,
        windowMs: 1_000,
      }),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2_000)),
    ]);
    assert.equal(parallel, 1, "Separate members must record bursts without waiting");
  } finally {
    releaseGate();
    await Promise.allSettled([blocker, blocked]);
    await database.execute(
      "DROP TRIGGER IF EXISTS haf_test_pause_mention_burst ON mention_protection_burst_events",
    );
    await database.execute("DROP FUNCTION IF EXISTS haf_test_pause_mention_burst()");
  }
  assert.equal(await blocked, 1);
  assert.equal(await countBurstRows(database, guildId), 2);
}

async function waitForMentionBurstInsertLock(database: PostgresDatabaseCapability): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await database.query<{ blocked: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_stat_activity
         WHERE datname = current_database()
           AND pid <> pg_backend_pid()
           AND state = 'active'
           AND wait_event_type = 'Lock'
           AND query ILIKE '%insert into%'
           AND query ILIKE '%mention_protection_burst_events%'
       ) AS blocked`,
    );
    if (rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Expected blocked Mention Protection burst insert");
}

async function verifyMentionProtectionBreachDeduplication(
  database: PostgresDatabaseCapability,
): Promise<void> {
  const store = createPostgresMentionProtectionStore(database);
  const guildId = "guild-mention-breaches";
  const userId = "user-mention";
  const detection = mentionDetection("admin");

  const initial = await store.claimMessageBreaches(
    mentionClaim(guildId, "message-1", userId, 10_000, [detection]),
  );
  assert.equal(initial.length, 1);
  assert.equal(initial[0]?.stage, "initial");
  assert.deepEqual(initial[0]?.responsePolicy, detection.initialResponse);
  assert.equal(initial[0]?.contentSnapshot, "message content");

  assert.deepEqual(
    await store.claimMessageBreaches(
      mentionClaim(guildId, "message-1", userId, 10_000, [detection]),
    ),
    initial,
  );
  assert.equal(await countBreaches(database, guildId, "message-1"), 1);

  const repeated = await store.claimMessageBreaches(
    mentionClaim(guildId, "message-2", userId, 10_500, [detection]),
  );
  assert.equal(repeated[0]?.stage, "repeat");
  assert.deepEqual(repeated[0]?.responsePolicy, detection.repeatResponse);

  const afterRepeatPeriod = await store.claimMessageBreaches(
    mentionClaim(guildId, "message-3", userId, 12_000, [detection]),
  );
  assert.equal(afterRepeatPeriod[0]?.stage, "initial");

  const otherGuild = await store.claimMessageBreaches(
    mentionClaim("guild-mention-breaches-other", "message-1", userId, 10_000, [detection]),
  );
  assert.equal(otherGuild[0]?.stage, "initial");
  assert.equal(otherGuild[0]?.guildId, "guild-mention-breaches-other");

  const multipleProtections = await store.claimMessageBreaches(
    mentionClaim(guildId, "message-4", userId, 20_000, [
      mentionDetection("spam"),
      mentionDetection("admin"),
    ]),
  );
  assert.deepEqual(
    multipleProtections.map((breach) => breach.protection),
    ["admin", "spam"],
  );

  const concurrent = mentionClaim(guildId, "message-concurrent", "user-concurrent", 30_000, [
    mentionDetection("spam"),
  ]);
  const concurrentResults = await Promise.all([
    store.claimMessageBreaches(concurrent),
    store.claimMessageBreaches(concurrent),
  ]);
  assert.deepEqual(
    concurrentResults.map((result) => result.length),
    [1, 1],
  );
  assert.equal(await countBreaches(database, guildId, "message-concurrent"), 1);

  const retentionGuild = "guild-mention-retention";
  await store.claimMessageBreaches(
    mentionClaim(retentionGuild, "message-old", "user-retention", 1_000, [
      mentionDetection("spam"),
    ]),
  );
  const laterNow = 1_000 + 90 * 24 * 60 * 60 * 1_000 + 1;
  await store.claimMessageBreaches(
    mentionClaim(retentionGuild, "message-new", "user-retention", laterNow, [
      mentionDetection("spam"),
    ]),
  );
  const retained = await database.query<{ message_id: string }>(
    `SELECT message_id FROM mention_protection_breaches
     WHERE guild_id = $1
     ORDER BY message_id`,
    [retentionGuild],
  );
  assert.deepEqual(
    retained.map((row) => row.message_id),
    ["message-new"],
  );
}

async function verifyMentionProtectionActionFencing(
  database: PostgresDatabaseCapability,
): Promise<void> {
  const store = createPostgresMentionProtectionStore(database);
  const guildId = "guild-mention-actions";
  const messageId = "message-actions";
  const claims = await Promise.all(
    Array.from({ length: 4 }, () => store.claimAction(guildId, messageId, "delete", 100_000)),
  );
  assert.equal(claims.filter((claim) => claim === "claimed").length, 1);
  assert.equal(claims.filter((claim) => claim === "deferred").length, 3);
  assert.equal(await store.claimAction(guildId, messageId, "delete", 100_001), "deferred");
  assert.equal(await store.claimAction(guildId, messageId, "delete", 160_001), "claimed");
  await store.recordActionOutcome({
    guildId,
    messageId,
    action: "delete",
    status: "failed",
    retryable: true,
    updatedAtMs: 160_002,
  });
  assert.equal(await store.claimAction(guildId, messageId, "delete", 160_003), "claimed");
  await store.recordActionOutcome({
    guildId,
    messageId,
    action: "delete",
    status: "failed",
    retryable: true,
    updatedAtMs: 160_004,
  });
  assert.equal(await store.claimAction(guildId, messageId, "delete", 160_005), "satisfied");
  await store.recordActionOutcome({
    guildId,
    messageId,
    action: "delete",
    status: "succeeded",
    updatedAtMs: 160_006,
  });
  assert.equal(await store.claimAction(guildId, messageId, "delete", 160_007), "satisfied");
  assert.equal(await store.claimAction(guildId, messageId, "reply", 160_007), "claimed");
  assert.equal(
    await store.claimAction("guild-mention-actions-other", messageId, "delete", 160_007),
    "claimed",
  );

  const attempts = await database.query<{ attempt_count: string }>(
    `SELECT attempt_count FROM mention_protection_action_outcomes
     WHERE guild_id = $1 AND message_id = $2 AND action = $3`,
    [guildId, messageId, "delete"],
  );
  assert.equal(Number(attempts[0]?.attempt_count), 3);

  const staleMessage = "message-stale";
  assert.equal(await store.claimAction(guildId, staleMessage, "timeout", 200_000), "claimed");
  const recovered = await Promise.all([
    store.claimAction(guildId, staleMessage, "timeout", 260_001),
    store.claimAction(guildId, staleMessage, "timeout", 260_001),
  ]);
  assert.equal(recovered.filter((claim) => claim === "claimed").length, 1);
  assert.equal(recovered.filter((claim) => claim === "deferred").length, 1);

  const nonRetryable = "message-non-retryable";
  assert.equal(await store.claimAction(guildId, nonRetryable, "reply", 300_000), "claimed");
  await store.recordActionOutcome({
    guildId,
    messageId: nonRetryable,
    action: "reply",
    status: "failed",
    retryable: false,
    updatedAtMs: 300_001,
  });
  assert.equal(await store.claimAction(guildId, nonRetryable, "reply", 300_002), "satisfied");
}

function imageRulesConfig(
  guildId: string,
  overrides: Partial<ImageRulesConfig> = {},
): ImageRulesConfig {
  return {
    guildId,
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
    auditOnTopic: false,
    dryRun: false,
    createdAtMs: 100,
    updatedAtMs: 100,
    ...overrides,
  };
}

function imageQueueItem(
  guildId: string,
  channelId: string,
  messageId: string,
): Omit<ImageRulesModQueueItem, "id"> {
  return {
    guildId,
    channelId,
    messageId,
    authorId: "user-image",
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
  };
}

function botDefenseConfig(
  guildId: string,
  overrides: Partial<BotDefenseConfig> = {},
): BotDefenseConfig {
  return {
    guildId,
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
    ...overrides,
  };
}

function rateEvidence(): BotDefenseEvidence {
  return {
    kind: "rate",
    channelIds: ["channel-1", "channel-2"],
    channelCount: 2,
    windowSeconds: 60,
    matchKind: "image-attachments",
    attachmentCount: 4,
  };
}

async function openFlag(
  store: ReturnType<typeof createPostgresBotDefenseStore>,
  guildId: string,
  userId: string,
): Promise<BotFlag> {
  const flag = await store.openBotFlag(guildId, userId, "honeypot", {
    kind: "honeypot",
    channelId: "channel-1",
    messageId: "message-1",
  });
  assert.ok(flag);
  return flag;
}

function mentionProtectionConfig(
  guildId: string,
  overrides: Partial<MentionProtectionConfig> = {},
): MentionProtectionConfig {
  return {
    guildId,
    adminEnabled: true,
    spamEnabled: true,
    protectedAdminRoleIds: ["admin-role"],
    channelMode: "exclude",
    channelIds: ["channel-excluded"],
    excludedRoleIds: ["role-excluded"],
    massMentionThreshold: 5,
    burstMessageThreshold: 5,
    burstWindowSeconds: 10,
    adminRepeatPeriodMs: 86_400_000,
    spamRepeatPeriodMs: 86_400_000,
    adminInitialResponse: {
      reply: true,
      delete: false,
      restriction: { type: "none" },
    },
    adminRepeatResponse: {
      reply: true,
      delete: true,
      restriction: { type: "timeout", durationMs: 60_000 },
    },
    spamInitialResponse: {
      reply: true,
      delete: true,
      restriction: { type: "none" },
    },
    spamRepeatResponse: {
      reply: false,
      delete: true,
      restriction: { type: "timed-role", roleId: "muted-role", durationMs: 300_000 },
    },
    createdAtMs: 100,
    updatedAtMs: 100,
    ...overrides,
  };
}

function mentionDetection(
  protection: MentionProtectionDetection["protection"],
  overrides: Partial<MentionProtectionDetection> = {},
): MentionProtectionDetection {
  return {
    protection,
    condition: protection === "admin" ? "admin-mention" : "mass-mention",
    repeatPeriodMs: 1_000,
    initialResponse: {
      reply: true,
      delete: false,
      restriction: { type: "none" },
    },
    repeatResponse: {
      reply: true,
      delete: true,
      restriction: { type: "timeout", durationMs: 60_000 },
    },
    evidence: { source: "postgres-contract", protection },
    ...overrides,
  };
}

function mentionClaim(
  guildId: string,
  messageId: string,
  userId: string,
  nowMs: number,
  detections: MentionProtectionDetection[],
): MentionProtectionClaimInput {
  return {
    guildId,
    messageId,
    userId,
    channelId: "channel-mention",
    messageCreatedAtMs: nowMs - 100,
    contentSnapshot: "message content",
    nowMs,
    detections,
  };
}

async function countBurstRows(
  database: PostgresDatabaseCapability,
  guildId: string,
): Promise<number> {
  const rows = await database.query<{ count: number }>(
    "SELECT COUNT(*)::INTEGER AS count FROM mention_protection_burst_events WHERE guild_id = $1",
    [guildId],
  );
  return rows[0]?.count ?? 0;
}

async function countBreaches(
  database: PostgresDatabaseCapability,
  guildId: string,
  messageId: string,
): Promise<number> {
  const rows = await database.query<{ count: number }>(
    `SELECT COUNT(*)::INTEGER AS count FROM mention_protection_breaches
     WHERE guild_id = $1 AND message_id = $2`,
    [guildId, messageId],
  );
  return rows[0]?.count ?? 0;
}

function singleWinner<T>(values: (T | null)[]): T {
  const winners = values.filter((value): value is T => value !== null);
  assert.equal(winners.length, 1);
  return winners[0]!;
}

async function assertRejectsWithMessage(
  operation: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    const messages: string[] = [];
    let current: unknown = error;
    while (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
    }
    assert.ok(
      messages.some((message) => pattern.test(message)),
      `Expected rejection matching ${pattern}, received: ${messages.join(" <- ")}`,
    );
    return;
  }
  assert.fail(`Expected rejection matching ${pattern}`);
}
