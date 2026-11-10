import type { BlocklistConfig, TimedRoleAssignment } from "../types";

export interface AdminOverviewGuild {
  guildId: string;
  emojis: string[];
  timedRoles: TimedRoleAssignment[];
  roleNamesById: Record<string, string>;
}

export async function buildAdminOverviewGuilds(
  config: BlocklistConfig,
  timedRoles: TimedRoleAssignment[],
  _discordBotToken: string,
  _refreshDiscordCache = false,
): Promise<AdminOverviewGuild[]> {
  const guilds = new Map<string, AdminOverviewGuild>();

  for (const [guildId, guildConfig] of Object.entries(config.guilds)) {
    guilds.set(guildId, {
      guildId,
      emojis: [...guildConfig.emojis],
      timedRoles: [],
      roleNamesById: {},
    });
  }

  for (const timedRole of timedRoles) {
    const existing = guilds.get(timedRole.guildId);
    if (existing) {
      existing.timedRoles.push(timedRole);
      continue;
    }

    guilds.set(timedRole.guildId, {
      guildId: timedRole.guildId,
      emojis: [],
      timedRoles: [timedRole],
      roleNamesById: {},
    });
  }

  return [...guilds.values()].sort((left, right) => left.guildId.localeCompare(right.guildId));
}
