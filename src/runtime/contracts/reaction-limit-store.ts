import type { ReactionLimitBreachCounter, ReactionLimitConfig } from "../../types";

export interface ReactionLimitStore {
  readReactionLimitConfig(guildId: string): Promise<ReactionLimitConfig | null>;
  upsertReactionLimitConfig(config: ReactionLimitConfig): Promise<void>;
  incrementMessageReactionCount(
    guildId: string,
    channelId: string,
    messageId: string,
  ): Promise<number>;
  incrementUserMessageReactionCount(
    guildId: string,
    channelId: string,
    messageId: string,
    userId: string,
  ): Promise<number>;
  incrementBreachCounter(guildId: string, userId: string): Promise<number>;
  readBreachCounters(guildId: string): Promise<ReactionLimitBreachCounter[]>;
  resetBreachCounter(guildId: string, userId: string): Promise<void>;
  resetAllBreachCounters(guildId: string): Promise<void>;
  /** Retention: purge a bounded page per table of counters not touched since cutoffMs. */
  purgeExpiredCounters(cutoffMs: number, limitPerTable?: number): Promise<number>;
}
