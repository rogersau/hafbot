import {
  addGuildMemberRole,
  applyGuildMemberTimeout,
  createChannelMessage,
  createChannelMessageWithAttachments,
  deleteChannelMessage,
  deleteReaction,
  editChannelMessage,
  fetchChannelMessage,
  fetchGuildMember,
  getChannelParent,
  removeGuildMemberRole,
} from "../../discord";
import { fetchGuildSummary, leaveGuild, listGuildRoles } from "../../discord/guilds";
import {
  createDiscordGuildResourceValidator,
  type GuildResourceValidator,
} from "../../discord/guild-resource-validator";
import { guildMemberHasRole } from "../../discord/members";
import { createUserDmMessage, deleteChannel } from "../../discord/messages";
import { createDiscordReactionRoleOperations } from "../../discord/reaction-roles";

export function createGatewayDiscordCapabilities(
  token: string,
  guildResources: GuildResourceValidator = createDiscordGuildResourceValidator(token),
) {
  return {
    reactionRoles: createDiscordReactionRoleOperations(token),
    guildResources,
    addGuildMemberRole: (guildId: string, userId: string, roleId: string) =>
      addGuildMemberRole(guildId, userId, roleId, token),
    applyGuildMemberTimeout: (guildId: string, userId: string, untilMs: number) =>
      applyGuildMemberTimeout(guildId, userId, untilMs, token),
    createChannelMessage: (channelId: string, body: Parameters<typeof createChannelMessage>[1]) =>
      createChannelMessage(channelId, body, token),
    createChannelMessageWithAttachments: (
      channelId: string,
      body: Parameters<typeof createChannelMessageWithAttachments>[1],
      attachments: Parameters<typeof createChannelMessageWithAttachments>[2],
    ) => createChannelMessageWithAttachments(channelId, body, attachments, token),
    createUserDmMessage: (userId: string, body: Parameters<typeof createUserDmMessage>[1]) =>
      createUserDmMessage(userId, body, token),
    deleteChannel: (channelId: string) => deleteChannel(channelId, token),
    deleteChannelMessage: (channelId: string, messageId: string) =>
      deleteChannelMessage(channelId, messageId, token),
    deleteReaction: (
      channelId: string,
      messageId: string,
      emoji: Parameters<typeof deleteReaction>[2],
      userId: string,
    ) => deleteReaction(channelId, messageId, emoji, userId, token),
    editChannelMessage: (
      channelId: string,
      messageId: string,
      body: Parameters<typeof editChannelMessage>[2],
    ) => editChannelMessage(channelId, messageId, body, token),
    fetchGuildSummary: (guildId: string) => fetchGuildSummary(guildId, token),
    fetchChannelMessage: (channelId: string, messageId: string) =>
      fetchChannelMessage(channelId, messageId, token),
    fetchGuildMember: (guildId: string, userId: string) => fetchGuildMember(guildId, userId, token),
    getChannelParent: (channelId: string) => getChannelParent(channelId, token),
    guildMemberHasRole: (guildId: string, userId: string, roleId: string) =>
      guildMemberHasRole(guildId, userId, roleId, token),
    leaveGuild: (guildId: string) => leaveGuild(guildId, token),
    listGuildRoles: (guildId: string) => listGuildRoles(guildId, token),
    removeGuildMemberRole: (guildId: string, userId: string, roleId: string) =>
      removeGuildMemberRole(guildId, userId, roleId, token),
  };
}

export type GatewayDiscordCapabilities = ReturnType<typeof createGatewayDiscordCapabilities>;
