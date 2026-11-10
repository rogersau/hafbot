import type { LfgApplication, LfgConfig, LfgPost } from "./types";
import {
  buildAuditEmbed,
  allowUserMentions,
  formatStaffUserReference,
  formatUserMention,
  suppressMentions,
} from "./discord/messages";
import {
  DISCORD_ACTION_ROW_BUTTON_LIMIT,
  DISCORD_BUTTON_COMPONENT,
  DISCORD_CHANNEL_MESSAGE_RESPONSE,
  DISCORD_EMBED_FIELD_TRUNCATED_TEXT_LENGTH,
  DISCORD_EMBED_FIELD_VALUE_LIMIT,
  DISCORD_EPHEMERAL_FLAG,
  DISCORD_MESSAGE_COMPONENT_ROW,
  DISCORD_MODAL_RESPONSE,
  DISCORD_TEXT_INPUT_COMPONENT,
} from "./discord/constants";

const LFG_APPLICATION_MESSAGE_MAX_LENGTH = 500;
const LFG_SERVER_ID_MAX_LENGTH = 32;
const LFG_WHEN_PLAY_MAX_LENGTH = 100;
const LFG_LOOKING_FOR_MAX_LENGTH = 100;
const LFG_EXTRA_INFO_MAX_LENGTH = 500;

export type LfgCustomId =
  | { action: "create" }
  | { action: "create-clan" }
  | { action: "toggle-alerts" }
  | { action: "server"; serverId: string }
  | { action: "server-clan"; serverId: string }
  | { action: "modal"; serverId: string }
  | { action: "modal-clan"; serverId: string }
  | { action: "edit"; postId: string }
  | { action: "edit-modal"; postId: string }
  | { action: "interested"; postId: string }
  | { action: "apply-modal"; postId: string }
  | { action: "application-accept"; guildId: string; postId: string; applicantId: string }
  | { action: "application-reject"; guildId: string; postId: string; applicantId: string }
  | { action: "close"; postId: string }
  | { action: "close-confirm" | "close-cancel"; postId: string }
  | { action: "renew"; guildId: string; postId: string };

export function parseLfgCustomId(customId: string): LfgCustomId | null {
  const parts = customId.split(":");
  if (parts[0] !== "lfg") return null;

  if (parts[1] === "create") return { action: "create" };
  if (parts[1] === "create-clan") return { action: "create-clan" };
  if (parts[1] === "toggle-alerts") return { action: "toggle-alerts" };
  if (parts[1] === "server" && parts[2]) {
    return { action: "server", serverId: parts.slice(2).join(":") };
  }
  if (parts[1] === "server-clan" && parts[2]) {
    return { action: "server-clan", serverId: parts.slice(2).join(":") };
  }
  if (parts[1] === "modal" && parts[2]) {
    return { action: "modal", serverId: parts.slice(2).join(":") };
  }
  if (parts[1] === "modal-clan" && parts[2]) {
    return { action: "modal-clan", serverId: parts.slice(2).join(":") };
  }
  if (parts[1] === "edit" && parts[2]) {
    return { action: "edit", postId: parts.slice(2).join(":") };
  }
  if (parts[1] === "edit-modal" && parts[2]) {
    return { action: "edit-modal", postId: parts.slice(2).join(":") };
  }
  if (parts[1] === "interested" && parts[2]) {
    return { action: "interested", postId: parts.slice(2).join(":") };
  }
  if (parts[1] === "apply-modal" && parts[2]) {
    return { action: "apply-modal", postId: parts.slice(2).join(":") };
  }
  if (
    (parts[1] === "application-accept" || parts[1] === "application-reject") &&
    parts[2] &&
    parts[3] &&
    parts[4]
  ) {
    return {
      action: parts[1],
      guildId: parts[2],
      postId: parts[3],
      applicantId: parts.slice(4).join(":"),
    };
  }
  if (parts[1] === "close" && parts[2]) {
    return { action: "close", postId: parts.slice(2).join(":") };
  }
  if ((parts[1] === "close-confirm" || parts[1] === "close-cancel") && parts[2]) {
    return { action: parts[1], postId: parts.slice(2).join(":") };
  }
  if (parts[1] === "renew" && parts[2] && parts[3]) {
    return { action: "renew", guildId: parts[2], postId: parts.slice(3).join(":") };
  }

  return null;
}

