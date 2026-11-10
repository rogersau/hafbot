import type { ObjectStore } from "../runtime/object-store";
import type { PostgresDatabaseCapability } from "../runtime/postgres/postgres-capability";
import type { GuildR2QuotaStore } from "../runtime/contracts";
import { readPostgresSafeInteger } from "../runtime/postgres/postgres-values";

const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60_000;

export interface PortableObjectReconciliationResult {
  scannedObjects: number;
  releasedReservations: number;
  resolvedUploadReservations: number;
  completed: boolean;
  cursor: string | null;
}

export async function reconcilePortableObjectsPage(input: {
  database: PostgresDatabaseCapability;
  objects: ObjectStore;
  guildObjects: GuildR2QuotaStore;
  bucketId: string;
  nowMs?: number;
  pageSize?: number;
}): Promise<PortableObjectReconciliationResult> {
  const nowMs = input.nowMs ?? Date.now();
  const pageSize = readPageSize(input.pageSize ?? 250);
  const releasedReservations = await input.guildObjects.releaseExpiredReservations(nowMs, pageSize);
  const expiredUploads = await input.guildObjects.listExpiredUploadReservations(nowMs, pageSize);
  let resolvedUploadReservations = 0;
  for (const reservation of expiredUploads) {
    let sizeBytes: number | null;
    try {
      sizeBytes = (await input.objects.head(reservation.key))?.sizeBytes ?? null;
    } catch {
      continue;
    }
    if (
      await input.guildObjects.resolveExpiredUploadReservation({
        ...reservation,
        actualBytes: sizeBytes,
        resolvedAtMs: nowMs,
      })
    ) {
      resolvedUploadReservations += 1;
    }
  }

  const state = await readOrCreateState(input.database, input.bucketId, nowMs);
  const page = await input.objects.list({
    prefix: "",
    cursor: state.cursor ?? undefined,
    limit: pageSize,
  });
  await input.database.transaction(async (transaction) => {
    for (const object of page.objects) {
      const guildId = readGuildId(object.key);
      if (!guildId) continue;
      const createdAtMs = object.uploadedAt?.getTime() ?? nowMs;
      await transaction.execute(
        `INSERT INTO guild_object_accounting (
           guild_id, object_key, size_bytes, created_at_ms, status, reserved_bytes,
           reservation_expires_at_ms, operation_key, updated_at_ms,
           reconciliation_generation, had_committed_object, upload_started_at_ms,
           tombstoned_at_ms
         ) VALUES ($1, $2, $3, $4, 'committed', 0, NULL, NULL, $5, $6, TRUE, NULL, NULL)
         ON CONFLICT (guild_id, object_key) DO UPDATE SET
           size_bytes = EXCLUDED.size_bytes,
           created_at_ms = EXCLUDED.created_at_ms,
           status = 'committed',
           reserved_bytes = 0,
           reservation_expires_at_ms = NULL,
           operation_key = NULL,
           updated_at_ms = EXCLUDED.updated_at_ms,
           reconciliation_generation = EXCLUDED.reconciliation_generation,
           had_committed_object = TRUE,
           upload_started_at_ms = NULL,
           tombstoned_at_ms = NULL
         WHERE guild_object_accounting.status <> 'reserved'`,
        [guildId, object.key, object.sizeBytes, createdAtMs, nowMs, state.generation],
      );
    }
  });

  const nextCursor = page.cursor;
  if (nextCursor) {
    await writeState(input.database, {
      bucketId: input.bucketId,
      cursor: nextCursor,
      generation: state.generation,
      startedAtMs: state.startedAtMs,
      lastReconciledAtMs: state.lastReconciledAtMs,
      updatedAtMs: nowMs,
    });
  } else {
    await input.database.transaction(async (transaction) => {
      await transaction.execute(
        `UPDATE guild_object_accounting SET
           size_bytes = 0,
           status = 'deleted',
           reserved_bytes = 0,
           reservation_expires_at_ms = NULL,
           operation_key = NULL,
           updated_at_ms = $1,
           reconciliation_generation = NULL,
           had_committed_object = FALSE,
           upload_started_at_ms = NULL,
           tombstoned_at_ms = $1
         WHERE status = 'committed'
           AND COALESCE(reconciliation_generation, -1) <> $2
           AND updated_at_ms < $3`,
        [nowMs, state.generation, state.startedAtMs],
      );
      await transaction.execute(
        `DELETE FROM guild_object_accounting
          WHERE status = 'deleted' AND tombstoned_at_ms <= $1`,
        [nowMs - TOMBSTONE_RETENTION_MS],
      );
      await transaction.execute(
        `UPDATE guild_object_reconciliation_state SET
           cursor = NULL,
           generation = $1,
           started_at_ms = NULL,
           last_reconciled_at_ms = $2,
           updated_at_ms = $2
         WHERE bucket_id = $3`,
        [state.generation + 1, nowMs, input.bucketId],
      );
    });
  }

  return {
    scannedObjects: page.objects.length,
    releasedReservations,
    resolvedUploadReservations,
    completed: nextCursor === null,
    cursor: nextCursor,
  };
}

