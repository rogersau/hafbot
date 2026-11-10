import { eq } from "drizzle-orm";

import { productAnalyticsPreferences } from "../../db/postgres/app-schema";
import type { ProductAnalyticsPreferenceStore } from "../contracts";
import type { PostgresDatabaseCapability } from "./postgres-capability";

export function createPostgresProductAnalyticsPreferenceStore(
  database: PostgresDatabaseCapability,
): ProductAnalyticsPreferenceStore {
  const db = database.drizzle;
  return {
    async readEnabled(guildId) {
      const rows = await db
        .select({ enabled: productAnalyticsPreferences.enabled })
        .from(productAnalyticsPreferences)
        .where(eq(productAnalyticsPreferences.guildId, guildId))
        .limit(1);
      return rows[0]?.enabled ?? true;
    },
    async setEnabled(guildId, enabled, updatedAtMs) {
      await db
        .insert(productAnalyticsPreferences)
        .values({ guildId, enabled, updatedAtMs })
        .onConflictDoUpdate({
          target: productAnalyticsPreferences.guildId,
          set: { enabled, updatedAtMs },
        });
    },
  };
}
