/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createCloudflareGuildR2ObjectStore } from "../src/runtime/cloudflare-guild-r2-object-store";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("createCloudflareGuildR2ObjectStore tracks usage per guild", async () => {
  const database = new SqliteD1Database();
  const firstStore = createCloudflareGuildR2ObjectStore(database as unknown as D1Database);
  const secondStore = createCloudflareGuildR2ObjectStore(database as unknown as D1Database);

  assert.strictEqual(firstStore, secondStore);
  assert.equal(await firstStore.getGuildUsageBytes("guild-1"), 0);

  await firstStore.upsertObject({
    guildId: "guild-1",
    key: "transcripts/a.html",
    sizeBytes: 100,
    createdAtMs: 1000,
  });
  await firstStore.upsertObject({
    guildId: "guild-1",
    key: "attachments/b.png",
    sizeBytes: 250,
    createdAtMs: 1001,
  });
  await firstStore.upsertObject({
    guildId: "guild-2",
    key: "transcripts/c.html",
    sizeBytes: 1000,
    createdAtMs: 1002,
  });

  assert.equal(await firstStore.getGuildUsageBytes("guild-1"), 350);

  await firstStore.upsertObject({
    guildId: "guild-1",
    key: "transcripts/a.html",
    sizeBytes: 175,
    createdAtMs: 2000,
  });

  assert.equal(await firstStore.getGuildUsageBytes("guild-1"), 425);

  await firstStore.deleteObject({ guildId: "guild-1", key: "attachments/b.png" });
  await firstStore.deleteObject({ guildId: "guild-1", key: "attachments/b.png" });

  assert.equal(await firstStore.getGuildUsageBytes("guild-1"), 175);
  assert.equal(await firstStore.getGuildUsageBytes("guild-2"), 1000);
  assert.equal(database.execCalls, 0);
});

test("Guild R2 notification timestamps fence stale creates and deletes", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareGuildR2ObjectStore(database as unknown as D1Database);
  await store.upsertObject({
    guildId: "guild-1",
    key: "guild-1/object.bin",
    sizeBytes: 100,
    createdAtMs: 2_000,
  });

  await store.upsertObject({
    guildId: "guild-1",
    key: "guild-1/object.bin",
    sizeBytes: 10,
    createdAtMs: 1_000,
  });
  await store.deleteObject({
    guildId: "guild-1",
    key: "guild-1/object.bin",
    deletedAtMs: 1_500,
  });
  assert.equal(await store.getGuildUsageBytes("guild-1"), 100);

  await store.deleteObject({
    guildId: "guild-1",
    key: "guild-1/object.bin",
    deletedAtMs: 3_000,
  });
  await store.upsertObject({
    guildId: "guild-1",
    key: "guild-1/object.bin",
    sizeBytes: 50,
    createdAtMs: 2_500,
  });
  assert.equal(await store.getGuildUsageBytes("guild-1"), 0);

  await store.upsertObject({
    guildId: "guild-1",
    key: "guild-1/object.bin",
    sizeBytes: 75,
    createdAtMs: 3_500,
  });
  assert.equal(await store.getGuildUsageBytes("guild-1"), 75);
});

test("Guild R2 reservations atomically reject concurrent writes beyond the limit", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareGuildR2ObjectStore(database as unknown as D1Database);

  const results = await Promise.all([
    store.reserveObject({
      guildId: "guild-1",
      key: "guild-1/a.bin",
      operationKey: "upload-a",
      reservedBytes: 60,
      limitBytes: 100,
      expiresAtMs: 2_000,
      nowMs: 1_000,
    }),
    store.reserveObject({
      guildId: "guild-1",
      key: "guild-1/b.bin",
      operationKey: "upload-b",
      reservedBytes: 60,
      limitBytes: 100,
      expiresAtMs: 2_000,
      nowMs: 1_000,
    }),
  ]);

  assert.deepEqual(results.map((result) => result.status).sort(), ["quota-exceeded", "reserved"]);
  assert.deepEqual(await store.getGuildUsage("guild-1"), {
    usedBytes: 0,
    reservedBytes: 60,
    lastReconciledAtMs: null,
  });
});

test("Guild R2 replacement reservations account for only the net size change", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareGuildR2ObjectStore(database as unknown as D1Database);
  await store.upsertObject({
    guildId: "guild-1",
    key: "guild-1/existing.bin",
    sizeBytes: 80,
    createdAtMs: 500,
  });

  assert.deepEqual(
    await store.reserveObject({
      guildId: "guild-1",
      key: "guild-1/existing.bin",
      operationKey: "replace",
      reservedBytes: 90,
      limitBytes: 100,
      expiresAtMs: 2_000,
      nowMs: 1_000,
    }),
    { status: "reserved", previousCommittedBytes: 80 },
  );
  assert.equal(
    (
      await store.reserveObject({
        guildId: "guild-1",
        key: "guild-1/other.bin",
        operationKey: "other",
        reservedBytes: 11,
        limitBytes: 100,
        expiresAtMs: 2_000,
        nowMs: 1_000,
      })
    ).status,
    "quota-exceeded",
  );

  assert.equal(
    await store.commitObject({
      guildId: "guild-1",
      key: "guild-1/existing.bin",
      operationKey: "replace",
      actualBytes: 90,
      committedAtMs: 1_100,
    }),
    true,
  );
  assert.equal(await store.getGuildUsageBytes("guild-1"), 90);
});

