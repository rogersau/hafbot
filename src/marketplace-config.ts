import type { MarketplaceConfig } from "./types";

export const DEFAULT_MARKETPLACE_NOTICE_EMBED = {
  title: "💼 Marketplace Noticeboard",
  description: "Create a Marketplace Post. Click the button below to start.",
  color: 0x3498db,
  buttonLabel: "Create Marketplace Post",
  buttonEmoji: "💼",
} as const;

export function createDefaultMarketplaceConfig(
  guildId: string,
  updatedAtMs = Date.now(),
): MarketplaceConfig {
  return {
    guildId,
    noticeChannelId: null,
    noticeMessageId: null,
    logChannelId: null,
    noticeEmbed: { ...DEFAULT_MARKETPLACE_NOTICE_EMBED },
    serverChoiceEnabled: true,
    serverOptions: [
      { id: "namalsk", label: "Namalsk", emoji: "🧊" },
      { id: "chernarus", label: "Chernarus", emoji: "🌲" },
    ],
    additionalChoicesEnabled: false,
    additionalChoices: [],
    flowUpdatedAtMs: updatedAtMs,
    updatedAtMs,
  };
}
