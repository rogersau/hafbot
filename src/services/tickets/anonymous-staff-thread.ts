import type {
  CreateChannelMessageInput,
  DiscordMessageAttachmentResource,
  DiscordMessageResource,
} from "../../discord/messages";
import type { TicketStore } from "../../runtime/contracts";
import { isRecord } from "../../unknown-parse";
import type { DiscordMessageCreate, DiscordMessageDelete, DiscordMessageUpdate } from "../../types";
import { resolveMessageDisplayName } from "../../runtime/discord-user";
import { suppressMentions } from "../../discord/messages";

type CreateStore = Pick<
  TicketStore,
  | "readOpenTicketByStaffThread"
  | "readTicketPanelConfigById"
  | "claimStaffMessageDelivery"
  | "completeStaffMessageDelivery"
  | "releaseStaffMessageDelivery"
>;

type UpdateStore = Pick<
  TicketStore,
  "readStaffMessageMappingByStaffMessage" | "updateStaffMessageMapping"
>;
type DeleteStore = Pick<
  TicketStore,
  "readStaffMessageMappingByStaffMessage" | "deleteStaffMessageMapping"
>;

interface AnonymousStaffThreadAdapters {
  createChannelMessage(
    channelId: string,
    body: CreateChannelMessageInput,
  ): Promise<DiscordMessageResource>;
  createChannelMessageWithAttachments?(
    channelId: string,
    body: CreateChannelMessageInput,
    files: Array<{ filename: string; contentType: string | null; data: Blob | ArrayBuffer }>,
  ): Promise<DiscordMessageResource>;
  fetchAttachment?(url: string): Promise<Response>;
  editChannelMessage(
    channelId: string,
    messageId: string,
    body: CreateChannelMessageInput,
  ): Promise<DiscordMessageResource>;
  deleteChannelMessage(channelId: string, messageId: string): Promise<void>;
  hasAdminAccess(message: DiscordMessageCreate): Promise<boolean>;
  now?: () => number;
}

const ALLOWED_MENTIONS: CreateChannelMessageInput["allowed_mentions"] = {
  ...suppressMentions(),
};

export function buildAnonymousSupportHelperMessage(): CreateChannelMessageInput {
  return {
    embeds: [
      {
        title: "Anonymous Support",
        description: "Reply to the member without exposing your Discord identity.",
        color: 0x5865f2,
        fields: [
          {
            name: "Send an anonymous reply",
            value: "Start your message with `!send`:\n`!send Your reply to the member`",
          },
          {
            name: "Keep a staff note private",
            value: "Post without `!send`. The message stays in this staff thread.",
          },
          {
            name: "Update a reply",
            value:
              "Edit or delete the original `!send` message to update or remove the bot's reply.",
          },
        ],
        footer: { text: "Attachments on !send messages are copied to the Ticket." },
      },
    ],
    allowed_mentions: ALLOWED_MENTIONS,
  };
}

export async function handleAnonymousStaffThreadMessageCreate(
  store: CreateStore,
  adapters: Pick<
    AnonymousStaffThreadAdapters,
    | "createChannelMessage"
    | "createChannelMessageWithAttachments"
    | "fetchAttachment"
    | "hasAdminAccess"
    | "now"
  >,
  message: DiscordMessageCreate | null,
): Promise<void> {
  if (!isProxyableCreateMessage(message)) {
    return;
  }

  const ticket = await store.readOpenTicketByStaffThread(message.guild_id, message.channel_id);
  if (!ticket) {
    return;
  }

  const trimmedContent = message.content.trimStart();
  if (!trimmedContent.startsWith("!send")) {
    return;
  }
  const publishedContent = trimmedContent.slice("!send".length).trimStart();

  const attachments = proxyableAttachments(message.attachments);
  if (publishedContent.length === 0 && attachments.length === 0) {
    return;
  }

  const panel = await store.readTicketPanelConfigById(message.guild_id, ticket.panelId ?? "main");
  const ticketType = panel?.ticketTypes.find((entry) => entry.id === ticket.ticketTypeId);
  if (!(ticketType?.anonymousSupportEnabled ?? false)) {
    return;
  }

  const isSupport = Boolean(
    ticket.supportRoleId && message.member?.roles?.includes(ticket.supportRoleId),
  );
  if (!isSupport && !(await adapters.hasAdminAccess(message))) {
    await adapters.createChannelMessage(message.channel_id, {
      content:
        "You need the Ticket support role, Administrator, Manage Guild, or the configured HAF administrator role to use `!send`.",
      allowed_mentions: { ...ALLOWED_MENTIONS, replied_user: false },
      message_reference: {
        message_id: message.id,
        channel_id: message.channel_id,
        guild_id: message.guild_id,
      },
      nonce: `ts-denied:${message.id}`,
      enforce_nonce: true,
    });
    return;
  }

  const identity = {
    guildId: message.guild_id,
    staffThreadId: message.channel_id,
    staffMessageId: message.id,
  };
  const claimedAtMs = adapters.now?.() ?? Date.now();
  const claimed = await store.claimStaffMessageDelivery({
    ...identity,
    ticketChannelId: ticket.channelId,
    staffUserId: message.author.id,
    staffDisplayName: displayNameForMessage(message) ?? message.author.id,
    content: publishedContent,
    createdAtMs: claimedAtMs,
  });
  if (!claimed) {
    return;
  }

  let botMessage: DiscordMessageResource;
  try {
    const files = await Promise.all(
      attachments.map((attachment, index) => downloadAttachment(adapters, attachment, index)),
    );

    const body = {
      content: publishedContent,
      allowed_mentions: ALLOWED_MENTIONS,
      nonce: `ts:${message.id}`,
      enforce_nonce: true,
    };
    botMessage =
      files.length > 0
        ? await createChannelMessageWithFiles(adapters, ticket.channelId, body, files)
        : await adapters.createChannelMessage(ticket.channelId, body);
  } catch (error) {
    await store.releaseStaffMessageDelivery({ ...identity, claimedAtMs });
    throw error;
  }

  await store.completeStaffMessageDelivery({
    ...identity,
    botMessageId: botMessage.id,
    claimedAtMs,
  });
}