interface ReconciliationStateRow extends Record<string, unknown> {
  cursor: string | null;
  generation: string | number;
  started_at_ms: string | number | null;
  last_reconciled_at_ms: string | number | null;
}

interface ReconciliationState {
  cursor: string | null;
  generation: number;
  startedAtMs: number;
  lastReconciledAtMs: number | null;
}

async function readOrCreateState(
  database: PostgresDatabaseCapability,
  bucketId: string,
  nowMs: number,
): Promise<ReconciliationState> {
  await database.execute(
    `INSERT INTO guild_object_reconciliation_state (
       bucket_id, cursor, generation, started_at_ms, last_reconciled_at_ms, updated_at_ms
     ) VALUES ($1, NULL, 1, $2, NULL, $2)
     ON CONFLICT (bucket_id) DO NOTHING`,
    [bucketId, nowMs],
  );
  await database.execute(
    `UPDATE guild_object_reconciliation_state
        SET started_at_ms = $1, updated_at_ms = $1
      WHERE bucket_id = $2 AND cursor IS NULL AND started_at_ms IS NULL`,
    [nowMs, bucketId],
  );
  const row = (
    await database.query<ReconciliationStateRow>(
      `SELECT cursor, generation, started_at_ms, last_reconciled_at_ms
         FROM guild_object_reconciliation_state
        WHERE bucket_id = $1`,
      [bucketId],
    )
  )[0];
  if (!row || row.started_at_ms === null) {
    throw new Error(`Object reconciliation state was not created for ${bucketId}.`);
  }
  return {
    cursor: row.cursor,
    generation: readPostgresSafeInteger(row.generation, "object reconciliation generation"),
    startedAtMs: readPostgresSafeInteger(row.started_at_ms, "object reconciliation start"),
    lastReconciledAtMs:
      row.last_reconciled_at_ms === null
        ? null
        : readPostgresSafeInteger(row.last_reconciled_at_ms, "object reconciliation completion"),
  };
}

async function writeState(
  database: PostgresDatabaseCapability,
  input: {
    bucketId: string;
    cursor: string;
    generation: number;
    startedAtMs: number;
    lastReconciledAtMs: number | null;
    updatedAtMs: number;
  },
): Promise<void> {
  await database.execute(
    `UPDATE guild_object_reconciliation_state SET
       cursor = $1,
       generation = $2,
       started_at_ms = $3,
       last_reconciled_at_ms = $4,
       updated_at_ms = $5
     WHERE bucket_id = $6`,
    [
      input.cursor,
      input.generation,
      input.startedAtMs,
      input.lastReconciledAtMs,
      input.updatedAtMs,
      input.bucketId,
    ],
  );
}

function readGuildId(key: string): string | null {
  const [guildId] = key.split("/");
  return guildId?.trim() ? guildId : null;
}

function readPageSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new Error("Object reconciliation page size must be between 1 and 1000.");
  }
  return value;
}
