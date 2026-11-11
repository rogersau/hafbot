import type {
  CommerceFinancialAction,
  CommerceFinancialActionLease,
  CommerceFinancialOperationsStore,
  CommerceOffboardingSubscription,
  CommerceScopedPayment,
  CommerceScopedSupportPayment,
  CommerceScopedSubscription,
  CommerceSellerOffboarding,
} from "../../../../../src/commerce/financial-operations";
import type {
  CommerceConnectedAccount,
  CommerceCurrency,
  CommercePayment,
  CommerceSubscription,
} from "../../../../../src/commerce/types";
import type { CommerceSupportPayment } from "../../../../../src/commerce/support-payments";

type Row = Record<string, unknown>;
const ACTION_LEASE_SQL = `EXISTS (
  SELECT 1 FROM commerce_financial_actions a
   WHERE a.id=? AND a.status='processing' AND a.lease_token=? AND a.lease_expires_at_ms>?
)`;

export class SqliteCommerceFinancialOperationsStore implements CommerceFinancialOperationsStore {
  constructor(private readonly database: D1Database) {}

  async readPayment(paymentId: string): Promise<CommerceScopedPayment | null> {
    const row = await first(
      this.database,
      `SELECT p.*, o.guild_id AS scoped_guild_id,
              a.guild_id AS account_guild_id, a.stripe_account_id, a.status AS account_status,
              a.country, a.default_currency, a.charges_enabled, a.payouts_enabled,
              a.details_submitted, a.provider_created_at_ms AS account_provider_created_at_ms,
              a.archived_at_ms, a.created_at_ms AS account_created_at_ms,
              a.updated_at_ms AS account_updated_at_ms
       FROM commerce_payments p
       JOIN commerce_offerings o ON o.id = p.offering_id
       JOIN commerce_connected_accounts a ON a.id = p.connected_account_id
       WHERE p.id = ? LIMIT 1`,
      paymentId,
    );
    if (!row) return null;
    const subscriptionRow = await first(
      this.database,
      `SELECT * FROM commerce_subscriptions
       WHERE connected_account_id = ? AND buyer_id = ? AND offering_id = ?
       ORDER BY created_at_ms DESC LIMIT 1`,
      row.connected_account_id,
      row.buyer_id,
      row.offering_id,
    );
    return {
      payment: paymentFromRow(row),
      subscription: subscriptionRow ? subscriptionFromRow(subscriptionRow) : null,
      account: accountFromJoinedRow(row),
      guildId: String(row.scoped_guild_id),
    };
  }

  async readSupportPayment(paymentId: string): Promise<CommerceScopedSupportPayment | null> {
    const row = await first(
      this.database,
      `SELECT p.*, a.guild_id AS account_guild_id, a.stripe_account_id,
              a.status AS account_status, a.country, a.default_currency, a.charges_enabled,
              a.payouts_enabled, a.details_submitted,
              a.provider_created_at_ms AS account_provider_created_at_ms,
              a.archived_at_ms, a.created_at_ms AS account_created_at_ms,
              a.updated_at_ms AS account_updated_at_ms
       FROM commerce_support_payments p
       JOIN commerce_connected_accounts a ON a.id = p.connected_account_id
       WHERE p.id = ? LIMIT 1`,
      paymentId,
    );
    return row
      ? {
          payment: supportPaymentFromRow(row),
          account: accountFromJoinedRow(row),
          guildId: String(row.guild_id),
        }
      : null;
  }

  async readSubscription(subscriptionId: string): Promise<CommerceScopedSubscription | null> {
    const row = await first(
      this.database,
      `SELECT s.*, o.guild_id AS scoped_guild_id,
              a.guild_id AS account_guild_id, a.stripe_account_id, a.status AS account_status,
              a.country, a.default_currency, a.charges_enabled, a.payouts_enabled,
              a.details_submitted, a.provider_created_at_ms AS account_provider_created_at_ms,
              a.archived_at_ms, a.created_at_ms AS account_created_at_ms,
              a.updated_at_ms AS account_updated_at_ms
       FROM commerce_subscriptions s
       JOIN commerce_offerings o ON o.id = s.offering_id
       JOIN commerce_connected_accounts a ON a.id = s.connected_account_id
       WHERE s.id = ? LIMIT 1`,
      subscriptionId,
    );
    return row
      ? {
          subscription: subscriptionFromRow(row),
          account: accountFromJoinedRow(row),
          guildId: String(row.scoped_guild_id),
        }
      : null;
  }

  async readSeller(guildId: string): Promise<{ account: CommerceConnectedAccount } | null> {
    const row = await first(
      this.database,
      `SELECT a.* FROM commerce_connected_accounts a
       JOIN commerce_seller_profiles p ON p.connected_account_id = a.id
       WHERE a.guild_id = ? AND a.status <> 'archived' LIMIT 1`,
      guildId,
    );
    return row ? { account: accountFromRow(row) } : null;
  }

