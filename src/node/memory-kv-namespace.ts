import { createMemoryJsonCache } from "./memory-json-cache";

/** Bounded process-local KV for caches only. Authoritative state uses PostgreSQL stores. */
export function createMemoryKvNamespace(options?: {
  maxEntries?: number;
  maxBytes?: number;
  maxEntryBytes?: number;
  now?: () => number;
}): KVNamespace {
  const cache = createMemoryJsonCache<string>(options);
  const now = options?.now ?? Date.now;
  const namespace = {
    async get(key: string, typeOrOptions?: string | { type?: string }) {
      const value = await cache.get(key);
      if (value === null) return null;
      const type = typeof typeOrOptions === "string" ? typeOrOptions : typeOrOptions?.type;
      if (type === "json") {
        try {
          return JSON.parse(value) as unknown;
        } catch {
          return null;
        }
      }
      if (type === "arrayBuffer") return new TextEncoder().encode(value).buffer;
      if (type === "stream") {
        const bytes = new TextEncoder().encode(value);
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        });
      }
      return value;
    },

    async put(
      key: string,
      value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
      putOptions?: KVNamespacePutOptions,
    ) {
      if (typeof value !== "string") {
        throw new Error("The portable cache KV accepts string values only.");
      }
      const nowSeconds = Math.floor(now() / 1_000);
      const ttlFromExpiration =
        putOptions?.expiration === undefined ? undefined : putOptions.expiration - nowSeconds;
      const ttlSeconds = putOptions?.expirationTtl ?? ttlFromExpiration;
      if (ttlSeconds !== undefined && ttlSeconds < 1) {
        await cache.delete(key);
        return;
      }
      await cache.put(key, value, { ttlSeconds });
    },

    delete(key: string) {
      return cache.delete(key);
    },
  };
  return namespace as unknown as KVNamespace;
}
