import { DISCORD_API, DiscordApiError, discordGetJson } from "../discord/client";
import { addGuildMemberRole } from "../discord/members";
import { loadGuildPermissionContext } from "../runtime/admin-permissions";
import type { ReactionRoleStore } from "../runtime/contracts/reaction-role-store";
import type { ReputationDiscord } from "./service";

export function createReputationDiscord(options: {
  token: string;
  botUserId: string;
  rolePolicy: Pick<ReactionRoleStore, "readRestrictedRoleIds" | "isRoleSuspended" | "listPanels">;
}): ReputationDiscord {
  return {
    async fetchMember(guildId, userId) {
      try {
        const member = await discordGetJson<{
          nick?: string | null;
          user?: { id?: string; bot?: boolean; username?: string; global_name?: string | null };
          roles?: string[];
        }>(`${DISCORD_API}/guilds/${guildId}/members/${userId}`, options.token);
        if (member.user?.id !== userId) return null;
        return {
          userId,
          displayName: member.nick || member.user.global_name || member.user.username || "Member",
          bot: member.user.bot === true,
          roleIds: member.roles ?? [],
        };
      } catch (error) {
        if (error instanceof DiscordApiError && error.status === 404) return null;
        throw error;
      }
    },
    loadPermissionContext: (guildId) =>
      loadGuildPermissionContext(guildId, options.botUserId, options.token),
    async readRestrictedRoleIds(guildId) {
      const restricted = await options.rolePolicy.readRestrictedRoleIds(guildId, {
        excludeReputationRewards: true,
      });
      for (const panel of await options.rolePolicy.listPanels(guildId)) {
        for (const option of [...panel.options, ...panel.publishedOptions])
          restricted.add(option.roleId);
      }
      return restricted;
    },
    isRoleSuspended: (guildId, userId, roleId) =>
      options.rolePolicy.isRoleSuspended(guildId, userId, roleId),
    addRole: (guildId, userId, roleId) =>
      addGuildMemberRole(guildId, userId, roleId, options.token),
  };
}
