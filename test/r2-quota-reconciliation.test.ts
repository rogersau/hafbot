/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import { createSqliteGuildR2ObjectStore } from "./support/sqlite/runtime/sqlite-guild-r2-object-store";
import { reconcileGuildR2ObjectsPage } from "./support/sqlite/runtime/r2-quota-reconciliation";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("R2 reconciliation repairs orphaned objects, stale rows, and size drift", async () => {
  const database = new SqliteD1Database();
  const store = createSqliteGuildR2ObjectStore(database as unknown as D1Database);
  await store.upsertObject({
    guildId: "guild-1",
    key: "guild-1/stale.bin",
    sizeBytes: 50,
    createdAtMs: 1,
  });
  await store.upsertObject({
    guildId: "guild-1",
    key: "guild-1/drift.bin",
    sizeBytes: 10,
    createdAtMs: 1,
  });

  const result = await reconcileGuildR2ObjectsPage({
    database: database as unknown as D1Database,
    bucket: bucketWithPages([
      {
        objects: [r2Object("guild-1/drift.bin", 25), r2Object("guild-1/orphan.bin", 30)],
        truncated: false,
      },
    ]),
    bucketId: "transcripts",
    nowMs: 2_000,
  });

  assert.equal(result.completed, true);
  assert.deepEqual(await store.getGuildUsage("guild-1"), {
    usedBytes: 55,
    reservedBytes: 0,
    lastReconciledAtMs: 2_000,
  });
});

test("R2 reconciliation persists its cursor and defers stale-row removal until completion", async () => {
  const database = new SqliteD1Database();
  const store = createSqliteGuildR2ObjectStore(database as unknown as D1Database);
  await store.upsertObject({
    guildId: "guild-1",
    key: "guild-1/stale.bin",
    sizeBytes: 40,
    createdAtMs: 1,
  });
  const bucket = bucketWithPages([
    { objects: [r2Object("guild-1/a.bin", 10)], truncated: true, cursor: "page-2" },
    { objects: [r2Object("guild-1/b.bin", 20)], truncated: false },
  ]);

  const first = await reconcileGuildR2ObjectsPage({
    database: database as unknown as D1Database,
    bucket,
    bucketId: "transcripts",
    nowMs: 2_000,
    pageSize: 1,
  });
  assert.deepEqual(first, {
    scannedObjects: 1,
    releasedReservations: 0,
    resolvedUploadReservations: 0,
    completed: false,
    cursor: "page-2",
  });
  assert.equal(await store.getGuildUsageBytes("guild-1"), 50);

  const second = await reconcileGuildR2ObjectsPage({
    database: database as unknown as D1Database,
    bucket,
    bucketId: "transcripts",
    nowMs: 3_000,
    pageSize: 1,
  });
  assert.equal(second.completed, true);
  assert.equal(await store.getGuildUsageBytes("guild-1"), 30);
  assert.deepEqual(bucket.cursors, [undefined, "page-2"]);
});

test("R2 reconciliation does not remove metadata written during a paginated scan", async () => {
  const database = new SqliteD1Database();
  const store = createSqliteGuildR2ObjectStore(database as unknown as D1Database);
  await store.upsertObject({
    guildId: "guild-1",
    key: "guild-1/stale.bin",
    sizeBytes: 40,
    createdAtMs: 1,
  });
  const bucket = bucketWithPages([
    { objects: [r2Object("guild-1/a.bin", 10)], truncated: true, cursor: "page-2" },
    { objects: [r2Object("guild-1/b.bin", 20)], truncated: false },
  ]);

  await reconcileGuildR2ObjectsPage({
    database: database as unknown as D1Database,
    bucket,
    bucketId: "transcripts",
    nowMs: 2_000,
    pageSize: 1,
  });
  await store.upsertObject({
    guildId: "guild-1",
    key: "guild-1/during-scan.bin",
    sizeBytes: 30,
    createdAtMs: 2_500,
  });
  await reconcileGuildR2ObjectsPage({
    database: database as unknown as D1Database,
    bucket,
    bucketId: "transcripts",
    nowMs: 3_000,
    pageSize: 1,
  });

  assert.equal(await store.getGuildUsageBytes("guild-1"), 60);
});

