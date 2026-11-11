import type { PostgresDatabaseCapability } from "./postgres-capability";
import { executePostgresCommands, type PostgresCommand } from "./postgres-statements";
import type { BillingSyncStore } from "../billing/owner-sync";
import type { BillingLedgerOperation, BillingSubscriptionProjection } from "../billing/types";

export class PostgresBillingSyncStore implements BillingSyncStore {
  constructor(private readonly database: PostgresDatabaseCapability) {}

  async listBoundOwnerIds(): Promise<string[]> {
    const result = await this.database.queryResult<{ owner_id: string }>(
      "SELECT owner_id FROM billing_customer_bindings ORDER BY owner_id",
      [],
    );
    return result.rows.map((row) => row.owner_id);
  }

  async readCustomerId(ownerId: string): Promise<string | null> {
    const row = await this.database
      .query<{ stripe_customer_id: string }>(
        "SELECT stripe_customer_id FROM billing_customer_bindings WHERE owner_id = $1",
        [ownerId],
      )
      .then((rows) => rows[0] ?? null);
    return row?.stripe_customer_id ?? null;
  }

  async readProjection(ownerId: string): Promise<BillingSubscriptionProjection | null> {
    const row = await this.database
      .query<Record<string, unknown>>("SELECT * FROM billing_subscriptions WHERE owner_id = $1", [
        ownerId,
      ])
      .then((rows) => rows[0] ?? null);
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
    await this.database.queryResult(
      `INSERT INTO billing_customer_bindings(owner_id, stripe_customer_id, created_at_ms)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
      [ownerId, customerId, nowMs],
    );
    const [ownerBinding, customerBinding] = await Promise.all([
      this.database
        .query<{ stripe_customer_id: string }>(
          "SELECT stripe_customer_id FROM billing_customer_bindings WHERE owner_id = $1",
          [ownerId],
        )
        .then((rows) => rows[0] ?? null),
      this.database
        .query<{ owner_id: string }>(
          "SELECT owner_id FROM billing_customer_bindings WHERE stripe_customer_id = $1",
          [customerId],
        )
        .then((rows) => rows[0] ?? null),
    ]);
    if (ownerBinding?.stripe_customer_id !== customerId || customerBinding?.owner_id !== ownerId) {
      throw new Error("Stripe Customer is already bound to another Plan Owner.");
    }
  }

  async acquireOwnerSync(ownerId: string, nowMs: number, leaseMs: number): Promise<number | null> {
    const row = await this.database
      .query<{ generation: number }>(
        `INSERT INTO billing_owner_sync_state(
           owner_id, generation, lease_until_ms, completed_generation, updated_at_ms
         ) VALUES ($1, 1, $2, 0, $3)
         ON CONFLICT(owner_id) DO UPDATE SET
           generation = billing_owner_sync_state.generation + 1,
           lease_until_ms = excluded.lease_until_ms,
           updated_at_ms = excluded.updated_at_ms
         WHERE billing_owner_sync_state.lease_until_ms IS NULL
            OR billing_owner_sync_state.lease_until_ms <= excluded.updated_at_ms
         RETURNING generation`,
        [ownerId, nowMs + leaseMs, nowMs],
      )
      .then((rows) => rows[0] ?? null);
    return row?.generation ?? null;
  }

  async releaseOwnerSync(ownerId: string, generation: number, nowMs: number): Promise<void> {
    await this.database.queryResult(
      `UPDATE billing_owner_sync_state SET lease_until_ms = NULL, updated_at_ms = $1
         WHERE owner_id = $2 AND generation = $3 AND completed_generation < $4`,
      [nowMs, ownerId, generation, generation],
    );
  }

  async commitOwnerSync(input: {
    ownerId: string;
    generation: number;
    projection: BillingSubscriptionProjection;
    operation: BillingLedgerOperation | null;
  }): Promise<boolean> {
    const projection = input.projection;
    // PostgreSQL needs explicit types for parameters used only in NULL checks.
    const statements: PostgresCommand[] = [
      {
        statement: `INSERT INTO billing_subscriptions(
             owner_id, stripe_customer_id, stripe_subscription_id, stripe_price_id,
             stripe_product_id, plan, frequency, status, current_period_start_ms,
             current_period_end_ms, cancel_at_period_end, cancelled_at_ms,
             latest_invoice_id, schedule_id, observed_at_ms, quarantine_reason
           )
           SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16 WHERE EXISTS(SELECT 1 FROM billing_owner_sync_state WHERE owner_id = $17 AND generation = $18 AND completed_generation < $19)
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
        values: [
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
        ],
      },
      {
        statement: `INSERT INTO billing_support_cases(id, owner_id, kind, status, safe_provider_ids_json, opened_at_ms, updated_at_ms)
           SELECT 'quarantine:' || $1, $2, 'stripe_quarantine', 'open', $3, $4, $5
           WHERE CAST($6 AS TEXT) IS NOT NULL AND EXISTS(SELECT 1 FROM billing_owner_sync_state WHERE owner_id = $7 AND generation = $8 AND completed_generation < $9)
           ON CONFLICT(id) DO UPDATE SET status = 'open', resolved_at_ms = NULL,
             safe_provider_ids_json = excluded.safe_provider_ids_json, updated_at_ms = excluded.updated_at_ms`,
        values: [
          input.ownerId,
          input.ownerId,
          JSON.stringify([projection.customerId, projection.subscriptionId].filter(Boolean)),
          projection.observedAtMs,
          projection.observedAtMs,
          projection.quarantineReason,
          input.ownerId,
          input.generation,
          input.generation,
        ],
      },
      {
        statement: `UPDATE billing_support_cases SET status = 'resolved', resolved_at_ms = $1, updated_at_ms = $2
           WHERE id = 'quarantine:' || $3 AND CAST($4 AS TEXT) IS NULL AND EXISTS(SELECT 1 FROM billing_owner_sync_state WHERE owner_id = $5 AND generation = $6 AND completed_generation < $7)`,
        values: [
          projection.observedAtMs,
          projection.observedAtMs,
          input.ownerId,
          projection.quarantineReason,
          input.ownerId,
          input.generation,
          input.generation,
        ],
      },
      {
        statement: `UPDATE billing_subscriptions SET
             grace_started_at_ms = CASE
               WHEN status IN ('past_due', 'unpaid') THEN COALESCE(grace_started_at_ms, observed_at_ms)
               WHEN status = 'active' THEN NULL ELSE grace_started_at_ms END,
             grace_ends_at_ms = CASE
               WHEN status IN ('past_due', 'unpaid') THEN COALESCE(grace_ends_at_ms, observed_at_ms + 604800000)
               WHEN status = 'active' THEN NULL ELSE grace_ends_at_ms END,
             grace_expired_at_ms = CASE WHEN status = 'active' THEN NULL ELSE grace_expired_at_ms END
           WHERE owner_id = $1 AND EXISTS(SELECT 1 FROM billing_owner_sync_state WHERE owner_id = $2 AND generation = $3 AND completed_generation < $4)`,
        values: [input.ownerId, input.ownerId, input.generation, input.generation],
      },
      {
        statement: `UPDATE guild_entitlements SET
             plan = CASE WHEN $1 = 'active' THEN $2 ELSE 'free' END,
             updated_at_ms = $3
           WHERE guild_id IN (SELECT guild_id FROM billing_guild_assignments WHERE owner_id = $4)
             AND $5 IN ('active', 'missing', 'incomplete', 'cancelled')
             AND EXISTS(SELECT 1 FROM billing_owner_sync_state WHERE owner_id = $6 AND generation = $7 AND completed_generation < $8)`,
        values: [
          projection.status,
          projection.plan,
          projection.observedAtMs,
          input.ownerId,
          projection.status,
          input.ownerId,
          input.generation,
          input.generation,
        ],
      },
      {
        statement: `DELETE FROM billing_guild_assignments
           WHERE owner_id = $1 AND $2 IN ('missing', 'cancelled') AND EXISTS(SELECT 1 FROM billing_owner_sync_state WHERE owner_id = $3 AND generation = $4 AND completed_generation < $5)`,
        values: [
          input.ownerId,
          projection.status,
          input.ownerId,
          input.generation,
          input.generation,
        ],
      },
      {
        statement: `UPDATE billing_owner_sync_state
           SET completed_generation = $1, lease_until_ms = NULL, updated_at_ms = $2
           WHERE owner_id = $3 AND generation = $4 AND completed_generation < $5`,
        values: [
          input.generation,
          input.operation?.createdAtMs ?? projection.observedAtMs,
          input.ownerId,
          input.generation,
          input.generation,
        ],
      },
    ];
    if (input.operation) {
      statements.splice(
        1,
        0,
        {
          statement: `INSERT INTO billing_operations_ledger(
             id, owner_id, kind, source, correlation_id, summary_json, created_at_ms
           ) SELECT $1, $2, $3, $4, $5, $6, $7 WHERE EXISTS(SELECT 1 FROM billing_owner_sync_state WHERE owner_id = $8 AND generation = $9 AND completed_generation < $10)`,
          values: [
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
          ],
        },
        {
          statement: `INSERT INTO billing_operation_delivery(operation_id, updated_at_ms)
             SELECT $1, $2 WHERE EXISTS(SELECT 1 FROM billing_owner_sync_state WHERE owner_id = $3 AND generation = $4 AND completed_generation < $5) ON CONFLICT(operation_id) DO NOTHING`,
          values: [
            input.operation.id,
            input.operation.createdAtMs,
            input.ownerId,
            input.generation,
            input.generation,
          ],
        },
        {
          statement: `INSERT INTO billing_delivery_outbox(operation_id, created_at_ms)
             SELECT $1, $2 WHERE EXISTS(SELECT 1 FROM billing_owner_sync_state WHERE owner_id = $3 AND generation = $4 AND completed_generation < $5) ON CONFLICT(operation_id) DO NOTHING`,
          values: [
            input.operation.id,
            input.operation.createdAtMs,
            input.ownerId,
            input.generation,
            input.generation,
          ],
        },
      );
    }
    await executePostgresCommands(this.database, statements);
    const row = await this.database
      .query<{ completed_generation: number }>(
        "SELECT completed_generation FROM billing_owner_sync_state WHERE owner_id = $1",
        [input.ownerId],
      )
      .then((rows) => rows[0] ?? null);
    return row?.completed_generation === input.generation;
  }
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}
