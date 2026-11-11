import {
  createFreeGuildEntitlement,
  isGuildEntitlementTier,
  type GuildEntitlement,
} from "../../types";
import type { GuildEntitlementStore } from "../contracts";
import type { PostgresDatabaseCapability } from "./postgres-capability";
import { readPostgresSafeInteger } from "./postgres-values";
import { parseDeploymentMode, selfHostedGuildEntitlements } from "../deployment-mode";

interface GuildEntitlementRow extends Record<string, unknown> {
  guild_id: string;
  plan: string;
  updated_at_ms: string | number;
}

export function createPostgresGuildEntitlementStore(
  database: PostgresDatabaseCapability,
  deploymentMode?: string,
): GuildEntitlementStore {
  if (parseDeploymentMode(deploymentMode) === "self-hosted") return selfHostedGuildEntitlements;
  return {
    async readGuildEntitlement(guildId): Promise<GuildEntitlement> {
      const rows = await database.query<GuildEntitlementRow>(
        `SELECT guild_id, plan, updated_at_ms
         FROM guild_entitlements
         WHERE guild_id = $1`,
        [guildId],
      );
      const row = rows[0];
      if (!row) return createFreeGuildEntitlement(guildId);
      if (!isGuildEntitlementTier(row.plan)) {
        throw new Error(`Invalid guild entitlement plan in storage: ${row.plan}`);
      }
      return {
        guildId: row.guild_id,
        tier: row.plan,
        updatedAtMs: readPostgresSafeInteger(row.updated_at_ms, "guild_entitlements.updated_at_ms"),
      };
    },
  };
}
