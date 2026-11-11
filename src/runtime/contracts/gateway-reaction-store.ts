import type { DiscordReaction } from "../../types";

export interface GatewayReactionStore {
  incrementCounters(
    eventKey: string,
    reaction: DiscordReaction,
  ): Promise<{
    totalReactions: number;
    userReactions: number;
  }>;
  incrementBreach(eventKey: string, guildId: string, userId: string): Promise<number>;
  resolveTimedRoleExpiry(eventKey: string, durationMs: number): Promise<number>;
}
