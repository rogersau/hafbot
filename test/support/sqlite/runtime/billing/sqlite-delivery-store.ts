import type {
  BillingDeliveryState,
  BillingDeliveryStore,
} from "../../../../../src/runtime/billing/delivery";
import type { BillingLedgerOperation } from "../../../../../src/runtime/billing/types";

export class SqliteBillingDeliveryStore implements BillingDeliveryStore {
  constructor(private readonly database: D1Database) {}
  async read(operationId: string): Promise<BillingDeliveryState | null> {
    const row = await this.database
      .prepare(
        `SELECT l.id, l.owner_id, l.kind, l.source, l.correlation_id, l.summary_json, l.created_at_ms,
       d.owner_dm_status, d.audit_status, d.owner_attempt_count
       FROM billing_operations_ledger l JOIN billing_operation_delivery d ON d.operation_id = l.id
       WHERE l.id = ?`,
      )
      .bind(operationId)
      .first<Record<string, unknown>>();
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
    await this.database.batch([
      this.database
        .prepare(
          `INSERT INTO billing_delivery_attempts(id, operation_id, destination, outcome, provider_correlation_id, attempted_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.id,
          input.operationId,
          input.destination,
          input.outcome,
          input.providerCorrelationId,
          input.attemptedAtMs,
        ),
      ...(input.destination === "owner_dm"
        ? [
            this.database
              .prepare(
                "UPDATE billing_operation_delivery SET owner_attempt_count = owner_attempt_count + 1, updated_at_ms = ? WHERE operation_id = ?",
              )
              .bind(input.attemptedAtMs, input.operationId),
          ]
        : []),
    ]);
  }
  async markOwnerDelivered(operationId: string, messageId: string, nowMs: number) {
    await this.update(
      "owner_dm_status = 'delivered', owner_dm_message_id = ?",
      operationId,
      messageId,
      nowMs,
    );
  }
  async markOwnerTerminal(operationId: string, reason: string, nowMs: number) {
    const owner = await this.database
      .prepare("SELECT owner_id FROM billing_operations_ledger WHERE id = ?")
      .bind(operationId)
      .first<{ owner_id: string }>();
    await this.database.batch([
      this.database
        .prepare(
          "UPDATE billing_operation_delivery SET owner_dm_status = 'terminal', terminal_reason = ?, updated_at_ms = ? WHERE operation_id = ?",
        )
        .bind(reason, nowMs, operationId),
      this.database
        .prepare(
          `INSERT INTO billing_support_cases(id, owner_id, kind, status, safe_provider_ids_json, opened_at_ms, updated_at_ms)
           SELECT ?, ?, 'owner_delivery_terminal', 'open', ?, ?, ? WHERE CAST(? AS TEXT) IS NOT NULL
           ON CONFLICT(id) DO UPDATE SET status = 'open', updated_at_ms = excluded.updated_at_ms`,
        )
        .bind(
          `delivery:${operationId}`,
          owner?.owner_id ?? null,
          JSON.stringify([operationId]),
          nowMs,
          nowMs,
          owner?.owner_id ?? null,
        ),
    ]);
  }
  async markAuditDelivered(operationId: string, messageId: string, nowMs: number) {
    await this.update(
      "audit_status = 'delivered', audit_message_id = ?",
      operationId,
      messageId,
      nowMs,
    );
  }
  async listPendingOutbox(limit = 100): Promise<string[]> {
    const result = await this.database
      .prepare(
        "SELECT operation_id FROM billing_delivery_outbox WHERE sent_at_ms IS NULL ORDER BY created_at_ms LIMIT ?",
      )
      .bind(limit)
      .all<{ operation_id: string }>();
    return result.results.map((row) => row.operation_id);
  }
  async markOutboxSent(operationId: string, sentAtMs: number): Promise<void> {
    await this.database
      .prepare(
        "UPDATE billing_delivery_outbox SET sent_at_ms = COALESCE(sent_at_ms, ?) WHERE operation_id = ?",
      )
      .bind(sentAtMs, operationId)
      .run();
  }
  async replay(operationId: string, nowMs: number): Promise<void> {
    await this.database.batch([
      this.database
        .prepare(
          "UPDATE billing_operation_delivery SET audit_status = 'pending', updated_at_ms = ? WHERE operation_id = ?",
        )
        .bind(nowMs, operationId),
      this.database
        .prepare(
          "INSERT INTO billing_delivery_outbox(operation_id, created_at_ms, sent_at_ms) VALUES (?, ?, NULL) ON CONFLICT(operation_id) DO UPDATE SET sent_at_ms = NULL",
        )
        .bind(operationId, nowMs),
    ]);
  }
  private async update(setClause: string, operationId: string, value: string, nowMs: number) {
    await this.database
      .prepare(
        `UPDATE billing_operation_delivery SET ${setClause}, updated_at_ms = ? WHERE operation_id = ?`,
      )
      .bind(value, nowMs, operationId)
      .run();
  }
}