  async listActiveSubscriptions(
    connectedAccountId: string,
  ): Promise<CommerceOffboardingSubscription[]> {
    const rows = await all(
      this.database,
      `SELECT id, stripe_subscription_id, buyer_id, offering_id, status,
              cancel_at_period_end, current_period_end_ms
       FROM commerce_subscriptions
       WHERE connected_account_id = ? AND status NOT IN ('canceled', 'ended')
       ORDER BY current_period_end_ms, id`,
      connectedAccountId,
    );
    return rows.map((row) => ({
      id: String(row.id),
      stripeSubscriptionId: String(row.stripe_subscription_id),
      buyerId: String(row.buyer_id),
      offeringId: String(row.offering_id),
      status: String(row.status) as CommerceOffboardingSubscription["status"],
      cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
      currentPeriodEndMs: numberOrNull(row.current_period_end_ms),
    }));
  }

  async readAction(actionId: string): Promise<CommerceFinancialAction | null> {
    const row = await first(
      this.database,
      "SELECT * FROM commerce_financial_actions WHERE id = ? LIMIT 1",
      actionId,
    );
    return row ? financialActionFromRow(row) : null;
  }

  async listRecoverableActions(nowMs: number, limit = 100): Promise<CommerceFinancialAction[]> {
    const rows = await all(
      this.database,
      `SELECT * FROM commerce_financial_actions
       WHERE quarantined_at_ms IS NULL AND
         ((status = 'failed' AND available_at_ms <= ?)
          OR (status = 'processing' AND (lease_expires_at_ms IS NULL OR lease_expires_at_ms <= ?)))
       ORDER BY available_at_ms, created_at_ms LIMIT ?`,
      nowMs,
      nowMs,
      limit,
    );
    return rows.map(financialActionFromRow);
  }

  async claimAction(
    action: CommerceFinancialAction,
    claim: { leaseToken: string; nowMs: number; leaseMs: number },
  ): Promise<"claimed" | "completed" | "processing" | "quarantined"> {
    const inserted = await run(
      this.database,
      `INSERT OR IGNORE INTO commerce_financial_actions
       (id, connected_account_id, guild_id, action_type, entity_type, entity_id,
        actor_user_id, reason_code, amount_minor, currency, status, provider_result_id,
         access_action, attempt_count, last_error_code, lease_token, claimed_at_ms,
         lease_expires_at_ms, available_at_ms, provider_completed_at_ms,
         reconciliation_requested_at_ms, created_at_ms, updated_at_ms, completed_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', NULL, ?, 1, NULL, ?, ?, ?, ?,
                NULL, NULL, ?, ?, NULL)`,
      action.id,
      action.connectedAccountId,
      action.guildId,
      action.actionType,
      action.entityType,
      action.entityId,
      action.actorUserId,
      action.reasonCode,
      action.amountMinor,
      action.currency,
      action.accessAction,
      claim.leaseToken,
      claim.nowMs,
      claim.nowMs + claim.leaseMs,
      action.availableAtMs,
      action.createdAtMs,
      action.updatedAtMs,
    );
    if (Number(inserted.meta.changes ?? 0) > 0) return "claimed";
    const existing = await first(
      this.database,
      `SELECT status, connected_account_id, guild_id, action_type, entity_type, entity_id,
               actor_user_id, reason_code, amount_minor, currency, access_action,
                lease_expires_at_ms, quarantined_at_ms
       FROM commerce_financial_actions WHERE id = ?`,
      action.id,
    );
    if (
      !existing ||
      existing.connected_account_id !== action.connectedAccountId ||
      existing.guild_id !== action.guildId ||
      existing.action_type !== action.actionType ||
      existing.entity_type !== action.entityType ||
      existing.entity_id !== action.entityId ||
      existing.actor_user_id !== action.actorUserId ||
      existing.reason_code !== action.reasonCode ||
      numberOrNull(existing.amount_minor) !== action.amountMinor ||
      nullableString(existing.currency) !== action.currency ||
      nullableString(existing.access_action) !== action.accessAction
    ) {
      throw new Error("commerce_financial_action_scope_mismatch");
    }
    if (existing?.status === "completed") return "completed";
    if (existing?.quarantined_at_ms != null) return "quarantined";
    if (
      (existing?.status === "failed" && existing.quarantined_at_ms == null) ||
      (existing?.status === "processing" &&
        (existing.lease_expires_at_ms == null ||
          Number(existing.lease_expires_at_ms) <= claim.nowMs))
    ) {
      const retried = await run(
        this.database,
        `UPDATE commerce_financial_actions
          SET status = 'processing', attempt_count = attempt_count + 1,
              last_error_code = NULL, lease_token = ?, claimed_at_ms = ?,
              lease_expires_at_ms = ?, updated_at_ms = ?
           WHERE id = ? AND quarantined_at_ms IS NULL AND (status = 'failed' OR
            (status = 'processing' AND (lease_expires_at_ms IS NULL OR lease_expires_at_ms <= ?)))`,
        claim.leaseToken,
        claim.nowMs,
        claim.nowMs + claim.leaseMs,
        claim.nowMs,
        action.id,
        claim.nowMs,
      );
      if (Number(retried.meta.changes ?? 0) > 0) return "claimed";
    }
    return "processing";
  }

