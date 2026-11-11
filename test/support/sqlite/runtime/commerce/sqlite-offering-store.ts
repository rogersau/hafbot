import type {
  CommerceOfferingStore,
  CommerceOfferingDashboard,
  CommerceOfferingPublishContext,
  CommerceOfferingRetirementProgress,
  CommerceOfferingRetirementStatus,
} from "../../../../../src/commerce/offering-service";
import type {
  CommerceOffering,
  CommerceOfferingLifecycle,
  CommercePrice,
} from "../../../../../src/commerce/types";

type Row = Record<string, unknown>;

/** D1 implementation for seller offering configuration and dashboard reads. */
export class SqliteCommerceOfferingStore implements CommerceOfferingStore {
  constructor(
    private readonly database: D1Database,
    private readonly premium: { isPremium(guildId: string): Promise<boolean> } = {
      async isPremium() {
        return false;
      },
    },
  ) {}

  async createOffering(offering: CommerceOffering): Promise<void> {
    await this.database
      .prepare(
        `INSERT INTO commerce_offerings
          (id, connected_account_id, guild_id, discord_role_id, name, description,
           purchase_type, state, terms_version, included_benefits_json, support_contact,
           role_manageable, repair_deadline_at_ms, repair_previous_state, retire_at_ms,
           published_at_ms, archived_at_ms, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           discord_role_id=excluded.discord_role_id, name=excluded.name,
           description=excluded.description, purchase_type=excluded.purchase_type,
           state=excluded.state, terms_version=excluded.terms_version,
           included_benefits_json=excluded.included_benefits_json,
           support_contact=excluded.support_contact,
           role_manageable=excluded.role_manageable,
           repair_deadline_at_ms=excluded.repair_deadline_at_ms,
           repair_previous_state=excluded.repair_previous_state,
           retire_at_ms=excluded.retire_at_ms,
           published_at_ms=excluded.published_at_ms,
           archived_at_ms=excluded.archived_at_ms,
           updated_at_ms=excluded.updated_at_ms`,
      )
      .bind(
        offering.id,
        offering.connectedAccountId,
        offering.guildId,
        offering.discordRoleId,
        offering.name,
        offering.description,
        offering.purchaseType,
        offering.state,
        offering.termsVersion,
        JSON.stringify(offering.includedBenefits),
        offering.supportContact,
        offering.roleManageable ? 1 : 0,
        offering.repairDeadlineAtMs,
        offering.repairPreviousState,
        offering.retireAtMs,
        offering.publishedAtMs,
        offering.archivedAtMs,
        offering.createdAtMs,
        offering.updatedAtMs,
      )
      .run();
  }

  async readOffering(offeringId: string): Promise<CommerceOffering | null> {
    const row = await this.database
      .prepare("SELECT * FROM commerce_offerings WHERE id = ? LIMIT 1")
      .bind(offeringId)
      .first<Row>();
    return row ? offeringFromRow(row) : null;
  }

  async listOfferings(connectedAccountId: string): Promise<CommerceOffering[]> {
    const result = await this.database
      .prepare(
        "SELECT * FROM commerce_offerings WHERE connected_account_id = ? ORDER BY created_at_ms",
      )
      .bind(connectedAccountId)
      .all<Row>();
    return result.results.map(offeringFromRow);
  }

