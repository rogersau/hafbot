import { hasGuildAdminPermission } from "../discord-interactions";
import type { DiscordAccountStore } from "./cloudflare-discord-account-store";

export interface DiscordDiscoverableGuild {
  guildId: string;
  name: string;
  icon: string | null;
  isOwner: boolean;
  canManage: boolean;
}

export interface DiscordGuildDiscoveryUserGuild {
  guildId: string;
  name: string;
  owner: boolean;
  permissions: string;
  icon: string | null;
}

export interface CreateGuildDiscoveryServiceOptions {
  discordAccounts: Pick<DiscordAccountStore, "readDiscordAccessToken">;
  listUserGuilds(
    accessToken: string,
    authUserId: string,
    refresh?: boolean,
  ): Promise<DiscordGuildDiscoveryUserGuild[]>;
  listBotGuilds(
    refresh?: boolean,
    allowStaleOnRateLimit?: boolean,
  ): Promise<Array<{ guildId: string; name: string; icon: string | null }>>;
}

export interface GuildDiscoveryService {
  discoverGuildsForUser(
    authUserId: string,
    discordUserId: string,
    refresh?: boolean,
    options?: { requireFreshBotGuilds?: boolean },
  ): Promise<DiscordDiscoverableGuild[]>;
}

export function createGuildDiscoveryService(
  options: CreateGuildDiscoveryServiceOptions,
): GuildDiscoveryService {
  const { discordAccounts, listUserGuilds, listBotGuilds } = options;

  return {
    async discoverGuildsForUser(
      authUserId: string,
      _discordUserId: string,
      refresh = false,
      discoveryOptions: { requireFreshBotGuilds?: boolean } = {},
    ): Promise<DiscordDiscoverableGuild[]> {
      const accessToken = await discordAccounts.readDiscordAccessToken(authUserId);
      if (!accessToken) {
        throw new Error("Signed-in user does not have a Discord OAuth access token.");
      }

      const [userGuilds, botGuilds] = await Promise.all([
        listUserGuilds(accessToken, authUserId, refresh),
        listBotGuilds(refresh, !discoveryOptions.requireFreshBotGuilds),
      ]);
      const botGuildIds = new Set(botGuilds.map((guild) => guild.guildId));
      const sharedManageableGuilds = userGuilds.filter(
        (guild) => botGuildIds.has(guild.guildId) && canManageGuild(guild),
      );

      return sharedManageableGuilds.map((guild) => ({
        guildId: guild.guildId,
        name: guild.name,
        icon: guild.icon,
        isOwner: guild.owner,
        canManage: true,
      }));
    },
  };
}

function canManageGuild(guild: DiscordGuildDiscoveryUserGuild): boolean {
  return guild.owner || hasGuildAdminPermission(guild.permissions);
}
