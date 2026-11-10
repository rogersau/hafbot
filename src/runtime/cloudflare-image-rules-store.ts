import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { appConfig, imageRulesConfigs, imageRulesModQueueItems } from "../db/app-schema";
import type { ImageRulesConfig, ImageRulesModQueueItem } from "../types";
import type { ImageRulesStore } from "./contracts/image-rules-store";
import { createD1DrizzleDatabase } from "./drizzle-db";

type ImageRulesConfigRow = typeof imageRulesConfigs.$inferSelect;
type ImageRulesConfigInsert = typeof imageRulesConfigs.$inferInsert;
type ImageRulesModQueueItemRow = typeof imageRulesModQueueItems.$inferSelect;
type ImageRulesModQueueItemInsert = typeof imageRulesModQueueItems.$inferInsert;

const RESTORE_CLAIMS_ENABLED_AT_KEY = "image_rules_restore_claims_enabled_at_ms";
const storeCache = new WeakMap<D1Database, ImageRulesStore>();

export function createCloudflareImageRulesStore(database: D1Database): ImageRulesStore {
  const cached = storeCache.get(database);
  if (cached) return cached;

  const db = createD1DrizzleDatabase(database);
  const store: ImageRulesStore = {
    async readConfig(guildId) {
      const row = await db
        .select()
        .from(imageRulesConfigs)
        .where(eq(imageRulesConfigs.guildId, guildId))
        .limit(1)
        .get();
      return row ? mapConfigRow(row) : null;
    },

    async upsertConfig(config) {
      const values = configToRow(config);
      await db
        .insert(imageRulesConfigs)
        .values(values)
        .onConflictDoUpdate({
          target: imageRulesConfigs.guildId,
          set: {
            enabled: values.enabled,
            topicDescription: values.topicDescription,
            autoDeleteThreshold: values.autoDeleteThreshold,
            modReviewThreshold: values.modReviewThreshold,
            targetChannelIdsJson: values.targetChannelIdsJson,
            excludedRoleIdsJson: values.excludedRoleIdsJson,
            modQueueChannelId: values.modQueueChannelId,
            modRoleIdsJson: values.modRoleIdsJson,
            pingOnQueuePost: values.pingOnQueuePost,
            reactOnTopic: values.reactOnTopic,
            auditOnTopic: values.auditOnTopic,
            dryRun: values.dryRun,
            updatedAtMs: values.updatedAtMs,
          },
        })
        .run();
    },

    async deleteConfig(guildId) {
      await db.delete(imageRulesConfigs).where(eq(imageRulesConfigs.guildId, guildId)).run();
    },

    async createModQueueItem(item) {
      const next: ImageRulesModQueueItem = { ...item, id: crypto.randomUUID() };
      await db
        .insert(imageRulesModQueueItems)
        .values(modQueueItemToRow(next))
        .onConflictDoNothing()
        .run();
      const persisted = await db
        .select()
        .from(imageRulesModQueueItems)
        .where(
          and(
            eq(imageRulesModQueueItems.guildId, item.guildId),
            eq(imageRulesModQueueItems.channelId, item.channelId),
            eq(imageRulesModQueueItems.messageId, item.messageId),
          ),
        )
        .limit(1)
        .get();
      if (!persisted) throw new Error("Image Rules Mod Queue item was not persisted.");
      return mapModQueueItemRow(persisted);
    },

    async readModQueueItem(itemId) {
      const row = await db
        .select()
        .from(imageRulesModQueueItems)
        .where(eq(imageRulesModQueueItems.id, itemId))
        .limit(1)
        .get();
      return row ? mapModQueueItemRow(row) : null;
    },

    async setModQueueItemQueueMessage(itemId, queueChannelId, queueMessageId, nowMs) {
      await db
        .update(imageRulesModQueueItems)
        .set({ queueChannelId, queueMessageId, updatedAtMs: nowMs })
        .where(eq(imageRulesModQueueItems.id, itemId))
        .run();
    },

    async claimModQueueItemRestore(itemId, claimToken, actorUserId, nowMs, leaseMs) {
      const row = await db
        .update(imageRulesModQueueItems)
        .set({
          restoreClaimToken: claimToken,
          restoreClaimExpiresAtMs: nowMs + leaseMs,
          failureReason: null,
          decidedByUserId: sql`COALESCE(${imageRulesModQueueItems.decidedByUserId}, ${actorUserId})`,
          decidedAtMs: sql`COALESCE(${imageRulesModQueueItems.decidedAtMs}, ${nowMs})`,
          updatedAtMs: nowMs,
        })
        .where(
          and(
            eq(imageRulesModQueueItems.id, itemId),
            eq(imageRulesModQueueItems.status, "pending"),
            sql`CAST(COALESCE((SELECT ${appConfig.value} FROM ${appConfig} WHERE ${appConfig.key} = ${RESTORE_CLAIMS_ENABLED_AT_KEY}), '0') AS INTEGER) <= ${nowMs}`,
            or(
              isNull(imageRulesModQueueItems.restoreClaimToken),
              isNull(imageRulesModQueueItems.restoreClaimExpiresAtMs),
              lte(imageRulesModQueueItems.restoreClaimExpiresAtMs, nowMs),
            ),
          ),
        )
        .returning()
        .get();
      return row ? mapModQueueItemRow(row) : null;
    },

    async markModQueueItemApproved(itemId, actorUserId, nowMs) {
      const row = await db
        .update(imageRulesModQueueItems)
        .set({
          status: "approved",
          decidedByUserId: actorUserId,
          decidedAtMs: nowMs,
          updatedAtMs: nowMs,
        })
        .where(
          and(
            eq(imageRulesModQueueItems.id, itemId),
            eq(imageRulesModQueueItems.status, "pending"),
            isNull(imageRulesModQueueItems.restoreClaimToken),
          ),
        )
        .returning()
        .get();
      return row ? mapModQueueItemRow(row) : null;
    },

    async markModQueueItemRestored(itemId, claimToken, actorUserId, restoredMessageId, nowMs) {
      const row = await db
        .update(imageRulesModQueueItems)
        .set({
          status: "restored",
          decidedByUserId: actorUserId,
          decidedAtMs: nowMs,
          updatedAtMs: nowMs,
          failureReason: null,
          restoreClaimToken: null,
          restoreClaimExpiresAtMs: null,
          restoredMessageId,
        })
        .where(
          and(
            eq(imageRulesModQueueItems.id, itemId),
            eq(imageRulesModQueueItems.status, "pending"),
            eq(imageRulesModQueueItems.restoreClaimToken, claimToken),
          ),
        )
        .returning()
        .get();
      return row ? mapModQueueItemRow(row) : null;
    },

    async markModQueueItemRestoreFailed(itemId, claimToken, actorUserId, failureReason, nowMs) {
      const row = await db
        .update(imageRulesModQueueItems)
        .set({
          status: "restore_failed",
          decidedByUserId: actorUserId,
          decidedAtMs: nowMs,
          updatedAtMs: nowMs,
          failureReason,
          restoreClaimToken: null,
          restoreClaimExpiresAtMs: null,
          restoredMessageId: null,
        })
        .where(
          and(
            eq(imageRulesModQueueItems.id, itemId),
            eq(imageRulesModQueueItems.status, "pending"),
            eq(imageRulesModQueueItems.restoreClaimToken, claimToken),
          ),
        )
        .returning()
        .get();
      return row ? mapModQueueItemRow(row) : null;
    },
  };

  storeCache.set(database, store);
  return store;
}

