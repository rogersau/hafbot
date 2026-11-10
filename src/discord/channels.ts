import { DISCORD_API, discordRequest } from "./client";
import type { CreateTicketChannelConfig } from "../services/ticket-service";
import type {
  CreateLfgPrivateVoiceChannelInput,
  UpdateLfgPrivateVoiceChannelAccessInput,
} from "../services/lfg-service";
import type { DiscordChannelResource } from "./guilds";
import type { NormalizedPermissionOverwrite } from "../services/channel-permission-copy-service";

const VIEW_CHANNEL = 1n << 10n;
const CONNECT = 1n << 20n;
const SPEAK = 1n << 21n;
const SEND_MESSAGES = 1n << 11n;
const MANAGE_THREADS = 1n << 34n;
const CREATE_PRIVATE_THREADS = 1n << 36n;
const SEND_MESSAGES_IN_THREADS = 1n << 38n;
const READ_MESSAGE_HISTORY = 1n << 16n;

export const BOT_DEFENSE_HONEYPOT_CHANNEL_NAME = "do-not-post";
export const BOT_DEFENSE_HONEYPOT_CHANNEL_TOPIC =
  "HAF Bot security channel: legitimate members should not post here. Posting creates a staff-review flag.";

export interface ConfigureBotDefenseHoneypotChannelInput {
  guildId: string;
  botUserId: string;
  hiddenRoleIds: string[];
  channelId?: string;
}

export async function configureBotDefenseHoneypotChannel(
  input: ConfigureBotDefenseHoneypotChannelInput,
  botToken: string,
): Promise<{ id: string; name: string }> {
  const visiblePermissions = VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY;
  const hiddenRoleIds = Array.from(new Set(input.hiddenRoleIds)).filter(
    (roleId) => roleId !== input.guildId && roleId !== input.botUserId,
  );
  const body = {
    name: BOT_DEFENSE_HONEYPOT_CHANNEL_NAME,
    type: 0,
    topic: BOT_DEFENSE_HONEYPOT_CHANNEL_TOPIC,
    permission_overwrites: [
      {
        id: input.guildId,
        type: 0,
        allow: String(visiblePermissions),
        deny: "0",
      },
      {
        id: input.botUserId,
        type: 1,
        allow: String(visiblePermissions),
        deny: "0",
      },
      ...hiddenRoleIds.map((roleId) => ({
        id: roleId,
        type: 0,
        allow: "0",
        deny: String(VIEW_CHANNEL),
      })),
    ],
  };
  const url = input.channelId
    ? `${DISCORD_API}/channels/${input.channelId}`
    : `${DISCORD_API}/guilds/${input.guildId}/channels`;
  const response = await discordRequest(url, input.channelId ? "PATCH" : "POST", botToken, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const channel = (await response.json()) as DiscordChannelResource;
  return { id: channel.id, name: channel.name };
}

export async function modifyChannel(
  channelId: string,
  body: { name?: string; [key: string]: unknown },
  botToken: string,
): Promise<void> {
  const response = await discordRequest(`${DISCORD_API}/channels/${channelId}`, "PATCH", botToken, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  response.body?.cancel();
}

export async function replaceChannelPermissionOverwrites(
  channelId: string,
  permissionOverwrites: readonly NormalizedPermissionOverwrite[],
  auditReason: string,
  botToken: string,
): Promise<DiscordChannelResource> {
  const response = await discordRequest(`${DISCORD_API}/channels/${channelId}`, "PATCH", botToken, {
    headers: {
      "Content-Type": "application/json",
      "X-Audit-Log-Reason": encodeURIComponent(auditReason.slice(0, 512)),
    },
    body: JSON.stringify({ permission_overwrites: permissionOverwrites }),
  });
  return (await response.json()) as DiscordChannelResource;
}

export async function createTicketChannel(
  config: CreateTicketChannelConfig,
  botToken: string,
): Promise<{ id: string }> {
  const supportRoleAllow =
    VIEW_CHANNEL |
    SEND_MESSAGES |
    READ_MESSAGE_HISTORY |
    (config.anonymousEnabled ? MANAGE_THREADS | SEND_MESSAGES_IN_THREADS : 0n);
  const botAllow =
    VIEW_CHANNEL |
    SEND_MESSAGES |
    READ_MESSAGE_HISTORY |
    (config.anonymousEnabled ? CREATE_PRIVATE_THREADS | SEND_MESSAGES_IN_THREADS : 0n);
  const permissionOverwrites = [
    {
      id: config.guildId,
      type: 0,
      allow: "0",
      deny: String(VIEW_CHANNEL),
    },
    {
      id: config.botUserId,
      type: 1,
      allow: String(botAllow),
      deny: "0",
    },
    {
      id: config.openerUserId,
      type: 1,
      allow: String(VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY),
      deny: "0",
    },
    {
      id: config.supportRoleId,
      type: 0,
      allow: String(supportRoleAllow),
      deny: "0",
    },
  ];

  const response = await discordRequest(
    `${DISCORD_API}/guilds/${config.guildId}/channels`,
    "POST",
    botToken,
    {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: config.name,
        type: 0,
        parent_id: config.parentId,
        permission_overwrites: permissionOverwrites,
      }),
    },
  );

  const channel = (await response.json()) as DiscordChannelResource;
  return { id: channel.id };
}

export async function addTicketParticipantAccess(
  channelId: string,
  userId: string,
  botToken: string,
): Promise<void> {
  const response = await discordRequest(
    `${DISCORD_API}/channels/${channelId}/permissions/${userId}`,
    "PUT",
    botToken,
    {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: 1,
        allow: String(VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY),
        deny: "0",
      }),
    },
  );
  response.body?.cancel();
}

