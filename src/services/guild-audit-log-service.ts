import type {
  AuditEventGroupId,
  AuditEventId,
  AuditEventStates,
  GuildAuditLogConfig,
} from "../types";
import { AUDIT_EVENT_GROUP_MEMBERS, AUDIT_EVENT_LABELS } from "../types";
import {
  buildAuditEmbed,
  formatStaffUserReference,
  suppressMentions,
  type DiscordEmbed,
  type DiscordEmbedField,
} from "../discord/messages";
import { createChannelMessage } from "../discord/messages";
import { getChannelParent } from "../discord/channels";
import { fetchGuildMember } from "../discord/members";
import type { GuildAuditLogStore } from "../runtime/contracts";
import type { ClanHistoryEvent } from "../clans";
import type { SuggestionAuditEvent } from "./suggestion-service";
import { isRecord } from "../unknown-parse";
import type { GuildResourceValidator } from "../discord/guild-resource-validator";

export interface MemberAuditEventData {
  guildId: string;
  user?: { id?: string; username?: string; global_name?: string | null };
  nick?: string | null;
  oldNick?: string | null;
  roles?: string[];
  oldRoles?: string[];
  memberRoleIds?: string[];
  reason?: string;
  context?: Record<string, unknown>;
}

export interface MessageAuditEventData {
  guildId: string;
  channelId: string;
  parentChannelId?: string;
  messageId?: string;
  content?: string;
  oldContent?: string;
  author?: { id?: string; username?: string; global_name?: string | null; bot?: boolean };
  memberRoleIds?: string[];
  image?: {
    imageUrl: string;
    imageDescription: string;
    classificationReason: string;
    offTopicConfidence: number;
    onTopicConfidence: number;
  };
  dryRun?: boolean;
  mentionProtection?: {
    protections: string[];
    conditions: string[];
    stages: string[];
    actionOutcomes: string[];
  };
}

export interface StructureAuditEventData {
  guildId: string;
  channelId: string;
  parentChannelId?: string;
  channelName?: string;
  channelType?: number;
  inviteCode?: string;
  inviter?: { id?: string; username?: string; global_name?: string | null };
  actor?: { id?: string; username?: string; global_name?: string | null };
}

interface PlayerCountAuditEventDataBase {
  guildId: string;
  serverId: string;
  serverName: string;
  identifier: string;
}

export interface PlayerCountFetchFailedAuditEventData extends PlayerCountAuditEventDataBase {
  errorMessage: string;
  streakCount: number;
}

export interface PlayerCountServerDeleteAuditEventData extends PlayerCountAuditEventDataBase {
  actorUserId: string;
}

export interface PlayerCountAuditEventDataById {
  "player-count.fetch-failed": PlayerCountFetchFailedAuditEventData;
  "player-count.server-delete": PlayerCountServerDeleteAuditEventData;
}

export type PlayerCountAuditEventId = keyof PlayerCountAuditEventDataById;
export type PlayerCountAuditEventData = PlayerCountAuditEventDataById[PlayerCountAuditEventId];

export interface ManagedMessageAuditEventData {
  guildId: string;
  channelId: string;
  messageId?: string;
  internalName: string;
  actorUserId?: string;
  previousMessageId?: string;
  scheduledAtMs?: number;
  failureReason?: string;
}

export interface PlatformLinkPanelPublishFailedAuditEventData {
  guildId: string;
  platform: "steam" | "xbox" | "playstation";
  panelChannelId: string;
}

const SUGGESTION_AUDIT_EVENT_IDS: Record<string, AuditEventId> = {
  "config.updated": "suggestion.config-change",
  "panel.published": "suggestion.panel-publish",
  "suggestion.created": "suggestion.create",
  "suggestion.revised": "suggestion.revision",
  "suggestion.status-changed": "suggestion.status-change",
  "reply.collapsed": "suggestion.reply-collapse",
  "reply.kept_collapsed": "suggestion.mod-decision",
  "reply.restored": "suggestion.mod-decision",
  "reply.deleted": "suggestion.mod-decision",
  "projection.repaired": "suggestion.repair",
};

