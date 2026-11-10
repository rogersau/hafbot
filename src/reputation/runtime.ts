import { createReputationDiscord } from "./discord";
import { ReputationService } from "./service";
import type { ReputationStore } from "./types";
import type { ReactionRoleStore } from "../runtime/contracts/reaction-role-store";

export function createReputationRuntime(options: {
  store: ReputationStore;
  resolveGuildBotIdentity: (guildId: string) => Promise<{ token: string; userId: string }>;
  rolePolicy: Pick<ReactionRoleStore, "readRestrictedRoleIds" | "isRoleSuspended" | "listPanels">;
  now?: () => number;
  isSuspended?: (guildId: string) => Promise<boolean>;
}) {
  const now = options.now ?? Date.now;
  async function serviceForGuild(guildId: string) {
    const bot = await options.resolveGuildBotIdentity(guildId);
    return new ReputationService(
      options.store,
      createReputationDiscord({
        token: bot.token,
        botUserId: bot.userId,
        rolePolicy: options.rolePolicy,
      }),
      now,
      options.isSuspended,
    );
  }
  return {
    serviceForGuild,
    async processRewards() {
      const jobs = await options.store.pendingRewards(now(), 20);
      let delivered = 0;
      let deferred = 0;
      for (const guildId of new Set(jobs.map((job) => job.guildId))) {
        if (await options.isSuspended?.(guildId)) {
          for (const job of jobs.filter((entry) => entry.guildId === guildId)) {
            await options.store.deferReward(job, now() + 5 * 60_000);
            deferred += 1;
          }
          continue;
        }
        const service = await serviceForGuild(guildId);
        const result = await service.processRewards(
          jobs.filter((job) => job.guildId === guildId).length,
          guildId,
        );
        delivered += result.delivered;
        deferred += result.deferred;
      }
      return { delivered, deferred };
    },
  };
}