test("Guild R2 shrinking replacements do not free capacity until commit", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareGuildR2ObjectStore(database as unknown as D1Database);
  await store.upsertObject({
    guildId: "guild-1",
    key: "guild-1/existing.bin",
    sizeBytes: 100,
    createdAtMs: 500,
  });
  await store.reserveObject({
    guildId: "guild-1",
    key: "guild-1/existing.bin",
    operationKey: "shrink",
    reservedBytes: 50,
    limitBytes: 100,
    expiresAtMs: 2_000,
    nowMs: 1_000,
  });

  const concurrent = await store.reserveObject({
    guildId: "guild-1",
    key: "guild-1/other.bin",
    operationKey: "other",
    reservedBytes: 1,
    limitBytes: 100,
    expiresAtMs: 2_000,
    nowMs: 1_000,
  });
  assert.equal(concurrent.status, "quota-exceeded");
  await store.releaseReservation({
    guildId: "guild-1",
    key: "guild-1/existing.bin",
    operationKey: "shrink",
  });
  assert.deepEqual(await store.getGuildUsage("guild-1"), {
    usedBytes: 100,
    reservedBytes: 0,
    lastReconciledAtMs: null,
  });
});

test("Guild R2 allows non-increasing replacements to recover after a downgrade", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareGuildR2ObjectStore(database as unknown as D1Database);
  await store.upsertObject({
    guildId: "guild-1",
    key: "guild-1/existing.bin",
    sizeBytes: 150,
    createdAtMs: 500,
  });

  const reservation = await store.reserveObject({
    guildId: "guild-1",
    key: "guild-1/existing.bin",
    operationKey: "recover-after-downgrade",
    reservedBytes: 100,
    limitBytes: 100,
    expiresAtMs: 2_000,
    nowMs: 1_000,
  });
  assert.equal(reservation.status, "reserved");
  assert.equal(
    await store.commitObject({
      guildId: "guild-1",
      key: "guild-1/existing.bin",
      operationKey: "recover-after-downgrade",
      actualBytes: 100,
      committedAtMs: 1_100,
    }),
    true,
  );
  assert.equal(await store.getGuildUsageBytes("guild-1"), 100);
});

test("Guild R2 failed and expired reservations restore prior committed usage", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareGuildR2ObjectStore(database as unknown as D1Database);
  await store.upsertObject({
    guildId: "guild-1",
    key: "guild-1/existing.bin",
    sizeBytes: 80,
    createdAtMs: 500,
  });
  await store.reserveObject({
    guildId: "guild-1",
    key: "guild-1/existing.bin",
    operationKey: "replace",
    reservedBytes: 90,
    limitBytes: 100,
    expiresAtMs: 2_000,
    nowMs: 1_000,
  });
  assert.equal(
    await store.releaseReservation({
      guildId: "guild-1",
      key: "guild-1/existing.bin",
      operationKey: "replace",
    }),
    true,
  );
  assert.deepEqual(await store.getGuildUsage("guild-1"), {
    usedBytes: 80,
    reservedBytes: 0,
    lastReconciledAtMs: null,
  });

  await store.reserveObject({
    guildId: "guild-1",
    key: "guild-1/new.bin",
    operationKey: "abandoned",
    reservedBytes: 20,
    limitBytes: 100,
    expiresAtMs: 2_000,
    nowMs: 1_000,
  });
  assert.equal(await store.releaseExpiredReservations(2_001, 100), 1);
  assert.deepEqual(await store.getGuildUsage("guild-1"), {
    usedBytes: 80,
    reservedBytes: 0,
    lastReconciledAtMs: null,
  });
});

test("Guild R2 reservation rollback restores a committed zero-byte object", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareGuildR2ObjectStore(database as unknown as D1Database);
  await store.upsertObject({
    guildId: "guild-1",
    key: "guild-1/empty.bin",
    sizeBytes: 0,
    createdAtMs: 500,
  });
  await store.reserveObject({
    guildId: "guild-1",
    key: "guild-1/empty.bin",
    operationKey: "replace-empty",
    reservedBytes: 10,
    limitBytes: 100,
    expiresAtMs: 2_000,
    nowMs: 1_000,
  });

  await store.releaseReservation({
    guildId: "guild-1",
    key: "guild-1/empty.bin",
    operationKey: "replace-empty",
  });

  const restored = await (database as unknown as D1Database)
    .prepare(
      `SELECT status, size_bytes AS sizeBytes FROM guild_r2_objects
       WHERE guild_id = ? AND object_key = ?`,
    )
    .bind("guild-1", "guild-1/empty.bin")
    .first<{ status: string; sizeBytes: number }>();
  assert.deepEqual(restored, { status: "committed", sizeBytes: 0 });
});
