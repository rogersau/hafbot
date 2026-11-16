import type { BillingSyncStore } from "../../../../../src/runtime/billing/owner-sync";
import type {
  BillingLedgerOperation,
  BillingSubscriptionProjection,
} from "../../../../../src/runtime/billing/types";

export class SqliteBillingSyncStore implements BillingSyncStore {
  constructor(private readonly database: D1Database) {}

  async listBoundOwnerIds(): Promise<string[]> {
    const result = await this.database
      .prepare("SELECT owner_id FROM billing_customer_bindings ORDER BY owner_id")
      .all<{ owner_id: string }>();
    return result.results.map((row) => row.owner_id);
  }

  async readCustomerId(ownerId: string): Promise<string | null> {
    const row = await this.database
      .prepare("SELECT stripe_customer_id FROM billing_customer_bindings WHERE owner_id = ?")
      .bind(ownerId)
      .first<{ stripe_customer_id: string }>();
    return row?.stripe_customer_id ?? null;
  }

  async readProjection(ownerId: string): Promise<BillingSubscriptionProjection | null> {
    const row = await this.database
      .prepare("SELECT * FROM billing_subscriptions WHERE owner_id = ?")
      .bind(ownerId)
      .first<Record<string, unknown>>();
    if (!row) return null;
    return {
      ownerId: String(row.owner_id),
      customerId: String(row.stripe_customer_id),
      subscriptionId: nullableString(row.stripe_subscription_id),
      priceId: nullableString(row.stripe_price_id),
      productId: nullableString(row.stripe_product_id),
      plan: row.plan as BillingSubscriptionProjection["plan"],
      frequency: row.frequency as BillingSubscriptionProjection["frequency"],
      status: row.status as BillingSubscriptionProjection["status"],
      currentPeriodStartMs: nullableNumber(row.current_period_start_ms),
      currentPeriodEndMs: nullableNumber(row.current_period_end_ms),
      cancelAtPeriodEnd: row.cancel_at_period_end === 1,
      cancelledAtMs: nullableNumber(row.cancelled_at_ms),
      latestInvoiceId: nullableString(row.latest_invoice_id),
      scheduleId: nullableString(row.schedule_id),
      observedAtMs: Number(row.observed_at_ms),
      quarantineReason: nullableString(row.quarantine_reason),
      graceStartedAtMs: nullableNumber(row.grace_started_at_ms),
      graceEndsAtMs: nullableNumber(row.grace_ends_at_ms),
      graceExpiredAtMs: nullableNumber(row.grace_expired_at_ms),
    };
  }

