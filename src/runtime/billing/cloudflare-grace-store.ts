import type { BillingGraceStore } from "./grace";
import { CloudflareBillingSyncStore } from "./cloudflare-billing-sync-store";

export class CloudflareBillingGraceStore implements BillingGraceStore {
  private readonly billing: CloudflareBillingSyncStore;
  constructor(private readonly database: D1Database) {
    this.billing = new CloudflareBillingSyncStore(database);
  }
  readProjection(ownerId: string) {
    return this.billing.readProjection(ownerId);
  }
  async listDueGraceOwners(nowMs: number): Promise<string[]> {
    const result = await this.database
      .prepare(
        "SELECT owner_id FROM billing_subscriptions WHERE grace_ends_at_ms <= ? AND grace_expired_at_ms IS NULL AND status IN ('past_due', 'unpaid')",
      )
      .bind(nowMs)
      .all<{ owner_id: string }>();
    return result.results.map((row) => row.owner_id);
  }
  async expireGrace(ownerId: string, nowMs: number): Promise<void> {
    await this.database.batch([
      this.database
        .prepare(
          "UPDATE billing_subscriptions SET grace_expired_at_ms = ? WHERE owner_id = ? AND grace_ends_at_ms <= ? AND status IN ('past_due', 'unpaid')",
        )
        .bind(nowMs, ownerId, nowMs),
      this.database
        .prepare(
          `UPDATE guild_entitlements SET plan = 'free', updated_at_ms = ?
         WHERE guild_id IN (SELECT guild_id FROM billing_guild_assignments WHERE owner_id = ?)
           AND EXISTS(SELECT 1 FROM billing_subscriptions WHERE owner_id = ? AND grace_expired_at_ms = ?)`,
        )
        .bind(nowMs, ownerId, ownerId, nowMs),
    ]);
  }
  async recordFailure(
    ownerId: string,
    reason: string,
    nowMs: number,
    terminalAttempt: number,
  ): Promise<void> {
    await this.database
      .prepare(
        `INSERT INTO billing_reconciliation_failures(owner_id, reason, attempt_count, first_failed_at_ms, last_failed_at_ms, terminal_at_ms)
         VALUES (?, ?, 1, ?, ?, CASE WHEN 1 >= ? THEN ? ELSE NULL END)
         ON CONFLICT(owner_id) DO UPDATE SET
           reason = excluded.reason,
           attempt_count = billing_reconciliation_failures.attempt_count + 1,
           last_failed_at_ms = excluded.last_failed_at_ms,
           terminal_at_ms = CASE
             WHEN billing_reconciliation_failures.attempt_count + 1 >= ?
             THEN COALESCE(billing_reconciliation_failures.terminal_at_ms, excluded.last_failed_at_ms)
             ELSE billing_reconciliation_failures.terminal_at_ms
           END`,
      )
      .bind(ownerId, reason, nowMs, nowMs, terminalAttempt, nowMs, terminalAttempt)
      .run();
    const failure = await this.database
      .prepare("SELECT attempt_count FROM billing_reconciliation_failures WHERE owner_id = ?")
      .bind(ownerId)
      .first<{ attempt_count: number }>();
    if ((failure?.attempt_count ?? 0) >= terminalAttempt) {
      await this.database
        .prepare(
          `INSERT INTO billing_support_cases(id, owner_id, kind, status, opened_at_ms, updated_at_ms)
           VALUES (?, ?, 'reconciliation_terminal', 'open', ?, ?)
           ON CONFLICT(id) DO UPDATE SET status = 'open', updated_at_ms = excluded.updated_at_ms`,
        )
        .bind(`reconciliation:${ownerId}`, ownerId, nowMs, nowMs)
        .run();
    }
  }
  async clearFailure(ownerId: string): Promise<void> {
    await this.database
      .prepare("DELETE FROM billing_reconciliation_failures WHERE owner_id = ?")
      .bind(ownerId)
      .run();
  }
}