export function buildLfgCloseConfirmation(post: LfgPost) {
  return {
    type: DISCORD_CHANNEL_MESSAGE_RESPONSE,
    data: {
      flags: DISCORD_EPHEMERAL_FLAG,
      content: [
        "**Close this LFG post?**",
        "The post will be marked closed and stop accepting interest or applications.",
        post.scope === "clan"
          ? "Your Clan's persistent private voice room will stay available."
          : "Any temporary private voice room for this post will be deleted, disconnecting members in it.",
        "This cannot be undone. Select Cancel to keep the post open.",
      ].join("\n\n"),
      allowed_mentions: suppressMentions(),
      components: [
        {
          type: DISCORD_MESSAGE_COMPONENT_ROW,
          components: [
            {
              type: DISCORD_BUTTON_COMPONENT,
              custom_id: `lfg:close-confirm:${post.id}`,
              label: "Close post",
              style: 4,
            },
            {
              type: DISCORD_BUTTON_COMPONENT,
              custom_id: `lfg:close-cancel:${post.id}`,
              label: "Cancel",
              style: 2,
            },
          ],
        },
      ],
    },
  };
}

export function buildLfgApplicationModal(postId: string) {
  return {
    type: DISCORD_MODAL_RESPONSE,
    data: {
      custom_id: `lfg:apply-modal:${postId}`,
      title: "Apply to LFG Post",
      components: [
        inputRow(
          "application_message",
          "Application message",
          true,
          LFG_APPLICATION_MESSAGE_MAX_LENGTH,
        ),
      ],
    },
  };
}

export function buildLfgApplicationReviewMessage(application: LfgApplication, post: LfgPost) {
  return {
    content: [
      "📝 **New LFG application**",
      "",
      `Applicant: ${formatUserMention(application.applicantId)} (${application.applicantDisplayName})`,
      `Server: **${post.serverLabel}**`,
      `Looking for: ${post.lookingFor || "Not specified"}`,
      "",
      `Message: ${application.message}`,
    ].join("\n"),
    allowed_mentions: allowUserMentions([application.applicantId]),
    components: [
      {
        type: DISCORD_MESSAGE_COMPONENT_ROW,
        components: [
          {
            type: DISCORD_BUTTON_COMPONENT,
            custom_id: `lfg:application-accept:${application.guildId}:${application.postId}:${application.applicantId}`,
            label: "Accept",
            style: 3,
          },
          {
            type: DISCORD_BUTTON_COMPONENT,
            custom_id: `lfg:application-reject:${application.guildId}:${application.postId}:${application.applicantId}`,
            label: "Reject",
            style: 4,
          },
        ],
      },
    ],
  };
}

export function buildLfgApplicationOutcomeMessage(application: LfgApplication, post: LfgPost) {
  const accepted = application.status === "accepted";
  return {
    content: [
      accepted
        ? "✅ **Your LFG application was accepted.**"
        : "❌ **Your LFG application was rejected.**",
      "",
      `Server: **${post.serverLabel}**`,
      `Looking for: ${post.lookingFor || "Not specified"}`,
    ].join("\n"),
    allowed_mentions: { parse: [] },
  };
}

export function buildLfgApplicationAuditMessage(
  application: LfgApplication,
  post: LfgPost,
  action: "applied" | "accepted" | "rejected",
) {
  const actionLabel =
    action === "applied" ? "Applied" : action === "accepted" ? "Accepted" : "Rejected";
  return {
    content: undefined,
    allowed_mentions: suppressMentions(),
    embeds: [
      buildAuditEmbed({
        title: `LFG application ${actionLabel}`,
        color: action === "accepted" ? 0x57f287 : action === "rejected" ? 0xed4245 : 0x5865f2,
        timestamp: new Date(application.reviewedAtMs ?? application.updatedAtMs).toISOString(),
        fields: [
          { name: "Post", value: post.id, inline: false },
          {
            name: "Applicant",
            value: formatStaffUserReference(application.applicantId),
            inline: false,
          },
          {
            name: "Actor",
            value: formatStaffUserReference(
              application.reviewedByUserId ?? application.applicantId,
            ),
            inline: false,
          },
          { name: "Message", value: application.message || "No message provided.", inline: false },
        ],
      }),
    ],
  };
}

