import { createSqliteGuildR2ObjectStore } from "./sqlite-guild-r2-object-store";

const R2_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export interface R2QuotaReconciliationResult {
  scannedObjects: number;
  releasedReservations: number;
  resolvedUploadReservations: number;
  completed: boolean;
  cursor: string | null;
}

export async function reconcileGuildR2ObjectsPage(input: {
  database: D1Database;
  bucket: R2Bucket;
  bucketId: string;
  nowMs?: number;
  pageSize?: number;
}): Promise<R2QuotaReconciliationResult> {
  const nowMs = input.nowMs ?? Date.now();
  const pageSize = input.pageSize ?? 250;
  const store = createSqliteGuildR2ObjectStore(input.database);
  const releasedReservations = await store.releaseExpiredReservations(nowMs, pageSize);
  const expiredUploads = await store.listExpiredUploadReservations(nowMs, pageSize);
  let resolvedUploadReservations = 0;
  for (const reservation of expiredUploads) {
    let object: R2Object | null;
    try {
      object = await input.bucket.head(reservation.key);
    } catch {
      continue;
    }
    if (
      await store.resolveExpiredUploadReservation({
        ...reservation,
        actualBytes: object?.size ?? null,
        resolvedAtMs: nowMs,
      })
    ) {
      resolvedUploadReservations += 1;
    }
  }
  const state = await readOrCreateState(input.database, input.bucketId, nowMs);
  const listed = await input.bucket.list({
    cursor: state.cursor ?? undefined,
    limit: pageSize,
  });

  if (listed.objects.length > 0) {
    await input.database.batch(
      listed.objects
        .map((object) => ({ object, guildId: readGuildId(object.key) }))
        .filter((entry): entry is { object: R2Object; guildId: string } => entry.guildId !== null)
        .map(({ object, guildId }) =>
          input.database
            .prepare(
              `INSERT INTO guild_r2_objects
                 (guild_id, object_key, size_bytes, created_at_ms, status, reserved_bytes,
                  reservation_expires_at_ms, operation_key, updated_at_ms,
                  reconciliation_generation, had_committed_object, upload_started_at_ms,
                  tombstoned_at_ms)
               VALUES (?, ?, ?, ?, 'committed', 0, NULL, NULL, ?, ?, 1, NULL, NULL)
               ON CONFLICT(guild_id, object_key) DO UPDATE SET
                 size_bytes = excluded.size_bytes,
                 created_at_ms = excluded.created_at_ms,
                 status = 'committed',
                 reserved_bytes = 0,
                 reservation_expires_at_ms = NULL,
                 operation_key = NULL,
                 updated_at_ms = excluded.updated_at_ms,
                 reconciliation_generation = excluded.reconciliation_generation,
                 had_committed_object = 1,
                 upload_started_at_ms = NULL,
                 tombstoned_at_ms = NULL
               WHERE guild_r2_objects.status <> 'reserved'`,
            )
            .bind(
              guildId,
              object.key,
              object.size,
              object.uploaded.getTime(),
              nowMs,
              state.generation,
            ),
        ),
    );
  }

  const nextCursor = listed.truncated ? (listed.cursor ?? null) : null;
  if (listed.truncated) {
    if (!nextCursor)
      throw new Error("R2 returned a truncated reconciliation page without a cursor.");
    await writeState(input.database, {
      bucketId: input.bucketId,
      cursor: nextCursor,
      generation: state.generation,
      startedAtMs: state.startedAtMs,
      lastReconciledAtMs: state.lastReconciledAtMs,
      updatedAtMs: nowMs,
    });
  } else {
    await input.database.batch([
      input.database
        .prepare(
          `UPDATE guild_r2_objects SET
             size_bytes = 0, status = 'deleted', reserved_bytes = 0,
             reservation_expires_at_ms = NULL, operation_key = NULL,
             updated_at_ms = ?, reconciliation_generation = NULL,
             had_committed_object = 0, upload_started_at_ms = NULL,
             tombstoned_at_ms = ?
           WHERE status = 'committed'
             AND COALESCE(reconciliation_generation, -1) <> ?
             AND updated_at_ms < ?`,
        )
        .bind(nowMs, nowMs, state.generation, state.startedAtMs),
      input.database
        .prepare(
          `DELETE FROM guild_r2_objects
           WHERE status = 'deleted' AND tombstoned_at_ms <= ?`,
        )
        .bind(nowMs - R2_TOMBSTONE_RETENTION_MS),
      input.database
        .prepare(
          `UPDATE guild_r2_reconciliation_state SET
             cursor = NULL, generation = ?, started_at_ms = NULL,
             last_reconciled_at_ms = ?, updated_at_ms = ?
           WHERE bucket_id = ?`,
        )
        .bind(state.generation + 1, nowMs, nowMs, input.bucketId),
    ]);
  }

  return {
    scannedObjects: listed.objects.length,
    releasedReservations,
    resolvedUploadReservations,
    completed: !listed.truncated,
    cursor: nextCursor,
  };
}

interface ReconciliationState {
  cursor: string | null;
  generation: number;
  startedAtMs: number;
  lastReconciledAtMs: number | null;
}

async function readOrCreateState(
  database: D1Database,
  bucketId: string,
  nowMs: number,
): Promise<ReconciliationState> {
  await database
    .prepare(
      `INSERT OR IGNORE INTO guild_r2_reconciliation_state
         (bucket_id, cursor, generation, started_at_ms, last_reconciled_at_ms, updated_at_ms)
       VALUES (?, NULL, 1, ?, NULL, ?)`,
    )
    .bind(bucketId, nowMs, nowMs)
    .run();
  await database
    .prepare(
      `UPDATE guild_r2_reconciliation_state
       SET started_at_ms = ?, updated_at_ms = ?
       WHERE bucket_id = ? AND cursor IS NULL AND started_at_ms IS NULL`,
    )
    .bind(nowMs, nowMs, bucketId)
    .run();
  const row = await database
    .prepare(
      `SELECT cursor, generation, started_at_ms AS "startedAtMs",
              last_reconciled_at_ms AS "lastReconciledAtMs"
       FROM guild_r2_reconciliation_state WHERE bucket_id = ?`,
    )
    .bind(bucketId)
    .first<ReconciliationState>();
  if (!row) throw new Error(`R2 reconciliation state was not created for ${bucketId}.`);
  return row;
}

async function writeState(
  database: D1Database,
  input: {
    bucketId: string;
    cursor: string | null;
    generation: number;
    startedAtMs: number;
    lastReconciledAtMs: number | null;
    updatedAtMs: number;
  },
): Promise<void> {
  await database
    .prepare(
      `UPDATE guild_r2_reconciliation_state SET
         cursor = ?, generation = ?, started_at_ms = ?,
         last_reconciled_at_ms = ?, updated_at_ms = ?
       WHERE bucket_id = ?`,
    )
    .bind(
      input.cursor,
      input.generation,
      input.startedAtMs,
      input.lastReconciledAtMs,
      input.updatedAtMs,
      input.bucketId,
    )
    .run();
}

function readGuildId(key: string): string | null {
  const [guildId] = key.split("/");
  return guildId?.trim() ? guildId : null;
}
