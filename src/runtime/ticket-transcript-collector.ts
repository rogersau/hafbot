import { listBotGuilds, listChannelMessages, listGuildTicketResources } from "../discord";
import { isRecord } from "../unknown-parse";
import type { DiscordMessageListItem } from "../discord/messages";
import {
  buildTicketTranscriptAttachmentPath,
  buildTicketTranscriptAttachmentStorageKey,
  buildTicketTranscriptPath,
  buildTicketTranscriptStorageKey,
  generateTicketTranscriptAccessToken,
  hydrateTicketTranscriptAttachmentUrl,
  renderTicketTranscriptHtml,
  TICKET_TRANSCRIPT_ACCESS_TOKEN_PLACEHOLDER,
  type TicketTranscriptAttachment,
  type TicketTranscriptMessage,
  type TicketTranscriptPresentationOptions,
} from "../tickets";
import type { TicketInstance, TicketParticipantEvent } from "../types";
import type { TicketTranscriptBlobStore, TicketTranscriptCapabilityAccess } from "./contracts";
import { resolveMessageDisplayName } from "./discord-user";

export const TICKET_TRANSCRIPT_ACCESS_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const TICKET_TRANSCRIPT_RETENTION_MS = 365 * 24 * 60 * 60 * 1_000;

export interface TicketTranscriptArtifacts {
  messages: TicketTranscriptMessage[];
  presentation: TicketTranscriptPresentationOptions;
  participantEvents: TicketParticipantEvent[];
  htmlUrl?: string;
  accessToken?: string;
  discard?: () => Promise<void>;
}

export interface StaffMessageResolver {
  readStaffMessageMapping(body: {
    guildId: string;
    ticketChannelId: string;
    botMessageId: string;
  }): Promise<{ staffUserId: string; staffDisplayName: string } | null>;
}

export async function buildTicketTranscriptArtifacts(options: {
  guildId: string;
  channelId: string;
  closingTicket: TicketInstance;
  closerDisplayName: string | null;
  discordBotToken: string;
  requestOrigin: string;
  ticketTranscriptBlobs?: TicketTranscriptBlobStore;
  ticketTranscriptCapabilities?: TicketTranscriptCapabilityAccess;
  staffMessageResolver?: StaffMessageResolver;
  participantEventResolver?: {
    listTicketParticipantEvents(
      guildId: string,
      channelId: string,
    ): Promise<TicketParticipantEvent[]>;
  };
}): Promise<TicketTranscriptArtifacts> {
  const messages = await listAllChannelMessages(options.channelId, options.discordBotToken);
  let transcriptMessages = await mapDiscordMessagesToTicketTranscriptMessages(
    messages,
    options.guildId,
    options.channelId,
    options.staffMessageResolver,
  );
  const participantEvents = options.participantEventResolver
    ? await options.participantEventResolver.listTicketParticipantEvents(
        options.guildId,
        options.channelId,
      )
    : [];

  const participantDisplayNames = new Map<string, string>();
  for (const message of transcriptMessages) {
    if (!participantDisplayNames.has(message.authorId)) {
      participantDisplayNames.set(message.authorId, message.authorTag ?? message.authorId);
    }
  }

  let guildName: string | null = null;
  let channelName: string | null = null;
  try {
    const [guilds, guildResources] = await Promise.all([
      listBotGuilds(options.discordBotToken),
      listGuildTicketResources(options.guildId, options.discordBotToken),
    ]);
    guildName = guilds.find((guild) => guild.guildId === options.guildId)?.name ?? null;
    channelName =
      guildResources.channels.find((channel) => channel.id === options.channelId)?.name ?? null;
  } catch (error) {
    console.error("Failed to resolve transcript display metadata", error);
  }

  const presentation = {
    guildName,
    channelName,
    openerDisplayName: participantDisplayNames.get(options.closingTicket.openerUserId) ?? null,
    closerDisplayName:
      options.closerDisplayName ??
      (options.closingTicket.closedByUserId
        ? (participantDisplayNames.get(options.closingTicket.closedByUserId) ?? null)
        : null),
  };
  let htmlUrl: string | undefined;
  let accessToken: string | undefined;
  let discard: (() => Promise<void>) | undefined;

  if (options.ticketTranscriptBlobs && options.ticketTranscriptCapabilities) {
    const objectId = crypto.randomUUID();
    const createdAtMs = Date.now();
    accessToken = generateTicketTranscriptAccessToken();
    try {
      transcriptMessages = await archiveTicketTranscriptAttachments(
        transcriptMessages,
        options.guildId,
        options.channelId,
        objectId,
        TICKET_TRANSCRIPT_ACCESS_TOKEN_PLACEHOLDER,
        options.requestOrigin,
        options.ticketTranscriptBlobs,
      );
      await options.ticketTranscriptBlobs.putHtml(
        buildTicketTranscriptStorageKey(options.guildId, options.channelId, objectId),
        renderTicketTranscriptHtml(options.closingTicket, transcriptMessages, presentation),
      );
      await options.ticketTranscriptCapabilities.issue({
        objectId,
        guildId: options.guildId,
        channelId: options.channelId,
        accessToken,
        createdAtMs,
        expiresAtMs: createdAtMs + TICKET_TRANSCRIPT_ACCESS_TTL_MS,
        retentionExpiresAtMs: createdAtMs + TICKET_TRANSCRIPT_RETENTION_MS,
      });
      const deleteTranscriptArtifacts = options.ticketTranscriptBlobs.deleteTranscriptArtifacts;
      const ticketTranscriptCapabilities = options.ticketTranscriptCapabilities;
      discard = async () => {
        const discardedAtMs = Date.now();
        await ticketTranscriptCapabilities.discard({
          objectId,
          guildId: options.guildId,
          channelId: options.channelId,
          discardedAtMs,
        });
        if (deleteTranscriptArtifacts) {
          await deleteTranscriptArtifacts({
            objectId,
            guildId: options.guildId,
            channelId: options.channelId,
          });
          await ticketTranscriptCapabilities.deleteRetentionExpired({
            objectId,
            nowMs: discardedAtMs,
          });
        }
      };
      transcriptMessages = hydrateTicketTranscriptAttachmentTokens(transcriptMessages, accessToken);
    } catch (error) {
      await options.ticketTranscriptBlobs
        .deleteTranscriptArtifacts?.({
          objectId,
          guildId: options.guildId,
          channelId: options.channelId,
        })
        .catch((cleanupError) =>
          console.error("Failed to clean up Ticket transcript artifacts", cleanupError),
        );
      throw error;
    }
    htmlUrl = `${options.requestOrigin}${buildTicketTranscriptPath(options.guildId, options.channelId, accessToken)}`;
  }

  return {
    messages: transcriptMessages,
    presentation,
    participantEvents,
    htmlUrl,
    accessToken,
    discard,
  };
}