export function buildLfgNoticeMessage(
  config?: Pick<LfgConfig, "notificationRoleId" | "noticeColor">,
) {
  const hasNotificationRole = Boolean(config?.notificationRoleId);
  return {
    embeds: [
      {
        title: "🎮 Looking For Gamers",
        description:
          "Looking for someone to play with? Click the button below and fill out a quick post.",
        color: config?.noticeColor ?? 0x2b2d31,
      },
    ],
    components: [
      {
        type: DISCORD_MESSAGE_COMPONENT_ROW,
        components: [
          {
            type: DISCORD_BUTTON_COMPONENT,
            custom_id: "lfg:create",
            label: "Create LFG Post",
            emoji: { name: "🎮" },
            style: 1,
          },
          ...(hasNotificationRole
            ? [
                {
                  type: DISCORD_BUTTON_COMPONENT,
                  custom_id: "lfg:toggle-alerts",
                  label: "Join / Leave LFG Alerts",
                  emoji: { name: "🔔" },
                  style: 2,
                },
              ]
            : []),
        ],
      },
    ],
  };
}

export function buildLfgServerResponse(config: LfgConfig, scope: "public" | "clan" = "public") {
  return {
    type: DISCORD_CHANNEL_MESSAGE_RESPONSE,
    data: {
      content: "Choose which server your LFG post is for.",
      flags: DISCORD_EPHEMERAL_FLAG,
      components: chunk(config.serverOptions, DISCORD_ACTION_ROW_BUTTON_LIMIT).map(
        (serverOptions) => ({
          type: DISCORD_MESSAGE_COMPONENT_ROW,
          components: serverOptions.map((option) => ({
            type: DISCORD_BUTTON_COMPONENT,
            custom_id: `lfg:${scope === "clan" ? "server-clan" : "server"}:${option.id}`,
            label: option.label || "Unnamed server",
            emoji: option.emoji ? { name: option.emoji } : undefined,
            style: 2,
          })),
        }),
      ),
    },
  };
}

export function buildLfgPostModal(
  serverId: string,
  values?: Partial<Pick<LfgPost, "serverId" | "whenPlay" | "lookingFor" | "extraInfo">>,
  options?: { customId?: string; title?: string; scope?: "public" | "clan" },
) {
  return {
    type: DISCORD_MODAL_RESPONSE,
    data: {
      custom_id:
        options?.customId ??
        `lfg:${options?.scope === "clan" ? "modal-clan" : "modal"}:${serverId}`,
      title: options?.title ?? "Create LFG Post",
      components: [
        inputRow(
          "server_id",
          "Server ID",
          true,
          LFG_SERVER_ID_MAX_LENGTH,
          values?.serverId ?? serverId,
        ),
        inputRow(
          "when_play",
          "When do you play?",
          true,
          LFG_WHEN_PLAY_MAX_LENGTH,
          values?.whenPlay,
        ),
        inputRow(
          "looking_for",
          "Looking for?",
          true,
          LFG_LOOKING_FOR_MAX_LENGTH,
          values?.lookingFor,
        ),
        inputRow("extra_info", "Extra info", false, LFG_EXTRA_INFO_MAX_LENGTH, values?.extraInfo),
      ],
    },
  };
}

