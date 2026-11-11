import type { Env } from "../../env";
import type { AuditEventId, DiscordMessageCreate, GuildEntitlement } from "../../types";
import { getGuildEntitlementLimits } from "../../types";
import type { BotDefenseConfig, BotDefenseEvidence, BotFlag } from "../../types";
import { isRecord } from "../../unknown-parse";
import {
  buildAuditEmbed,
  formatStaffUserReference,
  suppressMentions,
  type CreateChannelMessageInput,
  type DiscordEmbed,
  type DiscordAllowedMentions,
} from "../../discord/messages";
import type { MessageAuditEventData } from "../guild-audit-log-service";
import { buildBotDefenseComponentId } from "../../bot-defense-component-id";
import { deriveGatewayOperationNonce } from "../../runtime/gateway-event-idempotency";

const FORUM_CHANNEL_TYPE = 15;

export interface BotDefenseMessageFilterDependencies {
  fingerprintImageAttachments(attachments: unknown[]): Promise<string | null>;
  readConfig(guildId: string): Promise<BotDefenseConfig | null>;
  readGuildEntitlement(guildId: string): Promise<GuildEntitlement>;
  resolveChannelParent(
    channelId: string,
    botToken: string,
  ): Promise<{ parentId: string | null; type: number }>;
  openBotFlag(
    guildId: string,
    userId: string,
    detectorType: "honeypot" | "rate",
    evidence: BotDefenseEvidence,
  ): Promise<Pick<BotFlag, "guildId" | "userId" | "queueMessageId" | "createdAtMs"> | null>;
  setBotFlagQueueMessage(
    guildId: string,
    userId: string,
    expectedCreatedAtMs: number,
    queueMessageId: string,
    nowMs: number,
  ): Promise<void>;
  recordRateMessage(
    guildId: string,
    userId: string,
    channelId: string,
    messageFingerprint: string,
    messageTimestampMs: number,
  ): Promise<void>;
  listMatchingMessageChannelsInWindow(
    guildId: string,
    userId: string,
    messageFingerprint: string,
    windowMs: number,
    nowMs: number,
  ): Promise<string[]>;
  createChannelMessage(
    channelId: string,
    body: CreateChannelMessageInput,
    botToken: string,
  ): Promise<{ id?: string } | void>;
  warnUser(
    channelId: string,
    messageId: string,
    userId: string,
    detectorType: "honeypot" | "rate",
  ): Promise<void>;
  deleteMessage(channelId: string, messageId: string): Promise<void>;
  postAuditEvent(eventId: AuditEventId, data: MessageAuditEventData): Promise<void>;
  resolveBotDisplayName(guildId: string): Promise<string>;
  nowMs(): number;
}

export async function moderateBotDefenseMessageCreate(
  message: DiscordMessageCreate | null,
  env: BotDefenseEnv,
  dependencies: BotDefenseMessageFilterDependencies,
): Promise<void> {
  if (!message?.guild_id) return;

  const guildId = message.guild_id;
  const authorId = message.author?.id;
  if (!authorId) return;

  const [entitlementResult, configResult] = await Promise.allSettled([
    dependencies.readGuildEntitlement(guildId),
    dependencies.readConfig(guildId),
  ]);
  if (entitlementResult.status === "rejected") {
    throw entitlementResult.reason;
  }

  if (configResult.status === "rejected") {
    console.error("Failed to load bot defense config", configResult.reason);
    return;
  }

  const entitlement = entitlementResult.value;
  const paidFeatures = getGuildEntitlementLimits(entitlement.tier).paidFeatures;
  const config = configResult.value;
  if (!config || (!config.honeypotEnabled && !config.rateEnabled)) {
    return;
  }

  if (message.author?.bot || message.webhook_id) return;
  const memberRoleIds = message.member?.roles ?? [];
  if (config.excludedRoleIds.some((roleId) => memberRoleIds.includes(roleId))) return;

  const now = dependencies.nowMs();
  const timestampMs = deriveMessageTimestampMs(message, now);

  const honeypotActionFailed = await runHoneypotDetector(
    message,
    guildId,
    authorId,
    config,
    env,
    dependencies,
    now,
  );
  const rateActionFailed = paidFeatures
    ? await runRateDetector(message, guildId, authorId, config, env, dependencies, timestampMs, now)
    : false;
  if (honeypotActionFailed || rateActionFailed) {
    throw new Error("Bot Defense actions are deferred for retry.");
  }
}

