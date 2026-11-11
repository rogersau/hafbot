import type { PostgresDatabaseCapability } from "./postgres-capability";
import { executePostgresCommands } from "./postgres-statements";
import type { BillingSupportCase, BillingSupportStore } from "../billing/support";
import type { BillingLedgerOperation } from "../billing/types";
import { PostgresBillingHistoryStore } from "./postgres-billing-history";
import { PostgresBillingSyncStore } from "./postgres-billing-sync-store";
import { PostgresBillingAssignmentStore } from "./postgres-billing-assignment-store";

export class PostgresBillingSupportStore implements BillingSupportStore {
  private readonly history: PostgresBillingHistoryStore;
  private readonly billing: PostgresBillingSyncStore;
  private readonly assignments: PostgresBillingAssignmentStore;
  constructor(private readonly database: PostgresDatabaseCapability) {
    this.history = new PostgresBillingHistoryStore(database);
    this.billing = new PostgresBillingSyncStore(database);
    this.assignments = new PostgresBillingAssignmentStore(database);
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
    const result = await this.database.queryResult<Record<string, unknown>>(
      `SELECT id, owner_id, kind, status, safe_provider_ids_json, opened_at_ms, updated_at_ms, resolved_at_ms
       FROM billing_support_cases ${caseId ? "WHERE id = $1" : ""} ORDER BY updated_at_ms DESC`,
      caseId ? [caseId] : [],
    );
    return result.rows.map((row) => ({
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
    const result = await this.database.queryResult(
      `SELECT a.id, a.operation_id, a.destination, a.outcome, a.provider_correlation_id, a.attempted_at_ms
       FROM billing_delivery_attempts a JOIN billing_operations_ledger l ON l.id = a.operation_id
       WHERE l.owner_id = $1 ORDER BY a.attempted_at_ms DESC`,
      [ownerId],
    );
    return result.rows;
  }
  async setCaseStatus(caseId: string, status: string, nowMs: number) {
    if (!["open", "investigating", "resolved"].includes(status))
      throw new Error("invalid_case_status");
    await this.database.queryResult(
      "UPDATE billing_support_cases SET status = $1, updated_at_ms = $2, resolved_at_ms = CASE WHEN $3 = 'resolved' THEN $4 ELSE NULL END WHERE id = $5",
      [status, nowMs, status, nowMs, caseId],
    );
  }
  async appendSupportOperation(operation: BillingLedgerOperation) {
    await executePostgresCommands(this.database, [
      {
        statement:
          "INSERT INTO billing_operations_ledger(id, owner_id, kind, source, correlation_id, summary_json, created_at_ms) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        values: [
          operation.id,
          operation.ownerId,
          operation.kind,
          operation.source,
          operation.correlationId,
          operation.summaryJson,
          operation.createdAtMs,
        ],
      },
      {
        statement:
          "INSERT INTO billing_operation_delivery(operation_id, updated_at_ms) VALUES ($1, $2)",
        values: [operation.id, operation.createdAtMs],
      },
      {
        statement:
          "INSERT INTO billing_delivery_outbox(operation_id, created_at_ms) VALUES ($1, $2)",
        values: [operation.id, operation.createdAtMs],
      },
    ]);
  }
}
