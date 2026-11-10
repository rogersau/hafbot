import {
  readImageReviewWorkflow,
  type ImageRestoreDelivery,
} from "../services/image-rules/review-workflow";
import { buildEphemeralMessage } from "../discord-interactions";
import { DISCORD_API, DiscordApiError, discordRequest, parseDiscordJson } from "../discord/client";
import { createChannelMessage, createUserDmMessage, editChannelMessage } from "../discord/messages";
import { postMessageAuditEvent } from "../services/guild-audit-log-service";
import type { DiscordInteraction, RuntimeStores } from "./app-types";
import { getInteractionCustomId, getInteractionUserId } from "./discord-interaction-parsers";
import { hasInteractionAdminAccess } from "./interaction-admin-access";
import { createGuildBrandingResolver } from "./guild-branding";
import {
  GUILD_BOUND_INTERACTION_DENIAL_MESSAGE,
  isInteractionBoundToGuild,
} from "./interaction-guild-binding";

const APPROVE_PREFIX = "image-rules:approve:";
const RESTORE_PREFIX = "image-rules:restore:";
const RESTORE_LEASE_MS = 60_000;
const RESTORE_HISTORY_SAFETY_MARGIN_MS = 60_000;
const RESTORE_HISTORY_PAGE_SIZE = 100;
const RESTORE_HISTORY_MAX_PAGES = 100;
const RESTORE_IN_PROGRESS_MESSAGE =
  "This Image Rules queue item is currently being restored. Try again shortly.";
const RESTORE_ROLLOUT_MESSAGE =
  "Image Rules restore is briefly unavailable during a deployment. Try again shortly.";

interface RestoreHistoryMessage {
  id: string;
  channel_id: string;
  content: string;
  timestamp: string;
  nonce?: string | number;
  author?: { bot?: boolean };
}

export function isImageRulesComponentInteraction(interaction: DiscordInteraction): boolean {
  const customId = getInteractionCustomId(interaction);
  return parseApproveCustomId(customId) !== null || parseRestoreCustomId(customId) !== null;
}

export async function handleImageRulesComponentInteraction(
  interaction: DiscordInteraction,
  stores: RuntimeStores,
  discordBotToken: string,
): Promise<Response> {
  const customId = getInteractionCustomId(interaction);
  const restoreItemId = parseRestoreCustomId(customId);
  const itemId = parseApproveCustomId(customId) ?? restoreItemId;
  if (!itemId) return Response.json(buildEphemeralMessage("Unsupported Image Rules action."));

  const item = await stores.imageRules.readModQueueItem(itemId);
  if (!item)
    return Response.json(buildEphemeralMessage("This Image Rules queue item was not found."));
  if (!isInteractionBoundToGuild(interaction, item.guildId)) {
    return Response.json(buildEphemeralMessage(GUILD_BOUND_INTERACTION_DENIAL_MESSAGE));
  }
  if (readImageReviewWorkflow(item, Date.now()).kind === "handled") {
    return Response.json(
      buildEphemeralMessage("This Image Rules queue item has already been handled."),
    );
  }

  const config = await stores.imageRules.readConfig(item.guildId);
  let authorized: boolean;
  if (config && config.modRoleIds.length > 0) {
    authorized = getInteractionMemberRoles(interaction).some((roleId) =>
      config.modRoleIds.includes(roleId),
    );
  } else {
    authorized = await hasInteractionAdminAccess(interaction, stores);
  }
  if (!authorized) {
    return Response.json(
      buildEphemeralMessage("Only Image Rules moderators can approve this deletion."),
    );
  }

  const actorUserId = getInteractionUserId(interaction);
  if (!actorUserId)
    return Response.json(buildEphemeralMessage("Could not determine your Discord user."));

  if (restoreItemId) {
    const nowMs = Date.now();
    const workflow = readImageReviewWorkflow(item, nowMs);
    if (workflow.kind === "restore-leased") {
      return Response.json(buildEphemeralMessage(RESTORE_IN_PROGRESS_MESSAGE));
    }
    const claimToken = crypto.randomUUID();
    const claimed = await stores.imageRules.claimModQueueItemRestore(
      item.id,
      claimToken,
      actorUserId,
      nowMs,
      RESTORE_LEASE_MS,
    );
    if (!claimed) return await modQueueActionOutcome(item.id, stores);
    return restoreMessage(
      claimed,
      claimToken,
      actorUserId,
      { kind: workflow.kind === "restore-recovery-required" ? "inspect-history" : "new-delivery" },
      stores,
      discordBotToken,
    );
  }

  const approved = await stores.imageRules.markModQueueItemApproved(
    item.id,
    actorUserId,
    Date.now(),
  );
  if (!approved || approved.status !== "approved") {
    return await modQueueActionOutcome(item.id, stores);
  }

  await notifyAuthorOfOutcome(approved, "approved", stores, discordBotToken);

  if (approved.queueChannelId && approved.queueMessageId) {
    await editChannelMessage(
      approved.queueChannelId,
      approved.queueMessageId,
      {
        content: "Image Rules review completed.",
        embeds: [
          {
            title: "Image Rules: Deletion Approved",
            description: `Approved by <@${actorUserId}>. The original message remains deleted.`,
            color: 0x2f855a,
            fields: [
              {
                name: "Original message",
                value: `<#${approved.channelId}> / ${approved.messageId}`,
                inline: false,
              },
              { name: "Author", value: `<@${approved.authorId}>`, inline: true },
            ],
            image: { url: approved.imageUrl },
          },
        ],
        components: [],
        allowed_mentions: { parse: [] },
      },
      discordBotToken,
    );
  }

  await postMessageAuditEvent(
    "image-rule.mod-queue-action",
    {
      guildId: approved.guildId,
      channelId: approved.channelId,
      messageId: approved.messageId,
      content: `Deletion approved by <@${actorUserId}>`,
      author: { id: approved.authorId },
    },
    stores.guildAuditLog,
    discordBotToken,
  );

  return Response.json(buildEphemeralMessage("Image Rules deletion approved."));
}

