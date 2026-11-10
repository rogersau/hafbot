import { and, asc, eq, sql } from "drizzle-orm";

import {
  reactionLimitBreachCounters,
  reactionLimitConfigs,
  reactionLimitMessageReactionCounts,
  reactionLimitUserMessageReactionCounts,
} from "../../db/postgres/app-schema";
import type { ChannelFilterMode, ReactionLimitConfig } from "../../types";
import type { ReactionLimitStore } from "../contracts/reaction-limit-store";
import type { PostgresDatabaseCapability } from "./postgres-capability";

type ReactionLimitConfigRow = typeof reactionLimitConfigs.$inferSelect;
type ReactionLimitConfigInsert = typeof reactionLimitConfigs.$inferInsert;
const DEFAULT_RETENTION_PURGE_LIMIT_PER_TABLE = 500;

export function createPostgresReactionLimitStore(
  database: PostgresDatabaseCapability,
): ReactionLimitStore {
  const db = database.drizzle;
  return {
    async readReactionLimitConfig(guildId) {
      const rows = await db
        .select()
        .from(reactionLimitConfigs)
        .where(eq(reactionLimitConfigs.guildId, guildId))
        .limit(1);
      return rows[0] ? mapConfigRow(rows[0]) : null;
    },

    async upsertReactionLimitConfig(config) {
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
        });
    },

    async incrementBreachCounter(guildId, userId) {
      const rows = await db
        .insert(reactionLimitBreachCounters)
        .values({ guildId, userId, breachCount: 1 })
        .onConflictDoUpdate({
          target: [reactionLimitBreachCounters.guildId, reactionLimitBreachCounters.userId],
          set: { breachCount: sql`${reactionLimitBreachCounters.breachCount} + 1` },
        })
        .returning({ breachCount: reactionLimitBreachCounters.breachCount });
      return rows[0]?.breachCount ?? 1;
    },

    async incrementMessageReactionCount(guildId, channelId, messageId) {
      const updatedAtMs = Date.now();
      const rows = await db
        .insert(reactionLimitMessageReactionCounts)
        .values({ guildId, channelId, messageId, reactionCount: 1, updatedAtMs })
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
        .returning({ reactionCount: reactionLimitMessageReactionCounts.reactionCount });
      return rows[0]?.reactionCount ?? 1;
    },

    async incrementUserMessageReactionCount(guildId, channelId, messageId, userId) {
      const updatedAtMs = Date.now();
      const rows = await db
        .insert(reactionLimitUserMessageReactionCounts)
        .values({ guildId, channelId, messageId, userId, reactionCount: 1, updatedAtMs })
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
        .returning({ reactionCount: reactionLimitUserMessageReactionCounts.reactionCount });
      return rows[0]?.reactionCount ?? 1;
    },

    async readBreachCounters(guildId) {
      const rows = await db
        .select()
        .from(reactionLimitBreachCounters)
        .where(eq(reactionLimitBreachCounters.guildId, guildId))
        .orderBy(asc(reactionLimitBreachCounters.userId));
      return rows.map((row) => ({
        guildId: row.guildId,
        userId: row.userId,
        breachCount: row.breachCount,
      }));
    },

    async resetBreachCounter(guildId, userId) {
      await db
        .delete(reactionLimitBreachCounters)
        .where(
          and(
            eq(reactionLimitBreachCounters.guildId, guildId),
            eq(reactionLimitBreachCounters.userId, userId),
          ),
        );
    },

    async resetAllBreachCounters(guildId) {
      await db
        .delete(reactionLimitBreachCounters)
        .where(eq(reactionLimitBreachCounters.guildId, guildId));
    },

    async purgeExpiredCounters(cutoffMs, limitPerTable = DEFAULT_RETENTION_PURGE_LIMIT_PER_TABLE) {
      assertValidPurgeLimit(limitPerTable);
      const messageCounts = await database.query<{ deleted: number }>(
        `WITH expired AS (
           SELECT guild_id, channel_id, message_id
           FROM reaction_limit_message_reaction_counts
           WHERE updated_at_ms < $1
           ORDER BY updated_at_ms ASC
           LIMIT $2
         )
         DELETE FROM reaction_limit_message_reaction_counts AS counters
         USING expired
         WHERE counters.guild_id = expired.guild_id
           AND counters.channel_id = expired.channel_id
           AND counters.message_id = expired.message_id
         RETURNING 1 AS deleted`,
        [cutoffMs, limitPerTable],
      );
      const userCounts = await database.query<{ deleted: number }>(
        `WITH expired AS (
           SELECT guild_id, channel_id, message_id, user_id
           FROM reaction_limit_user_message_reaction_counts
           WHERE updated_at_ms < $1
           ORDER BY updated_at_ms ASC
           LIMIT $2
         )
         DELETE FROM reaction_limit_user_message_reaction_counts AS counters
         USING expired
         WHERE counters.guild_id = expired.guild_id
           AND counters.channel_id = expired.channel_id
           AND counters.message_id = expired.message_id
           AND counters.user_id = expired.user_id
         RETURNING 1 AS deleted`,
        [cutoffMs, limitPerTable],
      );
      return messageCounts.length + userCounts.length;
    },
  };
}

function assertValidPurgeLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) {
    throw new Error("Reaction Limit retention purge limit must be between 1 and 5000.");
  }
}

function configToRow(config: ReactionLimitConfig): ReactionLimitConfigInsert {
  return {
    guildId: config.guildId,
    limitsEnabled: config.limitsEnabled,
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
    limitsEnabled: row.limitsEnabled,
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
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}
