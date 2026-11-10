import { channelMatchesFilter } from "../../blocklist";
import { getGuildEntitlementLimits } from "../../types";
import type { DiscordReaction, GuildEntitlement, ReactionLimitConfig } from "../../types";

export interface ReactionSummary {
  totalReactions: number;
  userReactions: number;
}

export interface ReactionLimitAdapters {
  readConfig(guildId: string): Promise<ReactionLimitConfig | null>;
  readGuildEntitlement(guildId: string): Promise<GuildEntitlement>;
  incrementReactionCounters(reaction: DiscordReaction): Promise<ReactionSummary>;
  removeReaction(reaction: DiscordReaction): Promise<void>;
  incrementBreachCounter(guildId: string, userId: string): Promise<number>;
  resetBreachCounter(guildId: string, userId: string): Promise<void>;
  assignRole(input: {
    guildId: string;
    userId: string;
    roleId: string;
    durationMs: number | null;
  }): Promise<void>;
  sendDm(userId: string, message: string): Promise<void>;
  logRoleAssignment(input: {
    guildId: string;
    userId: string;
    roleId: string;
    reaction: DiscordReaction;
    breachCount: number;
    breachThreshold: number;
    userReactions: number;
    maxReactionsPerUserPerMessage: number;
  }): Promise<void>;
}

export async function moderateReactionLimitAdd(
  reaction: DiscordReaction | null,
  adapters: ReactionLimitAdapters,
): Promise<void> {
  if (!reaction?.guild_id) {
    return;
  }

  const config = await adapters.readConfig(reaction.guild_id);
  if (!config?.limitsEnabled) {
    return;
  }

  if (config.maxReactionsPerMessage === null && config.maxReactionsPerUserPerMessage === null) {
    return;
  }

  if (!channelMatchesFilter(config.channelMode, config.channelIds, reaction.channel_id)) {
    return;
  }

  const entitlement = await adapters.readGuildEntitlement(reaction.guild_id);
  if (!getGuildEntitlementLimits(entitlement.tier).reactionLimitsEnabled) {
    return;
  }

  const summary = await adapters.incrementReactionCounters(reaction);
  let removed = false;
  if (
    config.maxReactionsPerMessage !== null &&
    summary.totalReactions > config.maxReactionsPerMessage
  ) {
    await adapters.removeReaction(reaction);
    removed = true;
  }

  if (
    config.maxReactionsPerUserPerMessage === null ||
    summary.userReactions <= config.maxReactionsPerUserPerMessage
  ) {
    return;
  }

  if (!removed) {
    await adapters.removeReaction(reaction);
  }

  const breachCount = await adapters.incrementBreachCounter(reaction.guild_id, reaction.user_id);
  if (config.breachDmText?.trim() && !reaction.member?.user?.bot) {
    await adapters.sendDm(reaction.user_id, config.breachDmText);
  }

  if (
    config.breachThreshold === null ||
    breachCount < config.breachThreshold ||
    !config.breachRoleId
  ) {
    return;
  }

  await adapters.assignRole({
    guildId: reaction.guild_id,
    userId: reaction.user_id,
    roleId: config.breachRoleId,
    durationMs: config.breachRoleDurationMs,
  });
  await adapters.resetBreachCounter(reaction.guild_id, reaction.user_id);
  await adapters.logRoleAssignment({
    guildId: reaction.guild_id,
    userId: reaction.user_id,
    roleId: config.breachRoleId,
    reaction,
    breachCount,
    breachThreshold: config.breachThreshold,
    userReactions: summary.userReactions,
    maxReactionsPerUserPerMessage: config.maxReactionsPerUserPerMessage,
  });
}