async function restoreMessage(
  item: NonNullable<Awaited<ReturnType<RuntimeStores["imageRules"]["readModQueueItem"]>>>,
  claimToken: string,
  actorUserId: string,
  delivery: ImageRestoreDelivery,
  stores: RuntimeStores,
  discordBotToken: string,
): Promise<Response> {
  const restoreActorUserId = item.decidedByUserId ?? actorUserId;
  const restoreNonce = await deriveRestoreNonce(item.id);
  let existingMessage: Awaited<ReturnType<typeof createChannelMessage>> | null = null;

  if (delivery.kind === "inspect-history") {
    try {
      existingMessage = await findExistingRestoredMessage(item, restoreNonce, discordBotToken);
    } catch {
      return await modQueueActionOutcome(item.id, stores);
    }
  }

  let restoredMessage: Awaited<ReturnType<typeof createChannelMessage>>;
  try {
    restoredMessage =
      existingMessage ??
      (await createChannelMessage(
        item.channelId,
        {
          content:
            `Restored by Image Rules moderator <@${restoreActorUserId}>.\n` +
            `Original author: <@${item.authorId}>\n` +
            `Original message ID: ${item.messageId}`,
          embeds: [
            {
              title: "Restored Image Rules Message",
              color: 0x5865f2,
              fields: [{ name: "Topic", value: item.topicDescription, inline: false }],
              image: { url: item.imageUrl },
            },
          ],
          allowed_mentions: { parse: [] },
          nonce: restoreNonce,
          enforce_nonce: true,
        },
        discordBotToken,
      ));
  } catch (error) {
    if (!isDefinitiveRestoreFailure(error)) {
      return await modQueueActionOutcome(item.id, stores);
    }
    const failed = await stores.imageRules.markModQueueItemRestoreFailed(
      item.id,
      claimToken,
      restoreActorUserId,
      describeRestoreFailure(error),
      Date.now(),
    );
    if (failed?.status === "restore_failed") {
      await notifyAuthorOfOutcome(failed, "restore_failed", stores, discordBotToken);
      await editQueueMessage(
        failed,
        restoreActorUserId,
        "Restore Failed",
        0xed4245,
        failed.failureReason ?? "Unknown failure",
        discordBotToken,
      );
      await postQueueAuditEvent(
        failed,
        restoreActorUserId,
        "Restore failed",
        stores,
        discordBotToken,
      );
      return Response.json(buildEphemeralMessage("Failed to restore the Image Rules message."));
    }
    return await modQueueActionOutcome(item.id, stores);
  }

  const restored = await stores.imageRules.markModQueueItemRestored(
    item.id,
    claimToken,
    restoreActorUserId,
    restoredMessage.id,
    Date.now(),
  );
  if (!restored || restored.status !== "restored")
    return await modQueueActionOutcome(item.id, stores);

  await notifyAuthorOfOutcome(restored, "restored", stores, discordBotToken, restoredMessage.id);
  await editQueueMessage(
    restored,
    restoreActorUserId,
    "Message Restored",
    0x5865f2,
    "The image was reposted to the original channel.",
    discordBotToken,
  );
  await postQueueAuditEvent(
    restored,
    restoreActorUserId,
    "Message restored",
    stores,
    discordBotToken,
  );
  return Response.json(buildEphemeralMessage("Image Rules message restored."));
}

