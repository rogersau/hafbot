import type { CreateChannelMessageInput } from "../discord/messages";
import { buildAuditEmbed, formatStaffUserReference, suppressMentions } from "../discord/messages";
import { formatTimedRoleExpiry } from "../timed-roles";
import type { AuditEventId } from "../types";
import { resolveAuditChannelIdFromConfig } from "./guild-audit-log-service";
import type { GuildAuditLogStore, GuildNotificationChannelStore } from "../runtime/contracts";

export interface ActionActor {
  label: string;
  userId?: string;
}

export type ChannelMessageSender = (
  channelId: string,
  body: CreateChannelMessageInput,
) => Promise<void>;

export function buildBlocklistUpdateMessage(input: {
  action: "add" | "remove";
  emojis: string[];
  actor?: ActionActor;
}): CreateChannelMessageInput {
  return {
    embeds: [
      buildAuditEmbed({
        title: "🧱 Blocklist Update",
        color: input.action === "add" ? 0xed4245 : 0x57f287,
        fields: [
          { name: "Actor", value: formatActor(input.actor) },
          { name: "Action", value: input.action === "add" ? "Added" : "Removed" },
          { name: input.emojis.length === 1 ? "Emoji" : "Emojis", value: input.emojis.join(", ") },
        ],
      }),
    ],
    allowed_mentions: suppressMentions(),
  };
}

export function buildTimedRoleUpdateMessage(
  input:
    | {
        action: "add";
        actor?: ActionActor;
        userId: string;
        targetDisplayName?: string | null;
        roleId: string;
        durationInput: string;
        expiresAtMs: number;
      }
    | {
        action: "remove";
        actor?: ActionActor;
        userId: string;
        targetDisplayName?: string | null;
        roleId: string;
        durationInput?: string;
        expiresAtMs?: number;
      }
    | {
        action: "expire";
        userId: string;
        targetDisplayName?: string | null;
        roleId: string;
        expiresAtMs?: number;
      },
): CreateChannelMessageInput {
  if (input.action === "add") {
    return {
      embeds: [
        buildAuditEmbed({
          title: "⏱ Timed Role Update",
          color: 0x5865f2,
          fields: [
            { name: "Actor", value: formatActor(input.actor) },
            {
              name: "Target Member",
              value: formatTimedRoleTarget(input.userId, input.targetDisplayName),
            },
            { name: "Role", value: `<@&${input.roleId}>` },
            { name: "Duration", value: input.durationInput },
            { name: "Expires", value: formatTimedRoleExpiry(input.expiresAtMs) },
          ],
        }),
      ],
      allowed_mentions: suppressMentions(),
    };
  }

  if (input.action === "remove") {
    return {
      embeds: [
        buildAuditEmbed({
          title: "⏱ Timed Role Update",
          color: 0xfee75c,
          fields: [
            { name: "Actor", value: formatActor(input.actor) },
            {
              name: "Target Member",
              value: formatTimedRoleTarget(input.userId, input.targetDisplayName),
            },
            { name: "Role", value: `<@&${input.roleId}>` },
            ...(input.durationInput ? [{ name: "Duration", value: input.durationInput }] : []),
            ...(input.expiresAtMs
              ? [{ name: "Expires", value: formatTimedRoleExpiry(input.expiresAtMs) }]
              : []),
          ],
        }),
      ],
      allowed_mentions: suppressMentions(),
    };
  }

  return {
    embeds: [
      buildAuditEmbed({
        title: "⏱ Timed Role Update",
        color: 0x99aab5,
        fields: [
          { name: "Result", value: "Expired automatically" },
          {
            name: "Target Member",
            value: formatTimedRoleTarget(input.userId, input.targetDisplayName),
          },
          { name: "Role", value: `<@&${input.roleId}>` },
          ...(input.expiresAtMs
            ? [{ name: "Expired", value: formatTimedRoleExpiry(input.expiresAtMs) }]
            : []),
        ],
      }),
    ],
    allowed_mentions: suppressMentions(),
  };
}

export function buildTimedRoleRestorationFailureMessage(input: {
  userId: string;
  targetDisplayName?: string | null;
  roleId: string;
  failedRoleIds: string[];
  targetRoleRemovalPending?: boolean;
}): CreateChannelMessageInput {
  const pendingFields = [
    ...(input.targetRoleRemovalPending
      ? [{ name: "Timed Role Removal", value: "Still pending" }]
      : []),
    ...(input.failedRoleIds.length > 0
      ? [
          {
            name: "Roles Still Pending",
            value: input.failedRoleIds.map((roleId) => `<@&${roleId}>`).join(", "),
          },
        ]
      : [{ name: "Recovery State", value: "Cleanup is still pending" }]),
  ];
  return {
    embeds: [
      buildAuditEmbed({
        title: "⚠️ Timed Role Restoration Incomplete",
        color: 0xed4245,
        fields: [
          { name: "Result", value: "Restoration will be retried automatically" },
          {
            name: "Target Member",
            value: formatTimedRoleTarget(input.userId, input.targetDisplayName),
          },
          { name: "Timed Role", value: `<@&${input.roleId}>` },
          ...pendingFields,
        ],
      }),
    ],
    allowed_mentions: suppressMentions(),
  };
}

export async function postGuildActivityUpdate(
  store: Partial<GuildNotificationChannelStore>,
  sendChannelMessage: ChannelMessageSender | undefined,
  guildId: string,
  feature: string,
  body: CreateChannelMessageInput,
  auditLogStore?: GuildAuditLogStore,
  auditEventId?: AuditEventId,
): Promise<void> {
  if (typeof store.readGuildNotificationChannel !== "function" || !sendChannelMessage) {
    return;
  }

  try {
    const notificationChannelId = await store.readGuildNotificationChannel(guildId, feature);

    if (notificationChannelId) {
      await sendChannelMessage(notificationChannelId, body);
      return;
    }

    if (auditLogStore && auditEventId) {
      const config = await auditLogStore.readConfig(guildId);
      const channelId = config ? resolveAuditChannelIdFromConfig(config, auditEventId) : null;
      if (channelId) {
        await sendChannelMessage(channelId, body);
      }
    }
  } catch (error) {
    console.error("Failed to post activity update", error);
  }
}

function formatActor(actor?: ActionActor): string {
  if (actor?.userId) {
    return formatStaffUserReference(actor.userId);
  }

  return actor?.label ?? "a server admin";
}

function formatTimedRoleTarget(userId: string, targetDisplayName?: string | null): string {
  if (targetDisplayName) {
    return `${targetDisplayName}\n${formatStaffUserReference(userId)}`;
  }

  return formatStaffUserReference(userId);
}
