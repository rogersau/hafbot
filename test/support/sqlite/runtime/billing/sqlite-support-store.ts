import type {
  BillingSupportCase,
  BillingSupportStore,
} from "../../../../../src/runtime/billing/support";
import type { BillingLedgerOperation } from "../../../../../src/runtime/billing/types";
import { SqliteBillingHistoryStore } from "./history";
import { SqliteBillingSyncStore } from "./sqlite-billing-sync-store";
import { SqliteBillingAssignmentStore } from "./sqlite-assignment-store";

export class SqliteBillingSupportStore implements BillingSupportStore {
  private readonly history: SqliteBillingHistoryStore;
  private readonly billing: SqliteBillingSyncStore;
  private readonly assignments: SqliteBillingAssignmentStore;
  constructor(private readonly database: D1Database) {
    this.history = new SqliteBillingHistoryStore(database);
    this.billing = new SqliteBillingSyncStore(database);
    this.assignments = new SqliteBillingAssignmentStore(database);
  }
  listOwnerHistory(ownerId: string, limit?: number) {
    return this.history.listOwnerHistory(ownerId, limit);
  }
  readProjection(ownerId: string) {
    return this.billing.readProjection(ownerId);
  }
  listAssignments(ownerId: string) {
    return this.assignments.listAssignments(ownerId);
  }
  async listCases() {
    return this.readCases();
  }
  async readCase(caseId: string) {
    return (await this.readCases(caseId))[0] ?? null;
  }
  private async readCases(caseId?: string): Promise<BillingSupportCase[]> {
    const result = await this.database
      .prepare(
        `SELECT id, owner_id, kind, status, safe_provider_ids_json, opened_at_ms, updated_at_ms, resolved_at_ms
       FROM billing_support_cases ${caseId ? "WHERE id = ?" : ""} ORDER BY updated_at_ms DESC`,
      )
      .bind(...(caseId ? [caseId] : []))
      .all<Record<string, unknown>>();
    return result.results.map((row) => ({
      id: String(row.id),
      ownerId: String(row.owner_id),
      kind: String(row.kind),
      status: String(row.status),
      safeProviderIdsJson: String(row.safe_provider_ids_json),
      openedAtMs: Number(row.opened_at_ms),
      updatedAtMs: Number(row.updated_at_ms),
      resolvedAtMs: typeof row.resolved_at_ms === "number" ? row.resolved_at_ms : null,
    }));
  }
  async listDeliveryAttempts(ownerId: string): Promise<unknown[]> {
    const result = await this.database
      .prepare(
        `SELECT a.id, a.operation_id, a.destination, a.outcome, a.provider_correlation_id, a.attempted_at_ms
       FROM billing_delivery_attempts a JOIN billing_operations_ledger l ON l.id = a.operation_id
       WHERE l.owner_id = ? ORDER BY a.attempted_at_ms DESC`,
      )
      .bind(ownerId)
      .all();
    return result.results;
  }
  async setCaseStatus(caseId: string, status: string, nowMs: number) {
    if (!["open", "investigating", "resolved"].includes(status))
      throw new Error("invalid_case_status");
    await this.database
      .prepare(
        "UPDATE billing_support_cases SET status = ?, updated_at_ms = ?, resolved_at_ms = CASE WHEN ? = 'resolved' THEN ? ELSE NULL END WHERE id = ?",
      )
      .bind(status, nowMs, status, nowMs, caseId)
      .run();
  }
  async appendSupportOperation(operation: BillingLedgerOperation) {
    await this.database.batch([
      this.database
        .prepare(
          "INSERT INTO billing_operations_ledger(id, owner_id, kind, source, correlation_id, summary_json, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          operation.id,
          operation.ownerId,
          operation.kind,
          operation.source,
          operation.correlationId,
          operation.summaryJson,
          operation.createdAtMs,
        ),
      this.database
        .prepare(
          "INSERT INTO billing_operation_delivery(operation_id, updated_at_ms) VALUES (?, ?)",
        )
        .bind(operation.id, operation.createdAtMs),
      this.database
        .prepare("INSERT INTO billing_delivery_outbox(operation_id, created_at_ms) VALUES (?, ?)")
        .bind(operation.id, operation.createdAtMs),
    ]);
  }
}