function hydrateTicketTranscriptAttachmentTokens(
  messages: TicketTranscriptMessage[],
  accessToken: string,
): TicketTranscriptMessage[] {
  return messages.map((message) => ({
    ...message,
    attachments: message.attachments?.map((attachment) => ({
      ...attachment,
      url: hydrateTicketTranscriptAttachmentUrl(attachment.url, accessToken),
    })),
  }));
}

export async function mapDiscordMessagesToTicketTranscriptMessages(
  messages: DiscordMessageListItem[],
  guildId: string,
  ticketChannelId: string,
  staffMessageResolver?: StaffMessageResolver,
): Promise<TicketTranscriptMessage[]> {
  const messageMap = buildDiscordMessageMap(messages);

  return Promise.all(
    messages.map(async (message) => {
      const authorTag = resolveDiscordMessageDisplayName(message);
      const mapping = staffMessageResolver
        ? await staffMessageResolver.readStaffMessageMapping({
            guildId,
            ticketChannelId,
            botMessageId: message.id,
          })
        : null;
      const replyTarget = resolveReplyTarget(message, messageMap);

      return {
        messageId: message.id,
        authorId: message.author.id,
        authorTag: mapping ? `${authorTag} (${mapping.staffDisplayName})` : authorTag,
        authorAvatarUrl: buildDiscordAvatarUrl(message.author),
        content: message.content,
        createdAtMs: Date.parse(message.timestamp),
        attachments: mapDiscordMessageAttachments(message),
        replyToMessageId: replyTarget?.messageId ?? null,
        replyTo: replyTarget?.preview ?? null,
      };
    }),
  );
}

async function listAllChannelMessages(channelId: string, discordBotToken: string) {
  const messages = [];
  let before: string | undefined;

  for (let page = 0; page < 10; page += 1) {
    const batch = await listChannelMessages(channelId, discordBotToken, { before, limit: 100 });
    messages.push(...batch);
    if (batch.length < 100) {
      break;
    }

    before = batch[batch.length - 1]?.id;
    if (!before) {
      break;
    }
  }

  return messages.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
}

function resolveDiscordMessageDisplayName(message: {
  member?: { nick?: string | null };
  author: { global_name: string | null; username: string; id?: string };
}): string {
  return (
    resolveMessageDisplayName(
      {
        member: message.member,
        author: message.author,
      },
      { terminalFallback: "" },
    ) ?? ""
  );
}

interface DiscordMessageReplyTarget {
  messageId: string;
  preview: { authorTag: string | null; authorAvatarUrl?: string | null; content: string };
}

function buildDiscordMessageMap(
  messages: DiscordMessageListItem[],
): Map<string, { authorTag: string; authorAvatarUrl: string | null; content: string }> {
  const map = new Map<
    string,
    { authorTag: string; authorAvatarUrl: string | null; content: string }
  >();
  for (const message of messages) {
    map.set(message.id, {
      authorTag: resolveDiscordMessageDisplayName(message),
      authorAvatarUrl: buildDiscordAvatarUrl(message.author),
      content: message.content,
    });
  }

  return map;
}

