import type { BillingAdverseStore } from "./adverse";
import { CloudflareBillingSyncStore } from "./cloudflare-billing-sync-store";

export class CloudflareBillingAdverseStore implements BillingAdverseStore {
  private readonly billing: CloudflareBillingSyncStore;
  constructor(private readonly database: D1Database) {
    this.billing = new CloudflareBillingSyncStore(database);
  }
  readProjection(ownerId: string) {
    return this.billing.readProjection(ownerId);
  }
  async endAssignments(ownerId: string, nowMs: number) {
    await this.database.batch([
      this.database
        .prepare(
          "UPDATE guild_entitlements SET plan = 'free', updated_at_ms = ? WHERE guild_id IN (SELECT guild_id FROM billing_guild_assignments WHERE owner_id = ?)",
        )
        .bind(nowMs, ownerId),
      this.database
        .prepare("DELETE FROM billing_guild_assignments WHERE owner_id = ?")
        .bind(ownerId),
    ]);
  }
  async openCase(input: Parameters<BillingAdverseStore["openCase"]>[0]) {
    await this.database
      .prepare(
        `INSERT INTO billing_support_cases(id, owner_id, kind, status, safe_provider_ids_json, opened_at_ms, updated_at_ms)
       VALUES (?, ?, ?, 'open', ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = 'open', updated_at_ms = excluded.updated_at_ms`,
      )
      .bind(
        input.id,
        input.ownerId,
        input.kind,
        JSON.stringify([input.safeProviderId]),
        input.nowMs,
        input.nowMs,
      )
      .run();
  }
}