type BotDefenseEnv = Pick<Env, "DISCORD_BOT_TOKEN">;

async function runHoneypotDetector(
  message: DiscordMessageCreate,
  guildId: string,
  authorId: string,
  config: BotDefenseConfig,
  env: BotDefenseEnv,
  dependencies: BotDefenseMessageFilterDependencies,
  now: number,
): Promise<boolean> {
  if (!config.honeypotEnabled || config.honeypotChannelIds.length === 0) {
    return false;
  }

  const channelId = message.channel_id;
  let parent: { parentId: string | null; type: number } | undefined;
  if (config.honeypotChannelIds.includes(channelId)) {
    parent = { parentId: null, type: 0 };
  } else {
    try {
      parent = await dependencies.resolveChannelParent(channelId, env.DISCORD_BOT_TOKEN);
    } catch (error) {
      console.error("Failed to resolve channel parent for honeypot detector", error);
      return false;
    }
    if (!parent?.parentId || !config.honeypotChannelIds.includes(parent.parentId)) {
      return false;
    }
    const parentChannel = await dependencies.resolveChannelParent(
      parent.parentId,
      env.DISCORD_BOT_TOKEN,
    );
    if (parentChannel.type === FORUM_CHANNEL_TYPE) {
      return false;
    }
  }

  const actionFailed = await applyDetectorActions(
    message,
    authorId,
    "honeypot",
    config,
    dependencies,
  );
  const evidence = buildHoneypotEvidence(message);
  const flag = await dependencies.openBotFlag(guildId, authorId, "honeypot", evidence);
  if (!flag) return actionFailed;

  await dependencies.postAuditEvent("bot-defense.honeypot-trip", {
    guildId,
    channelId: message.channel_id,
    messageId: message.id,
    content: message.content,
    author: message.author,
  });

  await postBotFlagQueueMessage(
    guildId,
    authorId,
    flag.queueMessageId,
    "honeypot",
    evidence,
    config,
    env,
    dependencies,
    now,
    flag.createdAtMs,
  );
  return actionFailed;
}

async function runRateDetector(
  message: DiscordMessageCreate,
  guildId: string,
  authorId: string,
  config: BotDefenseConfig,
  env: BotDefenseEnv,
  dependencies: BotDefenseMessageFilterDependencies,
  timestampMs: number,
  now: number,
): Promise<boolean> {
  if (!config.rateEnabled) {
    return false;
  }

  const channelId = message.channel_id;
  const windowMs = config.rateWindowSeconds * 1000;
  if (timestampMs < now - windowMs || timestampMs > now) return false;
  const textFingerprint = await fingerprintRateMessage(message.content ?? "");
  const attachmentOnly = !textFingerprint;
  const messageFingerprint =
    textFingerprint ?? (await dependencies.fingerprintImageAttachments(message.attachments ?? []));
  if (!messageFingerprint) {
    return false;
  }
  // Downloads can finish out of order; retain event time but refresh the evaluation window.
  const fingerprintedAt = dependencies.nowMs();
  if (timestampMs < fingerprintedAt - windowMs || timestampMs > fingerprintedAt) return false;

  await dependencies.recordRateMessage(
    guildId,
    authorId,
    channelId,
    messageFingerprint,
    timestampMs,
  );
  const queriedAt = dependencies.nowMs();
  if (timestampMs < queriedAt - windowMs || timestampMs > queriedAt) return false;
  const distinctChannelIds = await dependencies.listMatchingMessageChannelsInWindow(
    guildId,
    authorId,
    messageFingerprint,
    windowMs,
    queriedAt,
  );
  const evaluatedAt = dependencies.nowMs();
  if (timestampMs < evaluatedAt - windowMs || timestampMs > evaluatedAt) return false;
  const distinctChannels = distinctChannelIds.length;
  if (distinctChannels < config.rateChannelThreshold) {
    return false;
  }

  const actionFailed = await applyDetectorActions(message, authorId, "rate", config, dependencies);
  const evidence = buildRateEvidence(
    message,
    distinctChannelIds,
    config.rateWindowSeconds,
    attachmentOnly,
  );
  const flag = await dependencies.openBotFlag(guildId, authorId, "rate", evidence);
  if (!flag) return actionFailed;

  await dependencies.postAuditEvent("bot-defense.rate-trip", {
    guildId,
    channelId,
    messageId: message.id,
    content: message.content,
    author: message.author,
  });

  await postBotFlagQueueMessage(
    guildId,
    authorId,
    flag.queueMessageId,
    "rate",
    evidence,
    config,
    env,
    dependencies,
    evaluatedAt,
    flag.createdAtMs,
  );
  return actionFailed;
}

