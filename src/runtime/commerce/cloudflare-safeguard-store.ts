import {
  COMMERCE_CONTROL_EFFECTS,
  COMMERCE_PILOT_LIMITS,
  type CommerceCapacityInput,
  type CommerceOperationalControl,
  type CommerceSafeguardDashboard,
  type CommerceSafeguardStore,
  type CommerceSafeguardUsage,
} from "../../commerce/safeguards";
import type { CommerceCurrency } from "../../commerce/types";

type Row = Record<string, unknown>;

export class CloudflareCommerceSafeguardStore implements CommerceSafeguardStore {
  constructor(private readonly database: D1Database) {}

  async claimCapacity(input: CommerceCapacityInput): Promise<boolean> {
    const existing = await first(
      this.database,
      "SELECT * FROM commerce_checkout_capacity_claims WHERE id = ?",
      input.id,
    );
    if (existing) {
      return (
        existing.checkout_kind === input.checkoutKind &&
        existing.connected_account_id === input.connectedAccountId &&
        existing.guild_id === input.guildId &&
        nullable(existing.offering_id) === input.offeringId &&
        existing.currency === input.currency &&
        Number(existing.amount_minor) === input.amountMinor
      );
    }
    const monthStartedAtMs = startOfUtcMonth(input.nowMs);
    const blockingControlTypes =
      input.checkoutKind === "support"
        ? ["commerce_kill", "new_checkout", "sales_suspension", "support_shutdown"]
        : [
            "commerce_kill",
            "new_checkout",
            "sales_suspension",
            "offering_suspension",
            "renewal_shutdown",
          ];
    const placeholders = blockingControlTypes.map(() => "?").join(",");
    const result = await run(
      this.database,
      `INSERT INTO commerce_checkout_capacity_claims
       (id, checkout_kind, connected_account_id, guild_id, offering_id, currency,
        amount_minor, month_started_at_ms, expires_at_ms, created_at_ms)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM commerce_operational_controls c
         WHERE c.enabled = 1 AND (c.expires_at_ms IS NULL OR c.expires_at_ms > ?)
           AND c.control_type IN (${placeholders})
           AND (
             (c.scope_type = 'global' AND c.scope_id = 'commerce') OR
             (c.scope_type = 'guild' AND c.scope_id = ?) OR
             (c.scope_type = 'seller' AND c.scope_id = ?) OR
             (c.scope_type = 'offering' AND c.scope_id = ?)
           )
       )
       AND (? = 'support' OR (
         (SELECT COUNT(*) FROM commerce_subscriptions s
          WHERE s.connected_account_id = ? AND s.status NOT IN ('canceled', 'ended'))
         + (SELECT COUNT(*) FROM commerce_checkout_capacity_claims cc
            WHERE cc.connected_account_id = ? AND cc.checkout_kind = 'subscription'
              AND cc.expires_at_ms > ?) < ?
       ))
       AND (? = 'support' OR (
         SELECT COUNT(*) FROM commerce_offering_lifecycles l
         WHERE l.connected_account_id = ? AND l.state = 'published'
       ) <= ?)
       AND (? <> 'support' OR ? <= ?)
       AND (
         COALESCE((SELECT SUM(p.amount_received_minor) FROM commerce_payments p
                   WHERE p.connected_account_id = ? AND p.currency = ? AND p.status = 'succeeded'
                     AND COALESCE(p.paid_at_ms, p.created_at_ms) >= ?), 0)
         + COALESCE((SELECT SUM(sp.amount_received_minor) FROM commerce_support_payments sp
                     WHERE sp.connected_account_id = ? AND sp.currency = ? AND sp.status = 'succeeded'
                       AND COALESCE(sp.paid_at_ms, sp.created_at_ms) >= ?), 0)
         + COALESCE((SELECT SUM(cc.amount_minor) FROM commerce_checkout_capacity_claims cc
                     WHERE cc.connected_account_id = ? AND cc.currency = ?
                       AND cc.month_started_at_ms = ? AND cc.expires_at_ms > ?), 0)
         + ?
       ) <= ?`,
      input.id,
      input.checkoutKind,
      input.connectedAccountId,
      input.guildId,
      input.offeringId,
      input.currency,
      input.amountMinor,
      monthStartedAtMs,
      input.expiresAtMs,
      input.nowMs,
      input.nowMs,
      ...blockingControlTypes,
      input.guildId,
      input.connectedAccountId,
      input.offeringId ?? "",
      input.checkoutKind,
      input.connectedAccountId,
      input.connectedAccountId,
      input.nowMs,
      COMMERCE_PILOT_LIMITS.activeSubscribers,
      input.checkoutKind,
      input.connectedAccountId,
      COMMERCE_PILOT_LIMITS.activeOfferings,
      input.checkoutKind,
      input.amountMinor,
      COMMERCE_PILOT_LIMITS.supportPaymentMinor,
      input.connectedAccountId,
      input.currency,
      monthStartedAtMs,
      input.connectedAccountId,
      input.currency,
      monthStartedAtMs,
      input.connectedAccountId,
      input.currency,
      monthStartedAtMs,
      input.nowMs,
      input.amountMinor,
      COMMERCE_PILOT_LIMITS.monthlyGrossMinor,
    );
    return Number(result.meta.changes ?? 0) === 1;
  }