export async function postSuggestionAuditEvent(
  event: SuggestionAuditEvent,
  store: GuildAuditLogStore,
  botToken: string,
): Promise<void> {
  try {
    const eventId = SUGGESTION_AUDIT_EVENT_IDS[event.event];
    if (!eventId) return;
    const config = await store.readConfig(event.guildId);
    if (!config) return;
    const channelId = resolveAuditChannelIdFromConfig(config, eventId);
    if (!channelId) return;
    const detail = isRecord(event.detail) ? event.detail : {};
    const fields: DiscordEmbedField[] = [
      { name: "Actor", value: formatStaffUserReference(event.actorUserId), inline: true },
    ];
    if (event.suggestionId) {
      fields.push({ name: "Suggestion ID", value: event.suggestionId, inline: true });
    }
    if (event.consideredReplyId) {
      fields.push({ name: "Considered Reply ID", value: event.consideredReplyId, inline: true });
    }
    if (typeof detail.from === "string" && typeof detail.to === "string") {
      fields.push({ name: "Status", value: `${detail.from} → ${detail.to}`.slice(0, 1024) });
    }
    if (typeof detail.reason === "string" && detail.reason.trim()) {
      fields.push({ name: "Reason", value: detail.reason.slice(0, 1024) });
    }
    await createChannelMessage(
      channelId,
      {
        embeds: [
          buildAuditEmbed({
            title: AUDIT_EVENT_LABELS[eventId],
            color: EMBED_COLORS[eventId] ?? 0x5865f2,
            fields,
          }),
        ],
        allowed_mentions: suppressMentions(),
        nonce: `suggestion-audit:${event.event}:${event.suggestionId ?? event.consideredReplyId ?? event.createdAtMs}`,
        enforce_nonce: true,
      },
      botToken,
    );
    if (event.event === "suggestion.status-changed" && detail.outcome) {
      const outcomeId: AuditEventId = "suggestion.outcome";
      const outcomeChannelId = resolveAuditChannelIdFromConfig(config, outcomeId);
      if (outcomeChannelId) {
        const outcome = detail.outcome as { summary?: unknown; nextStepOrLink?: unknown };
        await createChannelMessage(
          outcomeChannelId,
          {
            embeds: [
              buildAuditEmbed({
                title: AUDIT_EVENT_LABELS[outcomeId],
                color: EMBED_COLORS[outcomeId] ?? 0x57f287,
                fields: [
                  ...fields.slice(0, 2),
                  {
                    name: "Outcome",
                    value: String(outcome.summary ?? "Recorded").slice(0, 1024),
                  },
                  ...(outcome.nextStepOrLink
                    ? [
                        {
                          name: "Next step or link",
                          value: String(outcome.nextStepOrLink).slice(0, 1024),
                        },
                      ]
                    : []),
                ],
              }),
            ],
            allowed_mentions: suppressMentions(),
            nonce: `suggestion-outcome:${event.suggestionId ?? event.createdAtMs}`,
            enforce_nonce: true,
          },
          botToken,
        );
      }
    }
  } catch (error) {
    console.error("Failed to post Suggestion audit event", error);
  }
}

export interface MessageTemplateAuditEventData {
  guildId: string;
  internalName: string;
  actorUserId?: string;
}

export interface FeatureResourceSetupAuditEventData {
  guildId: string;
  setupRunId: string;
  surfaceKey: string;
  dependencyKey: string;
  event: "started" | "resumed" | "failed" | "completed";
  actorUserId: string;
  resourceIds: string[];
  failureMessage?: string | null;
}

export interface ChannelPermissionsCopiedAuditEventData {
  guildId: string;
  actorUserId: string;
  sourceChannelId: string;
  sourceChannelName: string;
  targetChannelId: string;
  targetChannelName: string;
  mode: "roles_only" | "exact";
  addedCount: number;
  changedCount: number;
  removedCount: number;
  retainedCount: number;
  memberOverwritesAffected: boolean;
  timestampMs: number;
  correlationId: string;
}

export async function postClanAuditEvent(
  event: ClanHistoryEvent,
  store: GuildAuditLogStore,
  botToken: string,
): Promise<void> {
  try {
    const config = await store.readConfig(event.guildId);
    if (!config) return;
    const eventId = clanAuditEventId(event.event);
    const channelId = resolveAuditChannelIdFromConfig(config, eventId);
    if (!channelId) return;
    const fields: DiscordEmbedField[] = [
      { name: "Action", value: event.event.slice(0, 1024) },
      { name: "Actor", value: formatStaffUserReference(event.actorUserId) },
    ];
    if (event.clanId) fields.push({ name: "Clan ID", value: event.clanId });
    if (event.requestId) fields.push({ name: "Request ID", value: event.requestId });
    if (event.reason) fields.push({ name: "Reason", value: event.reason.slice(0, 1024) });
    await createChannelMessage(
      channelId,
      {
        embeds: [
          buildAuditEmbed({
            title: AUDIT_EVENT_LABELS[eventId],
            color: EMBED_COLORS[eventId] ?? 0x5865f2,
            fields,
          }),
        ],
        allowed_mentions: suppressMentions(),
        nonce: `clan:${event.id}`,
        enforce_nonce: true,
      },
      botToken,
    );
  } catch (error) {
    console.error("Failed to post Clan Management audit event", error);
  }
}

function clanAuditEventId(event: string): AuditEventId {
  if (event.startsWith("request.")) return "clan-management.request";
  if (event.startsWith("provisioning.")) return "clan-management.provisioning";
  if (event.startsWith("application.")) return "clan-management.application";
  if (event.startsWith("invitation.")) return "clan-management.invitation";
  if (event.startsWith("membership.")) return "clan-management.membership";
  if (event.startsWith("leadership.")) return "clan-management.leadership";
  if (event.startsWith("board.")) return "clan-management.board";
  if (event.startsWith("dormancy.")) return "clan-management.dormancy";
  if (event.startsWith("deletion.")) return "clan-management.deletion";
  if (event.startsWith("resource.") || event.startsWith("reconciliation."))
    return "clan-management.degradation";
  return "clan-management.lifecycle";
}

export interface AuditExclusionPolicyChangeEventData {
  guildId: string;
  actorUserId?: string;
  actorLabel?: string;
  addedChannelIds: string[];
  removedChannelIds: string[];
  addedRoleIds: string[];
  removedRoleIds: string[];
}

