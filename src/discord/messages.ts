import type { DiscordMessageCreate, DiscordReaction } from "../types";
import {
  DISCORD_API,
  DiscordApiError,
  discordRequest,
  discordRawRequest,
  parseDiscordJson,
} from "./client";

export interface CreateChannelMessageInput {
  content?: string;
  embeds?: DiscordEmbed[];
  allowed_mentions?: DiscordAllowedMentions;
  components?: unknown[];
  message_reference?: DiscordMessageReference;
  nonce?: string;
  enforce_nonce?: boolean;
}

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbedFooter {
  text: string;
}

export interface DiscordEmbedThumbnail {
  url: string;
}

export interface DiscordEmbedImage {
  url: string;
}

export interface DiscordAllowedMentions {
  parse?: Array<"roles" | "users" | "everyone">;
  roles?: string[];
  users?: string[];
  replied_user?: boolean;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: DiscordEmbedField[];
  thumbnail?: DiscordEmbedThumbnail;
  image?: DiscordEmbedImage;
  footer?: DiscordEmbedFooter;
  timestamp?: string;
}

export interface DiscordMessageResource {
  id: string;
  channel_id: string;
  content: string;
}

export function buildAuditEmbed(input: {
  title: string;
  description?: string;
  color: number;
  fields: DiscordEmbedField[];
  timestamp?: string;
}): DiscordEmbed {
  return {
    title: input.title,
    description: input.description,
    color: input.color,
    fields: input.fields.map((field) => ({ ...field, inline: false })),
    footer: { text: "hafbot.xyz" },
    timestamp: input.timestamp ?? new Date().toISOString(),
  };
}

export function formatStaffUserReference(userId: string): string {
  return `${formatUserMention(userId)}\nID: ${userId}`;
}

export function formatUserMention(userId: string): string {
  return `<@${userId}>`;
}

export function suppressMentions(): DiscordAllowedMentions {
  return { parse: [] };
}

export function allowUserMentions(userIds: string[]): DiscordAllowedMentions {
  return { parse: [], users: userIds };
}

export interface DiscordMessageAttachmentResource {
  id: string;
  filename: string;
  description?: string | null;
  content_type?: string | null;
  size?: number;
  url: string;
  proxy_url?: string;
  height?: number | null;
  width?: number | null;
}

export interface DiscordMessageReference {
  message_id?: string;
  channel_id?: string;
  guild_id?: string;
}

export interface DiscordMessageListItem extends DiscordMessageResource {
  embeds?: DiscordEmbed[];
  components?: unknown[];
  timestamp: string;
  author: {
    id: string;
    username: string;
    discriminator: string;
    global_name: string | null;
    avatar: string | null;
  };
  member?: {
    nick?: string | null;
  };
  attachments?: DiscordMessageAttachmentResource[];
  message_reference?: DiscordMessageReference | null;
  referenced_message?: DiscordMessageListItem | null;
}