function modQueueItemToRow(item: ImageRulesModQueueItem): ImageRulesModQueueItemInsert {
  return { ...item };
}

function mapModQueueItemRow(row: ImageRulesModQueueItemRow): ImageRulesModQueueItem {
  return {
    id: row.id,
    guildId: row.guildId,
    channelId: row.channelId,
    messageId: row.messageId,
    authorId: row.authorId,
    imageUrl: row.imageUrl,
    topicDescription: row.topicDescription,
    offTopicConfidence: row.offTopicConfidence,
    onTopicConfidence: row.onTopicConfidence,
    status: row.status as ImageRulesModQueueItem["status"],
    queueChannelId: row.queueChannelId,
    queueMessageId: row.queueMessageId,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
    decidedByUserId: row.decidedByUserId,
    decidedAtMs: row.decidedAtMs,
    failureReason: row.failureReason,
    restoreClaimToken: row.restoreClaimToken,
    restoreClaimExpiresAtMs: row.restoreClaimExpiresAtMs,
    restoredMessageId: row.restoredMessageId,
  };
}

function mapConfigRow(row: ImageRulesConfigRow): ImageRulesConfig {
  return {
    guildId: row.guildId,
    enabled: row.enabled === 1,
    topicDescription: row.topicDescription,
    autoDeleteThreshold: row.autoDeleteThreshold,
    modReviewThreshold: row.modReviewThreshold,
    targetChannelIds: parseJsonStringArray(row.targetChannelIdsJson),
    excludedRoleIds: parseJsonStringArray(row.excludedRoleIdsJson),
    modQueueChannelId: row.modQueueChannelId ?? null,
    modRoleIds: parseJsonStringArray(row.modRoleIdsJson),
    pingOnQueuePost: row.pingOnQueuePost === 1,
    reactOnTopic: row.reactOnTopic === 1,
    auditOnTopic: row.auditOnTopic === 1,
    dryRun: row.dryRun === 1,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

function configToRow(config: ImageRulesConfig): ImageRulesConfigInsert {
  return {
    guildId: config.guildId,
    enabled: config.enabled ? 1 : 0,
    topicDescription: config.topicDescription,
    autoDeleteThreshold: config.autoDeleteThreshold,
    modReviewThreshold: config.modReviewThreshold,
    targetChannelIdsJson: JSON.stringify(config.targetChannelIds),
    excludedRoleIdsJson: JSON.stringify(config.excludedRoleIds),
    modQueueChannelId: config.modQueueChannelId,
    modRoleIdsJson: JSON.stringify(config.modRoleIds),
    pingOnQueuePost: config.pingOnQueuePost ? 1 : 0,
    reactOnTopic: config.reactOnTopic ? 1 : 0,
    auditOnTopic: config.auditOnTopic ? 1 : 0,
    dryRun: config.dryRun ? 1 : 0,
    createdAtMs: config.createdAtMs,
    updatedAtMs: config.updatedAtMs,
  };
}

function parseJsonStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}