const EMBED_COLORS: Record<string, number> = {
  "member.join": 0x57f287,
  "member.leave": 0xed4245,
  "member.nickname-change": 0xfee75c,
  "member.role-assign": 0x57f287,
  "member.role-remove": 0xed4245,
  "member.ban": 0xed4245,
  "member.unban": 0x57f287,
  "message.delete": 0xed4245,
  "message.update": 0xfee75c,
  "image-rule.on-topic": 0x57f287,
  "image-rule.off-topic-delete": 0xed4245,
  "image-rule.classification-failed": 0xfee75c,
  "image-rule.mod-queue-action": 0x2f855a,
  "guild-structure.invite-create": 0x57f287,
  "guild-structure.channel-create": 0x57f287,
  "guild-structure.channel-update": 0xfee75c,
  "guild-structure.channel-delete": 0xed4245,
  "guild-structure.channel-permissions-copied": 0x5865f2,
  "guild-structure.feature-resource-setup": 0x5865f2,
  "event.create": 0x5865f2,
  "event.update": 0xfee75c,
  "event.publish": 0x57f287,
  "event.cancel": 0xed4245,
  "event.archive": 0x95a5a6,
  "event.signup": 0x57f287,
  "event.leave": 0xfee75c,
  "event.reminder": 0x5865f2,
  "event.lifecycle": 0x5865f2,
  "player-count.fetch-failed": 0xed4245,
  "player-count.server-delete": 0xed4245,
  "ban-case.create": 0xed4245,
  "ban-case.status-change": 0x2f855a,
  "ban-case.server-action": 0xed4245,
  "member-verification.dm-sent": 0x5865f2,
  "member-verification.dm-undeliverable": 0xfee75c,
  "member-verification.dm-blocked": 0xed4245,
  "member-verification.verify": 0x57f287,
  "member-verification.verify-failed": 0xed4245,
  "member-verification.role-restoration": 0x57f287,
  "member-verification.panel-published": 0x5865f2,
  "member-verification.attempt-created": 0x5865f2,
  "member-verification.attempt-expired": 0xfee75c,
  "member-verification.attempt-reused": 0xed4245,
  "member-verification.discord-mismatch": 0xed4245,
  "member-verification.turnstile-failed": 0xfee75c,
  "member-verification.turnstile-pass": 0x57f287,
  "member-verification.steam-link-required": 0x5865f2,
  "member-verification.steam-link-missing": 0xfee75c,
  "bot-defense.honeypot-trip": 0xed4245,
  "bot-defense.rate-trip": 0xed4245,
  "bot-defense.confirm": 0x2f855a,
  "bot-defense.dismiss": 0x95a5a6,
  "mention-protection.delete": 0xed4245,
  "managed-message.create": 0x57f287,
  "managed-message.update": 0xfee75c,
  "managed-message.delete": 0xed4245,
  "managed-message.deleted-out-of-band": 0xed4245,
  "managed-message.repair": 0x5865f2,
  "managed-message.schedule": 0x5865f2,
  "managed-message.reschedule": 0x5865f2,
  "managed-message.cancel": 0x95a5a6,
  "managed-message.publish": 0x57f287,
  "managed-message.publish-failed": 0xed4245,
  "managed-message.draft-delete": 0xed4245,
  "message-template.create": 0x57f287,
  "message-template.update": 0xfee75c,
  "message-template.delete": 0xed4245,
  "guild-audit-log.exclusion-policy-change": 0x5865f2,
  "guild-audit-log.webhook-credential-reveal": 0xfee75c,
};

function getEventGroup(eventId: AuditEventId): AuditEventGroupId | null {
  for (const [groupId, events] of Object.entries(AUDIT_EVENT_GROUP_MEMBERS)) {
    if ((events as readonly string[]).includes(eventId)) {
      return groupId as AuditEventGroupId;
    }
  }
  return null;
}

export function isAuditEventEnabled(eventStates: AuditEventStates, eventId: AuditEventId): boolean {
  if (eventId in eventStates.overrides) {
    return eventStates.overrides[eventId] === true;
  }
  const group = getEventGroup(eventId);
  if (group && group in eventStates.groups) {
    return eventStates.groups[group] === true;
  }
  return true;
}

function hasAnyExcludedRole(config: GuildAuditLogConfig, roleIds: string[] | undefined): boolean {
  if (!roleIds) return false;
  const excludedRoleIds = new Set(config.excludedRoleIds ?? []);
  return roleIds.some((roleId) => excludedRoleIds.has(roleId));
}

async function isMessageAuditEventExcluded(
  config: GuildAuditLogConfig,
  data: MessageAuditEventData,
  botToken: string,
): Promise<boolean> {
  if (await isExcludedChannelWithResolvedParent(config, data, botToken)) return true;

  if (hasAnyExcludedRole(config, data.memberRoleIds)) return true;
  if ((config.excludedRoleIds?.length ?? 0) > 0 && !data.memberRoleIds && data.author?.id) {
    try {
      const member = await fetchGuildMember(data.guildId, data.author.id, botToken);
      if (hasAnyExcludedRole(config, member?.roles)) return true;
    } catch (error) {
      console.error("Failed to resolve Discord Audit Event member roles", error);
    }
  }
  return false;
}

async function isExcludedChannelWithResolvedParent(
  config: GuildAuditLogConfig,
  data: { channelId: string; parentChannelId?: string },
  botToken: string,
): Promise<boolean> {
  if (isExcludedChannel(config, data.channelId, data.parentChannelId)) return true;
  if ((config.excludedChannelIds?.length ?? 0) === 0 || data.parentChannelId) return false;
  try {
    const channel = await getChannelParent(data.channelId, botToken);
    return Boolean(channel.parentId && config.excludedChannelIds?.includes(channel.parentId));
  } catch (error) {
    console.error("Failed to resolve Discord Audit Event channel ancestry", error);
    return false;
  }
}

