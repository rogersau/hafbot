import { asc, eq, and, sql } from "drizzle-orm";
import { botDefenseConfigs, botDefenseRateWindowEvents, botFlags } from "../db/app-schema";
import { getBotDefenseHoneypotChannelLimitError } from "../bot-defense-config";
import type { BotDefenseConfig, BotFlag } from "../types";
import type { BotDefenseStore } from "./contracts/bot-defense-store";
import { createD1DrizzleDatabase } from "./drizzle-db";
import { isRecord } from "../unknown-parse";

type BotDefenseConfigRow = typeof botDefenseConfigs.$inferSelect;
type BotDefenseConfigInsert = typeof botDefenseConfigs.$inferInsert;
type BotFlagRow = typeof botFlags.$inferSelect;
type BotFlagInsert = typeof botFlags.$inferInsert;

const storeCache = new WeakMap<D1Database, BotDefenseStore>();

export function createCloudflareBotDefenseStore(database: D1Database): BotDefenseStore {
  const cached = storeCache.get(database);
  if (cached) return cached;

  const db = createD1DrizzleDatabase(database);
  const store: BotDefenseStore = {
    async readConfig(guildId) {
      const row = await db
        .select()
        .from(botDefenseConfigs)
        .where(eq(botDefenseConfigs.guildId, guildId))
        .limit(1)
        .get();
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
        .run();
    },

    async deleteConfig(guildId) {
      await db.delete(botDefenseConfigs).where(eq(botDefenseConfigs.guildId, guildId)).run();
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
          .get();
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
        .get();
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
        .get();
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
      const row = await db.select().from(botFlags).where(where).limit(1).get();
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
        .get();
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
        .run();
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
        .all();
      return rows.map(mapBotFlagRow);
    },

    async recordRateMessage(guildId, userId, channelId, messageFingerprint, messageTimestampMs) {
      await db
        .insert(botDefenseRateWindowEvents)
        .values({ guildId, userId, channelId, messageFingerprint, messageTimestampMs })
        .run();
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
        .run();
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
        .all();
      return rows.map((row) => row.channelId);
    },
  };

  storeCache.set(database, store);
  return store;
}

async function readFlag(
  db: ReturnType<typeof createD1DrizzleDatabase>,
  guildId: string,
  userId: string,
): Promise<BotFlag | null> {
  const row = await db
    .select()
    .from(botFlags)
    .where(and(eq(botFlags.guildId, guildId), eq(botFlags.userId, userId)))
    .limit(1)
    .get();
  return row ? mapBotFlagRow(row) : null;
}

function botFlagToRow(flag: BotFlag): BotFlagInsert {
  return {
    guildId: flag.guildId,
    userId: flag.userId,
    status: flag.status,
    detectorType: flag.detectorType,
    evidenceJson: JSON.stringify(flag.evidence),
    queueMessageId: flag.queueMessageId,
    resolvedByDiscordUserId: flag.resolvedByDiscordUserId,
    resolvedAtMs: flag.resolvedAtMs,
    createdAtMs: flag.createdAtMs,
    updatedAtMs: flag.updatedAtMs,
  };
}

function mapBotFlagRow(row: BotFlagRow): BotFlag {
  return {
    guildId: row.guildId,
    userId: row.userId,
    status: row.status as BotFlag["status"],
    detectorType: row.detectorType as BotFlag["detectorType"],
    evidence: parseEvidenceJson(row.evidenceJson),
    queueMessageId: row.queueMessageId ?? null,
    resolvedByDiscordUserId: row.resolvedByDiscordUserId ?? null,
    resolvedAtMs: row.resolvedAtMs ?? null,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

function parseEvidenceJson(value: string): BotFlag["evidence"] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (isRecord(parsed)) {
      return parsed as unknown as BotFlag["evidence"];
    }
  } catch {
    // fall through
  }
  return { kind: "honeypot", channelId: "", messageId: "" };
}

function defaultConfig(guildId: string): BotDefenseConfig {
  const now = Date.now();
  return {
    guildId,
    honeypotEnabled: false,
    honeypotWarnUser: false,
    honeypotDeleteMessage: false,
    rateEnabled: false,
    rateWarnUser: false,
    rateDeleteMessage: false,
    honeypotChannelIds: [],
    rateChannelThreshold: 5,
    rateWindowSeconds: 60,
    excludedRoleIds: [],
    modRoleIds: [],
    modQueueChannelId: null,
    pingOnQueuePost: true,
    createdAtMs: now,
    updatedAtMs: now,
  };
}

function mapConfigRow(row: BotDefenseConfigRow): BotDefenseConfig {
  return {
    guildId: row.guildId,
    honeypotEnabled: row.honeypotEnabled === 1,
    honeypotWarnUser: row.honeypotWarnUser === 1,
    honeypotDeleteMessage: row.honeypotDeleteMessage === 1,
    rateEnabled: row.rateEnabled === 1,
    rateWarnUser: row.rateWarnUser === 1,
    rateDeleteMessage: row.rateDeleteMessage === 1,
    honeypotChannelIds: parseJsonStringArray(row.honeypotChannelIdsJson),
    rateChannelThreshold: row.rateChannelThreshold,
    rateWindowSeconds: row.rateWindowSeconds,
    excludedRoleIds: parseJsonStringArray(row.excludedRoleIdsJson),
    modRoleIds: parseJsonStringArray(row.modRoleIdsJson),
    modQueueChannelId: row.modQueueChannelId ?? null,
    pingOnQueuePost: row.pingOnQueuePost === 1,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

function configToRow(config: BotDefenseConfig): BotDefenseConfigInsert {
  return {
    guildId: config.guildId,
    honeypotEnabled: config.honeypotEnabled ? 1 : 0,
    honeypotWarnUser: config.honeypotWarnUser ? 1 : 0,
    honeypotDeleteMessage: config.honeypotDeleteMessage ? 1 : 0,
    rateEnabled: config.rateEnabled ? 1 : 0,
    rateWarnUser: config.rateWarnUser ? 1 : 0,
    rateDeleteMessage: config.rateDeleteMessage ? 1 : 0,
    honeypotChannelIdsJson: JSON.stringify(config.honeypotChannelIds),
    rateChannelThreshold: config.rateChannelThreshold,
    rateWindowSeconds: config.rateWindowSeconds,
    excludedRoleIdsJson: JSON.stringify(config.excludedRoleIds),
    modRoleIdsJson: JSON.stringify(config.modRoleIds),
    modQueueChannelId: config.modQueueChannelId,
    pingOnQueuePost: config.pingOnQueuePost ? 1 : 0,
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
