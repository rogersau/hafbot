import type {
  SteamBanLookupCacheEntry,
  SteamBanLookupStore,
} from "../../services/steam-ban-lookup-service";
import type { PostgresDatabaseCapability } from "./postgres-capability";

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

interface SteamBanLookupRow extends Record<string, unknown> {
  entry_json: unknown;
}

export function createPostgresSteamBanLookupStore(
  database: PostgresDatabaseCapability,
  options: { ttlSeconds?: number; now?: () => Date } = {},
): SteamBanLookupStore {
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1) {
    throw new Error("Steam ban lookup cache TTL must be a positive integer.");
  }
  const now = options.now ?? (() => new Date());
  return {
    async read(steamId64) {
      const readAt = now();
      const rows = await database.query<SteamBanLookupRow>(
        `DELETE FROM steam_ban_lookup_cache
         WHERE steam_id64 = $1 AND expires_at <= $2
         RETURNING entry_json`,
        [steamId64, readAt],
      );
      if (rows.length > 0) return null;
      const active = await database.query<SteamBanLookupRow>(
        `SELECT entry_json
         FROM steam_ban_lookup_cache
         WHERE steam_id64 = $1 AND expires_at > $2`,
        [steamId64, readAt],
      );
      return (active[0]?.entry_json as SteamBanLookupCacheEntry | undefined) ?? null;
    },

    async write(steamId64, entry) {
      const writtenAt = now();
      const expiresAt = new Date(writtenAt.getTime() + ttlSeconds * 1_000);
      await database.execute(
        `INSERT INTO steam_ban_lookup_cache (steam_id64, entry_json, expires_at, updated_at)
         VALUES ($1, $2::jsonb, $3, $4)
         ON CONFLICT (steam_id64) DO UPDATE SET
           entry_json = EXCLUDED.entry_json,
           expires_at = EXCLUDED.expires_at,
           updated_at = EXCLUDED.updated_at`,
        [steamId64, JSON.stringify(entry), expiresAt, writtenAt],
      );
    },
  };
}