async function findExistingRestoredMessage(
  item: NonNullable<Awaited<ReturnType<RuntimeStores["imageRules"]["readModQueueItem"]>>>,
  restoreNonce: string,
  discordBotToken: string,
): Promise<Awaited<ReturnType<typeof createChannelMessage>> | null> {
  const earliestTimestampMs =
    (item.decidedAtMs ?? item.updatedAtMs) - RESTORE_HISTORY_SAFETY_MARGIN_MS;
  let before: string | undefined;

  for (let page = 0; page < RESTORE_HISTORY_MAX_PAGES; page += 1) {
    const messages = await listRestoreHistoryMessages(item.channelId, before, discordBotToken);
    const existing = messages.find((message) =>
      isMatchingRestoredMessage(message, item.messageId, restoreNonce),
    );
    if (existing) return existing;
    if (messages.length < RESTORE_HISTORY_PAGE_SIZE) return null;

    const oldest = messages[messages.length - 1];
    const oldestTimestampMs = Date.parse(oldest.timestamp);
    if (Number.isFinite(oldestTimestampMs) && oldestTimestampMs < earliestTimestampMs) return null;
    before = oldest.id;
  }

  throw new Error("Unable to safely verify prior Image Rules restore delivery.");
}

async function listRestoreHistoryMessages(
  channelId: string,
  before: string | undefined,
  discordBotToken: string,
): Promise<RestoreHistoryMessage[]> {
  const url = new URL(`${DISCORD_API}/channels/${channelId}/messages`);
  url.searchParams.set("limit", String(RESTORE_HISTORY_PAGE_SIZE));
  if (before) url.searchParams.set("before", before);
  const response = await discordRequest(url.toString(), "GET", discordBotToken);
  return await parseDiscordJson<RestoreHistoryMessage[]>(
    response,
    "Failed to inspect Image Rules restore history",
  );
}

function isMatchingRestoredMessage(
  message: RestoreHistoryMessage,
  originalMessageId: string,
  restoreNonce: string,
): boolean {
  if (message.nonce !== undefined && String(message.nonce) === restoreNonce) return true;
  return (
    message.author?.bot === true &&
    message.content.startsWith("Restored by Image Rules moderator ") &&
    message.content.includes(`\nOriginal message ID: ${originalMessageId}`)
  );
}

async function modQueueActionOutcome(itemId: string, stores: RuntimeStores): Promise<Response> {
  const current = await stores.imageRules.readModQueueItem(itemId);
  const workflow = current ? readImageReviewWorkflow(current, Date.now()) : null;
  if (workflow?.kind === "restore-leased" || workflow?.kind === "restore-recovery-required") {
    return Response.json(buildEphemeralMessage(RESTORE_IN_PROGRESS_MESSAGE));
  }
  if (workflow?.kind === "pending") {
    return Response.json(buildEphemeralMessage(RESTORE_ROLLOUT_MESSAGE));
  }
  return Response.json(
    buildEphemeralMessage("This Image Rules queue item has already been handled."),
  );
}

