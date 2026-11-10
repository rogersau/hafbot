import type {
  MarketplaceBusinessLog,
  MarketplaceConfig,
  MarketplacePost,
  MarketplaceTradeType,
} from "./types";
import {
  allowUserMentions,
  buildAuditEmbed,
  formatStaffUserReference,
  formatUserMention,
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
  DISCORD_UPDATE_MESSAGE_RESPONSE,
} from "./discord/constants";
import { DEFAULT_MARKETPLACE_NOTICE_EMBED } from "./marketplace-config";

const MARKETPLACE_TRADE_ITEM_MAX_LENGTH = 900;
const MARKETPLACE_EXTRA_INFO_MAX_LENGTH = 700;

export type MarketplaceCustomId =
  | { action: "create" }
  | { action: "type"; tradeType: MarketplaceTradeType }
  | {
      action: "server";
      tradeType: MarketplaceTradeType;
      serverId: string;
      flowUpdatedAtMs: number | null;
    }
  | {
      action: "choice";
      tradeType: MarketplaceTradeType;
      serverId: string;
      choiceIndex: number;
      optionIndex: number;
      choiceIndexes: number[];
      flowUpdatedAtMs: number | null;
    }
  | {
      action: "modal";
      tradeType: MarketplaceTradeType;
      serverId: string;
      choiceIndexes: number[];
      flowUpdatedAtMs: number | null;
    }
  | { action: "business"; postId: string }
  | { action: "confirm"; postId: string }
  | { action: "close"; postId: string };

export function parseMarketplaceCustomId(customId: string): MarketplaceCustomId | null {
  const parts = customId.split(":");
  if (parts[0] !== "market") return null;

  if (parts[1] === "create") return { action: "create" };
  if (parts[1] === "type" && isTradeType(parts[2])) {
    return { action: "type", tradeType: parts[2] };
  }
  if (parts[1] === "server" && isTradeType(parts[2]) && parts[3]) {
    const flowUpdatedAtMs = parseConfigVersion(parts[4]);
    if (parts[4] !== undefined && flowUpdatedAtMs === null) return null;
    return { action: "server", tradeType: parts[2], serverId: parts[3], flowUpdatedAtMs };
  }
  if (
    parts[1] === "choice" &&
    isTradeType(parts[2]) &&
    parts[3] &&
    isNonNegativeInteger(parts[4]) &&
    isNonNegativeInteger(parts[5])
  ) {
    const choiceIndexes = parseChoiceIndexes(parts[6]);
    const flowUpdatedAtMs = parseConfigVersion(parts[7]);
    if (choiceIndexes === null || (parts[7] !== undefined && flowUpdatedAtMs === null)) return null;
    return {
      action: "choice",
      tradeType: parts[2],
      serverId: decodeServerId(parts[3]),
      choiceIndex: Number(parts[4]),
      optionIndex: Number(parts[5]),
      choiceIndexes,
      flowUpdatedAtMs,
    };
  }
  if (parts[1] === "modal" && isTradeType(parts[2]) && parts[3]) {
    const isVersioned = parts[5] !== undefined;
    const flowUpdatedAtMs = isVersioned ? parseConfigVersion(parts[4]) : null;
    const choiceIndexes = parseChoiceIndexes(isVersioned ? parts[5] : parts[4]);
    if (choiceIndexes === null || (isVersioned && flowUpdatedAtMs === null)) return null;
    return {
      action: "modal",
      tradeType: parts[2],
      serverId: decodeServerId(parts[3]),
      choiceIndexes,
      flowUpdatedAtMs,
    };
  }
  if (parts[1] === "biz" && parts[2])
    return { action: "business", postId: parts.slice(2).join(":") };
  if (parts[1] === "confirm" && parts[2])
    return { action: "confirm", postId: parts.slice(2).join(":") };
  if (parts[1] === "close" && parts[2])
    return { action: "close", postId: parts.slice(2).join(":") };

  return null;
}

export function buildMarketplaceNoticeMessage(config?: MarketplaceConfig) {
  const embed = config?.noticeEmbed ?? DEFAULT_MARKETPLACE_NOTICE_EMBED;
  return {
    embeds: [
      {
        title: embed.title,
        description: embed.description,
        color: embed.color,
      },
    ],
    components: [
      {
        type: DISCORD_MESSAGE_COMPONENT_ROW,
        components: [
          {
            type: DISCORD_BUTTON_COMPONENT,
            custom_id: "market:create",
            label: embed.buttonLabel,
            emoji: embed.buttonEmoji ? { name: embed.buttonEmoji } : undefined,
            style: 1,
          },
        ],
      },
    ],
  };
}