function isExcludedChannel(
  config: GuildAuditLogConfig,
  channelId: string,
  parentChannelId?: string,
): boolean {
  const excludedChannelIds = new Set(config.excludedChannelIds ?? []);
  return (
    excludedChannelIds.has(channelId) ||
    Boolean(parentChannelId && excludedChannelIds.has(parentChannelId))
  );
}

export function buildMemberAuditEmbed(
  eventId: AuditEventId,
  data: MemberAuditEventData,
): DiscordEmbed {
  const label = AUDIT_EVENT_LABELS[eventId] ?? eventId;
  const color = EMBED_COLORS[eventId] ?? 0x5865f2;
  const fields: DiscordEmbedField[] = [];

  if (data.user?.id) {
    fields.push({
      name: "User",
      value: formatStaffUserReference(data.user.id),
    });
  }

  if (eventId === "member.nickname-change") {
    const oldNick = data.oldNick ?? "*None*";
    const newNick = data.nick ?? "*None*";
    fields.push({
      name: "Nickname",
      value: `**Before:** ${escapeAuditText(oldNick)}\n**After:** ${escapeAuditText(newNick)}`,
    });
  }

  if (eventId === "member.role-assign" || eventId === "member.role-remove") {
    if (data.roles && data.roles.length > 0) {
      fields.push({
        name: "Roles",
        value: data.roles.map((r) => `<@&${r}>`).join("\n"),
      });
    }
  }

  if (data.reason) {
    fields.push({
      name: "Reason",
      value: escapeAuditText(data.reason),
    });
  }

  if (data.context && Object.keys(data.context).length > 0) {
    fields.push({
      name: "Context",
      value: Object.entries(data.context)
        .map(([key, value]) => `**${escapeAuditText(key)}:** ${escapeAuditText(String(value))}`)
        .join("\n"),
    });
  }

  return buildAuditEmbed({
    title: label,
    color,
    fields,
  });
}

export function buildMessageAuditEmbed(
  eventId: AuditEventId,
  data: MessageAuditEventData,
): DiscordEmbed {
  const label = AUDIT_EVENT_LABELS[eventId] ?? eventId;
  const color = EMBED_COLORS[eventId] ?? 0x5865f2;
  const fields: DiscordEmbedField[] = [];

  if (data.author?.id) {
    fields.push({
      name: "Author",
      value: formatStaffUserReference(data.author.id),
    });
  }

  fields.push({
    name: "Channel",
    value: `<#${data.channelId}>`,
  });

  if (eventId === "message.update" && data.content) {
    const snapshot = truncateContent(data.content, 500);
    if (data.oldContent) {
      fields.push({
        name: "Before",
        value: truncateContent(data.oldContent, 500),
      });
    }
    fields.push({
      name: "New Content",
      value: snapshot,
    });
  }

  if (
    (eventId === "message.delete" ||
      eventId === "image-rule.off-topic-delete" ||
      eventId === "mention-protection.delete") &&
    data.content
  ) {
    fields.push({
      name: "Deleted Content",
      value: truncateContent(data.content, 500),
    });
  }

  if (eventId === "image-rule.on-topic" && data.content) {
    fields.push({
      name: "Message Content",
      value: truncateContent(data.content, 500),
    });
  }

  if (data.messageId) {
    fields.push({
      name: "Message ID",
      value: data.messageId,
    });
  }

  if (eventId === "mention-protection.delete" && data.mentionProtection) {
    fields.push(
      {
        name: "Protection",
        value: data.mentionProtection.protections.join(", "),
      },
      {
        name: "Condition",
        value: data.mentionProtection.conditions.join(", "),
      },
      {
        name: "Policy Stage",
        value: data.mentionProtection.stages.join(", "),
      },
    );
    if (data.mentionProtection.actionOutcomes.length > 0) {
      fields.push({
        name: "Response Outcomes",
        value: data.mentionProtection.actionOutcomes.join("\n"),
      });
    }
  }

  if (
    (eventId === "image-rule.off-topic-delete" || eventId === "image-rule.on-topic") &&
    data.image
  ) {
    fields.push(
      {
        name: "Image Description",
        value: truncateContent(data.image.imageDescription, 500),
      },
      {
        name: "Classification Reason",
        value: truncateContent(data.image.classificationReason, 500),
      },
      {
        name: "Off-Topic Confidence",
        value: `${(data.image.offTopicConfidence * 100).toFixed(1)}%`,
      },
      {
        name: "On-Topic Confidence",
        value: `${(data.image.onTopicConfidence * 100).toFixed(1)}%`,
      },
    );
  }

  if (data.dryRun) {
    fields.push({
      name: "Mode",
      value: "Dry run — no message, DM, or mod queue actions were taken.",
    });
  }

  const embed = buildAuditEmbed({
    title: label,
    color,
    fields,
  });

  if (
    (eventId === "image-rule.off-topic-delete" || eventId === "image-rule.on-topic") &&
    data.image
  ) {
    embed.image = { url: data.image.imageUrl };
  }

  if (data.dryRun) {
    embed.title = `${embed.title ?? label} (Dry Run)`;
    embed.color = 0x95a5a6;
  }

  return embed;
}