  async releaseCapacity(id: string): Promise<void> {
    await run(this.database, "DELETE FROM commerce_checkout_capacity_claims WHERE id = ?", id);
  }

  async refreshLimitAlerts(
    connectedAccountId: string,
    guildId: string,
    nowMs: number,
  ): Promise<void> {
    const usage = await this.readUsage(connectedAccountId, nowMs);
    const month = startOfUtcMonth(nowMs);
    const values: Array<{
      metric: string;
      currency: CommerceCurrency | null;
      value: number;
      limit: number;
    }> = [
      {
        metric: "active_subscribers",
        currency: null,
        value: usage.activeSubscribers,
        limit: COMMERCE_PILOT_LIMITS.activeSubscribers,
      },
      {
        metric: "active_offerings",
        currency: null,
        value: usage.activeOfferings,
        limit: COMMERCE_PILOT_LIMITS.activeOfferings,
      },
      ...(["AUD", "USD"] as const).map((currency) => ({
        metric: "monthly_gross",
        currency,
        value: usage.monthlyGrossMinor[currency],
        limit: COMMERCE_PILOT_LIMITS.monthlyGrossMinor,
      })),
    ];
    const statements: D1PreparedStatement[] = [];
    for (const item of values) {
      for (const threshold of COMMERCE_PILOT_LIMITS.alertThresholds) {
        if (item.value * 100 < item.limit * threshold) continue;
        const id = `limit:${guildId}:${month}:${item.metric}:${item.currency ?? "count"}:${threshold}`;
        statements.push(
          this.database
            .prepare(
              `INSERT INTO commerce_limit_alerts
               (id, connected_account_id, guild_id, metric, currency, threshold_percent,
                observed_value, limit_value, status, first_seen_at_ms, last_seen_at_ms,
                resolved_at_ms, created_at_ms, updated_at_ms)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, NULL, ?, ?)
               ON CONFLICT(id) DO UPDATE SET observed_value = excluded.observed_value,
                 last_seen_at_ms = excluded.last_seen_at_ms, status = 'open',
                 resolved_at_ms = NULL, updated_at_ms = excluded.updated_at_ms`,
            )
            .bind(
              id,
              connectedAccountId,
              guildId,
              item.metric,
              item.currency,
              threshold,
              item.value,
              item.limit,
              nowMs,
              nowMs,
              nowMs,
              nowMs,
            ),
        );
        const incidentKey = `commerce-limit:${item.metric}:${item.currency ?? "count"}:${threshold}`;
        statements.push(
          this.database
            .prepare(
              `INSERT INTO commerce_incidents
               (id, connected_account_id, guild_id, incident_key, severity, status,
                summary_code, entity_type, entity_id, safe_args_json, occurrence_count,
                first_seen_at_ms, last_seen_at_ms, resolved_at_ms, created_at_ms, updated_at_ms)
               VALUES (?, ?, ?, ?, ?, 'open', 'commerce_pilot_limit_threshold',
                       'seller', ?, ?, 1, ?, ?, NULL, ?, ?)
               ON CONFLICT(guild_id, incident_key) DO UPDATE SET
                 status = 'open', safe_args_json = excluded.safe_args_json,
                 occurrence_count = occurrence_count + 1,
                 last_seen_at_ms = excluded.last_seen_at_ms,
                 resolved_at_ms = NULL, updated_at_ms = excluded.updated_at_ms`,
            )
            .bind(
              `incident:${guildId}:${incidentKey}`,
              connectedAccountId,
              guildId,
              incidentKey,
              threshold === 100 ? "error" : "warning",
              connectedAccountId,
              JSON.stringify({
                metric: item.metric,
                currency: item.currency,
                threshold,
                observedValue: item.value,
                limitValue: item.limit,
              }),
              nowMs,
              nowMs,
              nowMs,
              nowMs,
            ),
        );
      }
    }
    if (statements.length > 0) await this.database.batch(statements);
  }

