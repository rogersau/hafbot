import type { GuildR2QuotaStore, GuildR2Usage } from "../contracts";
import type { PostgresDatabaseCapability, PostgresExecutor } from "./postgres-capability";
import { isPostgresUniqueViolation, readPostgresSafeInteger } from "./postgres-values";

interface ObjectAccountingRow extends Record<string, unknown> {
  guild_id: string;
  object_key: string;
  size_bytes: string | number;
  status: "committed" | "reserved" | "deleted" | "released";
  reserved_bytes: string | number;
  operation_key: string | null;
  had_committed_object: boolean;
}

interface UsageRow extends Record<string, unknown> {
  used_bytes: string | number;
  reserved_bytes: string | number;
}

const GUILD_ACCOUNTING_LOCK_NAMESPACE = 5_140_822_917;

export function createPostgresGuildObjectStore(
  database: PostgresDatabaseCapability,
): GuildR2QuotaStore {
  const store: GuildR2QuotaStore = {
    async upsertObject(input) {
      assertNonNegativeInteger(input.sizeBytes, "Object size");
      assertTimestamp(input.createdAtMs, "Object creation timestamp");
      await database.execute(
        `INSERT INTO guild_object_accounting (
           guild_id, object_key, size_bytes, created_at_ms, status, reserved_bytes,
           reservation_expires_at_ms, operation_key, updated_at_ms,
           reconciliation_generation, had_committed_object, upload_started_at_ms,
           tombstoned_at_ms
         ) VALUES ($1, $2, $3, $4, 'committed', 0, NULL, NULL, $4, NULL, TRUE, NULL, NULL)
         ON CONFLICT (guild_id, object_key) DO UPDATE SET
           size_bytes = EXCLUDED.size_bytes,
           created_at_ms = EXCLUDED.created_at_ms,
           status = 'committed',
           reserved_bytes = 0,
           reservation_expires_at_ms = NULL,
           operation_key = NULL,
           updated_at_ms = EXCLUDED.updated_at_ms,
           reconciliation_generation = NULL,
           had_committed_object = TRUE,
           upload_started_at_ms = NULL,
           tombstoned_at_ms = NULL
         WHERE guild_object_accounting.status <> 'reserved'
           AND guild_object_accounting.updated_at_ms < EXCLUDED.updated_at_ms`,
        [input.guildId, input.key, input.sizeBytes, input.createdAtMs],
      );
    },

    async deleteObject(input) {
      const deletedAtMs = input.deletedAtMs ?? Date.now();
      assertTimestamp(deletedAtMs, "Object deletion timestamp");
      await database.execute(
        `INSERT INTO guild_object_accounting (
           guild_id, object_key, size_bytes, created_at_ms, status, reserved_bytes,
           reservation_expires_at_ms, operation_key, updated_at_ms,
           reconciliation_generation, had_committed_object, upload_started_at_ms,
           tombstoned_at_ms
         ) VALUES ($1, $2, 0, $3, 'deleted', 0, NULL, NULL, $3, NULL, FALSE, NULL, $3)
         ON CONFLICT (guild_id, object_key) DO UPDATE SET
           size_bytes = 0,
           created_at_ms = EXCLUDED.created_at_ms,
           status = 'deleted',
           reserved_bytes = 0,
           reservation_expires_at_ms = NULL,
           operation_key = NULL,
           updated_at_ms = EXCLUDED.updated_at_ms,
           reconciliation_generation = NULL,
           had_committed_object = FALSE,
           upload_started_at_ms = NULL,
           tombstoned_at_ms = EXCLUDED.tombstoned_at_ms
         WHERE guild_object_accounting.status <> 'reserved'
           AND guild_object_accounting.updated_at_ms <= EXCLUDED.updated_at_ms`,
        [input.guildId, input.key, deletedAtMs],
      );
    },

    async getGuildUsageBytes(guildId) {
      return (await readGuildUsage(database, guildId)).usedBytes;
    },

    async getGuildUsage(guildId) {
      return readGuildUsage(database, guildId);
    },

    async reserveObject(input) {
      assertReservationInput(input);
      try {
        return await database.transaction(async (transaction) => {
          await lockGuildAccounting(transaction, input.guildId);
          const operationOwner = await transaction.query<{ guild_id: string; object_key: string }>(
            `SELECT guild_id, object_key
             FROM guild_object_accounting
             WHERE operation_key = $1`,
            [input.operationKey],
          );
          if (
            operationOwner[0] &&
            (operationOwner[0].guild_id !== input.guildId ||
              operationOwner[0].object_key !== input.key)
          ) {
            return { status: "conflict" } as const;
          }

          const existingRows = await transaction.query<ObjectAccountingRow>(
            `SELECT guild_id, object_key, size_bytes, status, reserved_bytes, operation_key,
                    had_committed_object
             FROM guild_object_accounting
             WHERE guild_id = $1 AND object_key = $2
             FOR UPDATE`,
            [input.guildId, input.key],
          );
          const existing = existingRows[0];
          if (existing?.status === "reserved" && existing.operation_key !== input.operationKey) {
            return { status: "conflict" } as const;
          }

          const usage = await readAccountingUsage(transaction, input.guildId);
          const previousBytes =
            existing?.had_committed_object === true
              ? readPostgresSafeInteger(existing.size_bytes, "guild_object_accounting.size_bytes")
              : 0;
          const existingEffectiveBytes = existing ? effectiveBytes(existing) : 0;
          const replacementEffectiveBytes = Math.max(previousBytes, input.reservedBytes);
          const projectedBytes =
            usage.usedBytes +
            usage.reservedBytes -
            existingEffectiveBytes +
            replacementEffectiveBytes;
          if (projectedBytes > input.limitBytes && input.reservedBytes > previousBytes) {
            return {
              status: "quota-exceeded",
              usage: await readGuildUsage(transaction, input.guildId),
            } as const;
          }

          const retainedSize = existing?.status === "deleted" ? 0 : previousBytes;
          const hadCommitted =
            existing?.status === "deleted" ? false : Boolean(existing?.had_committed_object);
          await transaction.execute(
            `INSERT INTO guild_object_accounting (
               guild_id, object_key, size_bytes, created_at_ms, status, reserved_bytes,
               reservation_expires_at_ms, operation_key, updated_at_ms,
               reconciliation_generation, had_committed_object, upload_started_at_ms,
               tombstoned_at_ms
             ) VALUES ($1, $2, 0, $3, 'reserved', $4, $5, $6, $3, NULL, FALSE, NULL, NULL)
             ON CONFLICT (guild_id, object_key) DO UPDATE SET
               size_bytes = $7,
               status = 'reserved',
               reserved_bytes = EXCLUDED.reserved_bytes,
               reservation_expires_at_ms = EXCLUDED.reservation_expires_at_ms,
               operation_key = EXCLUDED.operation_key,
               updated_at_ms = EXCLUDED.updated_at_ms,
               reconciliation_generation = NULL,
               had_committed_object = $8,
               upload_started_at_ms = NULL`,
            [
              input.guildId,
              input.key,
              input.nowMs,
              input.reservedBytes,
              input.expiresAtMs,
              input.operationKey,
              retainedSize,
              hadCommitted,
            ],
          );
          return { status: "reserved", previousCommittedBytes: previousBytes } as const;
        });
      } catch (error) {
        if (isPostgresUniqueViolation(error)) return { status: "conflict" };
        throw error;
      }
    },

    async commitObject(input) {
      assertNonNegativeInteger(input.actualBytes, "Committed object size");
      const changes = await database.execute(
        `UPDATE guild_object_accounting SET
           status = 'committed',
           size_bytes = $4,
           reserved_bytes = 0,
           reservation_expires_at_ms = NULL,
           operation_key = NULL,
           created_at_ms = $5,
           updated_at_ms = $5,
           had_committed_object = TRUE,
           upload_started_at_ms = NULL,
           tombstoned_at_ms = NULL
         WHERE guild_id = $1 AND object_key = $2 AND status = 'reserved'
           AND operation_key = $3 AND reserved_bytes = $4`,
        [input.guildId, input.key, input.operationKey, input.actualBytes, input.committedAtMs],
      );
      return changes === 1;
    },

    async markUploadStarted(input) {
      const changes = await database.execute(
        `UPDATE guild_object_accounting
         SET upload_started_at_ms = $4, updated_at_ms = $4
         WHERE guild_id = $1 AND object_key = $2 AND status = 'reserved'
           AND operation_key = $3`,
        [input.guildId, input.key, input.operationKey, input.startedAtMs],
      );
      return changes === 1;
    },

    async releaseReservation(input) {
      return database.transaction(async (transaction) => {
        const changes = await transaction.execute(
          `UPDATE guild_object_accounting SET
             status = CASE
               WHEN had_committed_object THEN 'committed'
               WHEN tombstoned_at_ms IS NOT NULL THEN 'deleted'
               ELSE 'released'
             END,
             reserved_bytes = 0,
             reservation_expires_at_ms = NULL,
             operation_key = NULL,
             upload_started_at_ms = NULL
           WHERE guild_id = $1 AND object_key = $2 AND status = 'reserved'
             AND operation_key = $3`,
          [input.guildId, input.key, input.operationKey],
        );
        await transaction.execute(
          `DELETE FROM guild_object_accounting
           WHERE guild_id = $1 AND object_key = $2 AND status = 'released'`,
          [input.guildId, input.key],
        );
        return changes === 1;
      });
    },

    async releaseExpiredReservations(nowMs, limit) {
      assertPositiveLimit(limit);
      return database.transaction(async (transaction) => {
        const released = await transaction.query<{ guild_id: string; object_key: string }>(
          `WITH candidates AS (
             SELECT guild_id, object_key
             FROM guild_object_accounting
             WHERE status = 'reserved'
               AND reservation_expires_at_ms <= $1
               AND upload_started_at_ms IS NULL
             ORDER BY reservation_expires_at_ms, guild_id, object_key
             FOR UPDATE SKIP LOCKED
             LIMIT $2
           )
           UPDATE guild_object_accounting AS objects SET
             status = CASE
               WHEN objects.had_committed_object THEN 'committed'
               WHEN objects.tombstoned_at_ms IS NOT NULL THEN 'deleted'
               ELSE 'released'
             END,
             reserved_bytes = 0,
             reservation_expires_at_ms = NULL,
             operation_key = NULL,
             upload_started_at_ms = NULL,
             updated_at_ms = $1
           FROM candidates
           WHERE objects.guild_id = candidates.guild_id
             AND objects.object_key = candidates.object_key
           RETURNING objects.guild_id, objects.object_key`,
          [nowMs, limit],
        );
        await transaction.execute("DELETE FROM guild_object_accounting WHERE status = 'released'");
        return released.length;
      });
    },

    async listExpiredUploadReservations(nowMs, limit) {
      assertPositiveLimit(limit);
      return database
        .query<{
          guild_id: string;
          object_key: string;
          operation_key: string;
        }>(
          `SELECT guild_id, object_key, operation_key
         FROM guild_object_accounting
         WHERE status = 'reserved'
           AND reservation_expires_at_ms <= $1
           AND upload_started_at_ms IS NOT NULL
           AND operation_key IS NOT NULL
         ORDER BY reservation_expires_at_ms, guild_id, object_key
         LIMIT $2`,
          [nowMs, limit],
        )
        .then((rows) =>
          rows.map((row) => ({
            guildId: row.guild_id,
            key: row.object_key,
            operationKey: row.operation_key,
          })),
        );
    },

    async resolveExpiredUploadReservation(input) {
      const changes =
        input.actualBytes === null
          ? await store.releaseReservation(input)
          : (await database.execute(
              `UPDATE guild_object_accounting SET
                 status = 'committed',
                 size_bytes = $4,
                 reserved_bytes = 0,
                 reservation_expires_at_ms = NULL,
                 operation_key = NULL,
                 created_at_ms = $5,
                 updated_at_ms = $5,
                 had_committed_object = TRUE,
                 upload_started_at_ms = NULL,
                 tombstoned_at_ms = NULL
               WHERE guild_id = $1 AND object_key = $2 AND status = 'reserved'
                 AND operation_key = $3`,
              [input.guildId, input.key, input.operationKey, input.actualBytes, input.resolvedAtMs],
            )) === 1;
      return changes;
    },
  };
  return store;
}