test("expired post-upload reservations are resolved by exact R2 metadata before cursor scanning", async () => {
  const database = new SqliteD1Database();
  const store = createSqliteGuildR2ObjectStore(database as unknown as D1Database);
  await store.reserveObject({
    guildId: "guild-1",
    key: "guild-1/uploaded.bin",
    operationKey: "upload",
    reservedBytes: 80,
    limitBytes: 100,
    expiresAtMs: 2_000,
    nowMs: 1_000,
  });
  await store.markUploadStarted({
    guildId: "guild-1",
    key: "guild-1/uploaded.bin",
    operationKey: "upload",
    startedAtMs: 1_100,
  });
  const bucket = bucketWithPages(
    [{ objects: [r2Object("guild-2/unrelated.bin", 10)], truncated: true, cursor: "page-2" }],
    { "guild-1/uploaded.bin": r2Object("guild-1/uploaded.bin", 80) },
  );

  const result = await reconcileGuildR2ObjectsPage({
    database: database as unknown as D1Database,
    bucket,
    bucketId: "transcripts",
    nowMs: 3_000,
    pageSize: 1,
  });

  assert.equal(result.resolvedUploadReservations, 1);
  assert.deepEqual(await store.getGuildUsage("guild-1"), {
    usedBytes: 80,
    reservedBytes: 0,
    lastReconciledAtMs: null,
  });
});

test("completed reconciliation garbage-collects only expired delete tombstones", async () => {
  const database = new SqliteD1Database();
  const store = createSqliteGuildR2ObjectStore(database as unknown as D1Database);
  await store.deleteObject({
    guildId: "guild-1",
    key: "guild-1/old.bin",
    deletedAtMs: 1_000,
  });
  await store.deleteObject({
    guildId: "guild-1",
    key: "guild-1/recent.bin",
    deletedAtMs: 35 * 24 * 60 * 60 * 1_000,
  });

  await reconcileGuildR2ObjectsPage({
    database: database as unknown as D1Database,
    bucket: bucketWithPages([{ objects: [], truncated: false }]),
    bucketId: "transcripts",
    nowMs: 40 * 24 * 60 * 60 * 1_000,
  });

  const rows = await (database as unknown as D1Database)
    .prepare(
      `SELECT object_key AS objectKey FROM guild_r2_objects
       WHERE guild_id = ? ORDER BY object_key`,
    )
    .bind("guild-1")
    .all<{ objectKey: string }>();
  assert.deepEqual(rows.results, [{ objectKey: "guild-1/recent.bin" }]);
});

test("R2 reconciliation resumes after state initialization fails before any page effects", async () => {
  const database = new SqliteD1Database();
  const faultedDatabase = databaseWithTransientFailure(database, "state-initialization");
  const bucket = bucketWithCursorPages({
    start: { objects: [r2Object("guild-1/new.bin", 30)], truncated: false },
  });

  await assert.rejects(
    reconcileGuildR2ObjectsPage({
      database: faultedDatabase,
      bucket,
      bucketId: "transcripts",
      nowMs: 2_000,
    }),
    /injected state initialization failure/,
  );
  assert.deepEqual(bucket.cursors, []);

  const recovered = await reconcileGuildR2ObjectsPage({
    database: faultedDatabase,
    bucket,
    bucketId: "transcripts",
    nowMs: 3_000,
  });

  assert.equal(recovered.completed, true);
  assert.equal(
    await createSqliteGuildR2ObjectStore(faultedDatabase).getGuildUsageBytes("guild-1"),
    30,
  );
  assert.deepEqual(bucket.cursors, [undefined]);
});