  async failAction(
    actionId: string,
    leaseToken: string,
    errorCode: string,
    nowMs: number,
  ): Promise<boolean> {
    await this.database.batch([
      this.database
        .prepare(
          `UPDATE commerce_financial_actions
            SET status = 'failed', last_error_code = ?,
                available_at_ms = ? + MIN(3600000, attempt_count * 60000),
                quarantined_at_ms = CASE WHEN attempt_count >= 5 THEN ? ELSE NULL END,
                lease_expires_at_ms = NULL, updated_at_ms = ?
            WHERE id = ? AND status = 'processing' AND lease_token = ?
              AND lease_expires_at_ms > ?`,
        )
        .bind(errorCode, nowMs, nowMs, nowMs, actionId, leaseToken, nowMs),
      this.database
        .prepare(
          `INSERT INTO commerce_incidents(
             id,connected_account_id,guild_id,incident_key,severity,status,summary_code,
             entity_type,entity_id,safe_args_json,occurrence_count,first_seen_at_ms,
             last_seen_at_ms,resolved_at_ms,created_at_ms,updated_at_ms
           )
           SELECT 'commerce-financial-action:' || id, connected_account_id, guild_id,
                  'commerce-financial-action:' || id, 'critical', 'open',
                  'commerce_financial_action_quarantined', entity_type, entity_id, '{}',
                  1, ?, ?, NULL, ?, ?
             FROM commerce_financial_actions
            WHERE id=? AND status='failed' AND lease_token=? AND quarantined_at_ms=?
           ON CONFLICT(guild_id,incident_key) DO UPDATE SET status='open',
             occurrence_count=occurrence_count+1,last_seen_at_ms=excluded.last_seen_at_ms,
             updated_at_ms=excluded.updated_at_ms`,
        )
        .bind(nowMs, nowMs, nowMs, nowMs, actionId, leaseToken, nowMs),
    ]);
    const current = await first(
      this.database,
      "SELECT status,last_error_code,lease_token FROM commerce_financial_actions WHERE id=?",
      actionId,
    );
    return (
      current?.status === "failed" &&
      current.last_error_code === errorCode &&
      current.lease_token === leaseToken
    );
  }

  async markProviderCompleted(
    actionId: string,
    leaseToken: string,
    providerResultId: string | null,
    nowMs: number,
  ): Promise<boolean> {
    const result = await run(
      this.database,
      `UPDATE commerce_financial_actions
        SET provider_result_id = COALESCE(provider_result_id, ?),
            provider_completed_at_ms = COALESCE(provider_completed_at_ms, ?), updated_at_ms = ?
        WHERE id = ? AND status = 'processing' AND lease_token = ?
          AND lease_expires_at_ms > ?`,
      providerResultId,
      nowMs,
      nowMs,
      actionId,
      leaseToken,
      nowMs,
    );
    return Number(result.meta.changes ?? 0) === 1;
  }

  async markReconciliationRequested(
    actionId: string,
    leaseToken: string,
    nowMs: number,
  ): Promise<boolean> {
    const result = await run(
      this.database,
      `UPDATE commerce_financial_actions
        SET reconciliation_requested_at_ms = COALESCE(reconciliation_requested_at_ms, ?),
            updated_at_ms = ?
        WHERE id = ? AND status = 'processing' AND lease_token = ?
          AND lease_expires_at_ms > ?
          AND provider_completed_at_ms IS NOT NULL`,
      nowMs,
      nowMs,
      actionId,
      leaseToken,
      nowMs,
    );
    return Number(result.meta.changes ?? 0) === 1;
  }

