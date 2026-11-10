/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import { createJsonKvCache } from "../src/runtime/discord-json-cache";

test("JSON KV cache returns null on miss and cached values after put", async () => {
  const kv = createMemoryKv();
  const cache = createJsonKvCache<{ guildId: string; name: string }>(kv);

  assert.equal(await cache.get("guild:guild-1"), null);

  await cache.put("guild:guild-1", { guildId: "guild-1", name: "Guild One" });

  assert.deepEqual(await cache.get("guild:guild-1"), {
    guildId: "guild-1",
    name: "Guild One",
  });
});

test("JSON KV cache passes TTL to KV put as expirationTtl", async () => {
  const puts: Array<{ key: string; value: string; options?: { expirationTtl?: number } }> = [];
  const kv = {
    async put(key: string, value: string, options?: { expirationTtl?: number }) {
      puts.push({ key, value, options });
    },
  } as unknown as KVNamespace;
  const cache = createJsonKvCache<{ value: string }>(kv);

  await cache.put("key", { value: "cached" }, { ttlSeconds: 300 });

  assert.deepEqual(puts, [
    {
      key: "key",
      value: JSON.stringify({ value: "cached" }),
      options: { expirationTtl: 300 },
    },
  ]);
});

test("JSON KV cache treats unavailable and throwing KV as no-op misses", async () => {
  const unavailableCache = createJsonKvCache<{ value: string }>();
  await unavailableCache.put("key", { value: "cached" });
  await unavailableCache.delete("key");
  assert.equal(await unavailableCache.get("key"), null);

  const throwingKv = {
    async get() {
      throw new Error("KV get failed");
    },
    async put() {
      throw new Error("KV put failed");
    },
    async delete() {
      throw new Error("KV delete failed");
    },
  } as unknown as KVNamespace;
  const throwingCache = createJsonKvCache<{ value: string }>(throwingKv);

  await throwingCache.put("key", { value: "cached" });
  await throwingCache.delete("key");
  assert.equal(await throwingCache.get("key"), null);
});

test("JSON KV cache treats invalid JSON as a cache miss", async () => {
  const kv = {
    async get() {
      return "{";
    },
  } as unknown as KVNamespace;
  const cache = createJsonKvCache<{ value: string }>(kv);

  assert.equal(await cache.get("key"), null);
});

function createMemoryKv(): KVNamespace {
  const values = new Map<string, string>();
  return {
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async put(key: string, value: string) {
      values.set(key, value);
    },
  } as unknown as KVNamespace;
}