async function lockGuildAccounting(transaction: PostgresExecutor, guildId: string): Promise<void> {
  await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, $2))", [
    guildId,
    GUILD_ACCOUNTING_LOCK_NAMESPACE,
  ]);
}

async function readAccountingUsage(
  database: PostgresExecutor,
  guildId: string,
): Promise<{ usedBytes: number; reservedBytes: number }> {
  const rows = await database.query<UsageRow>(
    `SELECT
       COALESCE(SUM(CASE WHEN status IN ('committed', 'reserved') THEN size_bytes ELSE 0 END), 0) AS used_bytes,
       COALESCE(SUM(CASE WHEN status = 'reserved' THEN GREATEST(reserved_bytes - size_bytes, 0) ELSE 0 END), 0) AS reserved_bytes
     FROM guild_object_accounting
     WHERE guild_id = $1`,
    [guildId],
  );
  return {
    usedBytes: readPostgresSafeInteger(rows[0]?.used_bytes ?? 0, "object usage used_bytes"),
    reservedBytes: readPostgresSafeInteger(
      rows[0]?.reserved_bytes ?? 0,
      "object usage reserved_bytes",
    ),
  };
}

async function readGuildUsage(database: PostgresExecutor, guildId: string): Promise<GuildR2Usage> {
  const usage = await readAccountingUsage(database, guildId);
  const reconciliation = await database.query<{ last_reconciled_at_ms: string | number | null }>(
    `SELECT MAX(last_reconciled_at_ms) AS last_reconciled_at_ms
     FROM guild_object_reconciliation_state`,
  );
  const last = reconciliation[0]?.last_reconciled_at_ms ?? null;
  return {
    ...usage,
    lastReconciledAtMs:
      last === null
        ? null
        : readPostgresSafeInteger(last, "guild_object_reconciliation_state.last_reconciled_at_ms"),
  };
}

function effectiveBytes(row: ObjectAccountingRow): number {
  if (row.status === "deleted" || row.status === "released") return 0;
  const size = readPostgresSafeInteger(row.size_bytes, "guild_object_accounting.size_bytes");
  if (row.status !== "reserved") return size;
  return Math.max(
    size,
    readPostgresSafeInteger(row.reserved_bytes, "guild_object_accounting.reserved_bytes"),
  );
}

function assertReservationInput(input: {
  reservedBytes: number;
  limitBytes: number;
  expiresAtMs: number;
  nowMs: number;
}): void {
  assertNonNegativeInteger(input.reservedBytes, "Object reservation size");
  assertNonNegativeInteger(input.limitBytes, "Object quota limit");
  assertTimestamp(input.nowMs, "Object reservation timestamp");
  assertTimestamp(input.expiresAtMs, "Object reservation expiry");
  if (input.expiresAtMs <= input.nowMs) {
    throw new Error("Object reservation expiry must be in the future.");
  }
}

function assertTimestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be valid.`);
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
}

function assertPositiveLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new Error("Object accounting batch limit must be between 1 and 10000.");
  }
}
