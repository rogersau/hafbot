import { DISCORD_API, discordGetJson } from "./client";
import {
  createChannelMessage,
  createReaction,
  deleteReaction,
  deleteChannelMessage,
  editChannelMessage,
} from "./messages";
import { addGuildMemberRole, fetchGuildMember, removeGuildMemberRole } from "./members";
import { loadGuildPermissionContext } from "../runtime/admin-permissions";

export function createDiscordReactionRoleOperations(token: string) {
  return {
    loadPermissionContext: (guildId: string, botUserId: string) =>
      loadGuildPermissionContext(guildId, botUserId, token),
    createMessage: (channelId: string, body: Parameters<typeof createChannelMessage>[1]) =>
      createChannelMessage(channelId, body, token),
    editMessage: (
      channelId: string,
      messageId: string,
      body: Parameters<typeof editChannelMessage>[2],
    ) => editChannelMessage(channelId, messageId, body, token),
    deleteMessage: (channelId: string, messageId: string) =>
      deleteChannelMessage(channelId, messageId, token),
    seedReaction: (channelId: string, messageId: string, emoji: string) =>
      createReaction(channelId, messageId, emoji, token),
    clearReaction: (
      channelId: string,
      messageId: string,
      emoji: { id: string | null; name: string },
      userId: string,
    ) => deleteReaction(channelId, messageId, { ...emoji, animated: false }, userId, token),
    fetchMember: (guildId: string, userId: string) => fetchGuildMember(guildId, userId, token),
    addRole: (guildId: string, userId: string, roleId: string) =>
      addGuildMemberRole(guildId, userId, roleId, token),
    removeRole: (guildId: string, userId: string, roleId: string) =>
      removeGuildMemberRole(guildId, userId, roleId, token),
    async hasReaction(channelId: string, messageId: string, emoji: string, userId: string) {
      // A single exact-user lookup for each reaction type avoids scanning or paging a large panel.
      const after = (BigInt(userId) - 1n).toString();
      for (const type of [0, 1]) {
        const users = await discordGetJson<Array<{ id: string }>>(
          `${DISCORD_API}/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}?after=${after}&limit=1&type=${type}`,
          token,
        );
        if (users.some((user) => user.id === userId)) return true;
      }
      return false;
    },
  };
}

export type ReactionRoleDiscord = ReturnType<typeof createDiscordReactionRoleOperations>;
