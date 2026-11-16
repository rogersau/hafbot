import assert from "node:assert/strict";
import test from "node:test";
import type { ImageRulesConfig, ImageRulesModQueueItem } from "../src/types";
import { createPostgresBotDefenseStore } from "../src/runtime/postgres/postgres-bot-defense-store";
import { createPostgresImageRulesStore } from "../src/runtime/postgres/postgres-image-rules-store";
import { createPostgresDatabaseCapabilityFromEnvironment } from "../src/runtime/postgres/postgres-capability";
import { initializePostgresSchema } from "../src/runtime/postgres/postgres-schema";

const postgresUrl = process.env.TEST_POSTGRES_URL;

test(
  "native PostgreSQL moderation preserves Guild boundaries, concurrent claims and generation fencing",
  { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
  async () => {
    assert.ok(postgresUrl);
    const url = new URL(postgresUrl);
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || !url.pathname.endsWith("_test")) {
      throw new Error("PostgreSQL integration tests require a local database ending in _test.");
    }
    const database = createPostgresDatabaseCapabilityFromEnvironment({
      DATABASE_URL: postgresUrl,
      NODE_ENV: "test",
    });
    try {
      await database.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
      await initializePostgresSchema(database);
      const botDefense = createPostgresBotDefenseStore(database);
      const defaults = await botDefense.readConfig("guild-1");
      assert.ok(defaults);
      const config = {
        ...defaults,
        honeypotEnabled: true,
        honeypotWarnUser: true,
        honeypotDeleteMessage: true,
        rateEnabled: true,
        rateWarnUser: false,
        rateDeleteMessage: true,
        honeypotChannelIds: ["honeypot"],
        excludedRoleIds: ["trusted"],
        modRoleIds: ["staff"],
        modQueueChannelId: "queue",
        pingOnQueuePost: false,
      };
      await botDefense.upsertConfig(config);
      assert.deepEqual(await botDefense.readConfig("guild-1"), config);
      assert.equal((await botDefense.readConfig("guild-2"))?.honeypotEnabled, false);
      const evidence = { kind: "honeypot" as const, channelId: "trap", messageId: "message" };
      const claims = await Promise.all([
        botDefense.openBotFlag("guild-1", "member", "honeypot", evidence),
        botDefense.openBotFlag("guild-1", "member", "honeypot", evidence),
      ]);
      const opened = claims.find((flag) => flag !== null);
      assert.ok(opened);
      assert.equal(claims.filter(Boolean).length, 1);
      assert.equal(await botDefense.readOpenBotFlag("guild-2", "member"), null);
      assert.equal(
        await botDefense.resolveBotFlag(
          "guild-1",
          "member",
          opened.createdAtMs - 1,
          "dismissed",
          "staff",
        ),
        null,
      );
      assert.ok(
        await botDefense.resolveBotFlag(
          "guild-1",
          "member",
          opened.createdAtMs,
          "dismissed",
          "staff",
        ),
      );
      const reopened = await botDefense.openBotFlag("guild-1", "member", "honeypot", evidence);
      assert.ok(reopened);
      assert.ok(reopened.createdAtMs > opened.createdAtMs);
      await botDefense.setBotFlagQueueMessage(
        "guild-1",
        "member",
        opened.createdAtMs,
        "stale",
        Date.now(),
      );
      assert.equal((await botDefense.readOpenBotFlag("guild-1", "member"))?.queueMessageId, null);
      assert.ok(
        await botDefense.resolveBotFlag(
          "guild-1",
          "member",
          reopened.createdAtMs,
          "confirmed",
          "staff",
        ),
      );
      assert.equal(await botDefense.openBotFlag("guild-1", "member", "honeypot", evidence), null);
      assert.equal(await botDefense.isConfirmedMember("guild-1", "member"), true);

      await Promise.all([
        botDefense.recordRateMessage("guild-1", "member", "old", "same", 800),
        botDefense.recordRateMessage("guild-1", "member", "recent", "same", 950),
        botDefense.recordRateMessage("guild-1", "member", "other-content", "different", 960),
        botDefense.recordRateMessage("guild-1", "member", "future", "same", 1050),
        botDefense.recordRateMessage("guild-2", "member", "foreign", "same", 950),
      ]);
      assert.deepEqual(
        await botDefense.listMatchingMessageChannelsInWindow(
          "guild-1",
          "member",
          "same",
          100,
          1000,
        ),
        ["recent"],
      );
      assert.deepEqual(
        await botDefense.listMatchingMessageChannelsInWindow(
          "guild-2",
          "member",
          "same",
          100,
          1000,
        ),
        ["foreign"],
      );

      const images = createPostgresImageRulesStore(database);
      const imageConfig: ImageRulesConfig = {
        guildId: "guild-1",
        enabled: true,
        topicDescription: "Game screenshots",
        autoDeleteThreshold: 0.85,
        modReviewThreshold: 0.65,
        targetChannelIds: ["screenshots"],
        excludedRoleIds: ["staff"],
        modQueueChannelId: "queue",
        modRoleIds: ["moderator"],
        pingOnQueuePost: false,
        reactOnTopic: true,
        auditOnTopic: false,
        dryRun: false,
        createdAtMs: 100,
        updatedAtMs: 100,
      };
      await images.upsertConfig(imageConfig);
      assert.deepEqual(await images.readConfig("guild-1"), imageConfig);
      assert.equal(await images.readConfig("guild-2"), null);
      const item = await images.createModQueueItem(queueItem("guild-1"));
      assert.equal((await images.createModQueueItem(queueItem("guild-1"))).id, item.id);
      assert.notEqual((await images.createModQueueItem(queueItem("guild-2"))).id, item.id);
      const restores = await Promise.all([
        images.claimModQueueItemRestore(item.id, "first", "staff", 200, 100),
        images.claimModQueueItemRestore(item.id, "second", "staff", 200, 100),
      ]);
      const restore = restores.find((entry) => entry !== null);
      assert.ok(restore);
      assert.equal(restores.filter(Boolean).length, 1);
      assert.equal(await images.markModQueueItemApproved(item.id, "staff", 210), null);
      assert.ok(await images.claimModQueueItemRestore(item.id, "reclaimed", "staff-2", 301, 100));
      assert.equal(
        await images.markModQueueItemRestored(
          item.id,
          restore.restoreClaimToken!,
          "staff",
          "stale-message",
          302,
        ),
        null,
      );
      assert.ok(
        await images.markModQueueItemRestored(
          item.id,
          "reclaimed",
          "staff-2",
          "restored-message",
          303,
        ),
      );
      assert.equal(await images.claimModQueueItemRestore(item.id, "late", "staff", 500, 100), null);
      const persisted = await createPostgresImageRulesStore(database).readModQueueItem(item.id);
      assert.equal(persisted?.status, "restored");
      assert.equal(persisted?.restoredMessageId, "restored-message");
      await images.deleteConfig("guild-1");
      assert.equal(await images.readConfig("guild-1"), null);
    } finally {
      await database.close();
    }
  },
);

function queueItem(guildId: string): Omit<ImageRulesModQueueItem, "id"> {
  return {
    guildId,
    channelId: "screenshots",
    messageId: "message",
    authorId: "member",
    imageUrl: "https://cdn.discordapp.com/attachments/example.png",
    topicDescription: "Game screenshots",
    offTopicConfidence: 0.7,
    onTopicConfidence: 0.3,
    status: "pending",
    queueChannelId: "queue",
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
