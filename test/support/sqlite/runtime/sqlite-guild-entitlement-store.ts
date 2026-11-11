import { eq } from "drizzle-orm";
import { guildEntitlements } from "../db/app-schema";
import {
  createFreeGuildEntitlement,
  isGuildEntitlementTier,
  type GuildEntitlement,
} from "../../../../src/types";
import type { GuildEntitlementStore } from "../../../../src/runtime/contracts";
import { createD1DrizzleDatabase } from "./drizzle-db";
import {
  parseDeploymentMode,
  selfHostedGuildEntitlements,
} from "../../../../src/runtime/deployment-mode";

type GuildEntitlementRow = typeof guildEntitlements.$inferSelect;
const guildEntitlementStoreCache = new WeakMap<D1Database, GuildEntitlementStore>();

export function createSqliteGuildEntitlementStore(
  database: D1Database,
  deploymentMode?: string,
): GuildEntitlementStore {
  if (parseDeploymentMode(deploymentMode) === "self-hosted") return selfHostedGuildEntitlements;
  const cached = guildEntitlementStoreCache.get(database);
  if (cached) {
    return cached;
  }

  const db = createD1DrizzleDatabase(database);
  const store: GuildEntitlementStore = {
    async readGuildEntitlement(guildId: string): Promise<GuildEntitlement> {
      const freeEntitlement = createFreeGuildEntitlement(guildId);
      const row = await db
        .select()
        .from(guildEntitlements)
        .where(eq(guildEntitlements.guildId, guildId))
        .limit(1)
        .get();

      return row ? rowToEntitlement(row) : freeEntitlement;
    },
  };

  guildEntitlementStoreCache.set(database, store);
  return store;
}

function rowToEntitlement(row: GuildEntitlementRow): GuildEntitlement {
  if (!isGuildEntitlementTier(row.plan)) {
    throw new Error(`Invalid guild entitlement plan in storage: ${row.plan}`);
  }

  return {
    guildId: row.guildId,
    tier: row.plan,
    updatedAtMs: row.updatedAtMs,
  };
}
