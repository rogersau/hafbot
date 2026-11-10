import type { GuildPlanProjectionStore } from "./contracts";
import type { GuildPlan } from "../types";

export interface EffectiveGuildPlan {
  guildId: string;
  plan: GuildPlan;
  updatedAtMs: number;
}

export interface EffectiveGuildPlanStore {
  readEffectiveGuildPlan(guildId: string): Promise<EffectiveGuildPlan>;
}

export interface CreateEffectiveGuildPlanStoreOptions {
  projections: GuildPlanProjectionStore;
}

/**
 * Read the plan boundary used by new Billing consumers.
 *
 * Billing's projection is authoritative. Guilds without a projection default
 * to free without writing a synthetic entitlement row.
 */
export function createEffectiveGuildPlanStore(
  options: CreateEffectiveGuildPlanStoreOptions,
): EffectiveGuildPlanStore {
  return {
    async readEffectiveGuildPlan(guildId: string): Promise<EffectiveGuildPlan> {
      const projection = await options.projections.readGuildPlanProjection(guildId);
      return (
        projection ?? {
          guildId,
          plan: "free",
          updatedAtMs: 0,
        }
      );
    },
  };
}