  async saveControl(control: CommerceOperationalControl): Promise<void> {
    await this.database.batch([
      this.database
        .prepare(
          `INSERT INTO commerce_operational_controls
           (id, scope_type, scope_id, control_type, enabled, reason_code, actor_user_id,
            expires_at_ms, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(scope_type, scope_id, control_type) DO UPDATE SET
             enabled = excluded.enabled, reason_code = excluded.reason_code,
             actor_user_id = excluded.actor_user_id, expires_at_ms = excluded.expires_at_ms,
             updated_at_ms = excluded.updated_at_ms`,
        )
        .bind(
          control.id,
          control.scopeType,
          control.scopeId,
          control.controlType,
          control.enabled ? 1 : 0,
          control.reasonCode,
          control.actorUserId,
          control.expiresAtMs,
          control.createdAtMs,
          control.updatedAtMs,
        ),
      this.database
        .prepare(
          `INSERT INTO commerce_operations_ledger
           (id, connected_account_id, guild_id, operation_key, operation_type,
            entity_type, entity_id, actor_type, actor_id, payload_json, created_at_ms)
           VALUES (?, NULL, ?, ?, 'safeguard.control_changed', 'control', ?,
                   'operator', ?, ?, ?)`,
        )
        .bind(
          `safeguard:${control.id}`,
          control.scopeType === "guild" ? control.scopeId : "global",
          `safeguard:${control.id}`,
          `${control.scopeType}:${control.scopeId}:${control.controlType}`,
          control.actorUserId,
          JSON.stringify({
            enabled: control.enabled,
            reasonCode: control.reasonCode,
            expiresAtMs: control.expiresAtMs,
            effects: COMMERCE_CONTROL_EFFECTS[control.controlType],
          }),
          control.updatedAtMs,
        ),
    ]);
  }

  async readDashboard(guildId: string, nowMs: number): Promise<CommerceSafeguardDashboard | null> {
    const account = await first(
      this.database,
      `SELECT id FROM commerce_connected_accounts
       WHERE guild_id = ? AND status <> 'archived' LIMIT 1`,
      guildId,
    );
    if (!account) return null;
    const connectedAccountId = String(account.id);
    const controlRows = await all(
      this.database,
      `SELECT * FROM commerce_operational_controls c
       WHERE c.enabled = 1 AND (c.expires_at_ms IS NULL OR c.expires_at_ms > ?)
         AND (
           (c.scope_type = 'global' AND c.scope_id = 'commerce') OR
           (c.scope_type = 'guild' AND c.scope_id = ?) OR
           (c.scope_type = 'seller' AND c.scope_id = ?) OR
           (c.scope_type = 'offering' AND c.scope_id IN (
             SELECT id FROM commerce_offerings WHERE connected_account_id = ?
           ))
         )
       ORDER BY c.control_type, c.scope_type`,
      nowMs,
      guildId,
      connectedAccountId,
      connectedAccountId,
    );
    const controls = controlRows.map(controlFromRow);
    const usage = await this.readUsage(connectedAccountId, nowMs);
    const blockReasons = controls
      .filter((control) => COMMERCE_CONTROL_EFFECTS[control.controlType].newPurchases)
      .map((control) => `control:${control.controlType}:${control.reasonCode ?? "unspecified"}`);
    if (usage.activeSubscribers >= COMMERCE_PILOT_LIMITS.activeSubscribers) {
      blockReasons.push("limit:active_subscribers");
    }
    for (const currency of ["AUD", "USD"] as const) {
      if (usage.monthlyGrossMinor[currency] >= COMMERCE_PILOT_LIMITS.monthlyGrossMinor) {
        blockReasons.push(`limit:monthly_gross:${currency}`);
      }
    }
    return {
      connectedAccountId,
      guildId,
      controls,
      usage,
      limits: COMMERCE_PILOT_LIMITS,
      blockReasons,
    };
  }