  async createPrice(price: CommercePrice): Promise<boolean> {
    const result = await this.database
      .prepare(
        `INSERT INTO commerce_prices
          (id, connected_account_id, offering_id, stripe_product_id, stripe_price_id,
           currency, unit_amount_minor, price_type, recurring_interval, status,
           provider_created_at_ms, retired_at_ms, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .bind(
        price.id,
        price.connectedAccountId,
        price.offeringId,
        price.stripeProductId,
        price.stripePriceId,
        price.currency,
        price.unitAmountMinor,
        price.priceType,
        price.recurringInterval,
        price.status,
        price.providerCreatedAtMs,
        price.retiredAtMs,
        price.createdAtMs,
      )
      .run();
    return result.meta.changes > 0;
  }

  async retirePrice(priceId: string, retiredAtMs: number): Promise<void> {
    await this.database
      .prepare(
        "UPDATE commerce_prices SET status = 'retired', retired_at_ms = ? WHERE id = ? AND status = 'active'",
      )
      .bind(retiredAtMs, priceId)
      .run();
  }

  async listPrices(offeringId: string): Promise<CommercePrice[]> {
    const result = await this.database
      .prepare("SELECT * FROM commerce_prices WHERE offering_id = ? ORDER BY created_at_ms")
      .bind(offeringId)
      .all<Row>();
    return result.results.map(priceFromRow);
  }

  async readPublishContext(
    connectedAccountId: string,
    guildId: string,
    offeringId: string,
  ): Promise<CommerceOfferingPublishContext> {
    const row = await this.database
      .prepare(
        `SELECT a.status AS account_status, a.charges_enabled, a.payouts_enabled,
                a.details_submitted, p.lifecycle_state, p.approval_state,
                o.role_manageable, o.terms_version,
                EXISTS(SELECT 1 FROM commerce_seller_acceptances sa
                  WHERE sa.connected_account_id = a.id AND sa.terms_version = o.terms_version) AS terms_accepted
           FROM commerce_connected_accounts a
           JOIN commerce_seller_profiles p ON p.connected_account_id = a.id
           JOIN commerce_offerings o
             ON o.id = ? AND o.connected_account_id = a.id AND o.guild_id = a.guild_id
          WHERE a.id = ? AND a.guild_id = ? LIMIT 1`,
      )
      .bind(offeringId, connectedAccountId, guildId)
      .first<Row>();
    if (!row)
      return {
        premiumActive: false,
        sellerEligible: false,
        termsAccepted: false,
        roleManageable: false,
      };
    return {
      premiumActive: await this.premium.isPremium(guildId),
      sellerEligible:
        row.account_status === "active" &&
        Boolean(row.charges_enabled) &&
        Boolean(row.payouts_enabled) &&
        Boolean(row.details_submitted) &&
        row.lifecycle_state === "active" &&
        row.approval_state === "approved",
      termsAccepted: Boolean(row.terms_accepted),
      roleManageable: Boolean(row.role_manageable),
    };
  }

  async countPublishedSubscriptions(guildId: string): Promise<number> {
    const row = await this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM commerce_offerings o
         WHERE o.guild_id = ? AND o.purchase_type = 'subscription'
           AND (o.state = 'published'
             OR (o.state = 'repair_required' AND o.repair_previous_state = 'published'))`,
      )
      .bind(guildId)
      .first<{ count: number }>();
    return Number(row?.count ?? 0);
  }

  async hasPublishedRoleMapping(
    guildId: string,
    discordRoleId: string,
    excludingOfferingId: string,
  ): Promise<boolean> {
    const row = await this.database
      .prepare(
        `SELECT 1 AS found FROM commerce_offerings o
         WHERE o.guild_id = ? AND o.discord_role_id = ? AND o.id <> ?
           AND (
             o.state = 'published'
             OR (o.state = 'repair_required' AND o.repair_previous_state = 'published')
           )
         LIMIT 1`,
      )
      .bind(guildId, discordRoleId, excludingOfferingId)
      .first<{ found: number }>();
    return Boolean(row?.found);
  }