  async completeAction(action: CommerceFinancialAction, leaseToken: string): Promise<boolean> {
    const payload = JSON.stringify({
      reasonCode: action.reasonCode,
      amountMinor: action.amountMinor,
      currency: action.currency,
      providerResultId: action.providerResultId,
      accessAction: action.accessAction,
    });
    await this.database.batch([
      this.database
        .prepare(
          `UPDATE commerce_financial_actions
           SET status = 'completed', provider_result_id = ?, access_action = ?,
                provider_completed_at_ms = ?, reconciliation_requested_at_ms = ?,
                last_error_code = NULL, lease_expires_at_ms = ?, updated_at_ms = ?,
                completed_at_ms = ?
             WHERE id = ? AND status = 'processing' AND lease_token = ?
               AND lease_expires_at_ms > ?`,
        )
        .bind(
          action.providerResultId,
          action.accessAction,
          action.providerCompletedAtMs,
          action.reconciliationRequestedAtMs,
          action.completedAtMs,
          action.updatedAtMs,
          action.completedAtMs,
          action.id,
          leaseToken,
          action.updatedAtMs,
        ),
      this.database
        .prepare(
          `INSERT OR IGNORE INTO commerce_operations_ledger
           (id, connected_account_id, guild_id, operation_key, operation_type,
            entity_type, entity_id, actor_type, actor_id, payload_json, created_at_ms)
           SELECT ?, ?, ?, ?, ?, ?, ?, 'admin', ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM commerce_financial_actions
             WHERE id = ? AND status = 'completed' AND lease_token = ?
           )
           ON CONFLICT(id) DO NOTHING`,
        )
        .bind(
          `financial:${action.id}`,
          action.connectedAccountId,
          action.guildId,
          `financial:${action.id}`,
          action.actionType,
          action.entityType,
          action.entityId,
          action.actorUserId,
          payload,
          action.completedAtMs ?? action.updatedAtMs,
          action.id,
          leaseToken,
        ),
    ]);
    const current = await first(
      this.database,
      "SELECT status, lease_token FROM commerce_financial_actions WHERE id = ?",
      action.id,
    );
    return current?.status === "completed" && current.lease_token === leaseToken;
  }

  async enqueueSubscriptionCancellations(input: {
    parentActionId: string;
    workflowType: "seller_offboarding" | "renewal_shutdown";
    workflowId: string;
    connectedAccountId: string;
    guildId: string;
    subscriptions: CommerceOffboardingSubscription[];
    reasonCode: string;
    nowMs: number;
    leaseToken: string;
  }): Promise<void> {
    if (input.subscriptions.length === 0) return;
    await this.database.batch(
      input.subscriptions.map((subscription) => {
        const operationKey = `commerce:${input.workflowType}:${input.workflowId}:${subscription.id}`;
        const completed = subscription.cancelAtPeriodEnd;
        return this.database
          .prepare(
            `INSERT INTO commerce_financial_provider_actions(
               id, operation_key, parent_action_id, workflow_type, workflow_id,
               connected_account_id, guild_id, offering_id, subscription_id,
               stripe_subscription_id, action_type, reason_code, status, attempt_count,
               available_at_ms, lease_token, claimed_at_ms, lease_expires_at_ms,
               provider_completed_at_ms, reconciliation_requested_at_ms, completed_at_ms,
               last_error_code, created_at_ms, updated_at_ms
             ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'subscription.cancel_at_period_end', ?,
                       ?, 0, ?, NULL, NULL, NULL, ?, NULL, ?, NULL, ?, ?
                WHERE ${ACTION_LEASE_SQL}
             ON CONFLICT(operation_key) DO NOTHING`,
          )
          .bind(
            operationKey,
            operationKey,
            input.parentActionId,
            input.workflowType,
            input.workflowId,
            input.connectedAccountId,
            input.guildId,
            subscription.offeringId,
            subscription.id,
            subscription.stripeSubscriptionId,
            input.reasonCode,
            completed ? "completed" : "pending",
            input.nowMs,
            completed ? input.nowMs : null,
            completed ? input.nowMs : null,
            input.nowMs,
            input.nowMs,
            input.parentActionId,
            input.leaseToken,
            input.nowMs,
          );
      }),
    );
  }

  async enqueueRefundCancellation(input: {
    parentActionId: string;
    leaseToken: string;
    connectedAccountId: string;
    guildId: string;
    subscription: CommerceOffboardingSubscription;
    mode: "immediate" | "period_end";
    reasonCode: string;
    nowMs: number;
  }): Promise<void> {
    const operationKey = `commerce:refund-cancellation:${input.parentActionId}:${input.subscription.id}`;
    const alreadyComplete = input.mode === "period_end" && input.subscription.cancelAtPeriodEnd;
    await run(
      this.database,
      `INSERT INTO commerce_financial_provider_actions(
         id, operation_key, parent_action_id, workflow_type, workflow_id,
         connected_account_id, guild_id, offering_id, subscription_id,
         stripe_subscription_id, action_type, reason_code, status, attempt_count,
         available_at_ms, lease_token, claimed_at_ms, lease_expires_at_ms,
         provider_completed_at_ms, reconciliation_requested_at_ms, completed_at_ms,
         last_error_code, created_at_ms, updated_at_ms
       ) SELECT ?, ?, ?, 'refund_followup', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL,
                NULL, ?, NULL, ?, NULL, ?, ? WHERE ${ACTION_LEASE_SQL}
       ON CONFLICT(operation_key) DO NOTHING`,
      operationKey,
      operationKey,
      input.parentActionId,
      input.parentActionId,
      input.connectedAccountId,
      input.guildId,
      input.subscription.offeringId,
      input.subscription.id,
      input.subscription.stripeSubscriptionId,
      input.mode === "immediate"
        ? "subscription.cancel_immediately"
        : "subscription.cancel_at_period_end",
      input.reasonCode,
      alreadyComplete ? "completed" : "pending",
      input.nowMs,
      alreadyComplete ? input.nowMs : null,
      alreadyComplete ? input.nowMs : null,
      input.nowMs,
      input.nowMs,
      input.parentActionId,
      input.leaseToken,
      input.nowMs,
    );
  }

