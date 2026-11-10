import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryKvNamespace } from "../src/node/memory-kv-namespace";

test("portable memory KV supports cache reads, expiry, deletion, and bounded LRU eviction", async () => {
  let nowMs = 10_000;
  const namespace = createMemoryKvNamespace({
    maxEntries: 2,
    maxBytes: 1_000,
    maxEntryBytes: 500,
    now: () => nowMs,
  });

  await namespace.put("first", JSON.stringify({ value: 1 }), { expirationTtl: 2 });
  assert.equal(await namespace.get("first"), '{"value":1}');
  assert.deepEqual(await namespace.get("first", "json"), { value: 1 });
  assert.equal(
    new TextDecoder().decode((await namespace.get("first", "arrayBuffer")) ?? undefined),
    '{"value":1}',
  );
  const stream = await namespace.get("first", "stream");
  assert.equal(stream ? await new Response(stream).text() : null, '{"value":1}');

  await namespace.put("second", "two");
  await namespace.get("first");
  await namespace.put("third", "three");
  assert.equal(await namespace.get("second"), null, "least-recently-used entry is evicted");
  assert.equal(await namespace.get("third"), "three");

  nowMs = 12_001;
  assert.equal(await namespace.get("first"), null, "expired entries are removed on read");
  await namespace.delete("third");
  assert.equal(await namespace.get("third"), null);

  await namespace.put("already-expired", "ignored", { expiration: 12 });
  assert.equal(await namespace.get("already-expired"), null);
  await assert.rejects(
    namespace.put("binary", new Uint8Array([1, 2, 3])),
    /accepts string values only/,
  );
});