export async function handleAnonymousStaffThreadMessageUpdate(
  store: UpdateStore,
  adapters: Pick<AnonymousStaffThreadAdapters, "editChannelMessage">,
  message: DiscordMessageUpdate | null,
): Promise<void> {
  if (!isMessageIdentity(message) || typeof message.content !== "string") {
    return;
  }

  const mapping = await store.readStaffMessageMappingByStaffMessage({
    guildId: message.guild_id,
    staffThreadId: message.channel_id,
    staffMessageId: message.id,
  });
  if (!mapping) {
    return;
  }

  const trimmedContent = message.content.trimStart();
  if (!trimmedContent.startsWith("!send")) {
    return;
  }
  const publishedContent = trimmedContent.slice("!send".length).trimStart();
  if (publishedContent.length === 0) {
    return;
  }

  await adapters.editChannelMessage(mapping.ticketChannelId, mapping.botMessageId, {
    content: publishedContent,
    allowed_mentions: ALLOWED_MENTIONS,
  });
  await store.updateStaffMessageMapping({
    guildId: message.guild_id,
    staffThreadId: message.channel_id,
    staffMessageId: message.id,
    staffDisplayName: displayNameForMessage(message) ?? mapping.staffDisplayName,
    content: publishedContent,
  });
}

export async function handleAnonymousStaffThreadMessageDelete(
  store: DeleteStore,
  adapters: Pick<AnonymousStaffThreadAdapters, "deleteChannelMessage">,
  message: DiscordMessageDelete | null,
): Promise<void> {
  if (!isMessageIdentity(message)) {
    return;
  }

  const mapping = await store.readStaffMessageMappingByStaffMessage({
    guildId: message.guild_id,
    staffThreadId: message.channel_id,
    staffMessageId: message.id,
  });
  if (!mapping) {
    return;
  }

  await adapters.deleteChannelMessage(mapping.ticketChannelId, mapping.botMessageId);
  await store.deleteStaffMessageMapping({
    guildId: message.guild_id,
    staffThreadId: message.channel_id,
    staffMessageId: message.id,
  });
}

function isProxyableCreateMessage(
  message: DiscordMessageCreate | null,
): message is DiscordMessageCreate & {
  guild_id: string;
  channel_id: string;
  id: string;
  content: string;
  author: { id: string };
} {
  if (!isMessageIdentity(message) || !message.author?.id) {
    return false;
  }
  if (message.author.bot === true) {
    return false;
  }
  if (message.type !== undefined && message.type !== 0) {
    return false;
  }
  if (typeof message.content !== "string" || message.content.trimStart().startsWith("/")) {
    return false;
  }

  return true;
}

function proxyableAttachments(
  attachments: unknown[] | undefined,
): DiscordMessageAttachmentResource[] {
  if (!Array.isArray(attachments)) {
    return [];
  }

  return attachments.filter((attachment): attachment is DiscordMessageAttachmentResource => {
    if (!isRecord(attachment)) {
      return false;
    }
    const candidate = attachment as Partial<DiscordMessageAttachmentResource>;
    return typeof candidate.url === "string" && typeof candidate.filename === "string";
  });
}

async function downloadAttachment(
  adapters: Pick<AnonymousStaffThreadAdapters, "fetchAttachment">,
  attachment: DiscordMessageAttachmentResource,
  index: number,
): Promise<{ filename: string; contentType: string | null; data: Blob }> {
  const url = new URL(attachment.url);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Unsupported attachment URL: ${attachment.url}`);
  }

  const response = await (adapters.fetchAttachment?.(attachment.url) ?? fetch(attachment.url));
  if (!response.ok) {
    throw new Error(`Failed to download attachment: ${response.status}`);
  }

  return {
    filename: attachment.filename || `attachment-${index}`,
    contentType: attachment.content_type ?? response.headers.get("Content-Type"),
    data: await response.blob(),
  };
}

async function createChannelMessageWithFiles(
  adapters: Pick<AnonymousStaffThreadAdapters, "createChannelMessageWithAttachments">,
  channelId: string,
  body: CreateChannelMessageInput,
  files: Array<{ filename: string; contentType: string | null; data: Blob | ArrayBuffer }>,
): Promise<DiscordMessageResource> {
  if (!adapters.createChannelMessageWithAttachments) {
    throw new Error("Attachment proxying is not configured");
  }

  return adapters.createChannelMessageWithAttachments(channelId, body, files);
}

function isMessageIdentity(
  message: DiscordMessageUpdate | DiscordMessageDelete | null,
): message is (DiscordMessageUpdate | DiscordMessageDelete) & {
  guild_id: string;
  channel_id: string;
  id: string;
} {
  return Boolean(message?.guild_id && message.channel_id && message.id);
}

function displayNameForMessage(
  message: DiscordMessageCreate | DiscordMessageUpdate,
): string | null {
  return resolveMessageDisplayName({
    member: message.member,
    author: message.author,
  });
}
