import type { PostgresDatabaseCapability } from "./postgres-capability";
import type { BillingManagementStore } from "../billing/management";
import { PostgresBillingSyncStore } from "./postgres-billing-sync-store";

export class PostgresBillingManagementStore implements BillingManagementStore {
  private readonly billing: PostgresBillingSyncStore;
  constructor(private readonly database: PostgresDatabaseCapability) {
    this.billing = new PostgresBillingSyncStore(database);
  }
  readProjection(ownerId: string) {
    return this.billing.readProjection(ownerId);
  }
  async countAssignments(ownerId: string): Promise<number> {
    const row = await this.database
      .query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM billing_guild_assignments WHERE owner_id = $1",
        [ownerId],
      )
      .then((rows) => rows[0] ?? null);
    return row?.count ?? 0;
  }
  async hasWhiteLabelObligation(ownerId: string): Promise<boolean> {
    const row = await this.database
      .query<{ present: number }>(
        `SELECT 1 AS present FROM billing_guild_assignments a
       JOIN white_label_bots w ON w.guild_id = a.guild_id
       WHERE a.owner_id = $1 AND w.status != 'decommissioned' LIMIT 1`,
        [ownerId],
      )
      .then((rows) => rows[0] ?? null);
    return row?.present === 1;
  }
}