export function buildMarketplaceTypeResponse() {
  return {
    type: DISCORD_CHANNEL_MESSAGE_RESPONSE,
    data: {
      content: "What type of marketplace post do you want to create?",
      flags: DISCORD_EPHEMERAL_FLAG,
      components: [
        {
          type: DISCORD_MESSAGE_COMPONENT_ROW,
          components: [
            {
              type: DISCORD_BUTTON_COMPONENT,
              custom_id: "market:type:have",
              label: "I have an item to trade",
              emoji: { name: "📦" },
              style: 3,
            },
            {
              type: DISCORD_BUTTON_COMPONENT,
              custom_id: "market:type:want",
              label: "I am looking for an item",
              emoji: { name: "🔎" },
              style: 1,
            },
          ],
        },
      ],
    },
  };
}

export function buildMarketplaceServerResponse(
  config: MarketplaceConfig,
  tradeType: MarketplaceTradeType,
) {
  return {
    type: DISCORD_UPDATE_MESSAGE_RESPONSE,
    data: {
      content: "Which server is this for?",
      components: chunk(config.serverOptions, DISCORD_ACTION_ROW_BUTTON_LIMIT).map(
        (serverOptions) => ({
          type: DISCORD_MESSAGE_COMPONENT_ROW,
          components: serverOptions.map((option) => ({
            type: DISCORD_BUTTON_COMPONENT,
            custom_id: `market:server:${tradeType}:${option.id}:${encodeConfigVersion(config.flowUpdatedAtMs ?? config.updatedAtMs)}`,
            label: option.label,
            emoji: option.emoji ? { name: option.emoji } : undefined,
            style: 2,
          })),
        }),
      ),
    },
  };
}

export function buildMarketplaceAdditionalChoiceResponse(
  config: MarketplaceConfig,
  tradeType: MarketplaceTradeType,
  serverId: string,
  choiceIndex: number,
  choiceIndexes: number[],
) {
  const choice = config.additionalChoices?.[choiceIndex];
  if (!choice) throw new Error("Marketplace additional choice is not configured");
  const encodedPreviousChoices = choiceIndexes.length > 0 ? choiceIndexes.join(",") : "~";
  const encodedServerId = serverId || "~";
  const configVersion = encodeConfigVersion(config.flowUpdatedAtMs ?? config.updatedAtMs);

  return {
    type: DISCORD_UPDATE_MESSAGE_RESPONSE,
    data: {
      content: choice.label,
      components: chunk(choice.options, DISCORD_ACTION_ROW_BUTTON_LIMIT).map((options) => ({
        type: DISCORD_MESSAGE_COMPONENT_ROW,
        components: options.map((option) => {
          const optionIndex = choice.options.indexOf(option);
          return {
            type: DISCORD_BUTTON_COMPONENT,
            custom_id: `market:choice:${tradeType}:${encodedServerId}:${choiceIndex}:${optionIndex}:${encodedPreviousChoices}:${configVersion}`,
            label: option.label,
            emoji: option.emoji ? { name: option.emoji } : undefined,
            style: 2,
          };
        }),
      })),
    },
  };
}

export function buildMarketplacePostModal(
  tradeType: MarketplaceTradeType,
  serverId: string,
  choiceIndexes: number[] = [],
  flowUpdatedAtMs?: number,
) {
  const encodedChoices = choiceIndexes.length > 0 ? choiceIndexes.join(",") : "~";
  const versionedState =
    flowUpdatedAtMs === undefined
      ? choiceIndexes.length > 0
        ? `:${encodedChoices}`
        : ""
      : `:${encodeConfigVersion(flowUpdatedAtMs)}:${encodedChoices}`;
  return {
    type: DISCORD_MODAL_RESPONSE,
    data: {
      custom_id: `market:modal:${tradeType}:${serverId || "~"}${versionedState}`,
      title: "Create Marketplace Post",
      components: [
        inputRow(
          "have",
          "What do you have for trade?",
          tradeType === "have",
          MARKETPLACE_TRADE_ITEM_MAX_LENGTH,
        ),
        inputRow(
          "want",
          "Is there something you are looking for?",
          tradeType === "want",
          MARKETPLACE_TRADE_ITEM_MAX_LENGTH,
        ),
        inputRow("extra", "Extra info", false, MARKETPLACE_EXTRA_INFO_MAX_LENGTH),
      ],
    },
  };
}

function isNonNegativeInteger(value: string | undefined): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

function parseChoiceIndexes(value: string | undefined): number[] | null {
  if (value === undefined || value === "~" || value === "") return [];
  const parts = value.split(",");
  return parts.every((part) => /^\d+$/.test(part)) ? parts.map(Number) : null;
}

function decodeServerId(value: string): string {
  return value === "~" ? "" : value;
}

function encodeConfigVersion(updatedAtMs: number): string {
  return updatedAtMs.toString(36);
}

