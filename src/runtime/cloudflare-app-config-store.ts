import { appConfig } from "../db/app-schema";
import type { AppConfigMutation } from "./admin-types";
import type { AppConfigStore } from "./contracts";
import { createD1DrizzleDatabase } from "./drizzle-db";

type AppConfigInsert = typeof appConfig.$inferInsert;

const appConfigStoreCache = new WeakMap<D1Database, AppConfigStore>();

export function createCloudflareAppConfigStore(database: D1Database): AppConfigStore {
  const cached = appConfigStoreCache.get(database);
  if (cached) {
    return cached;
  }

  const db = createD1DrizzleDatabase(database);
  const store: AppConfigStore = {
    async upsertAppConfig(body: AppConfigMutation): Promise<void> {
      const values = mutationToRow(body);
      await db
        .insert(appConfig)
        .values(values)
        .onConflictDoUpdate({
          target: appConfig.key,
          set: { value: values.value },
        })
        .run();
    },
  };

  appConfigStoreCache.set(database, store);
  return store;
}

function mutationToRow(body: AppConfigMutation): AppConfigInsert {
  return { key: body.key, value: body.value };
}
