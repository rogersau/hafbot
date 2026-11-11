import type { PostgresDatabaseCapability } from "./postgres-capability";
import { executePostgresCommands } from "./postgres-statements";
import type { BillingDeliveryState, BillingDeliveryStore } from "../billing/delivery";
import type { BillingLedgerOperation } from "../billing/types";

export class PostgresBillingDeliveryStore implements BillingDeliveryStore {
  constructor(private readonly database: PostgresDatabaseCapability) {}
  async read(operationId: string): Promise<BillingDeliveryState | null> {
    const row = await this.database
      .query<Record<string, unknown>>(
        `SELECT l.id, l.owner_id, l.kind, l.source, l.correlation_id, l.summary_json, l.created_at_ms,
       d.owner_dm_status, d.audit_status, d.owner_attempt_count
       FROM billing_operations_ledger l JOIN billing_operation_delivery d ON d.operation_id = l.id
       WHERE l.id = $1`,
        [operationId],
      )
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    return {
      operation: {
        id: String(row.id),
        ownerId: String(row.owner_id),
        kind: String(row.kind),
        source: row.source as BillingLedgerOperation["source"],
        correlationId: typeof row.correlation_id === "string" ? row.correlation_id : null,
        summaryJson: String(row.summary_json),
        createdAtMs: Number(row.created_at_ms),
      },
      ownerDmStatus: row.owner_dm_status as BillingDeliveryState["ownerDmStatus"],
      auditStatus: row.audit_status as BillingDeliveryState["auditStatus"],
      ownerAttemptCount: Number(row.owner_attempt_count),
    };
  }
  async recordAttempt(input: Parameters<BillingDeliveryStore["recordAttempt"]>[0]): Promise<void> {
    await executePostgresCommands(this.database, [
      {
        statement: `INSERT INTO billing_delivery_attempts(id, operation_id, destination, outcome, provider_correlation_id, attempted_at_ms)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        values: [
          input.id,
          input.operationId,
          input.destination,
          input.outcome,
          input.providerCorrelationId,
          input.attemptedAtMs,
        ],
      },
      ...(input.destination === "owner_dm"
        ? [
            {
              statement:
                "UPDATE billing_operation_delivery SET owner_attempt_count = owner_attempt_count + 1, updated_at_ms = $1 WHERE operation_id = $2",
              values: [input.attemptedAtMs, input.operationId],
            },
          ]
        : []),
    ]);
  }
  async markOwnerDelivered(operationId: string, messageId: string, nowMs: number) {
    await this.update(
      "owner_dm_status = 'delivered', owner_dm_message_id = $1",
      operationId,
      messageId,
      nowMs,
    );
  }
  async markOwnerTerminal(operationId: string, reason: string, nowMs: number) {
    const owner = await this.database
      .query<{ owner_id: string }>("SELECT owner_id FROM billing_operations_ledger WHERE id = $1", [
        operationId,
      ])
      .then((rows) => rows[0] ?? null);
    await executePostgresCommands(this.database, [
      {
        statement:
          "UPDATE billing_operation_delivery SET owner_dm_status = 'terminal', terminal_reason = $1, updated_at_ms = $2 WHERE operation_id = $3",
        values: [reason, nowMs, operationId],
      },
      {
        statement: `INSERT INTO billing_support_cases(id, owner_id, kind, status, safe_provider_ids_json, opened_at_ms, updated_at_ms)
           SELECT $1, $2, 'owner_delivery_terminal', 'open', $3, $4, $5 WHERE CAST($6 AS TEXT) IS NOT NULL
           ON CONFLICT(id) DO UPDATE SET status = 'open', updated_at_ms = excluded.updated_at_ms`,
        values: [
          `delivery:${operationId}`,
          owner?.owner_id ?? null,
          JSON.stringify([operationId]),
          nowMs,
          nowMs,
          owner?.owner_id ?? null,
        ],
      },
    ]);
  }
  async markAuditDelivered(operationId: string, messageId: string, nowMs: number) {
    await this.update(
      "audit_status = 'delivered', audit_message_id = $1",
      operationId,
      messageId,
      nowMs,
    );
  }
  async listPendingOutbox(limit = 100): Promise<string[]> {
    const result = await this.database.queryResult<{ operation_id: string }>(
      "SELECT operation_id FROM billing_delivery_outbox WHERE sent_at_ms IS NULL ORDER BY created_at_ms LIMIT $1",
      [limit],
    );
    return result.rows.map((row) => row.operation_id);
  }
  async markOutboxSent(operationId: string, sentAtMs: number): Promise<void> {
    await this.database.queryResult(
      "UPDATE billing_delivery_outbox SET sent_at_ms = COALESCE(sent_at_ms, $1) WHERE operation_id = $2",
      [sentAtMs, operationId],
    );
  }
  async replay(operationId: string, nowMs: number): Promise<void> {
    await executePostgresCommands(this.database, [
      {
        statement:
          "UPDATE billing_operation_delivery SET audit_status = 'pending', updated_at_ms = $1 WHERE operation_id = $2",
        values: [nowMs, operationId],
      },
      {
        statement:
          "INSERT INTO billing_delivery_outbox(operation_id, created_at_ms, sent_at_ms) VALUES ($1, $2, NULL) ON CONFLICT(operation_id) DO UPDATE SET sent_at_ms = NULL",
        values: [operationId, nowMs],
      },
    ]);
  }
  private async update(setClause: string, operationId: string, value: string, nowMs: number) {
    await this.database.queryResult(
      `UPDATE billing_operation_delivery SET ${setClause}, updated_at_ms = $2 WHERE operation_id = $3`,
      [value, nowMs, operationId],
    );
  }
}