async function notifyAuthorOfOutcome(
  item: NonNullable<Awaited<ReturnType<RuntimeStores["imageRules"]["readModQueueItem"]>>>,
  outcome: "approved" | "restored" | "restore_failed",
  stores: RuntimeStores,
  discordBotToken: string,
  restoredMessageId?: string,
): Promise<void> {
  try {
    const botDisplayName = await createGuildBrandingResolver(
      stores.whiteLabelBots,
    ).resolveBotDisplayName(item.guildId);
    const outcomeText =
      outcome === "approved"
        ? "Your image was reviewed and will remain deleted."
        : outcome === "restore_failed"
          ? "Your image was reviewed, but it could not be restored automatically. Server staff have been notified."
          : `Your image was reviewed and restored in <#${item.channelId}>.${
              restoredMessageId
                ? `\nhttps://discord.com/channels/${item.guildId}/${item.channelId}/${restoredMessageId}`
                : ""
            }`;
    await createUserDmMessage(
      item.authorId,
      {
        content: `${botDisplayName}: ${outcomeText}`,
        allowed_mentions: { parse: [] },
      },
      discordBotToken,
    );
    console.info("Image Rules outcome DM delivered", {
      guildId: item.guildId,
      itemId: item.id,
      outcome,
    });
  } catch (error) {
    console.error("Failed to deliver Image Rules outcome DM", {
      guildId: item.guildId,
      itemId: item.id,
      outcome,
      error,
    });
  }
}

async function editQueueMessage(
  item: NonNullable<Awaited<ReturnType<RuntimeStores["imageRules"]["readModQueueItem"]>>>,
  actorUserId: string,
  title: string,
  color: number,
  description: string,
  discordBotToken: string,
): Promise<void> {
  if (!item.queueChannelId || !item.queueMessageId) return;
  await editChannelMessage(
    item.queueChannelId,
    item.queueMessageId,
    {
      content: "Image Rules review completed.",
      embeds: [
        {
          title: `Image Rules: ${title}`,
          description: `${description}\nActioned by <@${actorUserId}>.`,
          color,
          fields: [
            {
              name: "Original message",
              value: `<#${item.channelId}> / ${item.messageId}`,
              inline: false,
            },
            { name: "Author", value: `<@${item.authorId}>`, inline: true },
          ],
          image: { url: item.imageUrl },
        },
      ],
      components: [],
      allowed_mentions: { parse: [] },
    },
    discordBotToken,
  );
}

async function postQueueAuditEvent(
  item: NonNullable<Awaited<ReturnType<RuntimeStores["imageRules"]["readModQueueItem"]>>>,
  actorUserId: string,
  action: string,
  stores: RuntimeStores,
  discordBotToken: string,
): Promise<void> {
  await postMessageAuditEvent(
    "image-rule.mod-queue-action",
    {
      guildId: item.guildId,
      channelId: item.channelId,
      messageId: item.messageId,
      content: `${action} by <@${actorUserId}>`,
      author: { id: item.authorId },
    },
    stores.guildAuditLog,
    discordBotToken,
  );
}

function parseApproveCustomId(customId: string | null): string | null {
  return customId?.startsWith(APPROVE_PREFIX)
    ? customId.slice(APPROVE_PREFIX.length) || null
    : null;
}

function parseRestoreCustomId(customId: string | null): string | null {
  return customId?.startsWith(RESTORE_PREFIX)
    ? customId.slice(RESTORE_PREFIX.length) || null
    : null;
}

function isDefinitiveRestoreFailure(error: unknown): boolean {
  return (
    error instanceof DiscordApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 429
  );
}

function describeRestoreFailure(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "Unknown restore failure";
}

async function deriveRestoreNonce(itemId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`image-rules:restore:${itemId}`),
  );
  return `ir:r:${Array.from(new Uint8Array(digest).slice(0, 10))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

function getInteractionMemberRoles(interaction: DiscordInteraction): string[] {
  const roles = interaction.member?.roles;
  return Array.isArray(roles)
    ? roles.filter((roleId): roleId is string => typeof roleId === "string")
    : [];
}
