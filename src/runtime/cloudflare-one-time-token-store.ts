import { oneTimeTokens } from "../db/app-schema";
import { lt } from "drizzle-orm";
import type { OneTimeTokenStore } from "./contracts/one-time-token-store";
import { createD1DrizzleDatabase } from "./drizzle-db";

const cache = new WeakMap<D1Database, OneTimeTokenStore>();

export function createCloudflareOneTimeTokenStore(database: D1Database): OneTimeTokenStore {
  const cached = cache.get(database);
  if (cached) return cached;

  const db = createD1DrizzleDatabase(database);
  const store: OneTimeTokenStore = {
    async consume(input) {
      if (input.expiresAtMs <= input.consumedAtMs) return false;
      await db.delete(oneTimeTokens).where(lt(oneTimeTokens.expiresAtMs, input.consumedAtMs)).run();
      const result = await db.insert(oneTimeTokens).values(input).onConflictDoNothing().run();
      return (result.meta.changes ?? 0) === 1;
    },
  };
  cache.set(database, store);
  return store;
}