export async function readTicketParticipantAccess(
  channelId: string,
  userId: string,
  botToken: string,
): Promise<{ allow: string; deny: string } | null> {
  const response = await discordRequest(`${DISCORD_API}/channels/${channelId}`, "GET", botToken);
  const channel = (await response.json()) as DiscordChannelResource;
  const overwrite = channel.permission_overwrites?.find(
    (entry) => entry.type === 1 && entry.id === userId,
  );
  return overwrite ? { allow: overwrite.allow, deny: overwrite.deny } : null;
}

export async function removeTicketParticipantAccess(
  channelId: string,
  userId: string,
  botToken: string,
): Promise<void> {
  const response = await discordRequest(
    `${DISCORD_API}/channels/${channelId}/permissions/${userId}`,
    "DELETE",
    botToken,
  );
  response.body?.cancel();
}

export async function createLfgPrivateVoiceChannel(
  input: CreateLfgPrivateVoiceChannelInput,
  botToken: string,
): Promise<{ id: string }> {
  const response = await discordRequest(
    `${DISCORD_API}/guilds/${input.guildId}/channels`,
    "POST",
    botToken,
    {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: input.name,
        type: 2,
        parent_id: input.parentId,
        permission_overwrites: buildLfgVoicePermissionOverwrites(input),
      }),
    },
  );

  const channel = (await response.json()) as DiscordChannelResource;
  return { id: channel.id };
}

export async function updateLfgPrivateVoiceChannelAccess(
  input: UpdateLfgPrivateVoiceChannelAccessInput,
  botToken: string,
): Promise<void> {
  await modifyChannel(
    input.channelId,
    { permission_overwrites: buildLfgVoicePermissionOverwrites(input) },
    botToken,
  );
}

function buildLfgVoicePermissionOverwrites(
  input: Pick<CreateLfgPrivateVoiceChannelInput, "guildId" | "ownerUserId" | "acceptedUserIds">,
) {
  const memberAllow = VIEW_CHANNEL | CONNECT | SPEAK;
  return [
    {
      id: input.guildId,
      type: 0,
      allow: "0",
      deny: String(memberAllow),
    },
    ...Array.from(new Set([input.ownerUserId, ...input.acceptedUserIds])).map((userId) => ({
      id: userId,
      type: 1,
      allow: String(memberAllow),
      deny: "0",
    })),
  ];
}

export async function createPrivateThread(
  channelId: string,
  name: string,
  botToken: string,
): Promise<{ id: string }> {
  const response = await discordRequest(
    `${DISCORD_API}/channels/${channelId}/threads`,
    "POST",
    botToken,
    {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, type: 12, invitable: false }),
    },
  );

  const thread = (await response.json()) as DiscordChannelResource;
  return { id: thread.id };
}

export async function addThreadMember(
  threadId: string,
  userId: string,
  botToken: string,
): Promise<void> {
  const response = await discordRequest(
    `${DISCORD_API}/channels/${threadId}/thread-members/${userId}`,
    "PUT",
    botToken,
  );
  response.body?.cancel();
}

export interface ForumTag {
  id: string;
  name: string;
  moderated?: boolean;
  emoji_id?: string | null;
  emoji_name?: string | null;
}

/**
 * List the available tags of a GUILD_FORUM channel.
 */
export async function listForumTags(channelId: string, botToken: string): Promise<ForumTag[]> {
  const response = await discordRequest(`${DISCORD_API}/channels/${channelId}`, "GET", botToken);
  const channel = (await response.json()) as { available_tags?: ForumTag[] };
  return Array.isArray(channel.available_tags)
    ? channel.available_tags.map((tag) => ({
        id: tag.id,
        name: tag.name,
        moderated: tag.moderated,
        emoji_id: tag.emoji_id,
        emoji_name: tag.emoji_name,
      }))
    : [];
}

/**
 * Ensure a GUILD_FORUM channel has the named tags, preserving its existing tag
 * definitions. Discord creates missing tags when the full available_tags set is
 * patched without an id on the new entries.
 */
export async function ensureForumTags(
  channelId: string,
  tagNames: string[],
  botToken: string,
): Promise<ForumTag[]> {
  const existing = await listForumTags(channelId, botToken);
  const missing = tagNames.filter((name) => !existing.some((tag) => tag.name === name));
  if (missing.length === 0) {
    return existing;
  }

  const response = await discordRequest(`${DISCORD_API}/channels/${channelId}`, "PATCH", botToken, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      available_tags: [
        ...existing.map((tag) => ({
          id: tag.id,
          name: tag.name,
          moderated: tag.moderated ?? false,
          emoji_id: tag.emoji_id ?? null,
          emoji_name: tag.emoji_name ?? null,
        })),
        ...missing.map((name) => ({
          name,
          moderated: false,
          emoji_id: null,
          emoji_name: null,
        })),
      ],
    }),
  });
  const channel = (await response.json()) as { available_tags?: ForumTag[] };
  return Array.isArray(channel.available_tags)
    ? channel.available_tags.map((tag) => ({
        id: tag.id,
        name: tag.name,
        moderated: tag.moderated,
        emoji_id: tag.emoji_id,
        emoji_name: tag.emoji_name,
      }))
    : [];
}

export async function getChannelParent(
  channelId: string,
  botToken: string,
): Promise<{ parentId: string | null; type: number }> {
  const response = await discordRequest(`${DISCORD_API}/channels/${channelId}`, "GET", botToken);
  const channel = (await response.json()) as DiscordChannelResource;
  return { parentId: channel.parent_id ?? null, type: channel.type };
}