export function buildLfgPostMessage(
  post: LfgPost,
  options?: { notificationRoleId?: string | null },
) {
  const closed = !post.active;
  const serverEmoji =
    post.serverLabel === "Namalsk" ? "🧊" : post.serverLabel === "Chernarus" ? "🌲" : "🔁";
  const expiresAt = post.expiresAtMs ? new Date(post.expiresAtMs).toISOString() : null;
  const notificationRoleId = options?.notificationRoleId ?? null;

  return {
    content: notificationRoleId ? `<@&${notificationRoleId}>` : undefined,
    allowed_mentions: notificationRoleId ? { roles: [notificationRoleId] } : { parse: [] },
    embeds: [
      {
        title: "🎮 Looking For Gamers",
        color: closed ? 0xed4245 : 0x57f287,
        fields: [
          {
            name: `${serverEmoji} Server`,
            value: post.serverLabel || "Not specified",
            inline: false,
          },
          { name: "🕒 When", value: post.whenPlay || "Not specified", inline: false },
          { name: "👥 Looking for", value: post.lookingFor || "Not specified", inline: false },
          {
            name: "📝 Info",
            value: truncateField(post.extraInfo || "No extra info provided."),
            inline: false,
          },
          { name: "👤 Posted by", value: formatUserMention(post.ownerId), inline: false },
          ...(expiresAt
            ? [
                {
                  name: "⏳ Expires",
                  value: `<t:${Math.floor(post.expiresAtMs! / 1000)}:R>`,
                  inline: false,
                },
              ]
            : []),
          { name: "📌 Status", value: closed ? "Closed" : "Open", inline: false },
        ],
        timestamp: new Date(post.createdAtMs).toISOString(),
      },
    ],
    components: [
      {
        type: DISCORD_MESSAGE_COMPONENT_ROW,
        components: [
          {
            type: DISCORD_BUTTON_COMPONENT,
            custom_id: `lfg:interested:${post.id}`,
            label: "I'm Interested",
            emoji: { name: "✅" },
            style: 3,
            disabled: closed,
          },
          {
            type: DISCORD_BUTTON_COMPONENT,
            custom_id: `lfg:edit:${post.id}`,
            label: "Edit Post",
            emoji: { name: "✏️" },
            style: 2,
            disabled: closed,
          },
          {
            type: DISCORD_BUTTON_COMPONENT,
            custom_id: `lfg:close:${post.id}`,
            label: "Close Post",
            emoji: { name: "❌" },
            style: 4,
            disabled: closed,
          },
        ],
      },
    ],
  };
}

export function buildLfgDmMessage(
  interestedUserId: string,
  interestedUserDisplayName: string,
  post: LfgPost,
  options: { allowInterestedUserMention?: boolean } = {},
) {
  const allowInterestedUserMention = options.allowInterestedUserMention ?? true;
  const userLine = allowInterestedUserMention
    ? `${formatUserMention(interestedUserId)} (${interestedUserDisplayName})`
    : `${interestedUserDisplayName}\nID: ${interestedUserId}`;

  return {
    content: [
      "🔥 **Someone is interested in your LFG post!**",
      "",
      `User: ${userLine}`,
      `Server: **${post.serverLabel}**`,
      `Looking for: ${post.lookingFor}`,
      "",
      "You can DM them directly or add them as a Discord friend.",
    ].join("\n"),
    allowed_mentions: allowInterestedUserMention
      ? allowUserMentions([interestedUserId])
      : suppressMentions(),
  };
}

export function buildLfgRenewalReminderMessage(post: LfgPost) {
  return {
    content: [
      "⏳ **Your LFG post is expiring soon.**",
      "",
      `Server: **${post.serverLabel}**`,
      `Looking for: ${post.lookingFor || "Not specified"}`,
      "",
      "Click below to renew it.",
    ].join("\n"),
    allowed_mentions: suppressMentions(),
    components: [
      {
        type: DISCORD_MESSAGE_COMPONENT_ROW,
        components: [
          {
            type: DISCORD_BUTTON_COMPONENT,
            custom_id: `lfg:renew:${post.guildId}:${post.id}`,
            label: "Renew Post",
            emoji: { name: "♻️" },
            style: 3,
          },
        ],
      },
    ],
  };
}

function inputRow(
  customId: string,
  label: string,
  required: boolean,
  maxLength: number,
  value?: string,
) {
  return {
    type: DISCORD_MESSAGE_COMPONENT_ROW,
    components: [
      {
        type: DISCORD_TEXT_INPUT_COMPONENT,
        custom_id: customId,
        label,
        style: 2,
        required,
        max_length: maxLength,
        value,
      },
    ],
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function truncateField(value: string): string {
  return value.length <= DISCORD_EMBED_FIELD_VALUE_LIMIT
    ? value
    : `${value.slice(0, DISCORD_EMBED_FIELD_TRUNCATED_TEXT_LENGTH)}...`;
}