  async beginRoleReplacement(input: {
    offering: CommerceOffering;
    replacementRoleId: string;
    nowMs: number;
  }): Promise<"updated" | "replacement_pending"> {
    const row = await this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM commerce_role_assignments ra
         JOIN commerce_entitlements e ON e.id=ra.entitlement_id
         WHERE e.offering_id=? AND ra.status IN ('pending','assigned','withheld','removing','failed')`,
      )
      .bind(input.offering.id)
      .first<{ count: number }>();
    if (Number(row?.count ?? 0) === 0) {
      await this.createOffering({
        ...input.offering,
        discordRoleId: input.replacementRoleId,
        roleManageable: true,
        repairDeadlineAtMs: null,
        repairPreviousState:
          input.offering.state === "repair_required" ? input.offering.repairPreviousState : null,
        updatedAtMs: input.nowMs,
      });
      return "updated";
    }
    const repairId = `role-repair:${input.offering.id}:${input.offering.discordRoleId}`;
    const deadlineAtMs = input.offering.repairDeadlineAtMs ?? input.nowMs + 72 * 60 * 60 * 1_000;
    await this.database.batch([
      this.database
        .prepare(
          `INSERT INTO commerce_paid_role_repairs(
             id,offering_id,guild_id,old_role_id,replacement_role_id,started_at_ms,deadline_at_ms,
             status,repaired_count,last_error_code,created_at_ms,updated_at_ms
           ) VALUES (?,?,?,?,?,?,?,'pending',0,NULL,?,?)
           ON CONFLICT(id) DO UPDATE SET replacement_role_id=excluded.replacement_role_id,
             status='pending',last_error_code=NULL,updated_at_ms=excluded.updated_at_ms`,
        )
        .bind(
          repairId,
          input.offering.id,
          input.offering.guildId,
          input.offering.discordRoleId,
          input.replacementRoleId,
          input.nowMs,
          deadlineAtMs,
          input.nowMs,
          input.nowMs,
        ),
      this.database
        .prepare(
          `UPDATE commerce_offerings
           SET state='repair_required',
               repair_previous_state=CASE WHEN state='repair_required'
                 THEN repair_previous_state ELSE state END,
               role_manageable=1, repair_deadline_at_ms=?, updated_at_ms=?
           WHERE id=?`,
        )
        .bind(deadlineAtMs, input.nowMs, input.offering.id),
    ]);
    return "replacement_pending";
  }

  async beginRetirement(input: {
    offering: CommerceOffering;
    actorUserId: string;
    reasonCode: string;
    actionId: string;
    retireAtMs: number;
    nowMs: number;
  }): Promise<void> {
    const operationPrefix = `commerce:offering-retirement:${input.offering.id}`;
    await this.database.batch([
      this.database
        .prepare(
          `UPDATE commerce_offerings
             SET state='retiring', retire_at_ms=COALESCE(retire_at_ms, ?), updated_at_ms=?
           WHERE id=? AND state IN ('published','unpublished','suspended','retiring')`,
        )
        .bind(input.retireAtMs, input.nowMs, input.offering.id),
      this.database
        .prepare(
          `INSERT INTO commerce_offering_retirements(
             id, connected_account_id, guild_id, offering_id, requested_by_user_id, reason_code,
             status, active_subscription_count, scheduled_cancellation_count,
             failed_cancellation_count, latest_period_end_ms, last_error_code,
             created_at_ms, updated_at_ms, completed_at_ms
           )
           SELECT ?, ?, ?, ?, ?, ?, 'scheduling_cancellations',
             COALESCE(SUM(CASE WHEN status NOT IN ('canceled','ended') THEN 1 ELSE 0 END), 0),
             COALESCE(SUM(CASE WHEN status NOT IN ('canceled','ended') AND cancel_at_period_end=1 THEN 1 ELSE 0 END), 0),
             0, MAX(CASE WHEN status NOT IN ('canceled','ended') THEN current_period_end_ms END), NULL, ?, ?, NULL
             FROM commerce_subscriptions
            WHERE offering_id=?
           ON CONFLICT(offering_id) DO NOTHING`,
        )
        .bind(
          input.actionId,
          input.offering.connectedAccountId,
          input.offering.guildId,
          input.offering.id,
          input.actorUserId,
          input.reasonCode,
          input.nowMs,
          input.nowMs,
          input.offering.id,
        ),
      this.database
        .prepare(
          `INSERT INTO commerce_financial_provider_actions(
             id, operation_key, parent_action_id, workflow_type, workflow_id,
             connected_account_id, guild_id, offering_id, subscription_id,
             stripe_subscription_id, action_type, reason_code, status, attempt_count,
             available_at_ms, lease_token, claimed_at_ms, lease_expires_at_ms,
             provider_completed_at_ms, reconciliation_requested_at_ms, completed_at_ms,
             last_error_code, created_at_ms, updated_at_ms
           )
           SELECT ? || ':' || s.id, ? || ':' || s.id, r.id, 'offering_retirement', r.offering_id,
                   s.connected_account_id, ?, s.offering_id, s.id, s.stripe_subscription_id,
                   'subscription.cancel_at_period_end', r.reason_code,
                   CASE WHEN s.cancel_at_period_end=1 THEN 'completed' ELSE 'pending' END,
                   0, ?, NULL, NULL, NULL,
                   CASE WHEN s.cancel_at_period_end=1 THEN ? END,
                   CASE WHEN s.cancel_at_period_end=1 THEN ? END,
                   CASE WHEN s.cancel_at_period_end=1 THEN ? END,
                   NULL, ?, ?
             FROM commerce_subscriptions s
             JOIN commerce_offering_retirements r ON r.offering_id=s.offering_id
            WHERE s.offering_id=?
              AND s.status NOT IN ('canceled','ended')
              AND r.id=?
           ON CONFLICT(operation_key) DO NOTHING`,
        )
        .bind(
          operationPrefix,
          operationPrefix,
          input.offering.guildId,
          input.nowMs,
          input.nowMs,
          input.nowMs,
          input.nowMs,
          input.nowMs,
          input.nowMs,
          input.offering.id,
          input.actionId,
        ),
    ]);
  }

  async archiveOffering(offeringId: string, nowMs: number): Promise<boolean> {
    const result = await this.database
      .prepare(
        `UPDATE commerce_offerings
            SET state='archived', archived_at_ms=COALESCE(archived_at_ms, ?), updated_at_ms=?
          WHERE id=?
            AND (
              (
                state='retiring'
                AND EXISTS (
                  SELECT 1 FROM commerce_offering_retirements r
                   WHERE r.offering_id=? AND r.status='complete'
                )
              )
              OR (
                state='draft'
                AND NOT EXISTS (
                  SELECT 1 FROM commerce_offering_retirements r
                   WHERE r.offering_id=?
                )
              )
            )
            AND NOT EXISTS (
              SELECT 1 FROM commerce_subscriptions s
               WHERE s.offering_id=? AND s.status NOT IN ('canceled','ended')
            )`,
      )
      .bind(nowMs, nowMs, offeringId, offeringId, offeringId, offeringId)
      .run();
    return result.meta.changes === 1;
  }

  async readDashboard(connectedAccountId: string): Promise<CommerceOfferingDashboard> {
    const account = await this.database
      .prepare(
        "SELECT status, charges_enabled, payouts_enabled, details_submitted FROM commerce_connected_accounts WHERE id = ?",
      )
      .bind(connectedAccountId)
      .first<Row>();
    const offerings = await this.database
      .prepare(
        `SELECT * FROM commerce_offerings
         WHERE connected_account_id = ? ORDER BY created_at_ms`,
      )
      .bind(connectedAccountId)
      .all<Row>();
    const output = [] as CommerceOfferingDashboard["offerings"];
    for (const row of offerings.results) {
      const id = String(row.id);
      const subs = await this.database
        .prepare(
          `SELECT
             SUM(CASE WHEN status IN ('active','trialing') AND cancel_at_period_end = 0 THEN 1 ELSE 0 END) active,
             SUM(CASE WHEN status NOT IN ('canceled','ended') AND cancel_at_period_end = 1 THEN 1 ELSE 0 END) canceling,
             SUM(CASE WHEN status IN ('incomplete','past_due','paused','unpaid') THEN 1 ELSE 0 END) past_due
           FROM commerce_subscriptions WHERE offering_id = ?`,
        )
        .bind(id)
        .first<Row>();
      const money = async (table: string, amount: string, status?: string, viaPayment = false) => {
        const where = status ? ` AND t.status = '${status}'` : "";
        const join = viaPayment ? " JOIN commerce_payments p ON p.id = t.payment_id" : "";
        const offeringWhere = viaPayment ? "p.offering_id" : "t.offering_id";
        const rows = await this.database
          .prepare(
            `SELECT t.currency, COALESCE(SUM(t.${amount}), 0) AS amount FROM ${table} t${join} WHERE ${offeringWhere} = ?${where} GROUP BY t.currency`,
          )
          .bind(id)
          .all<Row>();
        return rows.results.reduce(
          (acc, item) => ({ ...acc, [String(item.currency)]: Number(item.amount ?? 0) }),
          { AUD: 0, USD: 0 },
        ) as Record<"AUD" | "USD", number>;
      };
      const grossByCurrency = await money(
        "commerce_payments",
        "amount_received_minor",
        "succeeded",
      );
      const refundsByCurrency = await money("commerce_refunds", "amount_minor", "succeeded", true);
      const disputesByCurrency = await money("commerce_disputes", "amount_minor", undefined, true);
      const failures = await this.database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM commerce_role_assignments ra
               JOIN commerce_entitlements e ON e.id = ra.entitlement_id
              WHERE e.offering_id = ? AND ra.status = 'failed') AS role_failures,
             (SELECT COUNT(*) FROM commerce_incidents i
              WHERE i.entity_id = ? AND i.status = 'open') AS incidents`,
        )
        .bind(id, id)
        .first<Row>();
      const retirement = await this.database
        .prepare(
          `SELECT r.status, r.completed_at_ms, r.latest_period_end_ms,
             (SELECT COUNT(*) FROM commerce_subscriptions s
               WHERE s.offering_id=r.offering_id AND s.status NOT IN ('canceled','ended')) AS active_subscription_count,
             (SELECT COUNT(*) FROM commerce_subscriptions s
               WHERE s.offering_id=r.offering_id AND s.status NOT IN ('canceled','ended')
                 AND s.cancel_at_period_end=1) AS scheduled_cancellation_count,
             (SELECT COUNT(*) FROM commerce_financial_provider_actions a
               WHERE a.workflow_type='offering_retirement' AND a.workflow_id=r.offering_id
                  AND a.status IN ('failed','quarantined')) AS failed_cancellation_count,
             COALESCE(
               (SELECT MAX(s.current_period_end_ms) FROM commerce_subscriptions s
                 WHERE s.offering_id=r.offering_id AND s.status NOT IN ('canceled','ended')),
               r.latest_period_end_ms
             ) AS current_latest_period_end_ms
           FROM commerce_offering_retirements r
          WHERE r.offering_id=?
          LIMIT 1`,
        )
        .bind(id)
        .first<Row>();
      output.push({
        offering: offeringFromRow(row),
        subscribers: {
          active: Number(subs?.active ?? 0),
          canceling: Number(subs?.canceling ?? 0),
          pastDue: Number(subs?.past_due ?? 0),
          grace: 0,
          disputed: 0,
        },
        grossByCurrency,
        refundsByCurrency,
        disputesByCurrency,
        activePrices: (await this.listPrices(id)).filter((price) => price.status === "active"),
        estimatedProceedsByCurrency: {
          AUD: Math.max(
            0,
            grossByCurrency.AUD - refundsByCurrency.AUD - Math.round(grossByCurrency.AUD * 0.05),
          ),
          USD: Math.max(
            0,
            grossByCurrency.USD - refundsByCurrency.USD - Math.round(grossByCurrency.USD * 0.05),
          ),
        },
        upcomingCancellations: Number(subs?.canceling ?? 0),
        roleFailures: Number(failures?.role_failures ?? 0),
        reconciliationIncidents: Number(failures?.incidents ?? 0),
        retirement: retirement ? retirementFromRow(retirement) : null,
      });
    }
    return {
      seller: account
        ? {
            connectedAccountId,
            status: String(account.status),
            chargesEnabled: Boolean(account.charges_enabled),
            payoutsEnabled: Boolean(account.payouts_enabled),
            detailsSubmitted: Boolean(account.details_submitted),
          }
        : null,
      offerings: output,
      estimatedProceedsAreNonAuthoritative: true,
    };
  }
}