test("R2 reconciliation replays an object page after its committed write response is lost", async () => {
  const database = new SqliteD1Database();
  const faultedDatabase = databaseWithTransientFailure(database, "page-write-after-commit");
  const store = createSqliteGuildR2ObjectStore(faultedDatabase);
  await store.upsertObject({
    guildId: "guild-1",
    key: "guild-1/stale.bin",
    sizeBytes: 40,
    createdAtMs: 1,
  });
  await store.reserveObject({
    guildId: "guild-1",
    key: "guild-1/in-flight.bin",
    operationKey: "in-flight-upload",
    reservedBytes: 80,
    limitBytes: 200,
    expiresAtMs: 10_000,
    nowMs: 1_000,
  });
  await store.markUploadStarted({
    guildId: "guild-1",
    key: "guild-1/in-flight.bin",
    operationKey: "in-flight-upload",
    startedAtMs: 1_100,
  });
  await store.reserveObject({
    guildId: "guild-1",
    key: "guild-1/abandoned.bin",
    operationKey: "abandoned-upload",
    reservedBytes: 10,
    limitBytes: 200,
    expiresAtMs: 1_800,
    nowMs: 1_000,
  });
  const bucket = bucketWithCursorPages({
    start: { objects: [r2Object("guild-1/a.bin", 10)], truncated: true, cursor: "page-2" },
    "page-2": { objects: [r2Object("guild-1/b.bin", 20)], truncated: false },
  });

  await assert.rejects(
    reconcileGuildR2ObjectsPage({
      database: faultedDatabase,
      bucket,
      bucketId: "transcripts",
      nowMs: 2_000,
      pageSize: 1,
    }),
    /injected page write failure/,
  );
  assert.deepEqual(await store.getGuildUsage("guild-1"), {
    usedBytes: 50,
    reservedBytes: 80,
    lastReconciledAtMs: null,
  });
  await store.upsertObject({
    guildId: "guild-1",
    key: "guild-1/concurrent.bin",
    sizeBytes: 7,
    createdAtMs: 2_500,
  });

  const resumed = await reconcileGuildR2ObjectsPage({
    database: faultedDatabase,
    bucket,
    bucketId: "transcripts",
    nowMs: 3_000,
    pageSize: 1,
  });
  assert.equal(resumed.completed, false);
  assert.equal(resumed.releasedReservations, 0);
  assert.equal(resumed.cursor, "page-2");

  const completed = await reconcileGuildR2ObjectsPage({
    database: faultedDatabase,
    bucket,
    bucketId: "transcripts",
    nowMs: 4_000,
    pageSize: 1,
  });
  assert.equal(completed.completed, true);
  assert.deepEqual(await store.getGuildUsage("guild-1"), {
    usedBytes: 37,
    reservedBytes: 80,
    lastReconciledAtMs: 4_000,
  });
  assert.deepEqual(bucket.cursors, [undefined, undefined, "page-2"]);
});

test("R2 reconciliation resumes from a committed cursor after checkpoint response loss", async () => {
  const database = new SqliteD1Database();
  const faultedDatabase = databaseWithTransientFailure(database, "cursor-checkpoint-after-commit");
  const store = createSqliteGuildR2ObjectStore(faultedDatabase);
  await store.upsertObject({
    guildId: "guild-1",
    key: "guild-1/stale.bin",
    sizeBytes: 40,
    createdAtMs: 1,
  });
  const bucket = bucketWithCursorPages({
    start: { objects: [r2Object("guild-1/a.bin", 10)], truncated: true, cursor: "page-2" },
    "page-2": { objects: [r2Object("guild-1/b.bin", 20)], truncated: false },
  });

  await assert.rejects(
    reconcileGuildR2ObjectsPage({
      database: faultedDatabase,
      bucket,
      bucketId: "transcripts",
      nowMs: 2_000,
      pageSize: 1,
    }),
    /injected cursor checkpoint failure/,
  );
  assert.equal(await store.getGuildUsageBytes("guild-1"), 50);

  const completed = await reconcileGuildR2ObjectsPage({
    database: faultedDatabase,
    bucket,
    bucketId: "transcripts",
    nowMs: 3_000,
    pageSize: 1,
  });
  assert.equal(completed.completed, true);
  assert.deepEqual(await store.getGuildUsage("guild-1"), {
    usedBytes: 30,
    reservedBytes: 0,
    lastReconciledAtMs: 3_000,
  });
  assert.deepEqual(bucket.cursors, [undefined, "page-2"]);
});