  private async readUsage(
    connectedAccountId: string,
    nowMs: number,
  ): Promise<CommerceSafeguardUsage> {
    const month = startOfUtcMonth(nowMs);
    const [
      subscriptions,
      offerings,
      volume,
      checkouts,
      webhooks,
      reconciliation,
      roles,
      refunds,
      disputes,
      seller,
      repair,
    ] = await Promise.all([
      first(
        this.database,
        `SELECT
           SUM(CASE WHEN status NOT IN ('canceled','ended') THEN 1 ELSE 0 END) active,
           SUM(CASE WHEN status = 'past_due' THEN 1 ELSE 0 END) past_due,
           SUM(CASE WHEN status NOT IN ('canceled','ended') AND cancel_at_period_end = 1 THEN 1 ELSE 0 END) canceling
         FROM commerce_subscriptions WHERE connected_account_id = ?`,
        connectedAccountId,
      ),
      first(
        this.database,
        `SELECT COUNT(*) active FROM commerce_offering_lifecycles
         WHERE connected_account_id = ? AND state = 'published'`,
        connectedAccountId,
      ),
      all(
        this.database,
        `SELECT currency, SUM(gross_minor) gross_minor, SUM(fee_minor) fee_minor FROM (
           SELECT currency, amount_received_minor gross_minor,
                  CAST(amount_received_minor * 5 / 100 AS INTEGER) fee_minor
           FROM commerce_payments WHERE connected_account_id = ? AND status = 'succeeded'
             AND COALESCE(paid_at_ms, created_at_ms) >= ?
           UNION ALL
           SELECT currency, amount_received_minor, application_fee_minor
           FROM commerce_support_payments WHERE connected_account_id = ? AND status = 'succeeded'
             AND COALESCE(paid_at_ms, created_at_ms) >= ?
         ) GROUP BY currency`,
        connectedAccountId,
        month,
        connectedAccountId,
        month,
      ),
      first(
        this.database,
        `SELECT
           SUM(CASE WHEN status IN ('creating','open','returned') THEN 1 ELSE 0 END) open,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) failed,
           (SELECT COUNT(*) FROM commerce_payments p
            WHERE p.connected_account_id = ? AND p.status = 'succeeded') +
           (SELECT COUNT(*) FROM commerce_support_payments sp
            WHERE sp.connected_account_id = ? AND sp.status = 'succeeded') succeeded
         FROM (
           SELECT status FROM commerce_checkout_attempts WHERE connected_account_id = ?
           UNION ALL
           SELECT status FROM commerce_support_checkout_attempts WHERE connected_account_id = ?
         )`,
        connectedAccountId,
        connectedAccountId,
        connectedAccountId,
        connectedAccountId,
      ),
      first(
        this.database,
        `SELECT COUNT(*) accepted,
          SUM(CASE WHEN generation = 0 THEN 1 ELSE 0 END) quarantined,
          SUM(CASE WHEN status = 'ignored' THEN 1 ELSE 0 END) duplicate
         FROM commerce_webhook_events WHERE connected_account_id = ?`,
        connectedAccountId,
      ),
      first(
        this.database,
        `SELECT
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) failed,
          SUM(CASE WHEN status = 'pending' AND updated_at_ms < ? THEN 1 ELSE 0 END) stale
         FROM commerce_sync_state WHERE connected_account_id = ?`,
        nowMs - 15 * 60_000,
        connectedAccountId,
      ),
      first(
        this.database,
        `SELECT
          SUM(CASE WHEN status IN ('pending','processing') THEN 1 ELSE 0 END) pending,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) failed,
          (SELECT COUNT(*) FROM commerce_paid_role_outbox o
           WHERE o.entitlement_id IN (
             SELECT id FROM commerce_entitlements WHERE connected_account_id = ?
           ) AND o.status = 'dead_letter') dead_letter
         FROM commerce_role_assignments
         WHERE entitlement_id IN (
           SELECT id FROM commerce_entitlements WHERE connected_account_id = ?
         )`,
        connectedAccountId,
        connectedAccountId,
      ),
      all(
        this.database,
        `SELECT currency, COUNT(*) count, SUM(amount_minor) amount_minor
         FROM commerce_refunds WHERE connected_account_id = ? AND status = 'succeeded'
         GROUP BY currency`,
        connectedAccountId,
      ),
      all(
        this.database,
        `SELECT currency, COUNT(*) count, SUM(amount_minor) amount_minor FROM (
           SELECT currency, amount_minor FROM commerce_disputes
           WHERE connected_account_id = ? AND status NOT IN ('won','warning_closed')
           UNION ALL
           SELECT currency, amount_minor FROM commerce_support_disputes
           WHERE connected_account_id = ? AND status NOT IN ('won','warning_closed')
         ) GROUP BY currency`,
        connectedAccountId,
        connectedAccountId,
      ),
      first(
        this.database,
        `SELECT a.status account_status, p.lifecycle_state
         FROM commerce_connected_accounts a
         JOIN commerce_seller_profiles p ON p.connected_account_id = a.id WHERE a.id = ?`,
        connectedAccountId,
      ),
      first(
        this.database,
        `SELECT MIN(repair_deadline_at_ms) deadline
         FROM commerce_offering_lifecycles
         WHERE connected_account_id = ? AND state = 'repair_required'`,
        connectedAccountId,
      ),
    ]);
    const monthlyGrossMinor = moneyMap(volume, "gross_minor");
    const feesMinor = moneyMap(volume, "fee_minor");
    const refundAmounts = moneyMap(refunds, "amount_minor");
    const disputeAmounts = moneyMap(disputes, "amount_minor");
    return {
      activeSubscribers: Number(subscriptions?.active ?? 0),
      activeOfferings: Number(offerings?.active ?? 0),
      monthlyGrossMinor,
      checkoutCounts: {
        open: Number(checkouts?.open ?? 0),
        succeeded: Number(checkouts?.succeeded ?? 0),
        failed: Number(checkouts?.failed ?? 0),
      },
      webhookCounts: {
        accepted: Number(webhooks?.accepted ?? 0),
        duplicate: Number(webhooks?.duplicate ?? 0),
        quarantined: Number(webhooks?.quarantined ?? 0),
      },
      reconciliation: {
        staleCount: Number(reconciliation?.stale ?? 0),
        failedCount: Number(reconciliation?.failed ?? 0),
      },
      roles: {
        pending: Number(roles?.pending ?? 0),
        failed: Number(roles?.failed ?? 0),
        deadLetter: Number(roles?.dead_letter ?? 0),
      },
      subscriptions: {
        active: Number(subscriptions?.active ?? 0),
        pastDue: Number(subscriptions?.past_due ?? 0),
        grace: 0,
        disputed: disputes.reduce((sum, row) => sum + Number(row.count ?? 0), 0),
      },
      refunds: {
        count: refunds.reduce((sum, row) => sum + Number(row.count ?? 0), 0),
        amountMinor: refundAmounts,
      },
      disputes: {
        open: disputes.reduce((sum, row) => sum + Number(row.count ?? 0), 0),
        amountMinor: disputeAmounts,
      },
      feesMinor,
      restrictedSeller:
        seller?.account_status === "restricted" ||
        ["restricted", "repair_required", "disconnected"].includes(String(seller?.lifecycle_state)),
      oldestRepairAgeMs:
        repair?.deadline == null ? null : Math.max(0, nowMs - Number(repair.deadline)),
    };
  }
}

