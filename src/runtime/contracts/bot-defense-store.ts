import type {
  BotDefenseConfig,
  BotDefenseDetectorType,
  BotDefenseEvidence,
  BotFlag,
  BotFlagStatus,
} from "../../types";

export interface BotDefenseStore {
  readConfig(guildId: string): Promise<BotDefenseConfig | null>;
  upsertConfig(config: BotDefenseConfig): Promise<void>;
  deleteConfig(guildId: string): Promise<void>;

  openBotFlag(
    guildId: string,
    userId: string,
    detectorType: BotDefenseDetectorType,
    evidence: BotDefenseEvidence,
  ): Promise<BotFlag | null>;
  resolveBotFlag(
    guildId: string,
    userId: string,
    expectedCreatedAtMs: number,
    resolution: Exclude<BotFlagStatus, "open">,
    resolvedByDiscordUserId: string,
  ): Promise<BotFlag | null>;
  /** When supplied, only the matching open flag generation is returned. */
  readOpenBotFlag(
    guildId: string,
    userId: string,
    expectedCreatedAtMs?: number,
  ): Promise<BotFlag | null>;
  isConfirmedMember(guildId: string, userId: string): Promise<boolean>;
  setBotFlagQueueMessage(
    guildId: string,
    userId: string,
    expectedCreatedAtMs: number,
    queueMessageId: string,
    nowMs: number,
  ): Promise<void>;
  /** Open flags whose queue message was never delivered, older than graceMs. */
  listOpenBotFlagsMissingQueueMessage(
    nowMs: number,
    graceMs: number,
    limit: number,
  ): Promise<BotFlag[]>;

  recordRateMessage(
    guildId: string,
    userId: string,
    channelId: string,
    messageFingerprint: string,
    messageTimestampMs: number,
  ): Promise<void>;
  listMatchingMessageChannelsInWindow(
    guildId: string,
    userId: string,
    messageFingerprint: string,
    windowMs: number,
    nowMs: number,
  ): Promise<string[]>;
}
