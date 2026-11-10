import type { WhiteLabelBotStore } from "./contracts/white-label-bot-store";

export interface GuildBrandingResolver {
  resolveFooterText(guildId: string | undefined): Promise<string>;
  resolveBotDisplayName(guildId: string | undefined): Promise<string>;
}

export function createGuildBrandingResolver(
  whiteLabelBotStore: Pick<WhiteLabelBotStore, "readWhiteLabelBot"> | undefined,
): GuildBrandingResolver {
  return {
    async resolveFooterText(guildId) {
      const bot = guildId ? await whiteLabelBotStore?.readWhiteLabelBot(guildId) : null;
      if (bot?.status === "active" && bot.brandFooterText) {
        return bot.brandFooterText;
      }
      return "hafbot.xyz";
    },
    async resolveBotDisplayName(guildId) {
      const bot = guildId ? await whiteLabelBotStore?.readWhiteLabelBot(guildId) : null;
      if (bot?.status === "active") {
        return bot.displayName;
      }
      return "HAF Bot";
    },
  };
}
