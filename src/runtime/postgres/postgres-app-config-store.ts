import { appConfig } from "../../db/postgres/app-schema";
import type { AppConfigStore } from "../contracts";
import type { PostgresDatabaseCapability } from "./postgres-capability";

export function createPostgresAppConfigStore(database: PostgresDatabaseCapability): AppConfigStore {
  return {
    async upsertAppConfig(body) {
      await database.drizzle
        .insert(appConfig)
        .values(body)
        .onConflictDoUpdate({ target: appConfig.key, set: { value: body.value } });
    },
  };
}