  async bindCustomer(ownerId: string, customerId: string, nowMs: number): Promise<void> {
    await this.database
      .prepare(
        `INSERT INTO billing_customer_bindings(owner_id, stripe_customer_id, created_at_ms)
         VALUES (?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .bind(ownerId, customerId, nowMs)
      .run();
    const [ownerBinding, customerBinding] = await Promise.all([
      this.database
        .prepare("SELECT stripe_customer_id FROM billing_customer_bindings WHERE owner_id = ?")
        .bind(ownerId)
        .first<{ stripe_customer_id: string }>(),
      this.database
        .prepare("SELECT owner_id FROM billing_customer_bindings WHERE stripe_customer_id = ?")
        .bind(customerId)
        .first<{ owner_id: string }>(),
    ]);
    if (ownerBinding?.stripe_customer_id !== customerId || customerBinding?.owner_id !== ownerId) {
      throw new Error("Stripe Customer is already bound to another Plan Owner.");
    }
  }

  async acquireOwnerSync(ownerId: string, nowMs: number, leaseMs: number): Promise<number | null> {
    const row = await this.database
      .prepare(
        `INSERT INTO billing_owner_sync_state(
           owner_id, generation, lease_until_ms, completed_generation, updated_at_ms
         ) VALUES (?, 1, ?, 0, ?)
         ON CONFLICT(owner_id) DO UPDATE SET
           generation = billing_owner_sync_state.generation + 1,
           lease_until_ms = excluded.lease_until_ms,
           updated_at_ms = excluded.updated_at_ms
         WHERE billing_owner_sync_state.lease_until_ms IS NULL
            OR billing_owner_sync_state.lease_until_ms <= excluded.updated_at_ms
         RETURNING generation`,
      )
      .bind(ownerId, nowMs + leaseMs, nowMs)
      .first<{ generation: number }>();
    return row?.generation ?? null;
  }

  async releaseOwnerSync(ownerId: string, generation: number, nowMs: number): Promise<void> {
    await this.database
      .prepare(
        `UPDATE billing_owner_sync_state SET lease_until_ms = NULL, updated_at_ms = ?
         WHERE owner_id = ? AND generation = ? AND completed_generation < ?`,
      )
      .bind(nowMs, ownerId, generation, generation)
      .run();
  }

  async commitOwnerSync(input: {
    ownerId: string;
    generation: number;
    projection: BillingSubscriptionProjection;
    operation: BillingLedgerOperation | null;
  }): Promise<boolean> {
    const projection = input.projection;
    const generationGuard =
      "EXISTS(SELECT 1 FROM billing_owner_sync_state WHERE owner_id = ? AND generation = ? AND completed_generation < ?)";
    // PostgreSQL needs explicit types for parameters used only in NULL checks.
    const statements: D1PreparedStatement[] = [
      this.database
        .prepare(
          `INSERT INTO billing_subscriptions(
             owner_id, stripe_customer_id, stripe_subscription_id, stripe_price_id,
             stripe_product_id, plan, frequency, status, current_period_start_ms,
             current_period_end_ms, cancel_at_period_end, cancelled_at_ms,
             latest_invoice_id, schedule_id, observed_at_ms, quarantine_reason
           )
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${generationGuard}
           ON CONFLICT(owner_id) DO UPDATE SET
             stripe_customer_id = excluded.stripe_customer_id,
             stripe_subscription_id = excluded.stripe_subscription_id,
             stripe_price_id = excluded.stripe_price_id,
             stripe_product_id = excluded.stripe_product_id,
             plan = excluded.plan,
             frequency = excluded.frequency,
             status = excluded.status,
             current_period_start_ms = excluded.current_period_start_ms,
             current_period_end_ms = excluded.current_period_end_ms,
             cancel_at_period_end = excluded.cancel_at_period_end,
             cancelled_at_ms = excluded.cancelled_at_ms,
             latest_invoice_id = excluded.latest_invoice_id,
             schedule_id = excluded.schedule_id,
             observed_at_ms = excluded.observed_at_ms,
             quarantine_reason = excluded.quarantine_reason`,
        )
        .bind(
          projection.ownerId,
          projection.customerId,
          projection.subscriptionId,
          projection.priceId,
          projection.productId,
          projection.plan,
          projection.frequency,
          projection.status,
          projection.currentPeriodStartMs,
          projection.currentPeriodEndMs,
          projection.cancelAtPeriodEnd ? 1 : 0,
          projection.cancelledAtMs,
          projection.latestInvoiceId,
          projection.scheduleId,
          projection.observedAtMs,
          projection.quarantineReason,
          input.ownerId,
          input.generation,
          input.generation,
        ),
      this.database
        .prepare(
          `INSERT INTO billing_support_cases(id, owner_id, kind, status, safe_provider_ids_json, opened_at_ms, updated_at_ms)
           SELECT 'quarantine:' || ?, ?, 'stripe_quarantine', 'open', ?, ?, ?
           WHERE CAST(? AS TEXT) IS NOT NULL AND ${generationGuard}
           ON CONFLICT(id) DO UPDATE SET status = 'open', resolved_at_ms = NULL,
             safe_provider_ids_json = excluded.safe_provider_ids_json, updated_at_ms = excluded.updated_at_ms`,
        )
        .bind(
          input.ownerId,
          input.ownerId,
          JSON.stringify([projection.customerId, projection.subscriptionId].filter(Boolean)),
          projection.observedAtMs,
          projection.observedAtMs,
          projection.quarantineReason,
          input.ownerId,
          input.generation,
          input.generation,
        ),
      this.database
        .prepare(
          `UPDATE billing_support_cases SET status = 'resolved', resolved_at_ms = ?, updated_at_ms = ?
           WHERE id = 'quarantine:' || ? AND CAST(? AS TEXT) IS NULL AND ${generationGuard}`,
        )
        .bind(
          projection.observedAtMs,
          projection.observedAtMs,
          input.ownerId,
          projection.quarantineReason,
          input.ownerId,
          input.generation,
          input.generation,
        ),
      this.database
        .prepare(
          `UPDATE billing_subscriptions SET
             grace_started_at_ms = CASE
               WHEN status IN ('past_due', 'unpaid') THEN COALESCE(grace_started_at_ms, observed_at_ms)
               WHEN status = 'active' THEN NULL ELSE grace_started_at_ms END,
             grace_ends_at_ms = CASE
               WHEN status IN ('past_due', 'unpaid') THEN COALESCE(grace_ends_at_ms, observed_at_ms + 604800000)
               WHEN status = 'active' THEN NULL ELSE grace_ends_at_ms END,
             grace_expired_at_ms = CASE WHEN status = 'active' THEN NULL ELSE grace_expired_at_ms END
           WHERE owner_id = ? AND ${generationGuard}`,
        )
        .bind(input.ownerId, input.ownerId, input.generation, input.generation),
      this.database
        .prepare(
          `UPDATE guild_entitlements SET
             plan = CASE WHEN ? = 'active' THEN ? ELSE 'free' END,
             updated_at_ms = ?
           WHERE guild_id IN (SELECT guild_id FROM billing_guild_assignments WHERE owner_id = ?)
             AND ? IN ('active', 'missing', 'incomplete', 'cancelled')
             AND ${generationGuard}`,
        )
        .bind(
          projection.status,
          projection.plan,
          projection.observedAtMs,
          input.ownerId,
          projection.status,
          input.ownerId,
          input.generation,
          input.generation,
        ),
      this.database
        .prepare(
          `DELETE FROM billing_guild_assignments
           WHERE owner_id = ? AND ? IN ('missing', 'cancelled') AND ${generationGuard}`,
        )
        .bind(input.ownerId, projection.status, input.ownerId, input.generation, input.generation),
      this.database
        .prepare(
          `UPDATE billing_owner_sync_state
           SET completed_generation = ?, lease_until_ms = NULL, updated_at_ms = ?
           WHERE owner_id = ? AND generation = ? AND completed_generation < ?`,
        )
        .bind(
          input.generation,
          input.operation?.createdAtMs ?? projection.observedAtMs,
          input.ownerId,
          input.generation,
          input.generation,
        ),
    ];
    if (input.operation) {
      statements.splice(
        1,
        0,
        this.database
          .prepare(
            `INSERT INTO billing_operations_ledger(
             id, owner_id, kind, source, correlation_id, summary_json, created_at_ms
           ) SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${generationGuard}`,
          )
          .bind(
            input.operation.id,
            input.operation.ownerId,
            input.operation.kind,
            input.operation.source,
            input.operation.correlationId,
            input.operation.summaryJson,
            input.operation.createdAtMs,
            input.ownerId,
            input.generation,
            input.generation,
          ),
        this.database
          .prepare(
            `INSERT INTO billing_operation_delivery(operation_id, updated_at_ms)
             SELECT ?, ? WHERE ${generationGuard} ON CONFLICT(operation_id) DO NOTHING`,
          )
          .bind(
            input.operation.id,
            input.operation.createdAtMs,
            input.ownerId,
            input.generation,
            input.generation,
          ),
        this.database
          .prepare(
            `INSERT INTO billing_delivery_outbox(operation_id, created_at_ms)
             SELECT ?, ? WHERE ${generationGuard} ON CONFLICT(operation_id) DO NOTHING`,
          )
          .bind(
            input.operation.id,
            input.operation.createdAtMs,
            input.ownerId,
            input.generation,
            input.generation,
          ),
      );
    }
    await this.database.batch(statements);
    const row = await this.database
      .prepare("SELECT completed_generation FROM billing_owner_sync_state WHERE owner_id = ?")
      .bind(input.ownerId)
      .first<{ completed_generation: number }>();
    return row?.completed_generation === input.generation;
  }
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}
