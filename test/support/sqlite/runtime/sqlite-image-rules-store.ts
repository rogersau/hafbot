import {
  modQueueItemToRow,
  mapModQueueItemRow,
  mapConfigRow,
  configToRow,
} from "../../../../src/runtime/image-rules-records";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { imageRulesConfigs, imageRulesModQueueItems } from "../db/app-schema";
import type { ImageRulesModQueueItem } from "../../../../src/types";
import type { ImageRulesStore } from "../../../../src/runtime/contracts/image-rules-store";
import { createD1DrizzleDatabase } from "./drizzle-db";

const storeCache = new WeakMap<D1Database, ImageRulesStore>();

export function createSqliteImageRulesStore(database: D1Database): ImageRulesStore {
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
