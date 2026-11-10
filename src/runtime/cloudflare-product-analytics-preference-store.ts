import { eq } from "drizzle-orm";

import { productAnalyticsPreferences } from "../db/app-schema";
import type { ProductAnalyticsPreferenceStore } from "./contracts";
import { createD1DrizzleDatabase } from "./drizzle-db";

const cache = new WeakMap<D1Database, ProductAnalyticsPreferenceStore>();

export function createCloudflareProductAnalyticsPreferenceStore(
  database: D1Database,
): ProductAnalyticsPreferenceStore {
  const cached = cache.get(database);
  if (cached) return cached;
  const db = createD1DrizzleDatabase(database);
  const store: ProductAnalyticsPreferenceStore = {
    async readEnabled(guildId) {
      const row = await db
        .select({ enabled: productAnalyticsPreferences.enabled })
        .from(productAnalyticsPreferences)
        .where(eq(productAnalyticsPreferences.guildId, guildId))
        .limit(1)
        .get();
      return row?.enabled ?? true;
    },
    async setEnabled(guildId, enabled, updatedAtMs) {
      await db
        .insert(productAnalyticsPreferences)
        .values({ guildId, enabled, updatedAtMs })
        .onConflictDoUpdate({
          target: productAnalyticsPreferences.guildId,
          set: { enabled, updatedAtMs },
        })
        .run();
    },
  };
  cache.set(database, store);
  return store;
}