export function resolveAuditChannelIdFromConfig(
  config: GuildAuditLogConfig,
  eventId: AuditEventId,
): string | null {
  if (!isAuditEventEnabled(config.eventStates, eventId)) return null;
  return resolveConfiguredAuditChannelId(config, eventId);
}

function resolveConfiguredAuditChannelId(
  config: GuildAuditLogConfig,
  eventId: AuditEventId,
): string | null {
  const group = getEventGroup(eventId);
  if (group && config.groupChannelIds?.[group]) {
    return config.groupChannelIds[group];
  }
  return config.auditChannelId || null;
}

export async function postMessageAuditEvent(
  eventId: AuditEventId,
  data: MessageAuditEventData,
  store: GuildAuditLogStore,
  botToken: string,
  botUserId?: string,
  rethrow = false,
  dedupeNonce?: string,
): Promise<void> {
  try {
    const config = await store.readConfig(data.guildId);
    if (!config) return;
    if (
      (eventId === "message.update" || eventId === "message.delete") &&
      (await isMessageAuditEventExcluded(config, data, botToken))
    ) {
      return;
    }
    const channelId = resolveAuditChannelIdFromConfig(config, eventId);
    if (!channelId) return;
    if (data.channelId === channelId) return;
    if (botUserId && data.author?.id === botUserId) return;

    const embed = buildMessageAuditEmbed(eventId, data);
    await createChannelMessage(
      channelId,
      {
        embeds: [embed],
        allowed_mentions: suppressMentions(),
        ...(dedupeNonce
          ? { nonce: dedupeNonce, enforce_nonce: true }
          : eventId === "mention-protection.delete"
            ? { nonce: `a:${data.messageId}`, enforce_nonce: true }
            : {}),
      },
      botToken,
    );
  } catch (error) {
    // The queue caller owns retry classification and failure reporting.
    if (rethrow) throw error;
    console.error("Failed to post Guild Audit Log message event", error);
  }
}

export function buildStructureAuditEmbed(
  eventId: AuditEventId,
  data: StructureAuditEventData,
): DiscordEmbed {
  const label = AUDIT_EVENT_LABELS[eventId] ?? eventId;
  const color = EMBED_COLORS[eventId] ?? 0x5865f2;
  const fields: DiscordEmbedField[] = [];

  if (data.actor?.id) {
    fields.push({
      name: "Actor",
      value: formatStaffUserReference(data.actor.id),
    });
  }

  if (eventId === "guild-structure.invite-create") {
    if (data.inviteCode) {
      fields.push({
        name: "Invite Code",
        value: data.inviteCode,
      });
    }
    if (data.inviter?.id) {
      fields.push({
        name: "Inviter",
        value: formatStaffUserReference(data.inviter.id),
      });
    }
  }

  const channelLabel = data.channelName
    ? `${data.channelName} (<#${data.channelId}>)`
    : `<#${data.channelId}>`;
  fields.push({
    name: "Channel",
    value: channelLabel,
  });

  return buildAuditEmbed({
    title: label,
    color,
    fields,
  });
}

export async function postStructureAuditEvent(
  eventId: AuditEventId,
  data: StructureAuditEventData,
  store: GuildAuditLogStore,
  botToken: string,
  botUserId?: string,
  rethrow = false,
  dedupeNonce?: string,
): Promise<void> {
  try {
    const config = await store.readConfig(data.guildId);
    if (!config) return;
    if (
      eventId === "guild-structure.invite-create" &&
      (await isExcludedChannelWithResolvedParent(config, data, botToken))
    ) {
      return;
    }
    const channelId = resolveAuditChannelIdFromConfig(config, eventId);
    if (!channelId) return;
    if (data.channelId === channelId) return;
    const actorId = data.actor?.id ?? data.inviter?.id;
    if (botUserId && actorId === botUserId) return;

    const embed = buildStructureAuditEmbed(eventId, data);
    await createChannelMessage(
      channelId,
      {
        embeds: [embed],
        allowed_mentions: suppressMentions(),
        ...(dedupeNonce ? { nonce: dedupeNonce, enforce_nonce: true } : {}),
      },
      botToken,
    );
  } catch (error) {
    if (rethrow) throw error;
    console.error("Failed to post Guild Audit Log structure event", error);
  }
}

export async function postFeatureResourceSetupAuditEvent(
  data: FeatureResourceSetupAuditEventData,
  store: GuildAuditLogStore,
  botToken: string,
): Promise<void> {
  try {
    const config = await store.readConfig(data.guildId);
    if (!config) return;
    const eventId: AuditEventId = "guild-structure.feature-resource-setup";
    const channelId = resolveAuditChannelIdFromConfig(config, eventId);
    if (!channelId) return;
    const fields: DiscordEmbedField[] = [
      { name: "Feature", value: data.surfaceKey },
      { name: "Dependency", value: data.dependencyKey },
      { name: "Setup event", value: data.event },
      { name: "Actor", value: formatStaffUserReference(data.actorUserId) },
      { name: "Setup Run", value: data.setupRunId },
    ];
    if (data.resourceIds.length > 0) {
      fields.push({ name: "Resources", value: data.resourceIds.join(", ").slice(0, 1024) });
    }
    if (data.failureMessage) {
      fields.push({ name: "Failure", value: data.failureMessage.slice(0, 1024) });
    }
    await createChannelMessage(
      channelId,
      {
        embeds: [
          buildAuditEmbed({
            title: AUDIT_EVENT_LABELS[eventId],
            color: EMBED_COLORS[eventId],
            fields,
          }),
        ],
        allowed_mentions: suppressMentions(),
        nonce: `feature-setup:${data.setupRunId}:${data.event}`,
        enforce_nonce: true,
      },
      botToken,
    );
  } catch (error) {
    console.error("Failed to post Feature Resource Setup audit event", error);
  }
}

