import { sql } from "drizzle-orm";
import { createD1DrizzleDatabase } from "./drizzle-db";

import type { DiscordAccountStore } from "../../../../src/runtime/contracts/discord-account-store";

const DISCORD_PROVIDER_ID = "discord";

const discordAccountStoreCache = new WeakMap<D1Database, DiscordAccountStore>();

export function createSqliteDiscordAccountStore(database: D1Database): DiscordAccountStore {
  const cached = discordAccountStoreCache.get(database);
  if (cached) {
    return cached;
  }

  const db = createD1DrizzleDatabase(database);
  const store: DiscordAccountStore = {
    async readDiscordAccessToken(userId: string): Promise<string | null> {
      const row = await db.get<{ accessToken: string | null }>(
        sql`SELECT "accessToken" FROM "Account" WHERE "userId" = ${userId} AND "providerId" = ${DISCORD_PROVIDER_ID} ORDER BY "updatedAt" DESC LIMIT 1`,
      );

      if (!row || typeof row.accessToken !== "string" || row.accessToken.trim().length === 0) {
        return null;
      }

      return row.accessToken;
    },
  };

  discordAccountStoreCache.set(database, store);
  return store;
}
