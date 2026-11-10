import type {
  SteamBanLookupCacheEntry,
  SteamBanLookupStore,
} from "../services/steam-ban-lookup-service";

const KEY_PREFIX = "steam_ban:";
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

export function createCloudflareSteamBanLookupStore(
  kv: KVNamespace,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): SteamBanLookupStore {
  return {
    async read(steamId64) {
      return await kv.get<SteamBanLookupCacheEntry>(`${KEY_PREFIX}${steamId64}`, "json");
    },
    async write(steamId64, entry) {
      await kv.put(`${KEY_PREFIX}${steamId64}`, JSON.stringify(entry), {
        expirationTtl: ttlSeconds,
      });
    },
  };
}