export async function postChannelPermissionsCopiedAuditEvent(
  data: ChannelPermissionsCopiedAuditEventData,
  store: GuildAuditLogStore,
  botToken: string,
): Promise<void> {
  try {
    const config = await store.readConfig(data.guildId);
    if (!config) return;
    const eventId = "guild-structure.channel-permissions-copied" as const;
    const channelId = resolveAuditChannelIdFromConfig(config, eventId);
    if (!channelId) return;
    await createChannelMessage(
      channelId,
      {
        embeds: [
          buildAuditEmbed({
            title: AUDIT_EVENT_LABELS[eventId],
            color: EMBED_COLORS[eventId],
            fields: [
              { name: "Actor", value: formatStaffUserReference(data.actorUserId) },
              {
                name: "Source Channel",
                value: `${escapeAuditText(data.sourceChannelName)}\nID: ${data.sourceChannelId}`,
              },
              {
                name: "Target Channel",
                value: `${escapeAuditText(data.targetChannelName)}\nID: ${data.targetChannelId}`,
              },
              {
                name: "Mode",
                value: data.mode === "roles_only" ? "Role permissions only" : "Exact copy",
              },
              {
                name: "Overwrite Changes",
                value: [
                  `Added: ${data.addedCount}`,
                  `Changed: ${data.changedCount}`,
                  `Removed: ${data.removedCount}`,
                  `Retained: ${data.retainedCount}`,
                ].join("\n"),
              },
              {
                name: "Member-specific Overwrites Affected",
                value: data.memberOverwritesAffected ? "Yes" : "No",
              },
              { name: "Correlation ID", value: escapeAuditText(data.correlationId) },
            ],
            timestamp: new Date(data.timestampMs).toISOString(),
          }),
        ],
        allowed_mentions: suppressMentions(),
        nonce: await channelPermissionCopyAuditNonce(data.correlationId),
        enforce_nonce: true,
      },
      botToken,
    );
  } catch (error) {
    console.error("Failed to post Channel Permissions Copied audit event", error);
  }
}

async function channelPermissionCopyAuditNonce(correlationId: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(correlationId)),
  );
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return `cpc:${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").slice(0, 21)}`;
}

export async function resolveAuditChannelId(
  guildId: string,
  featureChannelId: string | null | undefined,
  store: GuildAuditLogStore,
  eventId?: AuditEventId,
): Promise<string | null> {
  if (featureChannelId) return featureChannelId;
  try {
    const config = await store.readConfig(guildId);
    if (!config) return null;
    if (eventId) {
      return resolveAuditChannelIdFromConfig(config, eventId);
    }
    return config.auditChannelId || null;
  } catch (error) {
    console.error("Failed to resolve Guild Audit Log destination", error);
    return null;
  }
}

export async function postMemberAuditEvent(
  eventId: AuditEventId,
  data: MemberAuditEventData,
  store: GuildAuditLogStore,
  botToken: string,
  rethrow = false,
  dedupeNonce?: string,
): Promise<void> {
  try {
    const config = await store.readConfig(data.guildId);
    if (!config) return;
    if (
      (eventId === "member.nickname-change" ||
        eventId === "member.role-assign" ||
        eventId === "member.role-remove") &&
      hasAnyExcludedRole(config, data.memberRoleIds)
    ) {
      return;
    }
    const channelId = resolveAuditChannelIdFromConfig(config, eventId);
    if (!channelId) return;

    const embed = buildMemberAuditEmbed(eventId, data);
    await createChannelMessage(
      channelId,
      {
        embeds: [embed],
        allowed_mentions: suppressMentions(),
        ...(dedupeNonce ? { nonce: dedupeNonce, enforce_nonce: true } : {}),
      },
      botToken,
    );
  } catch (error) {
    if (rethrow) throw error;
    if (eventId === "ban-case.server-action")
      console.error("Ban Case audit notification failed", { code: "notification_failed" });
    else console.error("Failed to post Guild Audit Log member event", error);
  }
}

export interface WebhookCredentialRevealAuditEventData {
  guildId: string;
  actorUserId?: string;
  publicId: string;
  destinationId: string;
  fingerprint: string;
}

export async function postWebhookCredentialRevealAuditEvent(
  data: WebhookCredentialRevealAuditEventData,
  store: GuildAuditLogStore,
  botToken: string,
): Promise<void> {
  try {
    const config = await store.readConfig(data.guildId);
    if (!config) return;
    const eventId = "guild-audit-log.webhook-credential-reveal" as const;
    const channelId = resolveConfiguredAuditChannelId(config, eventId);
    if (!channelId) return;
    await createChannelMessage(
      channelId,
      {
        embeds: [
          buildAuditEmbed({
            title: AUDIT_EVENT_LABELS[eventId],
            color: EMBED_COLORS[eventId],
            fields: [
              {
                name: "Actor",
                value: data.actorUserId
                  ? formatStaffUserReference(data.actorUserId)
                  : "Authenticated admin session",
              },
              { name: "Webhook Source", value: escapeAuditText(data.publicId) },
              { name: "Destination", value: escapeAuditText(data.destinationId) },
              { name: "Credential Fingerprint", value: escapeAuditText(data.fingerprint) },
            ],
          }),
        ],
        allowed_mentions: suppressMentions(),
      },
      botToken,
    );
  } catch (error) {
    console.error("Failed to post webhook credential reveal audit event", error);
  }
}