test("R2 reconciliation remains safe when final cleanup commits before its response is lost", async () => {
  const database = new SqliteD1Database();
  const faultedDatabase = databaseWithTransientFailure(database, "finalization-after-commit");
  const store = createSqliteGuildR2ObjectStore(faultedDatabase);
  await store.upsertObject({
    guildId: "guild-1",
    key: "guild-1/stale.bin",
    sizeBytes: 40,
    createdAtMs: 1,
  });
  const bucket = bucketWithCursorPages({
    start: { objects: [r2Object("guild-1/current.bin", 30)], truncated: false },
  });

  await assert.rejects(
    reconcileGuildR2ObjectsPage({
      database: faultedDatabase,
      bucket,
      bucketId: "transcripts",
      nowMs: 2_000,
    }),
    /injected finalization failure/,
  );
  assert.deepEqual(await store.getGuildUsage("guild-1"), {
    usedBytes: 30,
    reservedBytes: 0,
    lastReconciledAtMs: 2_000,
  });

  const replayed = await reconcileGuildR2ObjectsPage({
    database: faultedDatabase,
    bucket,
    bucketId: "transcripts",
    nowMs: 3_000,
  });
  assert.equal(replayed.completed, true);
  assert.deepEqual(await store.getGuildUsage("guild-1"), {
    usedBytes: 30,
    reservedBytes: 0,
    lastReconciledAtMs: 3_000,
  });
  assert.deepEqual(bucket.cursors, [undefined, undefined]);
});

function bucketWithPages(
  pages: Array<{ objects: R2Object[]; truncated: boolean; cursor?: string }>,
  heads: Record<string, R2Object> = {},
): R2Bucket & { cursors: Array<string | undefined> } {
  const cursors: Array<string | undefined> = [];
  let index = 0;
  return {
    cursors,
    async head(key: string) {
      return heads[key] ?? null;
    },
    async list(options?: R2ListOptions) {
      cursors.push(options?.cursor);
      const page = pages[index++]!;
      return { ...page, delimitedPrefixes: [] };
    },
  } as unknown as R2Bucket & { cursors: Array<string | undefined> };
}

function bucketWithCursorPages(
  pages: Record<string, { objects: R2Object[]; truncated: boolean; cursor?: string }>,
): R2Bucket & { cursors: Array<string | undefined> } {
  const cursors: Array<string | undefined> = [];
  return {
    cursors,
    async head() {
      return null;
    },
    async list(options?: R2ListOptions) {
      cursors.push(options?.cursor);
      const page = pages[options?.cursor ?? "start"];
      if (!page) throw new Error(`missing test page for cursor ${options?.cursor ?? "start"}`);
      return { ...page, delimitedPrefixes: [] };
    },
  } as unknown as R2Bucket & { cursors: Array<string | undefined> };
}

function databaseWithTransientFailure(
  database: SqliteD1Database,
  failure:
    | "state-initialization"
    | "page-write-after-commit"
    | "cursor-checkpoint-after-commit"
    | "finalization-after-commit",
): D1Database {
  let injected = false;
  const base = database.d1;

  function wrapStatement(query: string, statement: D1PreparedStatement): D1PreparedStatement {
    return new Proxy(statement, {
      get(target, property, receiver) {
        if (property === "bind") {
          return (...values: unknown[]) =>
            wrapStatement(query, target.bind(...values) as D1PreparedStatement);
        }
        if (property === "run") {
          return async () => {
            if (
              !injected &&
              failure === "state-initialization" &&
              query.includes("INSERT OR IGNORE INTO guild_r2_reconciliation_state")
            ) {
              injected = true;
              throw new Error("injected state initialization failure");
            }
            const result = await target.run();
            if (
              !injected &&
              failure === "cursor-checkpoint-after-commit" &&
              query.includes("UPDATE guild_r2_reconciliation_state SET")
            ) {
              injected = true;
              throw new Error("injected cursor checkpoint failure");
            }
            return result;
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (query: string) => wrapStatement(query, target.prepare(query));
      }
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const result = await target.batch(statements as never);
          if (!injected && failure === "page-write-after-commit" && statements.length === 1) {
            injected = true;
            throw new Error("injected page write failure");
          }
          if (!injected && failure === "finalization-after-commit" && statements.length === 3) {
            injected = true;
            throw new Error("injected finalization failure");
          }
          return result;
        };
      }
      return Reflect.get(target, property, receiver);
    },
  }) as D1Database;
}

function r2Object(key: string, size: number): R2Object {
  return { key, size, uploaded: new Date(1_500) } as R2Object;
}
