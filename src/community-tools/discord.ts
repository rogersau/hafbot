import { DISCORD_API, DiscordApiError, discordRequest } from "../discord/client";
import { fetchDiscordChannel, fetchGuildSummary } from "../discord/guilds";
import type { DiscordChannelResource } from "../discord/guilds";
import { applyGuildMemberTimeout, fetchGuildMember } from "../discord/members";
import {
  createChannelMessage,
  deleteChannelMessage,
  listChannelMessages,
} from "../discord/messages";
import {
  getChannelPermissions,
  getMemberBaseGuildPermissions,
  hasPermission,
  loadGuildPermissionContext,
} from "../runtime/admin-permissions";
import { CommunityToolsError } from "./config";
import type { CommunityDiscord } from "./service";

export function createCommunityDiscord(
  guildId: string,
  token: string,
  botUserId: string,
): CommunityDiscord {
  let resourcePromise: ReturnType<typeof loadGuildPermissionContext> | undefined;
  const resources = () =>
    (resourcePromise ??= loadGuildPermissionContext(guildId, botUserId, token));
  const member = async (userId: string) => {
    const value = await fetchGuildMember(guildId, userId, token);
    return value ? { roles: value.roles ?? [], bot: value.user?.bot === true } : null;
  };
  const permissionChannel = async (channel: DiscordChannelResource) => {
    if (channel.guild_id !== guildId)
      throw new CommunityToolsError("Choose a channel in this server.", 403);
    if (![10, 11, 12].includes(channel.type)) return channel;
    if (!channel.parent_id)
      throw new CommunityToolsError("The thread's parent channel is unavailable.", 403);
    // Threads inherit overwrites from their parent, including staff permissions.
    const parent = await fetchDiscordChannel(channel.parent_id, token);
    if (parent.guild_id !== guildId || ![0, 5, 15, 16].includes(parent.type))
      throw new CommunityToolsError("The thread's parent channel is unavailable.", 403);
    return parent;
  };
  const validateChannel = async (channelId: string, privateOnly = false) => {
    const [channel, context] = await Promise.all([
      fetchDiscordChannel(channelId, token),
      resources(),
    ]);
    if (channel.guild_id !== guildId || ![0, 5, 10, 11, 12].includes(channel.type))
      throw new CommunityToolsError("Choose a text channel in this server.");
    const effectiveChannel = await permissionChannel(channel);
    const permissions = getChannelPermissions(context, effectiveChannel);
    if (
      !hasPermission(permissions, 1n << 10n) ||
      !hasPermission(permissions, [10, 11, 12].includes(channel.type) ? 1n << 38n : 1n << 11n)
    )
      throw new CommunityToolsError(
        "HAF Bot needs View Channel and Send Messages in the selected channel.",
      );
    if (
      privateOnly &&
      !effectiveChannel.permission_overwrites?.some(
        (overwrite) => overwrite.id === guildId && (BigInt(overwrite.deny) & (1n << 10n)) !== 0n,
      )
    )
      throw new CommunityToolsError(
        "Choose a private staff channel that denies View Channel to @everyone.",
      );
  };
  async function mutate(method: "DELETE" | "PUT", path: string, reason: string, body?: unknown) {
    try {
      const response = await discordRequest(DISCORD_API + path, method, token, {
        headers: {
          "X-Audit-Log-Reason": encodeURIComponent(reason.slice(0, 400)),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      await response.body?.cancel();
    } catch (error) {
      if (error instanceof DiscordApiError && error.status === 404 && method === "DELETE") return;
      throw error;
    }
  }
  return {
    resources,
    member,
    validateChannel,
    async send(channelId, content, roleIds, nonce) {
      await validateChannel(channelId);
      const roles = Array.from(new Set(roleIds));
      const mentions = roles.map((id) => `<@&${id}>`).join(" ");
      await createChannelMessage(
        channelId,
        {
          content: `${mentions}${mentions ? "\n" : ""}${content}`.slice(0, 2000),
          allowed_mentions: { parse: [], roles },
          nonce,
          enforce_nonce: true,
        },
        token,
      );
    },
    async delete(channelId, messageId) {
      await validateChannel(channelId);
      await deleteChannelMessage(channelId, messageId, token);
    },
    async timeout(userId, untilMs) {
      const [current, context, guild] = await Promise.all([
        fetchGuildMember(guildId, userId, token),
        resources(),
        fetchGuildSummary(guildId, token),
      ]);
      if (!current || userId === guild.owner_id || userId === botUserId) return;
      const roles = current.roles ?? [];
      const permissions = getMemberBaseGuildPermissions({
        guildId,
        roles: context.roles,
        memberRoleIds: roles,
      });
      const position = (ids: string[]) =>
        Math.max(
          0,
          ...context.roles.filter((role) => ids.includes(role.id)).map((role) => role.position),
        );
      if ((permissions & 8n) !== 0n || position(roles) >= position(context.member.roles)) return;
      const previous = current.communication_disabled_until
        ? Date.parse(current.communication_disabled_until)
        : 0;
      if (previous >= untilMs) return;
      await applyGuildMemberTimeout(guildId, userId, untilMs, token);
    },
    async moderate(action, userId, reason) {
      await mutate(
        action === "ban" ? "PUT" : "DELETE",
        `/guilds/${guildId}/${action === "kick" ? "members" : "bans"}/${userId}`,
        reason,
        action === "ban" ? { delete_message_seconds: 0 } : undefined,
      );
    },
    async messages(channelId, limit) {
      await validateChannel(channelId);
      return (await listChannelMessages(channelId, token, { limit })).map((message) => ({
        id: message.id,
        userId: message.author.id,
        content: message.content ?? "",
        bot: "bot" in message.author && message.author.bot === true,
      }));
    },
    async assertStaffTarget(actorId, targetId, permission, channelId) {
      const [context, actor, target, guild] = await Promise.all([
        resources(),
        member(actorId),
        member(targetId),
        fetchGuildSummary(guildId, token),
      ]);
      if (!actor) throw new CommunityToolsError("You are no longer a member of this server.", 403);
      const bits = channelId
        ? getChannelPermissions(
            { ...context, botUserId: actorId, member: { roles: actor.roles } },
            await permissionChannel(await fetchDiscordChannel(channelId, token)),
          )
        : getMemberBaseGuildPermissions({
            guildId,
            roles: context.roles,
            memberRoleIds: actor.roles,
          });
      if (
        permission !== 0n &&
        actorId !== guild.owner_id &&
        (!hasPermission(bits, permission) || (channelId && !hasPermission(bits, 1n << 10n)))
      )
        throw new CommunityToolsError(
          "Your Discord role does not grant the permission required for this action.",
          403,
        );
      if (actorId === targetId) return;
      if (targetId === guild.owner_id || targetId === botUserId)
        throw new CommunityToolsError("This member cannot be targeted.", 403);
      if (!target) return;
      const targetBits = getMemberBaseGuildPermissions({
        guildId,
        roles: context.roles,
        memberRoleIds: target.roles,
      });
      const position = (roles: string[]) =>
        Math.max(
          0,
          ...context.roles.filter((role) => roles.includes(role.id)).map((role) => role.position),
        );
      if (
        (targetBits & 8n) !== 0n ||
        (actorId !== guild.owner_id && position(actor.roles) <= position(target.roles)) ||
        position(context.member.roles) <= position(target.roles)
      )
        throw new CommunityToolsError(
          "The target must be below you and HAF Bot in the Discord role hierarchy.",
          403,
        );
    },
  };
}