  async stopNewSales(
    connectedAccountId: string,
    guildId: string,
    lease: CommerceFinancialActionLease,
  ): Promise<void> {
    await this.database.batch([
      this.database
        .prepare(
          `UPDATE commerce_offering_lifecycles
           SET state = CASE WHEN state = 'published' THEN 'unpublished' ELSE state END,
               updated_at_ms = ?
            WHERE connected_account_id = ? AND ${ACTION_LEASE_SQL}`,
        )
        .bind(lease.nowMs, connectedAccountId, lease.actionId, lease.leaseToken, lease.nowMs),
      this.database
        .prepare(
          `UPDATE commerce_support_configs SET enabled = 0, updated_at_ms = ?
            WHERE guild_id = ? AND ${ACTION_LEASE_SQL}`,
        )
        .bind(lease.nowMs, guildId, lease.actionId, lease.leaseToken, lease.nowMs),
    ]);
  }

  async saveSellerLifecycle(
    connectedAccountId: string,
    state: "offboarding" | "disconnected",
    lease: CommerceFinancialActionLease,
  ): Promise<void> {
    const statements = [
      this.database
        .prepare(
          `UPDATE commerce_seller_profiles SET lifecycle_state = ?, updated_at_ms = ?
           WHERE connected_account_id = ? AND ${ACTION_LEASE_SQL}`,
        )
        .bind(
          state,
          lease.nowMs,
          connectedAccountId,
          lease.actionId,
          lease.leaseToken,
          lease.nowMs,
        ),
    ];
    if (state === "disconnected") {
      statements.push(
        this.database
          .prepare(
            `UPDATE commerce_connected_accounts
             SET status = 'disconnected', charges_enabled = 0, payouts_enabled = 0,
                 updated_at_ms = ?
              WHERE id = ? AND status <> 'archived' AND ${ACTION_LEASE_SQL}`,
          )
          .bind(lease.nowMs, connectedAccountId, lease.actionId, lease.leaseToken, lease.nowMs),
      );
    }
    await this.database.batch(statements);
  }

  async saveOffboarding(
    value: CommerceSellerOffboarding,
    lease: CommerceFinancialActionLease,
  ): Promise<void> {
    await run(
      this.database,
      `INSERT INTO commerce_seller_offboarding
       (connected_account_id, guild_id, status, reason_code, actor_user_id,
        active_subscription_count, latest_paid_through_at_ms, started_at_ms,
        completed_at_ms, updated_at_ms)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${ACTION_LEASE_SQL}
       ON CONFLICT(connected_account_id) DO UPDATE SET
         status = excluded.status, reason_code = excluded.reason_code,
         actor_user_id = excluded.actor_user_id,
         active_subscription_count = excluded.active_subscription_count,
         latest_paid_through_at_ms = excluded.latest_paid_through_at_ms,
         completed_at_ms = excluded.completed_at_ms, updated_at_ms = excluded.updated_at_ms`,
      value.connectedAccountId,
      value.guildId,
      value.status,
      value.reasonCode,
      value.actorUserId,
      value.activeSubscriptionCount,
      value.latestPaidThroughAtMs,
      value.startedAtMs,
      value.completedAtMs,
      value.updatedAtMs,
      lease.actionId,
      lease.leaseToken,
      lease.nowMs,
    );
  }

  async readOffboarding(connectedAccountId: string): Promise<CommerceSellerOffboarding | null> {
    const row = await first(
      this.database,
      "SELECT * FROM commerce_seller_offboarding WHERE connected_account_id = ?",
      connectedAccountId,
    );
    return row ? offboardingFromRow(row) : null;
  }

