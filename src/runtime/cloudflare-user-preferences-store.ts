import { eq } from "drizzle-orm";

import { userPreferences } from "../db/app-schema";
import type { UserPreferences } from "./admin-types";
import type { UserPreferencesStore } from "./contracts/user-preferences-store";
import { createD1DrizzleDatabase } from "./drizzle-db";

const userPreferencesStoreCache = new WeakMap<D1Database, UserPreferencesStore>();

export function createCloudflareUserPreferencesStore(database: D1Database): UserPreferencesStore {
  const cached = userPreferencesStoreCache.get(database);
  if (cached) {
    return cached;
  }

  const db = createD1DrizzleDatabase(database);
  const store: UserPreferencesStore = {
    async readUserPreferences(userId: string): Promise<UserPreferences | null> {
      const row = await db
        .select()
        .from(userPreferences)
        .where(eq(userPreferences.userId, userId))
        .get();
      if (!row) return null;
      return rowToPreferences(row);
    },
    async upsertUserPreferences(userId: string, preferences: UserPreferences): Promise<void> {
      const values = preferencesToRow(userId, preferences);
      await db
        .insert(userPreferences)
        .values(values)
        .onConflictDoUpdate({
          target: userPreferences.userId,
          set: {
            hiddenGuildIdsJson: values.hiddenGuildIdsJson,
            defaultGuildId: values.defaultGuildId,
            emailNotifications: values.emailNotifications,
            pushNotifications: values.pushNotifications,
            theme: values.theme,
            language: values.language,
            updatedAtMs: values.updatedAtMs,
          },
        })
        .run();
    },
  };

  userPreferencesStoreCache.set(database, store);
  return store;
}

function rowToPreferences(row: typeof userPreferences.$inferSelect): UserPreferences {
  return {
    hiddenGuildIds: parseHiddenGuildIds(row.hiddenGuildIdsJson),
    defaultGuildId: row.defaultGuildId ?? null,
    emailNotifications: row.emailNotifications === 1,
    pushNotifications: row.pushNotifications === 1,
    theme: row.theme as UserPreferences["theme"],
    language: row.language as UserPreferences["language"],
  };
}

function preferencesToRow(
  userId: string,
  preferences: UserPreferences,
): typeof userPreferences.$inferInsert {
  return {
    userId,
    hiddenGuildIdsJson: JSON.stringify(preferences.hiddenGuildIds),
    defaultGuildId: preferences.defaultGuildId,
    emailNotifications: preferences.emailNotifications ? 1 : 0,
    pushNotifications: preferences.pushNotifications ? 1 : 0,
    theme: preferences.theme,
    language: preferences.language,
    updatedAtMs: Date.now(),
  };
}

function parseHiddenGuildIds(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}
