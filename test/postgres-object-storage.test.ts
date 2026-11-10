import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { reconcilePortableObjectsPage } from "../src/node/portable-object-reconciliation";
import { createPortableTicketTranscriptBlobStore } from "../src/runtime/portable-blob-stores";
import {
  createPostgresDatabaseCapabilityFromEnvironment,
  type PostgresDatabaseCapability,
} from "../src/runtime/postgres/postgres-capability";
import { createPostgresGuildEntitlementStore } from "../src/runtime/postgres/postgres-guild-entitlement-store";
import { createPostgresGuildObjectStore } from "../src/runtime/postgres/postgres-guild-object-store";
import {
  applyPostgresMigrations,
  readPostgresMigrations,
} from "../src/runtime/postgres/postgres-migrations";
import { createPostgresPlayerCountStreakReportedStore } from "../src/runtime/postgres/postgres-player-count-streak-store";
import { createPostgresSteamBanLookupStore } from "../src/runtime/postgres/postgres-steam-ban-lookup-store";
import { InMemoryObjectStore } from "./support/in-memory-object-store";

const postgresUrl = process.env.TEST_POSTGRES_URL;

test(
  "portable object reconciliation repairs accounting without deleting concurrent writes",
  { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
  async () => {
    assert.ok(postgresUrl);
    assertSafeTestDatabase(postgresUrl);
    const database = createPostgresDatabaseCapabilityFromEnvironment({
      DATABASE_URL: postgresUrl,
      NODE_ENV: "test",
      PG_POOL_MAX: "6",
    });
    try {
      await resetAndMigrate(database);
      const objects = new InMemoryObjectStore();
      const accounting = createPostgresGuildObjectStore(database);
      const nowMs = 4_000_000_000;

      await objects.put("guild-a/one.bin", new Uint8Array([1, 2, 3]));
      await objects.put("guild-b/two.bin", new Uint8Array([1, 2, 3, 4, 5]));
      await objects.put("guild-c/uploaded.bin", new Uint8Array([1, 2, 3, 4]));
      await accounting.upsertObject({
        guildId: "guild-stale",
        key: "guild-stale/missing.bin",
        sizeBytes: 99,
        createdAtMs: 1_000,
      });
      await accounting.upsertObject({
        guildId: "guild-concurrent",
        key: "guild-concurrent/new-during-scan.bin",
        sizeBytes: 7,
        createdAtMs: nowMs + 1,
      });
      await accounting.reserveObject({
        guildId: "guild-reserved",
        key: "guild-reserved/abandoned.bin",
        operationKey: "abandoned-operation",
        reservedBytes: 10,
        limitBytes: 100,
        nowMs: 2_000,
        expiresAtMs: 3_000,
      });
      await accounting.reserveObject({
        guildId: "guild-c",
        key: "guild-c/uploaded.bin",
        operationKey: "uploaded-operation",
        reservedBytes: 10,
        limitBytes: 100,
        nowMs: 2_000,
        expiresAtMs: 3_000,
      });
      await accounting.markUploadStarted({
        guildId: "guild-c",
        key: "guild-c/uploaded.bin",
        operationKey: "uploaded-operation",
        startedAtMs: 2_500,
      });
      await database.execute(
        `INSERT INTO guild_object_accounting (
           guild_id, object_key, size_bytes, created_at_ms, status, reserved_bytes,
           updated_at_ms, had_committed_object, tombstoned_at_ms
         ) VALUES ('guild-old', 'guild-old/deleted.bin', 0, 1, 'deleted', 0, 1, FALSE, 1)`,
      );

      const pages = [];
      do {
        pages.push(
          await reconcilePortableObjectsPage({
            database,
            objects,
            guildObjects: accounting,
            bucketId: "test-objects",
            nowMs,
            pageSize: 1,
          }),
        );
      } while (!pages.at(-1)!.completed);

      assert.equal(pages.length, 3);
      assert.equal(pages[0]?.releasedReservations, 1);
      assert.equal(pages[0]?.resolvedUploadReservations, 1);
      assert.equal(
        pages.reduce((total, page) => total + page.scannedObjects, 0),
        3,
      );
      assert.equal((await accounting.getGuildUsage("guild-a")).usedBytes, 3);
      assert.equal((await accounting.getGuildUsage("guild-b")).usedBytes, 5);
      assert.equal((await accounting.getGuildUsage("guild-c")).usedBytes, 4);
      assert.equal((await accounting.getGuildUsage("guild-reserved")).reservedBytes, 0);

      const rows = await database.query<{
        guild_id: string;
        status: string;
        size_bytes: string | number;
      }>(
        `SELECT guild_id, status, size_bytes
           FROM guild_object_accounting
          WHERE guild_id IN ('guild-stale', 'guild-concurrent', 'guild-old')
          ORDER BY guild_id`,
      );
      assert.deepEqual(rows, [
        { guild_id: "guild-concurrent", status: "committed", size_bytes: "7" },
        { guild_id: "guild-stale", status: "deleted", size_bytes: "0" },
      ]);
      const state = await database.query<{
        cursor: string | null;
        generation: string | number;
        started_at_ms: string | number | null;
        last_reconciled_at_ms: string | number | null;
      }>(
        `SELECT cursor, generation, started_at_ms, last_reconciled_at_ms
           FROM guild_object_reconciliation_state
          WHERE bucket_id = 'test-objects'`,
      );
      assert.deepEqual(state, [
        {
          cursor: null,
          generation: "2",
          started_at_ms: null,
          last_reconciled_at_ms: String(nowMs),
        },
      ]);
    } finally {
      await database.close();
    }
  },
);

test(
  "PostgreSQL object accounting preserves quotas, recovery, blobs, entitlements, and TTL caches",
  { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
  async () => {
    assert.ok(postgresUrl);
    assertSafeTestDatabase(postgresUrl);
    const database = createPostgresDatabaseCapabilityFromEnvironment({
      DATABASE_URL: postgresUrl,
      NODE_ENV: "test",
      PG_POOL_MAX: "6",
    });
    try {
      await resetAndMigrate(database);
      await verifyEntitlements(database);
      await verifyAtomicQuota(database);
      await verifyRecoveryAndPortableBlobs(database);
      await verifyTtlCaches(database);
    } finally {
      await database.close();
    }
  },
);

async function verifyEntitlements(database: PostgresDatabaseCapability): Promise<void> {
  const store = createPostgresGuildEntitlementStore(database);
  assert.equal((await store.readGuildEntitlement("missing")).tier, "free");
  await database.execute(
    `INSERT INTO guild_entitlements (guild_id, tier, plan, updated_at_ms)
     VALUES ('premium-guild', 'premium', 'premium', 123)`,
  );
  assert.deepEqual(await store.readGuildEntitlement("premium-guild"), {
    guildId: "premium-guild",
    tier: "premium",
    updatedAtMs: 123,
  });
}

async function verifyAtomicQuota(database: PostgresDatabaseCapability): Promise<void> {
  const store = createPostgresGuildObjectStore(database);
  const reservations = await Promise.all([
    store.reserveObject({
      guildId: "quota-guild",
      key: "quota-guild/a.bin",
      operationKey: "quota-a",
      reservedBytes: 60,
      limitBytes: 100,
      nowMs: 1_000,
      expiresAtMs: 2_000,
    }),
    store.reserveObject({
      guildId: "quota-guild",
      key: "quota-guild/b.bin",
      operationKey: "quota-b",
      reservedBytes: 60,
      limitBytes: 100,
      nowMs: 1_000,
      expiresAtMs: 2_000,
    }),
  ]);
  assert.deepEqual(reservations.map(({ status }) => status).sort(), ["quota-exceeded", "reserved"]);
  assert.deepEqual(await store.getGuildUsage("quota-guild"), {
    usedBytes: 0,
    reservedBytes: 60,
    lastReconciledAtMs: null,
  });
  assert.equal(await store.releaseExpiredReservations(2_001, 10), 1);
}

async function verifyRecoveryAndPortableBlobs(database: PostgresDatabaseCapability): Promise<void> {
  const quota = createPostgresGuildObjectStore(database);
  await quota.upsertObject({
    guildId: "premium-guild",
    key: "premium-guild/existing.bin",
    sizeBytes: 100,
    createdAtMs: 500,
  });
  const shrinking = await quota.reserveObject({
    guildId: "premium-guild",
    key: "premium-guild/existing.bin",
    operationKey: "shrink",
    reservedBytes: 50,
    limitBytes: 100,
    nowMs: 1_000,
    expiresAtMs: 2_000,
  });
  assert.deepEqual(shrinking, { status: "reserved", previousCommittedBytes: 100 });
  assert.equal(
    (
      await quota.reserveObject({
        guildId: "premium-guild",
        key: "premium-guild/other.bin",
        operationKey: "other",
        reservedBytes: 1,
        limitBytes: 100,
        nowMs: 1_000,
        expiresAtMs: 2_000,
      })
    ).status,
    "quota-exceeded",
  );
  assert.equal(
    await quota.releaseReservation({
      guildId: "premium-guild",
      key: "premium-guild/existing.bin",
      operationKey: "shrink",
    }),
    true,
  );
  assert.equal(await quota.getGuildUsageBytes("premium-guild"), 100);

  await quota.reserveObject({
    guildId: "premium-guild",
    key: "premium-guild/abandoned.bin",
    operationKey: "abandoned",
    reservedBytes: 20,
    limitBytes: 1_000,
    nowMs: 1_000,
    expiresAtMs: 2_000,
  });
  assert.equal(await quota.releaseExpiredReservations(2_001, 10), 1);

  await quota.reserveObject({
    guildId: "premium-guild",
    key: "premium-guild/uploaded.bin",
    operationKey: "started",
    reservedBytes: 20,
    limitBytes: 1_000,
    nowMs: 3_000,
    expiresAtMs: 4_000,
  });
  await quota.markUploadStarted({
    guildId: "premium-guild",
    key: "premium-guild/uploaded.bin",
    operationKey: "started",
    startedAtMs: 3_100,
  });
  assert.deepEqual(await quota.listExpiredUploadReservations(4_001, 10), [
    {
      guildId: "premium-guild",
      key: "premium-guild/uploaded.bin",
      operationKey: "started",
    },
  ]);
  assert.equal(
    await quota.resolveExpiredUploadReservation({
      guildId: "premium-guild",
      key: "premium-guild/uploaded.bin",
      operationKey: "started",
      actualBytes: 20,
      resolvedAtMs: 4_100,
    }),
    true,
  );

  const objects = new InMemoryObjectStore();
  const transcripts = createPortableTicketTranscriptBlobStore({
    objects,
    guildEntitlements: createPostgresGuildEntitlementStore(database),
    guildObjects: quota,
    now: (() => {
      let value = 10_000;
      return () => ++value;
    })(),
  });
  await transcripts.putHtml("premium-guild/channel/transcript.html", "<p>hello</p>");
  assert.equal(await transcripts.getHtml("premium-guild/channel/transcript.html"), "<p>hello</p>");
  assert.deepEqual((await objects.head("premium-guild/channel/transcript.html"))?.metadata, {
    visibility: "private",
    contentClass: "ticket-transcript",
  });
}

async function verifyTtlCaches(database: PostgresDatabaseCapability): Promise<void> {
  let now = new Date("2026-08-20T00:00:00.000Z");
  const steam = createPostgresSteamBanLookupStore(database, {
    ttlSeconds: 60,
    now: () => now,
  });
  const entry = {
    lastCheckedAtMs: 1,
    communityBanned: false,
    vacBanned: false,
    numberOfVacBans: 0,
    daysSinceLastBan: 0,
    numberOfGameBans: 0,
    economyBan: "none",
    gameBans: [],
  };
  await steam.write("76561190000000000", entry);
  assert.deepEqual(await steam.read("76561190000000000"), entry);
  now = new Date("2026-08-20T00:01:01.000Z");
  assert.equal(await steam.read("76561190000000000"), null);

  now = new Date("2026-08-20T01:00:00.000Z");
  const streaks = createPostgresPlayerCountStreakReportedStore(database, {
    ttlSeconds: 60,
    now: () => now,
  });
  await streaks.markStreakReported("guild:server");
  assert.equal(await streaks.isStreakReported("guild:server"), true);
  now = new Date("2026-08-20T01:01:01.000Z");
  assert.equal(await streaks.isStreakReported("guild:server"), false);
  await streaks.clearStreakReported("guild:server");
}

async function resetAndMigrate(database: PostgresDatabaseCapability): Promise<void> {
  await database.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await applyPostgresMigrations(
    database,
    await readPostgresMigrations(resolve("migrations/postgres")),
  );
}

function assertSafeTestDatabase(value: string): void {
  const url = new URL(value);
  const databaseName = url.pathname.slice(1);
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (!local || !databaseName.endsWith("_test")) {
    throw new Error("PostgreSQL integration tests require a local database ending in _test.");
  }
}
