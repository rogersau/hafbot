import { DISCORD_API, DiscordApiError, discordRequest } from "../discord/client";
import { fetchGuildSummary } from "../discord/guilds";
import { fetchGuildMember } from "../discord/members";
import {
  getBaseGuildPermissions,
  getMemberBaseGuildPermissions,
  hasPermission,
  loadGuildPermissionContext,
} from "../runtime/admin-permissions";
import type { BanAppealDiscord } from "./service";
import { BanAppealError } from "./types";

export function createBanAppealDiscord(
  guildId: string,
  token: string,
  botUserId: string,
): BanAppealDiscord {
  const capabilities = async () => {
    const context = await loadGuildPermissionContext(guildId, botUserId, token);
    if (!hasPermission(getBaseGuildPermissions(context), 4n))
      throw new BanAppealError(
        "HAF Bot needs Ban Members to verify bans and process appeals.",
        403,
      );
    return context;
  };
  return {
    assertCapabilities: async () => {
      await capabilities();
    },
    async readBan(userId) {
      try {
        const response = await discordRequest(
          `${DISCORD_API}/guilds/${guildId}/bans/${userId}`,
          "GET",
          token,
          { signal: AbortSignal.timeout(10_000) },
        );
        const ban = (await response.json()) as { user?: { id?: string }; reason?: string | null };
        if (ban.user?.id !== userId)
          throw new BanAppealError("Discord returned an unexpected ban identity.", 503);
        return { reason: typeof ban.reason === "string" ? ban.reason : null };
      } catch (error) {
        if (error instanceof DiscordApiError && error.status === 404) return null;
        throw error;
      }
    },
    async assertCanReview(actorUserId, action) {
      const [context, member, guild] = await Promise.all([
        capabilities(),
        fetchGuildMember(guildId, actorUserId, token),
        fetchGuildSummary(guildId, token),
      ]);
      if (!member)
        throw new BanAppealError(
          "You must currently belong to the server to review an appeal.",
          403,
        );
      if (actorUserId === guild.owner_id) return;
      const permissions = getMemberBaseGuildPermissions({
        guildId,
        roles: context.roles,
        memberRoleIds: member.roles ?? [],
      });
      const allowed =
        action === "unban"
          ? hasPermission(permissions, 4n)
          : hasPermission(permissions, 4n) || hasPermission(permissions, 32n);
      if (!allowed)
        throw new BanAppealError(
          action === "unban"
            ? "Your Discord roles must grant Ban Members to unban an appellant."
            : "Your Discord roles must grant Manage Server or Ban Members to reject an appeal.",
          403,
        );
    },
    async unban(userId, reason) {
      const response = await discordRequest(
        `${DISCORD_API}/guilds/${guildId}/bans/${userId}`,
        "DELETE",
        token,
        {
          headers: { "X-Audit-Log-Reason": encodeURIComponent(reason.slice(0, 400)) },
          signal: AbortSignal.timeout(10_000),
        },
      );
      await response.body?.cancel();
    },
  };
}
