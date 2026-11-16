import type { DiscordAccountStore } from "../contracts/discord-account-store";
import type { PostgresDatabaseCapability } from "./postgres-capability";

export function createPostgresDiscordAccountStore(
  database: PostgresDatabaseCapability,
): DiscordAccountStore {
  return {
    async readDiscordAccessToken(userId) {
      const [row] = await database.query<{ accessToken: string | null }>(
        `SELECT "accessToken" FROM "Account"
         WHERE "userId" = $1 AND "providerId" = 'discord'
         ORDER BY "updatedAt" DESC LIMIT 1`,
        [userId],
      );
      return typeof row?.accessToken === "string" && row.accessToken.trim()
        ? row.accessToken
        : null;
    },
  };
}
