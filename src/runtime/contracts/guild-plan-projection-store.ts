import type { GuildPlanProjection } from "../../types";

/**
 * The canonical plan projection written by Billing.
 *
 * A null read means this Guild has not reached the canonical projection yet;
 * it must not be confused with a projected Free plan.
 */
export interface GuildPlanProjectionStore {
  readGuildPlanProjection(guildId: string): Promise<GuildPlanProjection | null>;
  upsertGuildPlanProjection(projection: GuildPlanProjection): Promise<void>;
}