async function applyDetectorActions(
  message: DiscordMessageCreate,
  userId: string,
  detectorType: "honeypot" | "rate",
  config: BotDefenseConfig,
  dependencies: BotDefenseMessageFilterDependencies,
): Promise<boolean> {
  const actions =
    detectorType === "honeypot"
      ? { warnUser: config.honeypotWarnUser, deleteMessage: config.honeypotDeleteMessage }
      : { warnUser: config.rateWarnUser, deleteMessage: config.rateDeleteMessage };

  let retryRequired = false;
  if (actions.warnUser) {
    try {
      await dependencies.warnUser(message.channel_id, message.id, userId, detectorType);
    } catch (error) {
      retryRequired ||= isRetryableActionError(error);
      console.error(`Failed to warn user after ${detectorType} detector trip`, error);
    }
  }
  if (actions.deleteMessage) {
    try {
      await dependencies.deleteMessage(message.channel_id, message.id);
    } catch (error) {
      retryRequired ||= isRetryableActionError(error);
      console.error(`Failed to delete message after ${detectorType} detector trip`, error);
    }
  }
  return retryRequired;
}

function isRetryableActionError(error: unknown): boolean {
  const status = isRecord(error) && "status" in error ? error.status : undefined;
  return typeof status !== "number" || status === 429 || status >= 500;
}

async function postBotFlagQueueMessage(
  guildId: string,
  userId: string,
  existingQueueMessageId: string | null,
  detectorType: "honeypot" | "rate",
  evidence: BotDefenseEvidence,
  config: BotDefenseConfig,
  env: BotDefenseEnv,
  dependencies: BotDefenseMessageFilterDependencies,
  now: number,
  createdAtMs: number,
): Promise<void> {
  if (!config.modQueueChannelId) return;

  const body = buildBotFlagQueueMessageBody(
    guildId,
    userId,
    detectorType,
    evidence,
    config,
    now,
    createdAtMs,
  );
  const queueMessage = await dependencies.createChannelMessage(
    config.modQueueChannelId,
    body,
    env.DISCORD_BOT_TOKEN,
  );

  const queueMessageId = queueMessage?.id ?? existingQueueMessageId;
  if (queueMessageId) {
    await dependencies.setBotFlagQueueMessage(guildId, userId, createdAtMs, queueMessageId, now);
  }
}

