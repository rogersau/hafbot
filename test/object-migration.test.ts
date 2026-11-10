import assert from "node:assert/strict";
import test from "node:test";

import {
  inventoryObjectStore,
  syncObjectManifest,
  validateManifest,
  verifyObjectManifest,
  type ObjectSyncCheckpoint,
} from "../src/node/object-migration";
import { InMemoryObjectStore } from "./support/in-memory-object-store";

const MANAGED_MEDIA_FILENAME = "11111111-1111-4111-8111-111111111111.png";

test("object migration inventories, resumes, copies, and independently verifies bytes and metadata", async () => {
  const source = new InMemoryObjectStore();
  await source.put("guild/a.txt", "alpha", {
    contentType: "text/plain",
    metadata: { visibility: "private", empty: "" },
  });
  await source.put("guild/nested/b.bin", new Uint8Array([1, 2, 3]), {
    contentType: "application/octet-stream",
    metadata: { contentClass: "evidence-vault" },
  });
  const manifest = await inventoryObjectStore({
    store: source,
    source: { provider: "memory", identity: "source/test" },
    checksum: true,
    pageSize: 1,
    maxObjects: 10,
  });
  assert.equal(manifest.objectCount, 2);
  assert.equal(manifest.totalBytes, 8);
  assert.doesNotThrow(() => validateManifest(manifest, true));

  const destination = new InMemoryObjectStore();
  const checkpoints: ObjectSyncCheckpoint[] = [];
  const checkpoint = await syncObjectManifest({
    source,
    destination,
    destinationIdentity: "destination/test",
    manifest,
    writeCheckpoint: async (next) => {
      checkpoints.push(structuredClone(next));
    },
  });
  assert.equal(checkpoint.nextIndex, 2);
  assert.deepEqual(
    checkpoints.map(({ nextIndex }) => nextIndex),
    [1, 2],
  );
  assert.deepEqual((await destination.head("guild/a.txt"))?.metadata, {
    empty: "",
    visibility: "private",
  });
  assert.equal(
    (
      await verifyObjectManifest({
        destination,
        destinationIdentity: "destination/test",
        manifest,
        pageSize: 1,
      })
    ).status,
    "pass",
  );

  const resumed = await syncObjectManifest({
    source,
    destination,
    destinationIdentity: "destination/test",
    manifest,
    checkpoint,
  });
  assert.deepEqual(resumed, checkpoint);

  await destination.put("guild/a.txt", "wrong", {
    contentType: "text/plain",
    metadata: { visibility: "private", empty: "" },
  });
  const failed = await verifyObjectManifest({
    destination,
    destinationIdentity: "destination/test",
    manifest,
  });
  assert.equal(failed.status, "fail");
  assert.deepEqual(failed.differences, [{ key: "guild/a.txt", reason: "checksum_mismatch" }]);
});

test("object migration safety caps and manifest integrity fail closed", async () => {
  const source = new InMemoryObjectStore();
  await source.put("a", "a");
  await source.put("b", "b");
  await assert.rejects(
    inventoryObjectStore({
      store: source,
      source: { provider: "memory", identity: "source/test" },
      maxObjects: 1,
    }),
    /safety cap/,
  );
  const manifest = await inventoryObjectStore({
    store: source,
    source: { provider: "memory", identity: "source/test" },
    checksum: true,
  });
  manifest.entries[0]!.sizeBytes += 1;
  assert.throws(() => validateManifest(manifest, true), /entries checksum/);
});

test("object migration refuses source metadata changes after inventory", async () => {
  const source = new InMemoryObjectStore();
  await source.put("guild/a.txt", "stable-body", {
    contentType: "text/plain",
    metadata: { visibility: "private" },
  });
  const manifest = await inventoryObjectStore({
    store: source,
    source: { provider: "memory", identity: "source/metadata-fence" },
    checksum: true,
  });
  await source.put("guild/a.txt", "stable-body", {
    contentType: "text/plain",
    metadata: { visibility: "public" },
  });

  await assert.rejects(
    syncObjectManifest({
      source,
      destination: new InMemoryObjectStore(),
      destinationIdentity: "destination/metadata-fence",
      manifest,
    }),
    /Source object metadata changed during sync/,
  );
});

test("object migration refuses to overwrite a non-matching destination", async () => {
  const source = new InMemoryObjectStore();
  await source.put("guild/a.txt", "source", { contentType: "text/plain" });
  const manifest = await inventoryObjectStore({
    store: source,
    source: { provider: "memory", identity: "source/non-empty-target" },
    checksum: true,
  });
  const destination = new InMemoryObjectStore();
  await destination.put("guild/a.txt", "existing-customer-data", { contentType: "text/plain" });

  await assert.rejects(
    syncObjectManifest({
      source,
      destination,
      destinationIdentity: "destination/non-empty-target",
      manifest,
    }),
    /not a verified manifest prefix/,
  );
  assert.equal(
    await new Response((await destination.get("guild/a.txt"))!.body).text(),
    "existing-customer-data",
  );
});

