import type { PostgresDatabaseCapability } from "./postgres-capability";
import { executePostgresCommands } from "./postgres-statements";
import type { BillingAdverseStore } from "../billing/adverse";
import { PostgresBillingSyncStore } from "./postgres-billing-sync-store";

export class PostgresBillingAdverseStore implements BillingAdverseStore {
  private readonly billing: PostgresBillingSyncStore;
  constructor(private readonly database: PostgresDatabaseCapability) {
    this.billing = new PostgresBillingSyncStore(database);
  }
  readProjection(ownerId: string) {
    return this.billing.readProjection(ownerId);
  }
  async endAssignments(ownerId: string, nowMs: number) {
    await executePostgresCommands(this.database, [
      {
        statement:
          "UPDATE guild_entitlements SET plan = 'free', updated_at_ms = $1 WHERE guild_id IN (SELECT guild_id FROM billing_guild_assignments WHERE owner_id = $2)",
        values: [nowMs, ownerId],
      },
      { statement: "DELETE FROM billing_guild_assignments WHERE owner_id = $1", values: [ownerId] },
    ]);
  }
  async openCase(input: Parameters<BillingAdverseStore["openCase"]>[0]) {
    await this.database.queryResult(
      `INSERT INTO billing_support_cases(id, owner_id, kind, status, safe_provider_ids_json, opened_at_ms, updated_at_ms)
       VALUES ($1, $2, $3, 'open', $4, $5, $6) ON CONFLICT(id) DO UPDATE SET status = 'open', updated_at_ms = excluded.updated_at_ms`,
      [
        input.id,
        input.ownerId,
        input.kind,
        JSON.stringify([input.safeProviderId]),
        input.nowMs,
        input.nowMs,
      ],
    );
  }
}
