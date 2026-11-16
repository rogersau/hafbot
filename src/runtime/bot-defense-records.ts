import type { botDefenseConfigs, botFlags } from "../db/postgres/app-schema";
import type { BotDefenseConfig, BotFlag } from "../types";
import { isRecord } from "../unknown-parse";

type BotDefenseConfigRow = typeof botDefenseConfigs.$inferSelect;
type BotDefenseConfigInsert = typeof botDefenseConfigs.$inferInsert;
type BotFlagRow = typeof botFlags.$inferSelect;
type BotFlagInsert = typeof botFlags.$inferInsert;

export function botFlagToRow(flag: BotFlag): BotFlagInsert {
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

export function mapBotFlagRow(row: BotFlagRow): BotFlag {
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

export function defaultConfig(guildId: string): BotDefenseConfig {
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

export function mapConfigRow(row: BotDefenseConfigRow): BotDefenseConfig {
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

export function configToRow(config: BotDefenseConfig): BotDefenseConfigInsert {
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
