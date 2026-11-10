import {
  DISCORD_API,
  DiscordApiError,
  discordGetJson,
  discordOAuthGetJson,
  discordRequest,
} from "./client";

export interface DiscordChannelResource {
  id: string;
  guild_id?: string;
  name: string;
  type: number;
  parent_id: string | null;
  position: number | null;
  permission_overwrites?: DiscordPermissionOverwrite[];
  topic?: string | null;
}

export interface DiscordRoleResource {
  id: string;
  name: string;
  permissions: string;
  position: number;
  managed?: boolean;
}

export interface DiscordGuildSummaryResource {
  id: string;
  name: string;
  owner_id?: string;
  icon?: string | null;
}

export interface DiscordCurrentUserGuildResource {
  id: string;
  name: string;
  owner?: boolean;
  permissions?: string;
  icon?: string | null;
}

export interface DiscordPermissionOverwrite {
  id: string;
  type: number;
  allow: string;
  deny: string;
}

export interface DiscordGuildMemberResource {
  user?: {
    id: string;
    username?: string;
    global_name?: string | null;
  };
  roles: string[];
}

export interface GuildTicketResources {
  channels: DiscordChannelResource[];
  roles: DiscordRoleResource[];
}

export async function listBotGuilds(
  botToken: string,
): Promise<Array<{ guildId: string; name: string; icon: string | null }>> {
  const guilds = await discordGetJson<DiscordGuildSummaryResource[]>(
    `${DISCORD_API}/users/@me/guilds`,
    botToken,
  );

  return guilds.map(({ id, name, icon }) => ({
    guildId: id,
    name,
    icon: typeof icon === "string" && icon ? icon : null,
  }));
}

export async function leaveGuild(
  guildId: string,
  botToken: string,
): Promise<"left" | "not-member"> {
  try {
    await discordRequest(
      `${DISCORD_API}/users/@me/guilds/${encodeURIComponent(guildId)}`,
      "DELETE",
      botToken,
    );
    return "left";
  } catch (error) {
    if (error instanceof DiscordApiError && error.status === 404) return "not-member";
    throw error;
  }
}

export async function listCurrentUserGuilds(
  accessToken: string,
): Promise<
  Array<{ guildId: string; name: string; owner: boolean; permissions: string; icon: string | null }>
> {
  const guilds = await discordOAuthGetJson<DiscordCurrentUserGuildResource[]>(
    `${DISCORD_API}/users/@me/guilds`,
    accessToken,
  );

  return guilds.map(({ id, name, owner, permissions, icon }) => ({
    guildId: id,
    name,
    owner: owner === true,
    permissions: typeof permissions === "string" ? permissions : "0",
    icon: typeof icon === "string" && icon ? icon : null,
  }));
}

export async function fetchGuildSummary(
  guildId: string,
  botToken: string,
): Promise<DiscordGuildSummaryResource> {
  return discordGetJson<DiscordGuildSummaryResource>(`${DISCORD_API}/guilds/${guildId}`, botToken);
}

export interface DiscordGuildEmojiResource {
  id: string | null;
  name: string | null;
  animated?: boolean;
  available?: boolean;
}

export async function listGuildTicketResources(
  guildId: string,
  botToken: string,
): Promise<GuildTicketResources> {
  const [channels, roles] = await Promise.all([
    discordGetJson<DiscordChannelResource[]>(`${DISCORD_API}/guilds/${guildId}/channels`, botToken),
    discordGetJson<DiscordRoleResource[]>(`${DISCORD_API}/guilds/${guildId}/roles`, botToken),
  ]);

  return {
    channels,
    roles,
  };
}

export async function fetchDiscordChannel(
  channelId: string,
  botToken: string,
): Promise<DiscordChannelResource> {
  return discordGetJson<DiscordChannelResource>(`${DISCORD_API}/channels/${channelId}`, botToken);
}

export async function listGuildRoles(
  guildId: string,
  botToken: string,
): Promise<DiscordRoleResource[]> {
  return discordGetJson<DiscordRoleResource[]>(`${DISCORD_API}/guilds/${guildId}/roles`, botToken);
}

export async function listGuildEmojis(
  guildId: string,
  botToken: string,
): Promise<DiscordGuildEmojiResource[]> {
  return discordGetJson<DiscordGuildEmojiResource[]>(
    `${DISCORD_API}/guilds/${guildId}/emojis`,
    botToken,
  );
}

export async function getGuildPermissionResources(
  guildId: string,
  botUserId: string,
  botToken: string,
): Promise<{
  channels: DiscordChannelResource[];
  roles: DiscordRoleResource[];
  member: DiscordGuildMemberResource;
}> {
  const [channels, roles, member] = await Promise.all([
    discordGetJson<DiscordChannelResource[]>(`${DISCORD_API}/guilds/${guildId}/channels`, botToken),
    discordGetJson<DiscordRoleResource[]>(`${DISCORD_API}/guilds/${guildId}/roles`, botToken),
    discordGetJson<DiscordGuildMemberResource>(
      `${DISCORD_API}/guilds/${guildId}/members/${botUserId}`,
      botToken,
    ),
  ]);

  return {
    channels,
    roles,
    member,
  };
}

export async function fetchGuildMemberResource(
  guildId: string,
  userId: string,
  botToken: string,
): Promise<DiscordGuildMemberResource> {
  return discordGetJson<DiscordGuildMemberResource>(
    `${DISCORD_API}/guilds/${guildId}/members/${userId}`,
    botToken,
  );
}

export async function fetchChannelPermissionCopyResources(
  guildId: string,
  actorUserId: string,
  botUserId: string,
  botToken: string,
): Promise<{
  guild: DiscordGuildSummaryResource;
  channels: DiscordChannelResource[];
  roles: DiscordRoleResource[];
  actorMember: DiscordGuildMemberResource;
  botMember: DiscordGuildMemberResource;
}> {
  const [guild, channels, roles, actorMember, botMember] = await Promise.all([
    fetchGuildSummary(guildId, botToken),
    discordGetJson<DiscordChannelResource[]>(`${DISCORD_API}/guilds/${guildId}/channels`, botToken),
    listGuildRoles(guildId, botToken),
    fetchGuildMemberResource(guildId, actorUserId, botToken),
    fetchGuildMemberResource(guildId, botUserId, botToken),
  ]);
  return { guild, channels, roles, actorMember, botMember };
}