function resolveReplyTarget(
  message: DiscordMessageListItem,
  messageMap: Map<string, { authorTag: string; authorAvatarUrl: string | null; content: string }>,
): DiscordMessageReplyTarget | null {
  const referencedMessage = message.referenced_message;
  const referencedMessageId = referencedMessage?.id ?? message.message_reference?.message_id;
  if (!referencedMessageId) {
    return null;
  }

  const target = referencedMessage
    ? {
        authorTag: resolveDiscordMessageDisplayName(referencedMessage),
        authorAvatarUrl: buildDiscordAvatarUrl(referencedMessage.author),
        content: referencedMessage.content,
      }
    : messageMap.get(referencedMessageId);
  if (!target) {
    return {
      messageId: referencedMessageId,
      preview: {
        authorTag: null,
        authorAvatarUrl: null,
        content: "[original message unavailable]",
      },
    };
  }

  return {
    messageId: referencedMessageId,
    preview: {
      authorTag: target.authorTag,
      authorAvatarUrl: target.authorAvatarUrl,
      content: target.content,
    },
  };
}

function buildDiscordAvatarUrl(author: {
  id: string;
  avatar: string | null;
  discriminator?: string;
}): string | null {
  if (author.avatar) {
    return `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.png?size=128`;
  }

  const discriminator = Number(author.discriminator ?? 0);
  const defaultAvatarIndex = Number.isNaN(discriminator) ? 0 : discriminator % 5;
  return `https://cdn.discordapp.com/embed/avatars/${defaultAvatarIndex}.png`;
}

function mapDiscordMessageAttachments(message: {
  attachments?: unknown;
}): TicketTranscriptAttachment[] {
  if (!Array.isArray(message.attachments)) {
    return [];
  }

  const attachments: TicketTranscriptAttachment[] = [];
  for (const attachment of message.attachments) {
    if (!isRecord(attachment)) {
      continue;
    }

    const id = asOptionalString(attachment.id);
    const filename = asOptionalString(attachment.filename);
    const url = asOptionalString(attachment.url);
    if (!id || !filename || !url) {
      continue;
    }

    attachments.push({
      id,
      filename,
      url,
      proxyUrl: asOptionalString(attachment.proxy_url),
      contentType: normalizeContentType(asOptionalString(attachment.content_type)),
      size: asOptionalFiniteNumber(attachment.size),
      width: asOptionalFiniteNumber(attachment.width),
      height: asOptionalFiniteNumber(attachment.height),
    });
  }

  return attachments;
}

async function archiveTicketTranscriptAttachments(
  messages: TicketTranscriptMessage[],
  guildId: string,
  channelId: string,
  objectId: string,
  accessToken: string,
  requestOrigin: string,
  ticketTranscriptBlobs: TicketTranscriptBlobStore,
): Promise<TicketTranscriptMessage[]> {
  return Promise.all(
    messages.map(async (message) => {
      const attachments = message.attachments ?? [];
      if (attachments.length === 0) {
        return message;
      }

      return {
        ...message,
        attachments: (
          await Promise.all(
            attachments.map(async (attachment): Promise<TicketTranscriptAttachment | null> => {
              try {
                return await archiveTicketTranscriptAttachment(
                  attachment,
                  guildId,
                  channelId,
                  objectId,
                  accessToken,
                  requestOrigin,
                  ticketTranscriptBlobs,
                );
              } catch (error) {
                console.warn(
                  `Failed to archive attachment ${attachment.id} (${attachment.filename}), omitting it from the HTML transcript`,
                  error,
                );
                return null;
              }
            }),
          )
        ).filter((attachment): attachment is TicketTranscriptAttachment => attachment !== null),
      };
    }),
  );
}

async function archiveTicketTranscriptAttachment(
  attachment: TicketTranscriptAttachment,
  guildId: string,
  channelId: string,
  objectId: string,
  accessToken: string,
  requestOrigin: string,
  ticketTranscriptBlobs: TicketTranscriptBlobStore,
): Promise<TicketTranscriptAttachment> {
  const sourceUrl = getHttpUrl(attachment.url);
  if (!sourceUrl) {
    throw new Error(`Ticket attachment ${attachment.id} has an unsupported URL`);
  }

  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`Failed to archive ticket attachment ${attachment.id}: ${response.status}`);
  }

  const contentType =
    normalizeContentType(response.headers.get("content-type")) ?? attachment.contentType;
  const body = response.body ?? (await response.arrayBuffer());
  await ticketTranscriptBlobs.putAttachment(
    buildTicketTranscriptAttachmentStorageKey(
      guildId,
      channelId,
      objectId,
      attachment.id,
      attachment.filename,
    ),
    body,
    {
      contentType,
      sizeBytes: attachment.size ?? parseContentLength(response.headers.get("content-length")),
    },
  );

  return {
    ...attachment,
    url: `${requestOrigin}${buildTicketTranscriptAttachmentPath(guildId, channelId, accessToken, attachment.id, attachment.filename)}`,
    proxyUrl: null,
    contentType,
  };
}

function asOptionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asOptionalFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseContentLength(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function normalizeContentType(value: string | null): string | null {
  const normalized = value?.split(";")[0]?.trim().toLowerCase() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function getHttpUrl(value: string): string | null {
  try {
    const parsedUrl = new URL(value);
    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
      return null;
    }

    return parsedUrl.toString();
  } catch {
    return null;
  }
}
