import type { Cache } from "./discord-json-cache";
import {
  DiscordApiError,
  fetchGuildSummary,
  listCurrentUserGuilds,
  listBotGuilds,
  listGuildEmojis,
  listGuildRoles,
  listGuildTicketResources,
  type DiscordGuildSummaryResource,
  type DiscordGuildEmojiResource,
  type DiscordRoleResource,
  type GuildTicketResources,
} from "../discord";
import { loadGuildPermissionContext, type GuildPermissionContext } from "./admin-permissions";
import type { DiscordGuildDiscoveryUserGuild } from "./discord-guild-discovery";
import { createJsonCache } from "./discord-json-cache";

const ADMIN_DISCORD_CACHE_TTL_MS = 5 * 60 * 1000;
const GUILD_RESOURCE_CACHE_TTL_MS = 60 * 1000;
const BOT_GUILD_CACHE_TTL_SECONDS = 15 * 60;
const CURRENT_USER_GUILD_CACHE_TTL_SECONDS = 5 * 60;

export type BotGuild = { guildId: string; name: string; icon: string | null };

interface CacheEntry<T> {
  expiresAtMs: number;
  promise: Promise<T>;
}

const cache = new Map<string, CacheEntry<unknown>>();
const guildResourceValidationLoads = new Map<string, Promise<GuildTicketResources>>();

export function shouldRefreshAdminDiscordCache(url: URL): boolean {
  const refresh = url.searchParams.get("refresh");
  return refresh === "1" || refresh === "true";
}

export function getCachedBotGuilds(
  botToken: string,
  refresh: boolean,
  discordCache?: Cache<string>,
  allowStaleOnRateLimit = true,
): Promise<BotGuild[]> {
  const memoryKey = `bot-guilds:${botToken}`;
  const kvKey = "bot-guilds";
  return readCached(memoryKey, refresh, async () => {
    const kvCache = createJsonCache<BotGuild[]>(discordCache);
    if (!refresh) {
      const cachedGuilds = await kvCache.get(kvKey);
      if (cachedGuilds) return cachedGuilds;
    } else {
      logDiscordCache("refresh_bypass", "bot-guilds");
    }

    if (!refresh) {
      logDiscordCache("miss", "bot-guilds");
    }

    try {
      const guilds = await listBotGuilds(botToken);
      await kvCache.put(kvKey, guilds, { ttlSeconds: BOT_GUILD_CACHE_TTL_SECONDS });
      return guilds;
    } catch (error) {
      if (error instanceof DiscordApiError && error.status === 429) {
        logDiscordCache("discord_429", "bot-guilds");
        if (allowStaleOnRateLimit) {
          const cachedGuilds = await kvCache.get(kvKey);
          if (cachedGuilds) {
            logDiscordCache("stale_fallback", "bot-guilds");
            return cachedGuilds;
          }
        }
      }
      throw error;
    }
  });
}

export function getCachedCurrentUserGuilds(
  accessToken: string,
  refresh: boolean,
  cacheIdentity?: string,
  discordCache?: Cache<string>,
): Promise<DiscordGuildDiscoveryUserGuild[]> {
  return readCached(`current-user-guilds:${accessToken}`, refresh, async () => {
    const kvCache = createJsonCache<DiscordGuildDiscoveryUserGuild[]>(discordCache);
    const kvKey = cacheIdentity ? `current-user-guilds:${cacheIdentity}` : null;
    if (!refresh && kvKey) {
      const cachedGuilds = await kvCache.get(kvKey);
      if (cachedGuilds) return cachedGuilds;
    } else if (refresh) {
      logDiscordCache("refresh_bypass", "current-user-guilds");
    }

    if (!refresh) {
      logDiscordCache("miss", "current-user-guilds");
    }

    try {
      const guilds = await listCurrentUserGuilds(accessToken);
      if (kvKey) {
        await kvCache.put(kvKey, guilds, { ttlSeconds: CURRENT_USER_GUILD_CACHE_TTL_SECONDS });
      }
      return guilds;
    } catch (error) {
      if (error instanceof DiscordApiError && error.status === 429) {
        logDiscordCache("discord_429", "current-user-guilds");
      }
      throw error;
    }
  });
}

export function getCachedGuildPermissionContext(
  guildId: string,
  botUserId: string,
  botToken: string,
  refresh: boolean,
): Promise<GuildPermissionContext> {
  return readCached(`guild-permissions:${botToken}:${botUserId}:${guildId}`, refresh, () =>
    loadGuildPermissionContext(guildId, botUserId, botToken),
  );
}

export function getCachedGuildSummary(
  guildId: string,
  botToken: string,
  refresh: boolean,
): Promise<DiscordGuildSummaryResource> {
  return readCached(`guild-summary:${botToken}:${guildId}`, refresh, () =>
    fetchGuildSummary(guildId, botToken),
  );
}

export function getCachedGuildTicketResources(
  guildId: string,
  botToken: string,
  refresh: boolean,
): Promise<GuildTicketResources> {
  return readCached(
    `ticket-resources:${botToken}:${guildId}`,
    refresh,
    () => listGuildTicketResources(guildId, botToken),
    { ttlMs: GUILD_RESOURCE_CACHE_TTL_MS, cacheFailures: false },
  );
}

export function getCoalescedGuildTicketResources(
  guildId: string,
  botToken: string,
): Promise<GuildTicketResources> {
  const key = `ticket-resources:${botToken}:${guildId}`;
  const existing = guildResourceValidationLoads.get(key);
  if (existing) return existing;

  const promise = listGuildTicketResources(guildId, botToken);
  guildResourceValidationLoads.set(key, promise);
  promise.then(
    () => {
      if (guildResourceValidationLoads.get(key) === promise) {
        guildResourceValidationLoads.delete(key);
      }
    },
    () => {
      if (guildResourceValidationLoads.get(key) === promise) {
        guildResourceValidationLoads.delete(key);
      }
    },
  );
  return promise;
}

export function getCachedGuildRoles(
  guildId: string,
  botToken: string,
  refresh: boolean,
): Promise<DiscordRoleResource[]> {
  return readCached(`guild-roles:${botToken}:${guildId}`, refresh, () =>
    listGuildRoles(guildId, botToken),
  );
}

export function getCachedGuildEmojis(
  guildId: string,
  botToken: string,
  refresh: boolean,
): Promise<DiscordGuildEmojiResource[]> {
  return readCached(`guild-emojis:${botToken}:${guildId}`, refresh, () =>
    listGuildEmojis(guildId, botToken),
  );
}

function readCached<T>(
  key: string,
  refresh: boolean,
  load: () => Promise<T>,
  options: { ttlMs?: number; cacheFailures?: boolean } = {},
): Promise<T> {
  const existing = cache.get(key) as CacheEntry<T> | undefined;
  if (!refresh && existing && existing.expiresAtMs > Date.now()) {
    return existing.promise;
  }

  const entry: CacheEntry<T> = {
    expiresAtMs: Date.now() + (options.ttlMs ?? ADMIN_DISCORD_CACHE_TTL_MS),
    promise: load(),
  };
  if (options.cacheFailures === false) {
    entry.promise = entry.promise.catch((error) => {
      if (cache.get(key) === entry) cache.delete(key);
      throw error;
    });
  }
  cache.set(key, entry);
  return entry.promise;
}

function logDiscordCache(event: string, resource: string): void {
  console.info("discord_cache", { event, resource });
}