export async function postAuditExclusionPolicyChangeEvent(
  data: AuditExclusionPolicyChangeEventData,
  store: GuildAuditLogStore,
  botToken: string,
): Promise<void> {
  try {
    const config = await store.readConfig(data.guildId);
    if (!config) return;
    const eventId = "guild-audit-log.exclusion-policy-change" as const;
    const channelId = resolveConfiguredAuditChannelId(config, eventId);
    if (!channelId) return;

    const formatChannels = (ids: string[]) =>
      ids.length > 0 ? ids.map((id) => `<#${id}> (${id})`).join("\n") : "None";
    const formatRoles = (ids: string[]) =>
      ids.length > 0 ? ids.map((id) => `<@&${id}> (${id})`).join("\n") : "None";
    const embed = buildAuditEmbed({
      title: AUDIT_EVENT_LABELS[eventId],
      color: EMBED_COLORS[eventId],
      fields: [
        {
          name: "Actor",
          value: data.actorUserId
            ? formatStaffUserReference(data.actorUserId)
            : (data.actorLabel ?? "Authenticated admin session"),
        },
        { name: "Channels Added", value: formatChannels(data.addedChannelIds) },
        { name: "Channels Removed", value: formatChannels(data.removedChannelIds) },
        { name: "Roles Added", value: formatRoles(data.addedRoleIds) },
        { name: "Roles Removed", value: formatRoles(data.removedRoleIds) },
      ],
    });
    await createChannelMessage(
      channelId,
      { embeds: [embed], allowed_mentions: suppressMentions() },
      botToken,
    );
  } catch (error) {
    console.error("Failed to post Audit Exclusion Policy change event", error);
  }
}

export function buildPlayerCountAuditEmbed<EventId extends PlayerCountAuditEventId>(
  eventId: EventId,
  data: PlayerCountAuditEventDataById[EventId],
): DiscordEmbed {
  const label = AUDIT_EVENT_LABELS[eventId] ?? eventId;
  const color = EMBED_COLORS[eventId] ?? 0x5865f2;
  const fields: DiscordEmbedField[] = [
    { name: "Game Server", value: escapeAuditText(data.serverName), inline: false },
    { name: "Identifier", value: escapeAuditText(data.identifier), inline: false },
  ];
  if (eventId === "player-count.fetch-failed") {
    const failure = data as PlayerCountFetchFailedAuditEventData;
    fields.push({ name: "Error", value: escapeAuditText(failure.errorMessage), inline: false });
    fields.push({
      name: "Consecutive Failures",
      value: String(failure.streakCount),
      inline: false,
    });
  } else {
    const deletion = data as PlayerCountServerDeleteAuditEventData;
    fields.unshift({ name: "Actor", value: formatStaffUserReference(deletion.actorUserId) });
  }

  return buildAuditEmbed({
    title: `🎮 ${label}`,
    color,
    fields,
  });
}

export async function postPlayerCountAuditEvent<EventId extends PlayerCountAuditEventId>(
  eventId: EventId,
  data: PlayerCountAuditEventDataById[EventId],
  store: GuildAuditLogStore,
  botToken: string,
  guildResources: GuildResourceValidator,
): Promise<void> {
  try {
    const config = await store.readConfig(data.guildId);
    if (!config) return;
    const channelId = resolveAuditChannelIdFromConfig(config, eventId);
    if (!channelId) return;

    await guildResources.requireTextChannel(data.guildId, channelId);
    const embed = buildPlayerCountAuditEmbed(eventId, data);
    await createChannelMessage(
      channelId,
      { embeds: [embed], allowed_mentions: suppressMentions() },
      botToken,
    );
  } catch (error) {
    console.error("Failed to post Guild Audit Log player count event", error);
  }
}

export async function postPlatformLinkPanelPublishFailedAuditEvent(
  data: PlatformLinkPanelPublishFailedAuditEventData,
  store: GuildAuditLogStore,
  botToken: string,
): Promise<void> {
  try {
    const eventId = "platform-link.panel-publish-failed" as const;
    const config = await store.readConfig(data.guildId);
    if (!config) return;
    const channelId = resolveAuditChannelIdFromConfig(config, eventId);
    if (!channelId || channelId === data.panelChannelId) return;
    await createChannelMessage(
      channelId,
      {
        embeds: [
          buildAuditEmbed({
            title: AUDIT_EVENT_LABELS[eventId],
            color: EMBED_COLORS[eventId] ?? 0xed4245,
            fields: [
              { name: "Platform", value: data.platform },
              { name: "Panel Channel", value: `<#${data.panelChannelId}>` },
              {
                name: "Action Required",
                value:
                  "Grant HAF View Channel, Send Messages, and Embed Links in the panel channel.",
              },
            ],
          }),
        ],
        allowed_mentions: suppressMentions(),
      },
      botToken,
    );
  } catch (error) {
    console.error("Failed to post Player Link panel publication failure audit event", error);
  }
}

