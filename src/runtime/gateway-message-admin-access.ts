import type { DiscordGuildSummaryResource, DiscordRoleResource } from "../discord/guilds";
import { getMemberBaseGuildPermissions } from "./admin-permissions";
import {
  resolveGuildAdminAccess,
  hasAutomaticHafAdminPermission,
  type GuildAdminRoleStore,
} from "./guild-admin-access";

interface GatewayMessageAdminDiscord {
  fetchGuildSummary(guildId: string): Promise<DiscordGuildSummaryResource>;
  listGuildRoles(guildId: string): Promise<DiscordRoleResource[]>;
}

export async function hasGatewayMessageAdminAccess(options: {
  guildId: string;
  userId: string;
  memberRoleIds: readonly string[];
  memberPermissions?: string;
  store: GuildAdminRoleStore;
  discord: GatewayMessageAdminDiscord;
}): Promise<boolean> {
  if (
    await hasAutomaticHafAdminPermission(
      options.guildId,
      options.memberPermissions ?? "",
      options.store,
    )
  ) {
    return true;
  }

  const configuredAccess = await resolveGuildAdminAccess({
    guildId: options.guildId,
    userId: options.userId,
    store: options.store,
    suppliedRoleIds: options.memberRoleIds,
  });
  if (configuredAccess.ok) {
    return true;
  }

  const [guild, roles] = await Promise.all([
    options.discord.fetchGuildSummary(options.guildId),
    options.discord.listGuildRoles(options.guildId),
  ]);
  if (guild.owner_id === options.userId) {
    return true;
  }

  const permissions = getMemberBaseGuildPermissions({
    guildId: options.guildId,
    roles,
    memberRoleIds: options.memberRoleIds,
  });
  return hasAutomaticHafAdminPermission(options.guildId, permissions.toString(), options.store);
}
