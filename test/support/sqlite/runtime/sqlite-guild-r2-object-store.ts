import { and, eq, isNotNull, lt, lte, ne, sql } from "drizzle-orm";
import { guildR2Objects, guildR2ReconciliationState } from "../db/app-schema";
import type { GuildR2QuotaStore, GuildR2Usage } from "../../../../src/runtime/contracts";
import { createD1DrizzleDatabase, type AppDrizzleDatabase } from "./drizzle-db";

const guildR2ObjectStoreCache = new WeakMap<D1Database, GuildR2QuotaStore>();

export function createSqliteGuildR2ObjectStore(database: D1Database): GuildR2QuotaStore {
  const cached = guildR2ObjectStoreCache.get(database);
  if (cached) return cached;

  const db = createD1DrizzleDatabase(database);
  const store: GuildR2QuotaStore = {
    async upsertObject(input): Promise<void> {
      await db
        .insert(guildR2Objects)
        .values({
          guildId: input.guildId,
          objectKey: input.key,
          sizeBytes: input.sizeBytes,
          createdAtMs: input.createdAtMs,
          status: "committed",
          reservedBytes: 0,
          updatedAtMs: input.createdAtMs,
          hadCommittedObject: true,
          uploadStartedAtMs: null,
          tombstonedAtMs: null,
        })
        .onConflictDoUpdate({
          target: [guildR2Objects.guildId, guildR2Objects.objectKey],
          set: {
            sizeBytes: input.sizeBytes,
            createdAtMs: input.createdAtMs,
            status: "committed",
            reservedBytes: 0,
            reservationExpiresAtMs: null,
            operationKey: null,
            updatedAtMs: input.createdAtMs,
            hadCommittedObject: true,
            uploadStartedAtMs: null,
            tombstonedAtMs: null,
          },
          setWhere: and(
            ne(guildR2Objects.status, "reserved"),
            lt(guildR2Objects.updatedAtMs, input.createdAtMs),
          ),
        })
        .run();
    },

    async deleteObject(input): Promise<void> {
      const deletedAtMs = input.deletedAtMs ?? Date.now();
      await database
        .prepare(
          `INSERT INTO guild_r2_objects
             (guild_id, object_key, size_bytes, created_at_ms, status, reserved_bytes,
              reservation_expires_at_ms, operation_key, updated_at_ms,
              reconciliation_generation, had_committed_object, upload_started_at_ms,
              tombstoned_at_ms)
           VALUES (?, ?, 0, ?, 'deleted', 0, NULL, NULL, ?, NULL, 0, NULL, ?)
           ON CONFLICT(guild_id, object_key) DO UPDATE SET
             size_bytes = 0, created_at_ms = excluded.created_at_ms, status = 'deleted',
             reserved_bytes = 0, reservation_expires_at_ms = NULL, operation_key = NULL,
             updated_at_ms = excluded.updated_at_ms, reconciliation_generation = NULL,
             had_committed_object = 0, upload_started_at_ms = NULL,
             tombstoned_at_ms = excluded.tombstoned_at_ms
           WHERE guild_r2_objects.status <> 'reserved'
             AND guild_r2_objects.updated_at_ms <= excluded.updated_at_ms`,
        )
        .bind(input.guildId, input.key, deletedAtMs, deletedAtMs, deletedAtMs)
        .run();
    },

    async getGuildUsageBytes(guildId): Promise<number> {
      return (await readGuildUsage(db, guildId)).usedBytes;
    },

    async getGuildUsage(guildId): Promise<GuildR2Usage> {
      return readGuildUsage(db, guildId);
    },

    async reserveObject(input) {
      assertReservationInput(input);
      let result: D1Result;
      try {
        result = await database
          .prepare(
            `INSERT INTO guild_r2_objects
               (guild_id, object_key, size_bytes, created_at_ms, status, reserved_bytes,
                reservation_expires_at_ms, operation_key, updated_at_ms,
                reconciliation_generation, had_committed_object)
             SELECT ?, ?, 0, ?, 'reserved', ?, ?, ?, ?, NULL, 0
             WHERE
               (SELECT COALESCE(SUM(
                  CASE WHEN status = 'reserved' THEN MAX(size_bytes, reserved_bytes)
                       ELSE size_bytes END
                ), 0) FROM guild_r2_objects WHERE guild_id = ?)
               - COALESCE((SELECT
                  CASE WHEN status = 'reserved' THEN MAX(size_bytes, reserved_bytes)
                       ELSE size_bytes END
                  FROM guild_r2_objects WHERE guild_id = ? AND object_key = ?), 0)
               + MAX(COALESCE((SELECT size_bytes FROM guild_r2_objects
                   WHERE guild_id = ? AND object_key = ?), 0), ?) <= ?
               OR ? <= COALESCE((SELECT size_bytes FROM guild_r2_objects
                   WHERE guild_id = ? AND object_key = ?
                     AND had_committed_object = 1), -1)
             ON CONFLICT(guild_id, object_key) DO UPDATE SET
               size_bytes = CASE WHEN guild_r2_objects.status = 'deleted'
                 THEN 0 ELSE guild_r2_objects.size_bytes END,
               status = 'reserved',
               reserved_bytes = excluded.reserved_bytes,
               reservation_expires_at_ms = excluded.reservation_expires_at_ms,
               operation_key = excluded.operation_key,
               updated_at_ms = excluded.updated_at_ms,
               upload_started_at_ms = NULL,
               had_committed_object = CASE WHEN guild_r2_objects.status = 'deleted'
                 THEN 0 ELSE guild_r2_objects.had_committed_object END
             WHERE guild_r2_objects.status = 'committed'
                OR guild_r2_objects.status = 'deleted'
                OR guild_r2_objects.operation_key = excluded.operation_key`,
          )
          .bind(
            input.guildId,
            input.key,
            input.nowMs,
            input.reservedBytes,
            input.expiresAtMs,
            input.operationKey,
            input.nowMs,
            input.guildId,
            input.guildId,
            input.key,
            input.guildId,
            input.key,
            input.reservedBytes,
            input.limitBytes,
            input.reservedBytes,
            input.guildId,
            input.key,
          )
          .run();
      } catch (error) {
        if (String(error).includes("UNIQUE constraint failed")) return { status: "conflict" };
        throw error;
      }
      if ((result.meta.changes ?? 0) > 0) {
        const row = await database
          .prepare(
            `SELECT size_bytes AS "previousCommittedBytes"
             FROM guild_r2_objects
             WHERE guild_id = ? AND object_key = ? AND operation_key = ?`,
          )
          .bind(input.guildId, input.key, input.operationKey)
          .first<{ previousCommittedBytes: number }>();
        return { status: "reserved", previousCommittedBytes: row?.previousCommittedBytes ?? 0 };
      }

      const active = await database
        .prepare(
          `SELECT operation_key AS "operationKey" FROM guild_r2_objects
           WHERE guild_id = ? AND object_key = ? AND status = 'reserved'`,
        )
        .bind(input.guildId, input.key)
        .first<{ operationKey: string | null }>();
      if (active?.operationKey && active.operationKey !== input.operationKey) {
        return { status: "conflict" };
      }
      return { status: "quota-exceeded", usage: await readGuildUsage(db, input.guildId) };
    },

    async commitObject(input): Promise<boolean> {
      const result = await database
        .prepare(
          `UPDATE guild_r2_objects SET
             status = 'committed', size_bytes = ?, reserved_bytes = 0,
             reservation_expires_at_ms = NULL, operation_key = NULL,
             created_at_ms = ?, updated_at_ms = ?, had_committed_object = 1,
             upload_started_at_ms = NULL, tombstoned_at_ms = NULL
           WHERE guild_id = ? AND object_key = ? AND status = 'reserved'
             AND operation_key = ? AND reserved_bytes = ?`,
        )
        .bind(
          input.actualBytes,
          input.committedAtMs,
          input.committedAtMs,
          input.guildId,
          input.key,
          input.operationKey,
          input.actualBytes,
        )
        .run();
      return (result.meta.changes ?? 0) > 0;
    },

    async markUploadStarted(input): Promise<boolean> {
      const result = await database
        .prepare(
          `UPDATE guild_r2_objects SET upload_started_at_ms = ?, updated_at_ms = ?
           WHERE guild_id = ? AND object_key = ? AND status = 'reserved'
             AND operation_key = ?`,
        )
        .bind(input.startedAtMs, input.startedAtMs, input.guildId, input.key, input.operationKey)
        .run();
      return (result.meta.changes ?? 0) > 0;
    },

    async releaseReservation(input): Promise<boolean> {
      const [updated] = await database.batch([
        database
          .prepare(
            `UPDATE guild_r2_objects SET
               status = CASE WHEN had_committed_object = 1 THEN 'committed'
                 WHEN tombstoned_at_ms IS NOT NULL THEN 'deleted' ELSE 'released' END,
               reserved_bytes = 0, reservation_expires_at_ms = NULL,
               operation_key = NULL, upload_started_at_ms = NULL,
               updated_at_ms = updated_at_ms
             WHERE guild_id = ? AND object_key = ? AND status = 'reserved'
               AND operation_key = ?`,
          )
          .bind(input.guildId, input.key, input.operationKey),
        database
          .prepare(
            `DELETE FROM guild_r2_objects
             WHERE guild_id = ? AND object_key = ? AND status = 'released'`,
          )
          .bind(input.guildId, input.key),
      ]);
      return readBatchChanges(updated) > 0;
    },

    async releaseExpiredReservations(nowMs, limit): Promise<number> {
      const [updated] = await database.batch([
        database
          .prepare(
            `UPDATE guild_r2_objects SET
               status = CASE WHEN had_committed_object = 1 THEN 'committed'
                 WHEN tombstoned_at_ms IS NOT NULL THEN 'deleted' ELSE 'released' END,
               reserved_bytes = 0, reservation_expires_at_ms = NULL, operation_key = NULL,
               updated_at_ms = ?
             WHERE rowid IN (
               SELECT rowid FROM guild_r2_objects
               WHERE status = 'reserved' AND reservation_expires_at_ms <= ?
                 AND upload_started_at_ms IS NULL
               ORDER BY reservation_expires_at_ms ASC LIMIT ?
             )`,
          )
          .bind(nowMs, nowMs, limit),
        database.prepare(`DELETE FROM guild_r2_objects WHERE status = 'released'`),
      ]);
      return readBatchChanges(updated);
    },

    async listExpiredUploadReservations(nowMs, limit) {
      return db
        .select({
          guildId: guildR2Objects.guildId,
          key: guildR2Objects.objectKey,
          operationKey: guildR2Objects.operationKey,
        })
        .from(guildR2Objects)
        .where(
          and(
            eq(guildR2Objects.status, "reserved"),
            lte(guildR2Objects.reservationExpiresAtMs, nowMs),
            isNotNull(guildR2Objects.uploadStartedAtMs),
            isNotNull(guildR2Objects.operationKey),
          ),
        )
        .limit(limit)
        .all() as Promise<Array<{ guildId: string; key: string; operationKey: string }>>;
    },

    async resolveExpiredUploadReservation(input): Promise<boolean> {
      if (input.actualBytes === null) {
        return store.releaseReservation(input);
      }
      const result = await database
        .prepare(
          `UPDATE guild_r2_objects SET
             status = 'committed', size_bytes = ?, reserved_bytes = 0,
             reservation_expires_at_ms = NULL, operation_key = NULL,
             created_at_ms = ?, updated_at_ms = ?, had_committed_object = 1,
             upload_started_at_ms = NULL, tombstoned_at_ms = NULL
           WHERE guild_id = ? AND object_key = ? AND status = 'reserved'
             AND operation_key = ?`,
        )
        .bind(
          input.actualBytes,
          input.resolvedAtMs,
          input.resolvedAtMs,
          input.guildId,
          input.key,
          input.operationKey,
        )
        .run();
      return (result.meta.changes ?? 0) > 0;
    },
  };

  guildR2ObjectStoreCache.set(database, store);
  return store;
}

