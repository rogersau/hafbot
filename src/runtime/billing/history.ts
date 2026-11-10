import type { BillingLedgerOperation } from "./types";

export interface BillingHistoryStore {
  listOwnerHistory(ownerId: string, limit?: number): Promise<BillingLedgerOperation[]>;
}

export class CloudflareBillingHistoryStore implements BillingHistoryStore {
  constructor(private readonly database: D1Database) {}
  async listOwnerHistory(ownerId: string, limit = 100): Promise<BillingLedgerOperation[]> {
    const result = await this.database
      .prepare(
        `SELECT id, owner_id, kind, source, correlation_id, summary_json, created_at_ms
       FROM billing_operations_ledger WHERE owner_id = ? ORDER BY created_at_ms DESC LIMIT ?`,
      )
      .bind(ownerId, limit)
      .all<{
        id: string;
        owner_id: string;
        kind: string;
        source: BillingLedgerOperation["source"];
        correlation_id: string | null;
        summary_json: string;
        created_at_ms: number;
      }>();
    return result.results.map((row) => ({
      id: row.id,
      ownerId: row.owner_id,
      kind: row.kind,
      source: row.source,
      correlationId: row.correlation_id,
      summaryJson: row.summary_json,
      createdAtMs: row.created_at_ms,
    }));
  }
}
