import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryJsonCache } from "../src/node/memory-json-cache";

test("process cache supports cache reads, expiry, deletion, and bounded LRU eviction", async () => {
  let nowMs = 10_000;
  const namespace = createMemoryJsonCache<string>({
    maxEntries: 2,
    maxBytes: 1_000,
    maxEntryBytes: 500,
    now: () => nowMs,
  });

  await namespace.put("first", JSON.stringify({ value: 1 }), { ttlSeconds: 2 });
  assert.equal(await namespace.get("first"), '{"value":1}');

  await namespace.put("second", "two");
  await namespace.get("first");
  await namespace.put("third", "three");
  assert.equal(await namespace.get("second"), null, "least-recently-used entry is evicted");
  assert.equal(await namespace.get("third"), "three");

  nowMs = 12_001;
  assert.equal(await namespace.get("first"), null, "expired entries are removed on read");
  await namespace.delete("third");
  assert.equal(await namespace.get("third"), null);

  await namespace.put("invalid-ttl", "ignored", { ttlSeconds: 0 });
  assert.equal(await namespace.get("invalid-ttl"), null);
});
