import type {
  GatewayEventOperationStore,
  GatewayEventOperationReceipt,
} from "../../src/runtime/gateway-event-idempotency";
interface OperationRow {
  event_key: string;
  handler_key: string;
  state: "processing" | "completed" | "terminal";
  lease_token: string | null;
  lease_expires_at_ms: number | null;
  attempts: number;
  outcome_code: string | null;
  outcome_json: string | null;
  completed_at_ms: number | null;
}

export function createGatewayEventOperationStore(database: D1Database): GatewayEventOperationStore {
  return {
    async claim(eventKey, handlerKey, nowMs, leaseDurationMs) {
      const leaseToken = crypto.randomUUID();
      const leaseExpiresAtMs = nowMs + Math.max(1, Math.floor(leaseDurationMs));
      await database
        .prepare(
          `INSERT INTO gateway_event_operations (
             event_key, handler_key, state, lease_token, lease_expires_at_ms,
             attempts, outcome_code, outcome_json, created_at_ms, updated_at_ms, completed_at_ms
           ) VALUES (?, ?, 'processing', ?, ?, 1, NULL, NULL, ?, ?, NULL)
           ON CONFLICT(event_key, handler_key) DO UPDATE SET
             lease_token = excluded.lease_token,
             lease_expires_at_ms = excluded.lease_expires_at_ms,
             attempts = gateway_event_operations.attempts + 1,
             updated_at_ms = excluded.updated_at_ms
           WHERE gateway_event_operations.state = 'processing'
             AND gateway_event_operations.lease_expires_at_ms <= excluded.updated_at_ms`,
        )
        .bind(eventKey, handlerKey, leaseToken, leaseExpiresAtMs, nowMs, nowMs)
        .run();

      const row = await readRow(database, eventKey, handlerKey);
      if (!row) throw new Error("Gateway Event operation claim was not persisted.");
      if (row.state === "completed" || row.state === "terminal") {
        return {
          status: row.state,
          outcomeCode: row.outcome_code,
          outcomeJson: row.outcome_json,
        };
      }
      if (row.lease_token !== leaseToken) {
        return { status: "busy", leaseExpiresAtMs: row.lease_expires_at_ms ?? nowMs };
      }
      return {
        status: row.attempts === 1 ? "acquired" : "reclaimed",
        leaseToken,
        attempts: row.attempts,
      };
    },

    complete(leaseToken, eventKey, handlerKey, nowMs, outcomeCode, outcomeJson) {
      return finishOperation(
        database,
        "completed",
        leaseToken,
        eventKey,
        handlerKey,
        nowMs,
        outcomeCode,
        outcomeJson,
      );
    },

    terminal(leaseToken, eventKey, handlerKey, nowMs, outcomeCode) {
      return finishOperation(
        database,
        "terminal",
        leaseToken,
        eventKey,
        handlerKey,
        nowMs,
        outcomeCode,
        null,
      );
    },

    async renew(leaseToken, eventKey, handlerKey, nowMs, leaseDurationMs) {
      const result = await database
        .prepare(
          `UPDATE gateway_event_operations
           SET lease_expires_at_ms = ?, updated_at_ms = ?
           WHERE event_key = ? AND handler_key = ?
             AND state = 'processing' AND lease_token = ?`,
        )
        .bind(
          nowMs + Math.max(1, Math.floor(leaseDurationMs)),
          nowMs,
          eventKey,
          handlerKey,
          leaseToken,
        )
        .run();
      return (result.meta.changes ?? 0) === 1;
    },

    async read(eventKey, handlerKey) {
      const row = await readRow(database, eventKey, handlerKey);
      return row ? mapRow(row) : null;
    },

    async cleanupCompletedBefore(cutoffMs) {
      const reactionResults = await database
        .prepare(
          `DELETE FROM gateway_reaction_limit_mutations
           WHERE result_one IS NOT NULL AND created_at_ms < ?
             AND EXISTS (
               SELECT 1 FROM gateway_event_operations
               WHERE gateway_event_operations.event_key = gateway_reaction_limit_mutations.event_key
                 AND gateway_event_operations.handler_key = CASE gateway_reaction_limit_mutations.mutation_kind
                   WHEN 'counters' THEN 'reaction-add:reaction-limit:counters'
                   WHEN 'breach' THEN 'reaction-add:reaction-limit:breach-increment'
                   WHEN 'timed-role-expiry' THEN 'reaction-add:reaction-limit:timed-role'
                 END
                 AND gateway_event_operations.state IN ('completed', 'terminal')
             )`,
        )
        .bind(cutoffMs)
        .run();
      const result = await database
        .prepare(
          `DELETE FROM gateway_event_operations
           WHERE state IN ('completed', 'terminal') AND completed_at_ms < ?`,
        )
        .bind(cutoffMs)
        .run();
      return (result.meta.changes ?? 0) + (reactionResults.meta.changes ?? 0);
    },
  };
}

async function finishOperation(
  database: D1Database,
  state: "completed" | "terminal",
  leaseToken: string,
  eventKey: string,
  handlerKey: string,
  nowMs: number,
  outcomeCode: string,
  outcomeJson: string | null = null,
): Promise<boolean> {
  const result = await database
    .prepare(
      `UPDATE gateway_event_operations
       SET state = ?, lease_token = NULL, lease_expires_at_ms = NULL,
           outcome_code = ?, outcome_json = ?, updated_at_ms = ?, completed_at_ms = ?
       WHERE event_key = ? AND handler_key = ? AND state = 'processing' AND lease_token = ?`,
    )
    .bind(
      state,
      safeOutcomeCode(outcomeCode),
      outcomeJson,
      nowMs,
      nowMs,
      eventKey,
      handlerKey,
      leaseToken,
    )
    .run();
  return (result.meta.changes ?? 0) === 1;
}

async function readRow(
  database: D1Database,
  eventKey: string,
  handlerKey: string,
): Promise<OperationRow | null> {
  return database
    .prepare(
      `SELECT event_key, handler_key, state, lease_token, lease_expires_at_ms,
              attempts, outcome_code, outcome_json, completed_at_ms
       FROM gateway_event_operations WHERE event_key = ? AND handler_key = ?`,
    )
    .bind(eventKey, handlerKey)
    .first<OperationRow>();
}

function mapRow(row: OperationRow): GatewayEventOperationReceipt {
  return {
    eventKey: row.event_key,
    handlerKey: row.handler_key,
    state: row.state,
    leaseExpiresAtMs: row.lease_expires_at_ms,
    attempts: row.attempts,
    outcomeCode: row.outcome_code,
    outcomeJson: row.outcome_json,
    completedAtMs: row.completed_at_ms,
  };
}

function safeOutcomeCode(value: string): string {
  return /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(value) ? value : "invalid_outcome";
}
