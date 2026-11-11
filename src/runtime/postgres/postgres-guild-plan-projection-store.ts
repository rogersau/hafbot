import { eq } from "drizzle-orm";
import { guildEntitlements } from "../../db/postgres/app-schema";
import { isGuildPlan, type GuildPlanProjection } from "../../types";
import type { GuildPlanProjectionStore } from "../contracts";
import type { PostgresDatabaseCapability } from "./postgres-capability";

type GuildEntitlementRow = typeof guildEntitlements.$inferSelect;
type GuildEntitlementInsert = typeof guildEntitlements.$inferInsert;

/** Stores the effective Guild plan projected by Billing. */
export function createPostgresGuildPlanProjectionStore(
  database: PostgresDatabaseCapability,
): GuildPlanProjectionStore {
  const db = database.drizzle;
  const store: GuildPlanProjectionStore = {
    async readGuildPlanProjection(guildId: string): Promise<GuildPlanProjection | null> {
      const row = await db
        .select()
        .from(guildEntitlements)
        .where(eq(guildEntitlements.guildId, guildId))
        .limit(1)
        .then((rows) => rows[0]);

      return row ? rowToProjection(row) : null;
    },

    async upsertGuildPlanProjection(projection: GuildPlanProjection): Promise<void> {
      assertValidProjection(projection);
      const values: GuildEntitlementInsert = {
        guildId: projection.guildId,
        plan: projection.plan,
        updatedAtMs: projection.updatedAtMs,
      };

      await db
        .insert(guildEntitlements)
        .values(values)
        .onConflictDoUpdate({
          target: guildEntitlements.guildId,
          set: { plan: values.plan, updatedAtMs: values.updatedAtMs },
        })
        .execute();
    },
  };

  return store;
}

function assertValidProjection(projection: GuildPlanProjection): void {
  if (!isGuildPlan(projection.plan)) {
    throw new Error(`Invalid guild plan projection: ${String(projection.plan)}`);
  }
}

function rowToProjection(row: GuildEntitlementRow): GuildPlanProjection | null {
  if (!isGuildPlan(row.plan)) {
    throw new Error(`Invalid guild plan projection in storage: ${row.plan}`);
  }

  return {
    guildId: row.guildId,
    plan: row.plan,
    updatedAtMs: row.updatedAtMs,
  };
}
