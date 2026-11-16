import type { PostgresDatabaseCapability } from "./postgres-capability";
import { executePostgresCommands } from "./postgres-statements";
import type { BillingGraceStore } from "../billing/grace";
import { PostgresBillingSyncStore } from "./postgres-billing-sync-store";

export class PostgresBillingGraceStore implements BillingGraceStore {
  private readonly billing: PostgresBillingSyncStore;
  constructor(private readonly database: PostgresDatabaseCapability) {
    this.billing = new PostgresBillingSyncStore(database);
  }
  readProjection(ownerId: string) {
    return this.billing.readProjection(ownerId);
  }
  async listDueGraceOwners(nowMs: number): Promise<string[]> {
    const result = await this.database.queryResult<{ owner_id: string }>(
      "SELECT owner_id FROM billing_subscriptions WHERE grace_ends_at_ms <= $1 AND grace_expired_at_ms IS NULL AND status IN ('past_due', 'unpaid')",
      [nowMs],
    );
    return result.rows.map((row) => row.owner_id);
  }
  async expireGrace(ownerId: string, nowMs: number): Promise<void> {
    await executePostgresCommands(this.database, [
      {
        statement:
          "UPDATE billing_subscriptions SET grace_expired_at_ms = $1 WHERE owner_id = $2 AND grace_ends_at_ms <= $3 AND status IN ('past_due', 'unpaid')",
        values: [nowMs, ownerId, nowMs],
      },
      {
        statement: `UPDATE guild_entitlements SET plan = 'free', updated_at_ms = $1
         WHERE guild_id IN (SELECT guild_id FROM billing_guild_assignments WHERE owner_id = $2)
           AND EXISTS(SELECT 1 FROM billing_subscriptions WHERE owner_id = $3 AND grace_expired_at_ms = $4)`,
        values: [nowMs, ownerId, ownerId, nowMs],
      },
    ]);
  }
  async recordFailure(
    ownerId: string,
    reason: string,
    nowMs: number,
    terminalAttempt: number,
  ): Promise<void> {
    await this.database.queryResult(
      `INSERT INTO billing_reconciliation_failures(owner_id, reason, attempt_count, first_failed_at_ms, last_failed_at_ms, terminal_at_ms)
         VALUES ($1, $2, 1, $3, $4, CASE WHEN 1 >= $5 THEN $6 ELSE NULL END)
         ON CONFLICT(owner_id) DO UPDATE SET
           reason = excluded.reason,
           attempt_count = billing_reconciliation_failures.attempt_count + 1,
           last_failed_at_ms = excluded.last_failed_at_ms,
           terminal_at_ms = CASE
             WHEN billing_reconciliation_failures.attempt_count + 1 >= $7
             THEN COALESCE(billing_reconciliation_failures.terminal_at_ms, excluded.last_failed_at_ms)
             ELSE billing_reconciliation_failures.terminal_at_ms
           END`,
      [ownerId, reason, nowMs, nowMs, terminalAttempt, nowMs, terminalAttempt],
    );
    const failure = await this.database
      .query<{ attempt_count: number }>(
        "SELECT attempt_count FROM billing_reconciliation_failures WHERE owner_id = $1",
        [ownerId],
      )
      .then((rows) => rows[0] ?? null);
    if ((failure?.attempt_count ?? 0) >= terminalAttempt) {
      await this.database.queryResult(
        `INSERT INTO billing_support_cases(id, owner_id, kind, status, opened_at_ms, updated_at_ms)
           VALUES ($1, $2, 'reconciliation_terminal', 'open', $3, $4)
           ON CONFLICT(id) DO UPDATE SET status = 'open', updated_at_ms = excluded.updated_at_ms`,
        [`reconciliation:${ownerId}`, ownerId, nowMs, nowMs],
      );
    }
  }
  async clearFailure(ownerId: string): Promise<void> {
    await this.database.queryResult(
      "DELETE FROM billing_reconciliation_failures WHERE owner_id = $1",
      [ownerId],
    );
  }
}
