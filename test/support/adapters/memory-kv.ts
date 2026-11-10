interface StoredValue {
  value: string;
  expiration?: number;
}

/** In-memory KV adapter with TTL semantics for integration tests. */
export class MemoryKv {
  #values = new Map<string, StoredValue>();

  async get(key: string, type?: "text" | "json" | "arrayBuffer" | "stream"): Promise<unknown> {
    const value = this.#read(key)?.value ?? null;
    if (value === null || type === undefined || type === "text") return value;
    if (type === "json") return JSON.parse(value);
    if (type === "arrayBuffer") return new TextEncoder().encode(value).buffer;
    return new Response(value).body;
  }

  async put(
    key: string,
    value: string,
    options?: { expiration?: number; expirationTtl?: number },
  ): Promise<void> {
    const expiration =
      options?.expiration ??
      (options?.expirationTtl ? Math.floor(Date.now() / 1000) + options.expirationTtl : undefined);
    this.#values.set(key, { value, expiration });
  }

  async delete(key: string): Promise<void> {
    this.#values.delete(key);
  }

  async list(options: { prefix?: string; limit?: number; cursor?: string } = {}) {
    const keys = [...this.#values.keys()]
      .filter((key) => !options.prefix || key.startsWith(options.prefix))
      .filter((key) => this.#read(key))
      .sort();
    const start = options.cursor ? Number(options.cursor) : 0;
    const selected = keys.slice(start, options.limit ? start + options.limit : undefined);
    const next = start + selected.length;
    return {
      keys: selected.map((name) => ({ name })),
      list_complete: next >= keys.length,
      cursor: next >= keys.length ? undefined : String(next),
    };
  }

  asBinding(): KVNamespace {
    return this as unknown as KVNamespace;
  }

  #read(key: string): StoredValue | undefined {
    const stored = this.#values.get(key);
    if (stored?.expiration && stored.expiration <= Math.floor(Date.now() / 1000)) {
      this.#values.delete(key);
      return undefined;
    }
    return stored;
  }
}
