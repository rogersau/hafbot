import { eq } from "drizzle-orm";
import { guildEntitlements } from "../db/app-schema";
import { isGuildPlan, type GuildPlanProjection } from "../types";
import type { GuildPlanProjectionStore } from "./contracts";
import { createD1DrizzleDatabase } from "./drizzle-db";

type GuildEntitlementRow = typeof guildEntitlements.$inferSelect;
type GuildEntitlementInsert = typeof guildEntitlements.$inferInsert;

const storeCache = new WeakMap<D1Database, GuildPlanProjectionStore>();

/**
 * Billing's write adapter for the canonical plan column on the existing
 * guild_entitlements compatibility projection.
 */
export function createCloudflareGuildPlanProjectionStore(
  database: D1Database,
): GuildPlanProjectionStore {
  const cached = storeCache.get(database);
  if (cached) {
    return cached;
  }

  const db = createD1DrizzleDatabase(database);
  const store: GuildPlanProjectionStore = {
    async readGuildPlanProjection(guildId: string): Promise<GuildPlanProjection | null> {
      const row = await db
        .select()
        .from(guildEntitlements)
        .where(eq(guildEntitlements.guildId, guildId))
        .limit(1)
        .get();

      return row ? rowToProjection(row) : null;
    },

    async upsertGuildPlanProjection(projection: GuildPlanProjection): Promise<void> {
      assertValidProjection(projection);
      const values: GuildEntitlementInsert = {
        guildId: projection.guildId,
        tier: projection.plan,
        plan: projection.plan,
        updatedAtMs: projection.updatedAtMs,
      };

      await db
        .insert(guildEntitlements)
        .values(values)
        .onConflictDoUpdate({
          target: guildEntitlements.guildId,
          set: { tier: values.tier, plan: values.plan, updatedAtMs: values.updatedAtMs },
        })
        .run();
    },
  };

  storeCache.set(database, store);
  return store;
}

function assertValidProjection(projection: GuildPlanProjection): void {
  if (!isGuildPlan(projection.plan)) {
    throw new Error(`Invalid guild plan projection: ${String(projection.plan)}`);
  }
}

function rowToProjection(row: GuildEntitlementRow): GuildPlanProjection | null {
  if (row.plan === null || row.plan === undefined) {
    return null;
  }
  if (!isGuildPlan(row.plan)) {
    throw new Error(`Invalid guild plan projection in storage: ${row.plan}`);
  }

  return {
    guildId: row.guildId,
    plan: row.plan,
    updatedAtMs: row.updatedAtMs,
  };
}