export function buildManagedMessageAuditEmbed(
  eventId:
    | "managed-message.create"
    | "managed-message.update"
    | "managed-message.unpublish"
    | "managed-message.delete"
    | "managed-message.deleted-out-of-band"
    | "managed-message.repair"
    | "managed-message.schedule"
    | "managed-message.reschedule"
    | "managed-message.cancel"
    | "managed-message.publish"
    | "managed-message.publish-failed"
    | "managed-message.draft-delete",
  data: ManagedMessageAuditEventData,
): DiscordEmbed {
  const fields: DiscordEmbedField[] = [
    { name: "Internal Name", value: data.internalName },
    { name: "Channel", value: `<#${data.channelId}>` },
  ];
  if (data.messageId) fields.push({ name: "Message ID", value: data.messageId });
  if (data.scheduledAtMs !== undefined) {
    fields.push({ name: "Scheduled For", value: new Date(data.scheduledAtMs).toISOString() });
  }
  if (data.failureReason) fields.push({ name: "Failure", value: data.failureReason });
  if (data.actorUserId) {
    fields.unshift({
      name: "Actor",
      value:
        data.actorUserId === "admin-ui"
          ? "Admin dashboard"
          : formatStaffUserReference(data.actorUserId),
    });
  }
  if (data.previousMessageId && data.previousMessageId !== data.messageId) {
    fields.push({ name: "Previous Message ID", value: data.previousMessageId });
  }
  return buildAuditEmbed({
    title: AUDIT_EVENT_LABELS[eventId] ?? eventId,
    color: EMBED_COLORS[eventId] ?? 0x5865f2,
    fields,
  });
}

export function buildMessageTemplateAuditEmbed(
  eventId: "message-template.create" | "message-template.update" | "message-template.delete",
  data: MessageTemplateAuditEventData,
): DiscordEmbed {
  const fields: DiscordEmbedField[] = [{ name: "Internal Name", value: data.internalName }];
  if (data.actorUserId) {
    fields.unshift({
      name: "Actor",
      value:
        data.actorUserId === "admin-ui"
          ? "Admin dashboard"
          : formatStaffUserReference(data.actorUserId),
    });
  }
  return buildAuditEmbed({
    title: AUDIT_EVENT_LABELS[eventId] ?? eventId,
    color: EMBED_COLORS[eventId] ?? 0x5865f2,
    fields,
  });
}

export async function postMessageTemplateAuditEvent(
  eventId: "message-template.create" | "message-template.update" | "message-template.delete",
  data: MessageTemplateAuditEventData,
  store: GuildAuditLogStore,
  botToken: string,
): Promise<void> {
  try {
    const config = await store.readConfig(data.guildId);
    if (!config) return;
    const channelId = resolveAuditChannelIdFromConfig(config, eventId);
    if (!channelId) return;
    await createChannelMessage(
      channelId,
      {
        embeds: [buildMessageTemplateAuditEmbed(eventId, data)],
        allowed_mentions: suppressMentions(),
      },
      botToken,
    );
  } catch (error) {
    console.error("Failed to post Message Template audit event", error);
  }
}

export async function postManagedMessageAuditEvent(
  eventId:
    | "managed-message.create"
    | "managed-message.update"
    | "managed-message.unpublish"
    | "managed-message.delete"
    | "managed-message.deleted-out-of-band"
    | "managed-message.repair"
    | "managed-message.schedule"
    | "managed-message.reschedule"
    | "managed-message.cancel"
    | "managed-message.publish"
    | "managed-message.publish-failed"
    | "managed-message.draft-delete",
  data: ManagedMessageAuditEventData,
  store: GuildAuditLogStore,
  botToken: string,
): Promise<void> {
  try {
    await postManagedMessageAuditEventOrThrow(eventId, data, store, botToken);
  } catch (error) {
    console.error("Failed to post Managed Message audit event", error);
  }
}

export async function postManagedMessageAuditEventOrThrow(
  eventId:
    | "managed-message.create"
    | "managed-message.update"
    | "managed-message.unpublish"
    | "managed-message.delete"
    | "managed-message.deleted-out-of-band"
    | "managed-message.repair"
    | "managed-message.schedule"
    | "managed-message.reschedule"
    | "managed-message.cancel"
    | "managed-message.publish"
    | "managed-message.publish-failed"
    | "managed-message.draft-delete",
  data: ManagedMessageAuditEventData,
  store: GuildAuditLogStore,
  botToken: string,
  dedupeNonce?: string,
): Promise<void> {
  const config = await store.readConfig(data.guildId);
  if (!config) return;
  const channelId = resolveAuditChannelIdFromConfig(config, eventId);
  if (!channelId || channelId === data.channelId) return;
  await createChannelMessage(
    channelId,
    {
      embeds: [buildManagedMessageAuditEmbed(eventId, data)],
      allowed_mentions: suppressMentions(),
      ...(dedupeNonce ? { nonce: dedupeNonce, enforce_nonce: true } : {}),
    },
    botToken,
  );
}

function truncateContent(text: string, maxLen: number): string {
  if (text.length > maxLen) return text.slice(0, maxLen - 3) + "...";
  return text;
}

function escapeAuditText(text: string): string {
  if (text.length > 100) return text.slice(0, 97) + "...";
  return text;
}