async function readGuildUsage(db: AppDrizzleDatabase, guildId: string): Promise<GuildR2Usage> {
  const row = await db
    .select({
      usedBytes: sql<number>`COALESCE(SUM(CASE WHEN ${guildR2Objects.status} IN ('committed', 'reserved') THEN ${guildR2Objects.sizeBytes} ELSE 0 END), 0)`,
      reservedBytes: sql<number>`COALESCE(SUM(CASE WHEN ${guildR2Objects.status} = 'reserved' THEN MAX(${guildR2Objects.reservedBytes} - ${guildR2Objects.sizeBytes}, 0) ELSE 0 END), 0)`,
    })
    .from(guildR2Objects)
    .where(eq(guildR2Objects.guildId, guildId))
    .get();
  const reconciliation = await db
    .select({
      lastReconciledAtMs: sql<number | null>`MAX(${guildR2ReconciliationState.lastReconciledAtMs})`,
    })
    .from(guildR2ReconciliationState)
    .get();
  return {
    usedBytes: row?.usedBytes ?? 0,
    reservedBytes: row?.reservedBytes ?? 0,
    lastReconciledAtMs: reconciliation?.lastReconciledAtMs ?? null,
  };
}

function assertReservationInput(input: {
  reservedBytes: number;
  limitBytes: number;
  expiresAtMs: number;
  nowMs: number;
}): void {
  if (!Number.isSafeInteger(input.reservedBytes) || input.reservedBytes < 0) {
    throw new Error("R2 reservation size must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(input.limitBytes) || input.limitBytes < 0) {
    throw new Error("R2 quota limit must be a non-negative safe integer.");
  }
  if (input.expiresAtMs <= input.nowMs) {
    throw new Error("R2 reservation expiry must be in the future.");
  }
}

function readBatchChanges(result: D1Result | undefined): number {
  return result?.meta.changes ?? 0;
}