  async archiveSeller(
    connectedAccountId: string,
    lease: CommerceFinancialActionLease,
  ): Promise<boolean> {
    await this.database.batch([
      this.database
        .prepare(
          `UPDATE commerce_connected_accounts
           SET status = 'archived', archived_at_ms = ?, updated_at_ms = ?
           WHERE id = ? AND NOT EXISTS (
             SELECT 1 FROM commerce_subscriptions s
              WHERE s.connected_account_id=? AND s.status NOT IN ('canceled','ended')
           ) AND ${ACTION_LEASE_SQL}`,
        )
        .bind(
          lease.nowMs,
          lease.nowMs,
          connectedAccountId,
          connectedAccountId,
          lease.actionId,
          lease.leaseToken,
          lease.nowMs,
        ),
      this.database
        .prepare(
          `UPDATE commerce_seller_profiles
           SET lifecycle_state = 'disconnected', updated_at_ms = ?
           WHERE connected_account_id = ? AND NOT EXISTS (
             SELECT 1 FROM commerce_subscriptions s
              WHERE s.connected_account_id=? AND s.status NOT IN ('canceled','ended')
           ) AND ${ACTION_LEASE_SQL}`,
        )
        .bind(
          lease.nowMs,
          connectedAccountId,
          connectedAccountId,
          lease.actionId,
          lease.leaseToken,
          lease.nowMs,
        ),
      this.database
        .prepare(
          `UPDATE commerce_offering_lifecycles
           SET state = 'archived', archived_at_ms = COALESCE(archived_at_ms, ?), updated_at_ms = ?
            WHERE connected_account_id = ? AND NOT EXISTS (
              SELECT 1 FROM commerce_subscriptions s
               WHERE s.connected_account_id=? AND s.status NOT IN ('canceled','ended')
            ) AND ${ACTION_LEASE_SQL}`,
        )
        .bind(
          lease.nowMs,
          lease.nowMs,
          connectedAccountId,
          connectedAccountId,
          lease.actionId,
          lease.leaseToken,
          lease.nowMs,
        ),
      this.database
        .prepare(
          `UPDATE commerce_offerings
           SET status = 'archived', archived_at_ms = COALESCE(archived_at_ms, ?), updated_at_ms = ?
            WHERE connected_account_id = ? AND NOT EXISTS (
              SELECT 1 FROM commerce_subscriptions s
               WHERE s.connected_account_id=? AND s.status NOT IN ('canceled','ended')
            ) AND ${ACTION_LEASE_SQL}`,
        )
        .bind(
          lease.nowMs,
          lease.nowMs,
          connectedAccountId,
          connectedAccountId,
          lease.actionId,
          lease.leaseToken,
          lease.nowMs,
        ),
    ]);
    const current = await first(
      this.database,
      `SELECT status,
              (SELECT COUNT(*) FROM commerce_subscriptions s
                WHERE s.connected_account_id=? AND s.status NOT IN ('canceled','ended')) active_count
         FROM commerce_connected_accounts WHERE id=?`,
      connectedAccountId,
      connectedAccountId,
    );
    return current?.status === "archived" && Number(current.active_count) === 0;
  }

  async recordDeauthorization(input: {
    connectedAccountId: string;
    guildId: string;
    buyerIds: string[];
    operationId: string;
    nowMs: number;
    leaseToken: string;
  }): Promise<void> {
    const incidentId = `commerce-deauth:${input.connectedAccountId}`;
    const statements: D1PreparedStatement[] = [
      this.database
        .prepare(
          `INSERT INTO commerce_incidents
           (id, connected_account_id, guild_id, incident_key, severity, status, summary_code,
            entity_type, entity_id, safe_args_json, occurrence_count, first_seen_at_ms,
            last_seen_at_ms, resolved_at_ms, created_at_ms, updated_at_ms)
            SELECT ?, ?, ?, ?, 'critical', 'open', 'commerce_seller_deauthorized',
                   'seller', ?, '{}', 1, ?, ?, NULL, ?, ? WHERE ${ACTION_LEASE_SQL}
           ON CONFLICT(guild_id, incident_key) DO UPDATE SET
             occurrence_count = occurrence_count + 1, status = 'open',
             last_seen_at_ms = excluded.last_seen_at_ms, updated_at_ms = excluded.updated_at_ms`,
        )
        .bind(
          incidentId,
          input.connectedAccountId,
          input.guildId,
          incidentId,
          input.connectedAccountId,
          input.nowMs,
          input.nowMs,
          input.nowMs,
          input.nowMs,
          input.operationId,
          input.leaseToken,
          input.nowMs,
        ),
      notification(
        this.database,
        input.operationId,
        input.leaseToken,
        "seller_audit",
        input.guildId,
        input.nowMs,
        { kind: "seller_deauthorized", guildId: input.guildId },
      ),
    ];
    const buyers = await all(
      this.database,
      `SELECT discord_user_id FROM commerce_buyers
       WHERE id IN (${input.buyerIds.map(() => "?").join(",") || "NULL"})`,
      ...input.buyerIds,
    );
    for (const buyer of buyers) {
      statements.push(
        notification(
          this.database,
          input.operationId,
          input.leaseToken,
          "buyer_dm",
          String(buyer.discord_user_id),
          input.nowMs,
          { kind: "seller_deauthorized", guildId: input.guildId },
        ),
      );
    }
    await this.database.batch(statements);
  }
}