export function buildBotFlagQueueMessageBody(
  guildId: string,
  userId: string,
  detectorType: "honeypot" | "rate",
  evidence: BotDefenseEvidence,
  config: BotDefenseConfig,
  now: number,
  createdAtMs: number,
): CreateChannelMessageInput {
  const embed = buildBotFlagEmbed(guildId, detectorType, userId, evidence, now);
  const roleMentions = config.pingOnQueuePost
    ? config.modRoleIds.map((roleId) => `<@&${roleId}>`).join(" ")
    : "";
  return {
    content: roleMentions,
    embeds: [embed],
    nonce: deriveGatewayOperationNonce("bot-defense-queue", `${guildId}:${userId}:${createdAtMs}`),
    enforce_nonce: true,
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 4,
            label: "Confirm Bot",
            custom_id: buildBotDefenseComponentId("confirm", guildId, userId, createdAtMs),
          },
          {
            type: 2,
            style: 2,
            label: "Dismiss",
            custom_id: buildBotDefenseComponentId("dismiss", guildId, userId, createdAtMs),
          },
        ],
      },
    ],
    allowed_mentions: config.pingOnQueuePost
      ? allowRoleMentions(config.modRoleIds)
      : suppressMentions(),
  };
}

function buildBotFlagEmbed(
  guildId: string,
  detectorType: "honeypot" | "rate",
  userId: string,
  evidence: BotDefenseEvidence,
  now: number,
): DiscordEmbed {
  const fields: { name: string; value: string; inline: boolean }[] = [
    { name: "Detector", value: detectorType === "honeypot" ? "Honeypot" : "Rate", inline: false },
    { name: "Flagged Member", value: formatStaffUserReference(userId), inline: false },
  ];

  if (evidence.kind === "honeypot") {
    fields.push(
      { name: "Honeypot Channel", value: `<#${evidence.channelId}>`, inline: false },
      {
        name: "Tripping Message",
        value: `https://discord.com/channels/${guildId}/${evidence.channelId}/${evidence.messageId}`,
        inline: false,
      },
    );
  } else {
    fields.push(
      { name: "Matching Channels", value: String(evidence.channelCount), inline: false },
      { name: "Window", value: `${evidence.windowSeconds}s`, inline: false },
      {
        name: "Matched Channels",
        value: evidence.channelIds.map((id) => `<#${id}>`).join(" ") || "N/A",
        inline: false,
      },
    );
    if (evidence.matchKind === "image-attachments") {
      fields.push({
        name: "Repeated Images",
        value: `${evidence.attachmentCount} image attachment(s), identical file bytes (order ignored).`,
        inline: false,
      });
    }
    if (evidence.messagePreview) {
      fields.push({ name: "Repeated Message", value: evidence.messagePreview, inline: false });
    }
    if (evidence.messageId && evidence.messageChannelId) {
      fields.push({
        name: "Latest Message",
        value: `https://discord.com/channels/${guildId}/${evidence.messageChannelId}/${evidence.messageId}`,
        inline: false,
      });
    }
  }

  return buildAuditEmbed({
    title: "Bot Defense Flag",
    color: 0xed4245,
    fields,
    timestamp: new Date(now).toISOString(),
  });
}

function buildHoneypotEvidence(message: DiscordMessageCreate): BotDefenseEvidence {
  return {
    kind: "honeypot",
    channelId: message.channel_id,
    messageId: message.id,
  };
}

function buildRateEvidence(
  message: DiscordMessageCreate,
  channelIds: string[],
  windowSeconds: number,
  attachmentOnly: boolean,
): BotDefenseEvidence {
  return {
    kind: "rate",
    channelIds,
    channelCount: channelIds.length,
    windowSeconds,
    messageId: message.id,
    messageChannelId: message.channel_id,
    messagePreview: (message.content ?? "").trim().slice(0, 500),
    ...(attachmentOnly
      ? { matchKind: "image-attachments" as const, attachmentCount: message.attachments?.length }
      : {}),
  };
}

function deriveMessageTimestampMs(message: DiscordMessageCreate, fallback: number): number {
  if (typeof message.id === "string" && message.id.length >= 17) {
    try {
      const timestamp = Number(BigInt(message.id) >> 22n) + 1420070400000;
      if (Number.isFinite(timestamp)) return timestamp;
    } catch {
      // fall through
    }
  }
  return fallback;
}

export async function fingerprintRateMessage(content: string): Promise<string | null> {
  const normalized = content.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  if (!normalized) return null;

  const bytes = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function allowRoleMentions(roleIds: string[]): DiscordAllowedMentions {
  return { parse: [], roles: roleIds };
}
