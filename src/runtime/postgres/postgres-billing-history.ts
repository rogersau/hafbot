import type { PostgresDatabaseCapability } from "./postgres-capability";
import type { BillingLedgerOperation } from "../billing/types";

export type BillingHistoryStore = {
  listOwnerHistory(ownerId: string, limit?: number): Promise<BillingLedgerOperation[]>;
};

export class PostgresBillingHistoryStore implements BillingHistoryStore {
  constructor(private readonly database: PostgresDatabaseCapability) {}
  async listOwnerHistory(ownerId: string, limit = 100): Promise<BillingLedgerOperation[]> {
    const result = await this.database.queryResult<{
      id: string;
      owner_id: string;
      kind: string;
      source: BillingLedgerOperation["source"];
      correlation_id: string | null;
      summary_json: string;
      created_at_ms: number;
    }>(
      `SELECT id, owner_id, kind, source, correlation_id, summary_json, created_at_ms
       FROM billing_operations_ledger WHERE owner_id = $1 ORDER BY created_at_ms DESC LIMIT $2`,
      [ownerId, limit],
    );
    return result.rows.map((row) => ({
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
