export interface Cache<T> {
  get(key: string): Promise<T | null>;
  put(key: string, value: T, options?: { ttlSeconds?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export function createJsonCache<T>(kv?: Cache<string>): Cache<T> {
  return {
    async get(key: string): Promise<T | null> {
      if (!kv) return null;

      let cached: string | null;
      try {
        cached = await kv.get(key);
      } catch {
        return null;
      }
      if (cached === null) return null;

      try {
        return JSON.parse(cached) as T;
      } catch {
        return null;
      }
    },
    async put(key: string, value: T, options?: { ttlSeconds?: number }): Promise<void> {
      if (!kv) return;

      try {
        await kv.put(
          key,
          JSON.stringify(value),
          options?.ttlSeconds ? { ttlSeconds: options.ttlSeconds } : undefined,
        );
      } catch {}
    },
    async delete(key: string): Promise<void> {
      if (!kv) return;

      try {
        await kv.delete(key);
      } catch {}
    },
  };
}
