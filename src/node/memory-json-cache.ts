import type { JsonKvCache } from "../runtime/discord-json-cache";

interface CacheEntry {
  json: string;
  sizeBytes: number;
  expiresAtMs: number | null;
}

export interface MemoryJsonCacheOptions {
  maxEntries?: number;
  maxBytes?: number;
  maxEntryBytes?: number;
  now?: () => number;
}

export function createMemoryJsonCache<T>(options: MemoryJsonCacheOptions = {}): JsonKvCache<T> {
  const maxEntries = readPositiveInteger(options.maxEntries, 1_000, "maxEntries");
  const maxBytes = readPositiveInteger(options.maxBytes, 16 * 1024 * 1024, "maxBytes");
  const maxEntryBytes = readPositiveInteger(
    options.maxEntryBytes,
    Math.min(maxBytes, 1024 * 1024),
    "maxEntryBytes",
  );
  if (maxEntryBytes > maxBytes) throw new Error("maxEntryBytes cannot exceed maxBytes.");
  const now = options.now ?? Date.now;
  const entries = new Map<string, CacheEntry>();
  let totalBytes = 0;

  const remove = (key: string): void => {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    totalBytes -= entry.sizeBytes;
  };

  const evict = (): void => {
    const currentTime = now();
    for (const [key, entry] of entries) {
      if (entry.expiresAtMs !== null && entry.expiresAtMs <= currentTime) remove(key);
    }
    while (entries.size > maxEntries || totalBytes > maxBytes) {
      const oldest = entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      remove(oldest);
    }
  };

  return {
    async get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.expiresAtMs !== null && entry.expiresAtMs <= now()) {
        remove(key);
        return null;
      }
      entries.delete(key);
      entries.set(key, entry);
      try {
        return JSON.parse(entry.json) as T;
      } catch {
        remove(key);
        return null;
      }
    },

    async put(key, value, putOptions) {
      let json: string;
      try {
        json = JSON.stringify(value);
      } catch {
        return;
      }
      if (typeof json !== "string") return;
      const sizeBytes =
        new TextEncoder().encode(key).byteLength + new TextEncoder().encode(json).byteLength;
      if (sizeBytes > maxEntryBytes) {
        remove(key);
        return;
      }
      const ttlSeconds = putOptions?.ttlSeconds;
      if (ttlSeconds !== undefined && (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1)) {
        return;
      }
      remove(key);
      entries.set(key, {
        json,
        sizeBytes,
        expiresAtMs: ttlSeconds === undefined ? null : now() + ttlSeconds * 1_000,
      });
      totalBytes += sizeBytes;
      evict();
    },

    async delete(key) {
      remove(key);
    },
  };
}

function readPositiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return result;
}