function parseConfigVersion(value: string | undefined): number | null {
  if (value === undefined || !/^[0-9a-z]+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 36);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function buildMarketplacePostMessage(post: MarketplacePost) {
  const closed = !post.active;
  const summaryFields = [
    {
      name: "Type",
      value: post.tradeType === "have" ? "Have item to trade" : "Looking for item",
      inline: true,
    },
    ...(post.serverLabel ? [{ name: "Server", value: post.serverLabel, inline: true }] : []),
    ...(post.additionalChoices ?? []).map((selection) => ({
      name: selection.choiceLabel,
      value: selection.optionLabel,
      inline: true,
    })),
  ];
  return {
    embeds: [
      {
        title: closed ? "🔒 Marketplace Listing Closed" : "💼 Marketplace Listing",
        color: closed ? 0x777777 : 0x2ecc71,
        fields: [
          ...summaryFields,
          {
            name: "What do you have for trade?",
            value: truncateField(post.have || "Not specified"),
          },
          {
            name: "Is there something you are looking for?",
            value: truncateField(post.want || "Not specified"),
          },
          { name: "Extra info", value: truncateField(post.extra || "None") },
          { name: "Posted by", value: formatUserMention(post.ownerId) },
        ],
        footer: { text: `Post ID: ${post.id}` },
        timestamp: new Date(post.createdAtMs).toISOString(),
      },
    ],
    components: [
      {
        type: DISCORD_MESSAGE_COMPONENT_ROW,
        components: [
          {
            type: DISCORD_BUTTON_COMPONENT,
            custom_id: `market:biz:${post.id}`,
            label: "Do Business",
            emoji: { name: "💼" },
            style: 3,
            disabled: closed,
          },
          {
            type: DISCORD_BUTTON_COMPONENT,
            custom_id: `market:close:${post.id}`,
            label: "Close Post",
            emoji: { name: "🔒" },
            style: 4,
            disabled: closed,
          },
        ],
      },
    ],
  };
}

export function buildMarketplaceWarningResponse(postId: string) {
  return {
    type: DISCORD_CHANNEL_MESSAGE_RESPONSE,
    data: {
      flags: DISCORD_EPHEMERAL_FLAG,
      content: [
        "⚠️ **Marketplace Notice**",
        "",
        "All trades arranged through this Discord marketplace must follow server rules.",
        "",
        "**Scamming, misleading, betraying, or setting players up through marketplace deals may result in a ban.**",
        "",
        "Only continue if you agree to do business fairly.",
      ].join("\n"),
      components: [
        {
          type: DISCORD_MESSAGE_COMPONENT_ROW,
          components: [
            {
              type: DISCORD_BUTTON_COMPONENT,
              custom_id: `market:confirm:${postId}`,
              label: "Confirm & Do Business",
              emoji: { name: "💼" },
              style: 4,
            },
          ],
        },
      ],
    },
  };
}

export function buildMarketplaceDmMessage(
  buyerId: string,
  buyerDisplayName: string,
  post: MarketplacePost,
) {
  return {
    content: [
      "💼 **Someone wants to do business with you!**",
      "",
      `User: ${formatUserMention(buyerId)} (${buyerDisplayName})`,
      ...(post.serverLabel ? [`Server: **${post.serverLabel}**`] : []),
      ...(post.additionalChoices ?? []).map(
        (selection) => `${selection.choiceLabel}: **${selection.optionLabel}**`,
      ),
      "",
      "**Marketplace post:**",
      `Have: ${post.have || "Not specified"}`,
      `Looking for: ${post.want || "Not specified"}`,
      "",
      "You can DM them directly or add them as a Discord friend.",
      "",
      "**Reminder:** Trades arranged through the Discord marketplace must follow server rules.",
    ].join("\n"),
    allowed_mentions: allowUserMentions([buyerId]),
  };
}

export function buildMarketplaceLogMessage(log: MarketplaceBusinessLog) {
  return {
    embeds: [
      buildAuditEmbed({
        title: "💼 Marketplace Business Logged",
        color: 0xf1c40f,
        timestamp: new Date(log.timestampMs).toISOString(),
        fields: [
          { name: "Interested user", value: formatStaffUserReference(log.buyerId) },
          { name: "Post owner", value: formatStaffUserReference(log.sellerId) },
          { name: "Server", value: log.serverLabel },
          { name: "Post ID", value: log.postId },
          { name: "DM sent", value: log.dmSent ? "Yes" : "No" },
          { name: "Have", value: truncateField(log.have || "Not specified") },
          { name: "Looking for", value: truncateField(log.want || "Not specified") },
        ],
      }),
    ],
  };
}

function inputRow(customId: string, label: string, required: boolean, maxLength: number) {
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

function isTradeType(value: unknown): value is MarketplaceTradeType {
  return value === "have" || value === "want";
}
