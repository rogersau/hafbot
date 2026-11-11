import type { BillingManagementStore } from "../../../../../src/runtime/billing/management";
import { SqliteBillingSyncStore } from "./sqlite-billing-sync-store";

export class SqliteBillingManagementStore implements BillingManagementStore {
  private readonly billing: SqliteBillingSyncStore;
  constructor(private readonly database: D1Database) {
    this.billing = new SqliteBillingSyncStore(database);
  }
  readProjection(ownerId: string) {
    return this.billing.readProjection(ownerId);
  }
  async countAssignments(ownerId: string): Promise<number> {
    const row = await this.database
      .prepare("SELECT COUNT(*) AS count FROM billing_guild_assignments WHERE owner_id = ?")
      .bind(ownerId)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }
  async hasWhiteLabelObligation(ownerId: string): Promise<boolean> {
    const row = await this.database
      .prepare(
        `SELECT 1 AS present FROM billing_guild_assignments a
       JOIN white_label_bots w ON w.guild_id = a.guild_id
       WHERE a.owner_id = ? AND w.status != 'decommissioned' LIMIT 1`,
      )
      .bind(ownerId)
      .first<{ present: number }>();
    return row?.present === 1;
  }
}