function notification(
  database: D1Database,
  operationId: string,
  leaseToken: string,
  destinationType: "seller_audit" | "buyer_dm",
  destinationId: string,
  nowMs: number,
  payload: Record<string, string>,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT OR IGNORE INTO commerce_delivery_outbox
       (id, operation_id, destination_type, destination_id, payload_json, status,
        attempt_count, available_at_ms, last_error_code, delivered_at_ms, created_at_ms, updated_at_ms)
        SELECT ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, ?, ?
        WHERE ${ACTION_LEASE_SQL}`,
    )
    .bind(
      `notification:${operationId}:${destinationType}:${destinationId}`,
      operationId,
      destinationType,
      destinationId,
      JSON.stringify(payload),
      nowMs,
      nowMs,
      nowMs,
      operationId,
      leaseToken,
      nowMs,
    );
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

function financialActionFromRow(row: Row): CommerceFinancialAction {
  return {
    id: String(row.id),
    connectedAccountId: String(row.connected_account_id),
    guildId: String(row.guild_id),
    actionType: String(row.action_type) as CommerceFinancialAction["actionType"],
    entityType: String(row.entity_type) as CommerceFinancialAction["entityType"],
    entityId: String(row.entity_id),
    actorUserId: String(row.actor_user_id),
    reasonCode: String(row.reason_code),
    amountMinor: numberOrNull(row.amount_minor),
    currency: currencyOrNull(row.currency),
    status: String(row.status) as CommerceFinancialAction["status"],
    providerResultId: nullableString(row.provider_result_id),
    accessAction: nullableString(row.access_action) as CommerceFinancialAction["accessAction"],
    attemptCount: Number(row.attempt_count),
    lastErrorCode: nullableString(row.last_error_code),
    leaseToken: nullableString(row.lease_token),
    claimedAtMs: numberOrNull(row.claimed_at_ms),
    leaseExpiresAtMs: numberOrNull(row.lease_expires_at_ms),
    availableAtMs: Number(row.available_at_ms ?? 0),
    providerCompletedAtMs: numberOrNull(row.provider_completed_at_ms),
    reconciliationRequestedAtMs: numberOrNull(row.reconciliation_requested_at_ms),
    quarantinedAtMs: numberOrNull(row.quarantined_at_ms),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
    completedAtMs: numberOrNull(row.completed_at_ms),
  };
}

function accountFromJoinedRow(row: Row): CommerceConnectedAccount {
  return {
    id: String(row.connected_account_id),
    guildId: String(row.account_guild_id),
    stripeAccountId: String(row.stripe_account_id),
    status: String(row.account_status) as CommerceConnectedAccount["status"],
    country: nullableString(row.country),
    defaultCurrency: currencyOrNull(row.default_currency),
    chargesEnabled: Boolean(row.charges_enabled),
    payoutsEnabled: Boolean(row.payouts_enabled),
    detailsSubmitted: Boolean(row.details_submitted),
    providerCreatedAtMs: numberOrNull(row.account_provider_created_at_ms),
    archivedAtMs: numberOrNull(row.archived_at_ms),
    createdAtMs: Number(row.account_created_at_ms),
    updatedAtMs: Number(row.account_updated_at_ms),
  };
}

function accountFromRow(row: Row): CommerceConnectedAccount {
  return {
    id: String(row.id),
    guildId: String(row.guild_id),
    stripeAccountId: String(row.stripe_account_id),
    status: String(row.status) as CommerceConnectedAccount["status"],
    country: nullableString(row.country),
    defaultCurrency: currencyOrNull(row.default_currency),
    chargesEnabled: Boolean(row.charges_enabled),
    payoutsEnabled: Boolean(row.payouts_enabled),
    detailsSubmitted: Boolean(row.details_submitted),
    providerCreatedAtMs: numberOrNull(row.provider_created_at_ms),
    archivedAtMs: numberOrNull(row.archived_at_ms),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function subscriptionFromRow(row: Row): CommerceSubscription {
  return {
    id: String(row.id),
    connectedAccountId: String(row.connected_account_id),
    customerId: String(row.customer_id),
    buyerId: String(row.buyer_id),
    offeringId: String(row.offering_id),
    priceId: String(row.price_id),
    stripeSubscriptionId: String(row.stripe_subscription_id),
    status: String(row.status) as CommerceSubscription["status"],
    cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
    currentPeriodStartMs: numberOrNull(row.current_period_start_ms),
    currentPeriodEndMs: numberOrNull(row.current_period_end_ms),
    canceledAtMs: numberOrNull(row.canceled_at_ms),
    endedAtMs: numberOrNull(row.ended_at_ms),
    providerUpdatedAtMs: numberOrNull(row.provider_updated_at_ms),
    latestInvoiceId: nullableString(row.latest_invoice_id),
    latestInvoiceStatus: nullableString(
      row.latest_invoice_status,
    ) as CommerceSubscription["latestInvoiceStatus"],
    latestPaymentIntentId: nullableString(row.latest_payment_intent_id),
    latestPaymentStatus: nullableString(
      row.latest_payment_status,
    ) as CommerceSubscription["latestPaymentStatus"],
    graceStartedAtMs: numberOrNull(row.grace_started_at_ms),
    graceEndsAtMs: numberOrNull(row.grace_ends_at_ms),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function paymentFromRow(row: Row): CommercePayment {
  return {
    id: String(row.id),
    connectedAccountId: String(row.connected_account_id),
    customerId: String(row.customer_id),
    buyerId: String(row.buyer_id),
    offeringId: String(row.offering_id),
    priceId: String(row.price_id),
    stripePaymentIntentId: String(row.stripe_payment_intent_id),
    stripeChargeId: nullableString(row.stripe_charge_id),
    stripeCheckoutSessionId: nullableString(row.stripe_checkout_session_id),
    stripeInvoiceId: nullableString(row.stripe_invoice_id),
    stripeSubscriptionId: nullableString(row.stripe_subscription_id),
    billingPeriodStartMs: numberOrNull(row.invoice_period_start_ms),
    billingPeriodEndMs: numberOrNull(row.invoice_period_end_ms),
    isLatestSubscriptionInvoice: Number(row.is_latest_subscription_invoice) === 1,
    currency: currency(row.currency),
    amountMinor: Number(row.amount_minor),
    amountReceivedMinor: Number(row.amount_received_minor),
    amountRefundedMinor: Number(row.amount_refunded_minor),
    applicationFeeMinor: numberOrNull(row.application_fee_minor),
    stripeFeeMinor: numberOrNull(row.stripe_fee_minor),
    stripeFeeTaxMinor: numberOrNull(row.stripe_fee_tax_minor),
    status: String(row.status) as CommercePayment["status"],
    providerCreatedAtMs: numberOrNull(row.provider_created_at_ms),
    paidAtMs: numberOrNull(row.paid_at_ms),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function supportPaymentFromRow(row: Row): CommerceSupportPayment {
  return {
    id: String(row.id),
    connectedAccountId: String(row.connected_account_id),
    guildId: String(row.guild_id),
    customerId: String(row.customer_id),
    buyerId: String(row.buyer_id),
    checkoutAttemptId: String(row.checkout_attempt_id),
    stripePaymentIntentId: String(row.stripe_payment_intent_id),
    stripeChargeId: nullableString(row.stripe_charge_id),
    stripeCheckoutSessionId: nullableString(row.stripe_checkout_session_id),
    currency: currency(row.currency),
    amountMinor: Number(row.amount_minor),
    amountReceivedMinor: Number(row.amount_received_minor),
    amountRefundedMinor: Number(row.amount_refunded_minor),
    applicationFeeMinor: Number(row.application_fee_minor),
    stripeFeeMinor: numberOrNull(row.stripe_fee_minor),
    stripeFeeTaxMinor: numberOrNull(row.stripe_fee_tax_minor),
    status: String(row.status) as CommerceSupportPayment["status"],
    providerCreatedAtMs: numberOrNull(row.provider_created_at_ms),
    paidAtMs: numberOrNull(row.paid_at_ms),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function offboardingFromRow(row: Row): CommerceSellerOffboarding {
  return {
    connectedAccountId: String(row.connected_account_id),
    guildId: String(row.guild_id),
    status: String(row.status) as CommerceSellerOffboarding["status"],
    reasonCode: String(row.reason_code),
    actorUserId: nullableString(row.actor_user_id),
    activeSubscriptionCount: Number(row.active_subscription_count),
    latestPaidThroughAtMs: numberOrNull(row.latest_paid_through_at_ms),
    startedAtMs: Number(row.started_at_ms),
    completedAtMs: numberOrNull(row.completed_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function numberOrNull(value: unknown): number | null {
  return value == null ? null : Number(value);
}

function currency(value: unknown): CommerceCurrency {
  if (value !== "AUD" && value !== "USD") throw new Error("Invalid commerce currency.");
  return value;
}

function currencyOrNull(value: unknown): CommerceCurrency | null {
  return value == null ? null : currency(value);
}
