import type { BanAppealStore } from "./types";
import { BanAppealService } from "./service";
import { createBanAppealDiscord } from "./discord";

export function createBanAppealRuntime(options: {
  store: BanAppealStore;
  resolveGuildBotIdentity: (guildId: string) => Promise<{ token: string; userId: string }>;
  isSuspended?: (guildId: string) => Promise<boolean>;
  now?: () => number;
}) {
  return {
    async serviceForGuild(guildId: string) {
      const identity = await options.resolveGuildBotIdentity(guildId);
      return new BanAppealService(
        options.store,
        guildId,
        createBanAppealDiscord(guildId, identity.token, identity.userId),
        options.now,
        options.isSuspended,
      );
    },
  };
}
