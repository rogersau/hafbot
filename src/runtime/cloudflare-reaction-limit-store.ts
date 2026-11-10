import { and, asc, eq, sql } from "drizzle-orm";
import {
  reactionLimitBreachCounters,
  reactionLimitConfigs,
  reactionLimitMessageReactionCounts,
  reactionLimitUserMessageReactionCounts,
} from "../db/app-schema";
import type { ChannelFilterMode, ReactionLimitBreachCounter, ReactionLimitConfig } from "../types";
import type { ReactionLimitStore } from "./contracts/reaction-limit-store";
import { createD1DrizzleDatabase } from "./drizzle-db";

type ReactionLimitConfigRow = typeof reactionLimitConfigs.$inferSelect;
type ReactionLimitConfigInsert = typeof reactionLimitConfigs.$inferInsert;
type ReactionLimitBreachCounterInsert = typeof reactionLimitBreachCounters.$inferInsert;
type ReactionLimitMessageReactionCountInsert =
  typeof reactionLimitMessageReactionCounts.$inferInsert;
type ReactionLimitUserMessageReactionCountInsert =
  typeof reactionLimitUserMessageReactionCounts.$inferInsert;

const reactionLimitStoreCache = new WeakMap<D1Database, ReactionLimitStore>();
const DEFAULT_RETENTION_PURGE_LIMIT_PER_TABLE = 500;

export function createCloudflareReactionLimitStore(database: D1Database): ReactionLimitStore {
  const cached = reactionLimitStoreCache.get(database);
  if (cached) {
    return cached;
  }

  const db = createD1DrizzleDatabase(database);
  const store: ReactionLimitStore = {
    async readReactionLimitConfig(guildId: string): Promise<ReactionLimitConfig | null> {
      const row = await db
        .select()
        .from(reactionLimitConfigs)
        .where(eq(reactionLimitConfigs.guildId, guildId))
        .limit(1)
        .get();

      return row ? mapConfigRow(row) : null;
    },

    async upsertReactionLimitConfig(config: ReactionLimitConfig): Promise<void> {
      const values = configToRow(config);
      await db
        .insert(reactionLimitConfigs)
        .values(values)
        .onConflictDoUpdate({
          target: reactionLimitConfigs.guildId,
          set: {
            limitsEnabled: values.limitsEnabled,
            maxReactionsPerMessage: values.maxReactionsPerMessage,
            maxReactionsPerUserPerMessage: values.maxReactionsPerUserPerMessage,
            breachThreshold: values.breachThreshold,
            breachRoleId: values.breachRoleId,
            breachRoleDurationMs: values.breachRoleDurationMs,
            breachDmText: values.breachDmText,
            channelMode: values.channelMode,
            channelIdsJson: values.channelIdsJson,
          },
        })
        .run();
    },

    async incrementBreachCounter(guildId: string, userId: string): Promise<number> {
      const values: ReactionLimitBreachCounterInsert = { guildId, userId, breachCount: 1 };
      const row = await db
        .insert(reactionLimitBreachCounters)
        .values(values)
        .onConflictDoUpdate({
          target: [reactionLimitBreachCounters.guildId, reactionLimitBreachCounters.userId],
          set: { breachCount: sql`${reactionLimitBreachCounters.breachCount} + 1` },
        })
        .returning({ breachCount: reactionLimitBreachCounters.breachCount })
        .get();
      return row?.breachCount ?? 1;
    },

    async incrementMessageReactionCount(
      guildId: string,
      channelId: string,
      messageId: string,
    ): Promise<number> {
      const updatedAtMs = Date.now();
      const values: ReactionLimitMessageReactionCountInsert = {
        guildId,
        channelId,
        messageId,
        reactionCount: 1,
        updatedAtMs,
      };
      const row = await db
        .insert(reactionLimitMessageReactionCounts)
        .values(values)
        .onConflictDoUpdate({
          target: [
            reactionLimitMessageReactionCounts.guildId,
            reactionLimitMessageReactionCounts.channelId,
            reactionLimitMessageReactionCounts.messageId,
          ],
          set: {
            reactionCount: sql`${reactionLimitMessageReactionCounts.reactionCount} + 1`,
            updatedAtMs,
          },
        })
        .returning({ reactionCount: reactionLimitMessageReactionCounts.reactionCount })
        .get();
      return row?.reactionCount ?? 1;
    },

    async incrementUserMessageReactionCount(
      guildId: string,
      channelId: string,
      messageId: string,
      userId: string,
    ): Promise<number> {
      const updatedAtMs = Date.now();
      const values: ReactionLimitUserMessageReactionCountInsert = {
        guildId,
        channelId,
        messageId,
        userId,
        reactionCount: 1,
        updatedAtMs,
      };
      const row = await db
        .insert(reactionLimitUserMessageReactionCounts)
        .values(values)
        .onConflictDoUpdate({
          target: [
            reactionLimitUserMessageReactionCounts.guildId,
            reactionLimitUserMessageReactionCounts.channelId,
            reactionLimitUserMessageReactionCounts.messageId,
            reactionLimitUserMessageReactionCounts.userId,
          ],
          set: {
            reactionCount: sql`${reactionLimitUserMessageReactionCounts.reactionCount} + 1`,
            updatedAtMs,
          },
        })
        .returning({ reactionCount: reactionLimitUserMessageReactionCounts.reactionCount })
        .get();
      return row?.reactionCount ?? 1;
    },

    async readBreachCounters(guildId: string): Promise<ReactionLimitBreachCounter[]> {
      const rows = await db
        .select()
        .from(reactionLimitBreachCounters)
        .where(eq(reactionLimitBreachCounters.guildId, guildId))
        .orderBy(asc(reactionLimitBreachCounters.userId))
        .all();
      return rows.map((row) => ({
        guildId: row.guildId,
        userId: row.userId,
        breachCount: row.breachCount,
      }));
    },

    async resetBreachCounter(guildId: string, userId: string): Promise<void> {
      await db
        .delete(reactionLimitBreachCounters)
        .where(
          and(
            eq(reactionLimitBreachCounters.guildId, guildId),
            eq(reactionLimitBreachCounters.userId, userId),
          ),
        )
        .run();
    },

    async resetAllBreachCounters(guildId: string): Promise<void> {
      await db
        .delete(reactionLimitBreachCounters)
        .where(eq(reactionLimitBreachCounters.guildId, guildId))
        .run();
    },

    async purgeExpiredCounters(
      cutoffMs: number,
      limitPerTable = DEFAULT_RETENTION_PURGE_LIMIT_PER_TABLE,
    ): Promise<number> {
      assertValidPurgeLimit(limitPerTable);
      const messageCounts = await database
        .prepare(
          `DELETE FROM reaction_limit_message_reaction_counts
           WHERE rowid IN (
             SELECT rowid FROM reaction_limit_message_reaction_counts
             WHERE updated_at_ms < ? ORDER BY updated_at_ms ASC LIMIT ?
           )`,
        )
        .bind(cutoffMs, limitPerTable)
        .run();
      const userCounts = await database
        .prepare(
          `DELETE FROM reaction_limit_user_message_reaction_counts
           WHERE rowid IN (
             SELECT rowid FROM reaction_limit_user_message_reaction_counts
             WHERE updated_at_ms < ? ORDER BY updated_at_ms ASC LIMIT ?
           )`,
        )
        .bind(cutoffMs, limitPerTable)
        .run();
      return (messageCounts.meta.changes ?? 0) + (userCounts.meta.changes ?? 0);
    },
  };

  reactionLimitStoreCache.set(database, store);
  return store;
}

function assertValidPurgeLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) {
    throw new Error("Reaction Limit retention purge limit must be between 1 and 5000.");
  }
}

function configToRow(config: ReactionLimitConfig): ReactionLimitConfigInsert {
  return {
    guildId: config.guildId,
    limitsEnabled: config.limitsEnabled ? 1 : 0,
    maxReactionsPerMessage: config.maxReactionsPerMessage,
    maxReactionsPerUserPerMessage: config.maxReactionsPerUserPerMessage,
    breachThreshold: config.breachThreshold,
    breachRoleId: config.breachRoleId,
    breachRoleDurationMs: config.breachRoleDurationMs,
    breachDmText: config.breachDmText,
    channelMode: config.channelMode,
    channelIdsJson: JSON.stringify(config.channelIds),
  };
}

function mapConfigRow(row: ReactionLimitConfigRow): ReactionLimitConfig {
  return {
    guildId: row.guildId,
    limitsEnabled: row.limitsEnabled === 1,
    maxReactionsPerMessage: row.maxReactionsPerMessage,
    maxReactionsPerUserPerMessage: row.maxReactionsPerUserPerMessage,
    breachThreshold: row.breachThreshold,
    breachRoleId: row.breachRoleId,
    breachRoleDurationMs: row.breachRoleDurationMs,
    breachDmText: row.breachDmText,
    channelMode: mapChannelMode(row.channelMode),
    channelIds: mapChannelIds(row.channelIdsJson),
  };
}

function mapChannelMode(value: string | null | undefined): ChannelFilterMode {
  return value === "exclude" ? "exclude" : "include";
}

function mapChannelIds(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}
