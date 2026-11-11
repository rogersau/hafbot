import {
  botFlagToRow,
  mapBotFlagRow,
  defaultConfig,
  mapConfigRow,
  configToRow,
} from "../bot-defense-records";
import { asc, eq, and, sql } from "drizzle-orm";
import {
  botDefenseConfigs,
  botDefenseRateWindowEvents,
  botFlags,
} from "../../db/postgres/app-schema";
import { getBotDefenseHoneypotChannelLimitError } from "../../bot-defense-config";
import type { BotFlag } from "../../types";
import type { BotDefenseStore } from "../contracts/bot-defense-store";
import type { PostgresDatabaseCapability } from "./postgres-capability";

export function createPostgresBotDefenseStore(
  database: PostgresDatabaseCapability,
): BotDefenseStore {
  const db = database.drizzle;
  const store: BotDefenseStore = {
    async readConfig(guildId) {
      const row = await db
        .select()
        .from(botDefenseConfigs)
        .where(eq(botDefenseConfigs.guildId, guildId))
        .limit(1)
        .then((rows) => rows[0]);
      return row ? mapConfigRow(row) : defaultConfig(guildId);
    },

    async upsertConfig(config) {
      const limitError = getBotDefenseHoneypotChannelLimitError(config.honeypotChannelIds);
      if (limitError) throw new Error(limitError);
      const values = configToRow(config);
      await db
        .insert(botDefenseConfigs)
        .values(values)
        .onConflictDoUpdate({
          target: botDefenseConfigs.guildId,
          set: {
            honeypotEnabled: values.honeypotEnabled,
            honeypotWarnUser: values.honeypotWarnUser,
            honeypotDeleteMessage: values.honeypotDeleteMessage,
            rateEnabled: values.rateEnabled,
            rateWarnUser: values.rateWarnUser,
            rateDeleteMessage: values.rateDeleteMessage,
            honeypotChannelIdsJson: values.honeypotChannelIdsJson,
            rateChannelThreshold: values.rateChannelThreshold,
            rateWindowSeconds: values.rateWindowSeconds,
            excludedRoleIdsJson: values.excludedRoleIdsJson,
            modRoleIdsJson: values.modRoleIdsJson,
            modQueueChannelId: values.modQueueChannelId,
            pingOnQueuePost: values.pingOnQueuePost,
            updatedAtMs: values.updatedAtMs,
          },
        })
        .execute();
    },

    async deleteConfig(guildId) {
      await db.delete(botDefenseConfigs).where(eq(botDefenseConfigs.guildId, guildId)).execute();
    },

    async openBotFlag(guildId, userId, detectorType, evidence) {
      const existing = await readFlag(db, guildId, userId);
      if (existing?.status === "open" || existing?.status === "confirmed") return null;

      const now = Date.now();
      const createdAtMs = existing ? Math.max(now, existing.createdAtMs + 1) : now;
      if (existing) {
        const updated: BotFlag = {
          ...existing,
          status: "open",
          detectorType,
          evidence,
          queueMessageId: null,
          resolvedByDiscordUserId: null,
          resolvedAtMs: null,
          createdAtMs,
          updatedAtMs: now,
        };
        const row = await db
          .update(botFlags)
          .set(botFlagToRow(updated))
          .where(
            and(
              eq(botFlags.guildId, guildId),
              eq(botFlags.userId, userId),
              eq(botFlags.status, "dismissed"),
              eq(botFlags.createdAtMs, existing.createdAtMs),
            ),
          )
          .returning()
          .then((rows) => rows[0]);
        return row ? mapBotFlagRow(row) : null;
      }

      const flag: BotFlag = {
        guildId,
        userId,
        status: "open",
        detectorType,
        evidence,
        queueMessageId: null,
        resolvedByDiscordUserId: null,
        resolvedAtMs: null,
        createdAtMs,
        updatedAtMs: now,
      };
      const row = await db
        .insert(botFlags)
        .values(botFlagToRow(flag))
        .onConflictDoNothing()
        .returning()
        .then((rows) => rows[0]);
      return row ? mapBotFlagRow(row) : null;
    },

    async resolveBotFlag(
      guildId,
      userId,
      expectedCreatedAtMs,
      resolution,
      resolvedByDiscordUserId,
    ) {
      const now = Date.now();
      const row = await db
        .update(botFlags)
        .set({
          status: resolution,
          resolvedByDiscordUserId,
          resolvedAtMs: now,
          updatedAtMs: now,
        })
        .where(
          and(
            eq(botFlags.guildId, guildId),
            eq(botFlags.userId, userId),
            eq(botFlags.status, "open"),
            eq(botFlags.createdAtMs, expectedCreatedAtMs),
          ),
        )
        .returning()
        .then((rows) => rows[0]);
      return row ? mapBotFlagRow(row) : null;
    },

    async readOpenBotFlag(guildId, userId, expectedCreatedAtMs) {
      const where =
        expectedCreatedAtMs === undefined
          ? and(
              eq(botFlags.guildId, guildId),
              eq(botFlags.userId, userId),
              eq(botFlags.status, "open"),
            )
          : and(
              eq(botFlags.guildId, guildId),
              eq(botFlags.userId, userId),
              eq(botFlags.status, "open"),
              eq(botFlags.createdAtMs, expectedCreatedAtMs),
            );
      const row = await db
        .select()
        .from(botFlags)
        .where(where)
        .limit(1)
        .then((rows) => rows[0]);
      return row ? mapBotFlagRow(row) : null;
    },

    async isConfirmedMember(guildId, userId) {
      const row = await db
        .select()
        .from(botFlags)
        .where(
          and(
            eq(botFlags.guildId, guildId),
            eq(botFlags.userId, userId),
            eq(botFlags.status, "confirmed"),
          ),
        )
        .limit(1)
        .then((rows) => rows[0]);
      return row != null;
    },

    async setBotFlagQueueMessage(guildId, userId, expectedCreatedAtMs, queueMessageId, nowMs) {
      await db
        .update(botFlags)
        .set({ queueMessageId, updatedAtMs: nowMs })
        .where(
          and(
            eq(botFlags.guildId, guildId),
            eq(botFlags.userId, userId),
            eq(botFlags.status, "open"),
            eq(botFlags.createdAtMs, expectedCreatedAtMs),
          ),
        )
        .execute();
    },

    async listOpenBotFlagsMissingQueueMessage(nowMs, graceMs, limit) {
      const rows = await db
        .select()
        .from(botFlags)
        .where(
          and(
            eq(botFlags.status, "open"),
            sql`${botFlags.queueMessageId} IS NULL`,
            sql`${botFlags.createdAtMs} <= ${nowMs - graceMs}`,
          ),
        )
        .orderBy(asc(botFlags.createdAtMs))
        .limit(limit)
        .execute();
      return rows.map(mapBotFlagRow);
    },

    async recordRateMessage(guildId, userId, channelId, messageFingerprint, messageTimestampMs) {
      await db
        .insert(botDefenseRateWindowEvents)
        .values({ guildId, userId, channelId, messageFingerprint, messageTimestampMs })
        .execute();
    },

    async listMatchingMessageChannelsInWindow(
      guildId,
      userId,
      messageFingerprint,
      windowMs,
      nowMs,
    ) {
      const cutoff = nowMs - windowMs;
      await db
        .delete(botDefenseRateWindowEvents)
        .where(
          and(
            eq(botDefenseRateWindowEvents.guildId, guildId),
            eq(botDefenseRateWindowEvents.userId, userId),
            sql`${botDefenseRateWindowEvents.messageTimestampMs} < ${cutoff}`,
          ),
        )
        .execute();
      const rows = await db
        .select({
          channelId: botDefenseRateWindowEvents.channelId,
        })
        .from(botDefenseRateWindowEvents)
        .where(
          and(
            eq(botDefenseRateWindowEvents.guildId, guildId),
            eq(botDefenseRateWindowEvents.userId, userId),
            eq(botDefenseRateWindowEvents.messageFingerprint, messageFingerprint),
            sql`${botDefenseRateWindowEvents.messageTimestampMs} >= ${cutoff}`,
            sql`${botDefenseRateWindowEvents.messageTimestampMs} <= ${nowMs}`,
          ),
        )
        .groupBy(botDefenseRateWindowEvents.channelId)
        .execute();
      return rows.map((row) => row.channelId);
    },
  };

  return store;
}

async function readFlag(
  db: PostgresDatabaseCapability["drizzle"],
  guildId: string,
  userId: string,
): Promise<BotFlag | null> {
  const row = await db
    .select()
    .from(botFlags)
    .where(and(eq(botFlags.guildId, guildId), eq(botFlags.userId, userId)))
    .limit(1)
    .then((rows) => rows[0]);
  return row ? mapBotFlagRow(row) : null;
}
