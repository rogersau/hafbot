import { oneTimeTokens } from "../../db/postgres/app-schema";
import { lt } from "drizzle-orm";
import type { OneTimeTokenStore } from "../contracts/one-time-token-store";
import type { PostgresDatabaseCapability } from "./postgres-capability";

export function createPostgresOneTimeTokenStore(
  database: PostgresDatabaseCapability,
): OneTimeTokenStore {
  const db = database.drizzle;
  const store: OneTimeTokenStore = {
    async consume(input) {
      if (input.expiresAtMs <= input.consumedAtMs) return false;
      await db
        .delete(oneTimeTokens)
        .where(lt(oneTimeTokens.expiresAtMs, input.consumedAtMs))
        .execute();
      const result = await db.insert(oneTimeTokens).values(input).onConflictDoNothing().execute();
      return (result.rowCount ?? 0) === 1;
    },
  };
  return store;
}