export async function createChannelMessage(
  channelId: string,
  body: CreateChannelMessageInput,
  botToken: string,
): Promise<DiscordMessageResource> {
  const response = await discordRequest(
    `${DISCORD_API}/channels/${channelId}/messages`,
    "POST",
    botToken,
    {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

  return await parseDiscordJson<DiscordMessageResource>(
    response,
    "Failed to create channel message",
  );
}

export async function fetchChannelMessage(
  channelId: string,
  messageId: string,
  botToken: string,
): Promise<
  (DiscordMessageCreate & Pick<CreateChannelMessageInput, "embeds" | "components">) | null
> {
  try {
    const response = await discordRequest(
      `${DISCORD_API}/channels/${channelId}/messages/${messageId}`,
      "GET",
      botToken,
    );
    return await parseDiscordJson<DiscordMessageCreate>(
      response,
      "Failed to fetch channel message",
    );
  } catch (error) {
    if (error instanceof DiscordApiError && error.status === 404) return null;
    throw error;
  }
}

export async function editOriginalInteractionResponse(
  applicationId: string,
  interactionToken: string,
  body: CreateChannelMessageInput,
): Promise<DiscordMessageResource> {
  const response = await discordRawRequest(
    `${DISCORD_API}/webhooks/${applicationId}/${interactionToken}/messages/@original`,
    "PATCH",
    {
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  return await parseDiscordJson<DiscordMessageResource>(
    response,
    "Failed to edit original interaction response",
  );
}

export async function createChannelMessageWithAttachments(
  channelId: string,
  body: CreateChannelMessageInput,
  files: Array<{ filename: string; contentType: string | null; data: Blob | ArrayBuffer }>,
  botToken: string,
): Promise<DiscordMessageResource> {
  const form = new FormData();
  form.set(
    "payload_json",
    JSON.stringify({
      content: body.content,
      allowed_mentions: body.allowed_mentions,
      attachments: files.map((file, index) => ({ id: index, filename: file.filename })),
    }),
  );
  files.forEach((file, index) => {
    form.set(
      `files[${index}]`,
      new File([file.data], file.filename, { type: file.contentType ?? undefined }),
    );
  });

  const response = await discordRequest(
    `${DISCORD_API}/channels/${channelId}/messages`,
    "POST",
    botToken,
    { body: form },
  );

  return await parseDiscordJson<DiscordMessageResource>(
    response,
    "Failed to create channel message with attachments",
  );
}

export async function editChannelMessage(
  channelId: string,
  messageId: string,
  body: CreateChannelMessageInput,
  botToken: string,
): Promise<DiscordMessageResource> {
  const response = await discordRequest(
    `${DISCORD_API}/channels/${channelId}/messages/${messageId}`,
    "PATCH",
    botToken,
    {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

  return await parseDiscordJson<DiscordMessageResource>(response, "Failed to edit channel message");
}

export async function deleteChannelMessage(
  channelId: string,
  messageId: string,
  botToken: string,
): Promise<void> {
  const response = await discordRequest(
    `${DISCORD_API}/channels/${channelId}/messages/${messageId}`,
    "DELETE",
    botToken,
  );
  response.body?.cancel();
}

export async function createUserDmChannel(
  userId: string,
  botToken: string,
): Promise<{ id: string }> {
  const response = await discordRequest(`${DISCORD_API}/users/@me/channels`, "POST", botToken, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient_id: userId }),
  });

  return await parseDiscordJson<{ id: string }>(response, "Failed to create DM channel");
}

export async function createUserDmMessage(
  userId: string,
  body: CreateChannelMessageInput,
  botToken: string,
): Promise<DiscordMessageResource> {
  const dmChannel = await createUserDmChannel(userId, botToken);
  return createChannelMessage(dmChannel.id, body, botToken);
}

export async function listChannelMessages(
  channelId: string,
  botToken: string,
  options?: { before?: string; after?: string; limit?: number },
): Promise<DiscordMessageListItem[]> {
  const url = new URL(`${DISCORD_API}/channels/${channelId}/messages`);
  url.searchParams.set("limit", String(options?.limit ?? 50));
  if (options?.before) {
    url.searchParams.set("before", options.before);
  }
  if (options?.after) {
    url.searchParams.set("after", options.after);
  }

  const response = await discordRequest(url.toString(), "GET", botToken);
  return await parseDiscordJson<DiscordMessageListItem[]>(
    response,
    "Failed to list channel messages",
  );
}

export async function deleteChannel(channelId: string, botToken: string): Promise<void> {
  const response = await discordRequest(`${DISCORD_API}/channels/${channelId}`, "DELETE", botToken);
  response.body?.cancel();
}

export async function uploadTranscriptToChannel(
  channelId: string,
  filename: string,
  transcriptBody: string,
  botToken: string,
  options?: {
    htmlTranscriptUrl?: string;
    embeds?: DiscordEmbed[];
  },
): Promise<DiscordMessageResource> {
  const form = new FormData();
  form.set(
    "payload_json",
    JSON.stringify({
      content: options?.htmlTranscriptUrl
        ? `HTML transcript: ${options.htmlTranscriptUrl}`
        : undefined,
      embeds: options?.embeds,
      attachments: [{ id: 0, filename }],
    }),
  );
  form.set("files[0]", new File([transcriptBody], filename, { type: "text/plain" }));

  const response = await discordRequest(
    `${DISCORD_API}/channels/${channelId}/messages`,
    "POST",
    botToken,
    { body: form },
  );

  return await parseDiscordJson<DiscordMessageResource>(response, "Failed to upload transcript");
}

export async function createReaction(
  channelId: string,
  messageId: string,
  emoji: string,
  botToken: string,
): Promise<void> {
  const url = `${DISCORD_API}/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`;
  const response = await discordRequest(url, "PUT", botToken, {
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok && response.status !== 204) {
    const error = await response.text().catch(() => "Unknown error");
    console.error(`Failed to add reaction: ${response.status} - ${error}`);
    throw new Error(`Discord API error: ${response.status}`);
  }

  response.body?.cancel();
}

export async function deleteReaction(
  channelId: string,
  messageId: string,
  emoji: DiscordReaction["emoji"],
  userId: string,
  botToken: string,
): Promise<void> {
  const encodedEmoji = encodeEmoji(emoji);

  const url = `${DISCORD_API}/channels/${channelId}/messages/${messageId}/reactions/${encodedEmoji}/${encodeURIComponent(userId)}`;

  const response = await discordRequest(url, "DELETE", botToken, {
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok && response.status !== 204) {
    const error = await response.text().catch(() => "Unknown error");
    console.error(`Failed to delete reaction: ${response.status} - ${error}`);
    throw new Error(`Discord API error: ${response.status}`);
  }

  response.body?.cancel();
}

function encodeEmoji(emoji: DiscordReaction["emoji"]): string {
  if (emoji.id && emoji.name) {
    return `${emoji.name}:${emoji.id}`;
  } else if (emoji.name) {
    return encodeURIComponent(emoji.name);
  }
  throw new Error("Invalid emoji: no name or id");
}
