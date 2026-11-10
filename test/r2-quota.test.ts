/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import {
  getKnownR2BodyBytes,
  putManagedGuildR2Object,
  resolveR2BodyBytes,
} from "../src/runtime/r2-quota";
import type { GuildR2QuotaStore } from "../src/runtime/contracts";
import {
  createProductionRuntimeStores,
  withStoreOverrides,
} from "./support/production-runtime-stores";

test("managed R2 writes persist the uploaded object size and release the reservation", async () => {
  const fixture = createProductionRuntimeStores();
  const quotaStore = fixture.stores.guildR2Objects as GuildR2QuotaStore;
  const bucket = createBucket(3);

  await putManagedGuildR2Object({
    key: "guild-1/channel-1.html",
    body: "abc",
    bucket,
    guildEntitlements: fixture.stores.guildEntitlements,
    guildR2Objects: quotaStore,
    operationKey: "upload-1",
    now: () => 1_000,
  });

  assert.deepEqual(await quotaStore.getGuildUsage("guild-1"), {
    usedBytes: 3,
    reservedBytes: 0,
    lastReconciledAtMs: null,
  });
  assert.deepEqual(bucket.putKeys, ["guild-1/channel-1.html"]);
});

test("managed R2 writes reject quota exhaustion before upload", async () => {
  const fixture = createProductionRuntimeStores();
  const quotaStore = fixture.stores.guildR2Objects as GuildR2QuotaStore;
  await quotaStore.upsertObject({
    guildId: "guild-1",
    key: "guild-1/existing.bin",
    sizeBytes: 100 * 1024 * 1024,
    createdAtMs: 1,
  });
  const bucket = createBucket(3);

  await assert.rejects(
    putManagedGuildR2Object({
      key: "guild-1/channel-1.html",
      body: "abc",
      bucket,
      guildEntitlements: fixture.stores.guildEntitlements,
      guildR2Objects: quotaStore,
      operationKey: "upload-1",
      now: () => 1_000,
    }),
    /R2 storage quota exceeded/,
  );
  assert.deepEqual(bucket.putKeys, []);
});

test("stream uploads require a trusted declared size without consuming the stream", async () => {
  const fixture = createProductionRuntimeStores();
  const quotaStore = fixture.stores.guildR2Objects as GuildR2QuotaStore;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
      controller.close();
    },
  });
  await assert.rejects(
    putManagedGuildR2Object({
      key: "guild-1/proof.bin",
      body,
      bucket: createBucket(1),
      guildEntitlements: fixture.stores.guildEntitlements,
      guildR2Objects: quotaStore,
    }),
    /trusted declared size/,
  );
  assert.equal(body.locked, false);
});

test("failed uploads release their production reservation", async () => {
  const fixture = createProductionRuntimeStores();
  const quotaStore = fixture.stores.guildR2Objects as GuildR2QuotaStore;
  const bucket = createBucket(3, new Error("R2 unavailable"));

  await assert.rejects(
    putManagedGuildR2Object({
      key: "guild-1/proof.bin",
      body: "abc",
      bucket,
      guildEntitlements: fixture.stores.guildEntitlements,
      guildR2Objects: quotaStore,
      operationKey: "upload-1",
      now: () => 1_000,
    }),
    /R2 unavailable/,
  );
  assert.deepEqual(await quotaStore.getGuildUsage("guild-1"), {
    usedBytes: 0,
    reservedBytes: 0,
    lastReconciledAtMs: null,
  });
});

test("size mismatch retains the upload reservation for reconciliation", async () => {
  const fixture = createProductionRuntimeStores();
  const quotaStore = fixture.stores.guildR2Objects as GuildR2QuotaStore;
  await assert.rejects(
    putManagedGuildR2Object({
      key: "guild-1/proof.bin",
      body: "abc",
      bucket: createBucket(2),
      guildEntitlements: fixture.stores.guildEntitlements,
      guildR2Objects: quotaStore,
      operationKey: "upload-1",
      now: () => 1_000,
    }),
    /size mismatch/,
  );
  assert.deepEqual(await quotaStore.getGuildUsage("guild-1"), {
    usedBytes: 0,
    reservedBytes: 3,
    lastReconciledAtMs: null,
  });
});

test("commit failures retain the uploaded object and reservation for reconciliation", async () => {
  const fixture = createProductionRuntimeStores();
  const quotaStore = fixture.stores.guildR2Objects as GuildR2QuotaStore;
  const store = withStoreOverrides<GuildR2QuotaStore>(quotaStore, {
    async commitObject() {
      throw new Error("D1 unavailable");
    },
  });

  await assert.rejects(
    putManagedGuildR2Object({
      key: "guild-1/proof.bin",
      body: "abc",
      bucket: createBucket(3),
      guildEntitlements: fixture.stores.guildEntitlements,
      guildR2Objects: store,
      operationKey: "upload-1",
      now: () => 1_000,
    }),
    /D1 unavailable/,
  );
  assert.deepEqual(await quotaStore.getGuildUsage("guild-1"), {
    usedBytes: 0,
    reservedBytes: 3,
    lastReconciledAtMs: null,
  });
});

test("getKnownR2BodyBytes counts known bodies and declared stream sizes", () => {
  assert.equal(getKnownR2BodyBytes("é"), 2);
  assert.equal(getKnownR2BodyBytes(new Uint8Array([1, 2, 3]).buffer), 3);
  assert.equal(resolveR2BodyBytes(new ReadableStream<Uint8Array>(), 12), 12);
  assert.throws(() => resolveR2BodyBytes("abc", 2), /declared size mismatch/);
});

function createBucket(size: number, putError?: Error): R2Bucket & { putKeys: string[] } {
  const putKeys: string[] = [];
  return {
    putKeys,
    async put(key: string) {
      putKeys.push(key);
      if (putError) throw putError;
      return { key, size } as R2Object;
    },
    async delete() {},
    async head() {
      return null;
    },
  } as unknown as R2Bucket & { putKeys: string[] };
}