function offeringFromRow(row: Row): CommerceOffering {
  return {
    id: String(row.id),
    connectedAccountId: String(row.connected_account_id),
    guildId: String(row.guild_id),
    discordRoleId: String(row.discord_role_id),
    name: String(row.name),
    description: row.description == null ? null : String(row.description),
    purchaseType: row.purchase_type === "one_time" ? "one_time" : "subscription",
    state: lifecycleValue(row.state),
    termsVersion: row.terms_version == null ? null : String(row.terms_version),
    includedBenefits: parseBenefits(row.included_benefits_json),
    supportContact: row.support_contact == null ? null : String(row.support_contact),
    roleManageable: Boolean(row.role_manageable),
    repairDeadlineAtMs:
      row.repair_deadline_at_ms == null ? null : Number(row.repair_deadline_at_ms),
    repairPreviousState:
      row.repair_previous_state == null ? null : lifecycleValue(row.repair_previous_state),
    retireAtMs: row.retire_at_ms == null ? null : Number(row.retire_at_ms),
    publishedAtMs: row.published_at_ms == null ? null : Number(row.published_at_ms),
    archivedAtMs: row.archived_at_ms == null ? null : Number(row.archived_at_ms),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function priceFromRow(row: Row): CommercePrice {
  return {
    id: String(row.id),
    connectedAccountId: String(row.connected_account_id),
    offeringId: String(row.offering_id),
    stripeProductId: String(row.stripe_product_id),
    stripePriceId: String(row.stripe_price_id),
    currency: row.currency === "USD" ? "USD" : "AUD",
    unitAmountMinor: Number(row.unit_amount_minor),
    priceType: row.price_type === "one_time" ? "one_time" : "recurring",
    recurringInterval:
      row.recurring_interval === "year"
        ? "year"
        : row.recurring_interval === "month"
          ? "month"
          : null,
    status: row.status === "retired" ? "retired" : "active",
    providerCreatedAtMs:
      row.provider_created_at_ms == null ? null : Number(row.provider_created_at_ms),
    retiredAtMs: row.retired_at_ms == null ? null : Number(row.retired_at_ms),
    createdAtMs: Number(row.created_at_ms),
  };
}

function lifecycleValue(value: unknown): CommerceOfferingLifecycle {
  const allowed: CommerceOfferingLifecycle[] = [
    "draft",
    "published",
    "unpublished",
    "repair_required",
    "retiring",
    "archived",
    "suspended",
  ];
  if (typeof value !== "string" || !allowed.includes(value as CommerceOfferingLifecycle))
    throw new Error("Invalid commerce offering lifecycle state");
  return value as CommerceOfferingLifecycle;
}

function retirementFromRow(row: Row): CommerceOfferingRetirementProgress {
  return {
    status: retirementStatus(row.status),
    activeSubscriptionCount: Number(row.active_subscription_count ?? 0),
    scheduledCancellationCount: Number(row.scheduled_cancellation_count ?? 0),
    failedCancellationCount: Number(row.failed_cancellation_count ?? 0),
    latestPeriodEndMs:
      row.current_latest_period_end_ms == null ? null : Number(row.current_latest_period_end_ms),
    completedAtMs: row.completed_at_ms == null ? null : Number(row.completed_at_ms),
  };
}

function retirementStatus(value: unknown): CommerceOfferingRetirementStatus {
  const allowed: CommerceOfferingRetirementStatus[] = [
    "requested",
    "stopping_sales",
    "scheduling_cancellations",
    "waiting_for_period_end",
    "complete",
    "failed",
  ];
  if (typeof value !== "string" || !allowed.includes(value as CommerceOfferingRetirementStatus)) {
    throw new Error("Invalid commerce offering retirement status");
  }
  return value as CommerceOfferingRetirementStatus;
}

function parseBenefits(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}