function controlFromRow(row: Row): CommerceOperationalControl {
  return {
    id: String(row.id),
    scopeType: String(row.scope_type) as CommerceOperationalControl["scopeType"],
    scopeId: String(row.scope_id),
    controlType: String(row.control_type) as CommerceOperationalControl["controlType"],
    enabled: Boolean(row.enabled),
    reasonCode: nullable(row.reason_code),
    actorUserId: String(row.actor_user_id),
    expiresAtMs: numberOrNull(row.expires_at_ms),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function moneyMap(rows: Row[], field: string): Record<CommerceCurrency, number> {
  const result = { AUD: 0, USD: 0 };
  for (const row of rows) {
    if (row.currency === "AUD" || row.currency === "USD") {
      result[row.currency] = Number(row[field] ?? 0);
    }
  }
  return result;
}

function startOfUtcMonth(nowMs: number): number {
  const date = new Date(nowMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

async function first(
  database: D1Database,
  query: string,
  ...values: unknown[]
): Promise<Row | null> {
  return (
    (await database
      .prepare(query)
      .bind(...values)
      .first<Row>()) ?? null
  );
}

async function all(database: D1Database, query: string, ...values: unknown[]): Promise<Row[]> {
  return ((
    await database
      .prepare(query)
      .bind(...values)
      .all<Row>()
  ).results ?? []) as Row[];
}

async function run(database: D1Database, query: string, ...values: unknown[]) {
  return database
    .prepare(query)
    .bind(...values)
    .run();
}

function nullable(value: unknown): string | null {
  return value == null ? null : String(value);
}

function numberOrNull(value: unknown): number | null {
  return value == null ? null : Number(value);
}
