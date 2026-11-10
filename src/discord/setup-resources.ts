import type { SetupResource } from "../feature-setup";
import { DISCORD_API, discordRequest } from "./client";

const VIEW_CHANNEL = 1n << 10n;
const SEND_MESSAGES = 1n << 11n;
const READ_MESSAGE_HISTORY = 1n << 16n;

interface CreatedDiscordResource {
  id: string;
  name: string;
}

export async function createSetupCategory(
  input: {
    guildId: string;
    name: string;
    private: boolean;
    botUserId: string;
    accessRoleIds?: string[];
  },
  botToken: string,
): Promise<SetupResource> {
  const permissionOverwrites = input.private
    ? [
        { id: input.guildId, type: 0, allow: "0", deny: String(VIEW_CHANNEL) },
        {
          id: input.botUserId,
          type: 1,
          allow: String(VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY),
          deny: "0",
        },
        ...(input.accessRoleIds ?? []).map((roleId) => ({
          id: roleId,
          type: 0,
          allow: String(VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY),
          deny: "0",
        })),
      ]
    : undefined;
  const created = await createGuildResource(
    input.guildId,
    {
      name: input.name,
      type: 4,
      ...(permissionOverwrites ? { permission_overwrites: permissionOverwrites } : {}),
    },
    botToken,
  );
  return { ...created, kind: "category" };
}

export async function createSetupTextChannel(
  input: SetupChannelInput,
  botToken: string,
): Promise<SetupResource> {
  const created = await createSetupChannel(input, 0, botToken);
  return { ...created, kind: "text_channel" };
}

export async function createSetupVoiceChannel(
  input: SetupChannelInput,
  botToken: string,
): Promise<SetupResource> {
  const created = await createSetupChannel(input, 2, botToken);
  return { ...created, kind: "voice_channel" };
}

export async function createSetupForumChannel(
  input: SetupChannelInput,
  botToken: string,
): Promise<SetupResource> {
  const created = await createSetupChannel(input, 15, botToken);
  return { ...created, kind: "forum_channel" };
}

export async function createSetupRole(
  input: { guildId: string; name: string },
  botToken: string,
): Promise<SetupResource> {
  const response = await discordRequest(
    `${DISCORD_API}/guilds/${input.guildId}/roles`,
    "POST",
    botToken,
    {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: input.name, permissions: "0", mentionable: false }),
    },
  );
  const created = (await response.json()) as CreatedDiscordResource;
  return { ...created, kind: "role" };
}

async function createGuildResource(
  guildId: string,
  body: Record<string, unknown>,
  botToken: string,
): Promise<CreatedDiscordResource> {
  const response = await discordRequest(
    `${DISCORD_API}/guilds/${guildId}/channels`,
    "POST",
    botToken,
    {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  return (await response.json()) as CreatedDiscordResource;
}

async function createSetupChannel(
  input: SetupChannelInput,
  type: 0 | 2 | 15,
  botToken: string,
): Promise<CreatedDiscordResource> {
  if (input.private && !input.botUserId) {
    throw new Error("Bot user identity is required to create a private setup channel.");
  }
  const permissionOverwrites = input.private
    ? [
        { id: input.guildId, type: 0, allow: "0", deny: String(VIEW_CHANNEL) },
        {
          id: input.botUserId!,
          type: 1,
          allow: String(VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY),
          deny: "0",
        },
        ...(input.accessRoleIds ?? []).map((roleId) => ({
          id: roleId,
          type: 0,
          allow: String(VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY),
          deny: "0",
        })),
      ]
    : undefined;
  return createGuildResource(
    input.guildId,
    {
      name: input.name,
      type,
      ...(permissionOverwrites ? { permission_overwrites: permissionOverwrites } : {}),
    },
    botToken,
  );
}

interface SetupChannelInput {
  guildId: string;
  name: string;
  private?: boolean;
  botUserId?: string;
  accessRoleIds?: string[];
}

export async function grantSetupChannelRoleAccess(
  channelId: string,
  roleId: string,
  botToken: string,
): Promise<void> {
  await discordRequest(
    `${DISCORD_API}/channels/${channelId}/permissions/${roleId}`,
    "PUT",
    botToken,
    {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: 0,
        allow: String(VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY),
        deny: "0",
      }),
    },
  );
}