test("object migration recovers a verified upload that preceded its checkpoint", async () => {
  const source = new InMemoryObjectStore();
  await source.put("a.txt", "alpha", {
    contentType: "text/plain",
    metadata: { visibility: "private" },
  });
  await source.put("b.txt", "bravo", { contentType: "text/plain" });
  const manifest = await inventoryObjectStore({
    store: source,
    source: { provider: "memory", identity: "source/checkpoint-gap" },
    checksum: true,
  });
  const destination = new InMemoryObjectStore();
  const first = manifest.entries[0]!;
  await destination.put(first.key, "alpha", {
    sizeBytes: first.sizeBytes,
    contentType: first.contentType,
    metadata: first.metadata,
  });
  const checkpoints: ObjectSyncCheckpoint[] = [];

  const checkpoint = await syncObjectManifest({
    source,
    destination,
    destinationIdentity: "destination/checkpoint-gap",
    manifest,
    writeCheckpoint: async (next) => {
      checkpoints.push(structuredClone(next));
    },
  });

  assert.equal(checkpoint.nextIndex, 2);
  assert.deepEqual(
    checkpoints.map((entry) => entry.nextIndex),
    [1, 2],
  );
  assert.equal(
    (
      await verifyObjectManifest({
        destination,
        destinationIdentity: "destination/checkpoint-gap",
        manifest,
      })
    ).status,
    "pass",
  );
});

test("object migration uses deterministic manifest key and metadata ordering", async () => {
  const source = new InMemoryObjectStore();
  await source.put("a", "a", { metadata: { z: "1", A: "2", _: "3" } });
  await source.put("B", "b");
  await source.put("_", "underscore");
  await source.put("é", "unicode");

  const manifest = await inventoryObjectStore({
    store: source,
    source: { provider: "memory", identity: "source/deterministic-order" },
    checksum: true,
  });

  assert.deepEqual(
    manifest.entries.map((entry) => entry.key),
    ["B", "_", "a", "é"],
  );
  assert.deepEqual(Object.keys(manifest.entries.find((entry) => entry.key === "a")!.metadata), [
    "A",
    "_",
    "z",
  ]);
  assert.doesNotThrow(() => validateManifest(manifest, true));
});

test("object migration preserves only legacy public managed media with explicit metadata", async () => {
  const source = new InMemoryObjectStore();
  const legacyKey = `guild-1/managed-media/${MANAGED_MEDIA_FILENAME}`;
  const currentKey = `guild-2/managed-media/${MANAGED_MEDIA_FILENAME}`;
  const partialMetadataKey = `guild-3/managed-media/${MANAGED_MEDIA_FILENAME}`;
  const unrelatedKey = "guild-1/evidence/11111111-1111-4111-8111-111111111111.png";

  await source.put(legacyKey, "legacy");
  await source.put(currentKey, "current");
  await source.put(partialMetadataKey, "partial", { metadata: { visibility: "public" } });
  await source.put(unrelatedKey, "private");
  source.objects.get(legacyKey)!.uploadedAt = new Date("2026-08-14T23:59:59.999Z");
  source.objects.get(currentKey)!.uploadedAt = new Date("2026-08-15T00:00:00.000Z");
  source.objects.get(partialMetadataKey)!.uploadedAt = new Date("2026-08-14T23:59:59.999Z");
  source.objects.get(unrelatedKey)!.uploadedAt = new Date("2026-08-14T23:59:59.999Z");

  const manifest = await inventoryObjectStore({
    store: source,
    source: { provider: "memory", identity: "source/legacy-media" },
    checksum: true,
  });
  const entries = new Map(manifest.entries.map((entry) => [entry.key, entry]));
  assert.deepEqual(entries.get(legacyKey)?.metadata, {
    contentClass: "managed-message-media",
    visibility: "public",
  });
  assert.deepEqual(entries.get(currentKey)?.metadata, {});
  assert.deepEqual(entries.get(partialMetadataKey)?.metadata, { visibility: "public" });
  assert.deepEqual(entries.get(unrelatedKey)?.metadata, {});

  const destination = new InMemoryObjectStore();
  await syncObjectManifest({
    source,
    destination,
    destinationIdentity: "destination/legacy-media",
    manifest,
  });
  assert.deepEqual((await destination.head(legacyKey))?.metadata, {
    contentClass: "managed-message-media",
    visibility: "public",
  });
  assert.equal(
    (
      await verifyObjectManifest({
        destination,
        destinationIdentity: "destination/legacy-media",
        manifest,
      })
    ).status,
    "pass",
  );
});
