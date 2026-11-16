import type { PostgresDatabaseCapability } from "./postgres-capability";
import type {
  CommerceSupportCheckoutAttempt,
  CommerceSupportConfig,
  CommerceSupportContext,
  CommerceSupportPayment,
  CommerceSupportReport,
  CommerceSupportStore,
} from "../../commerce/support-payments";
import type {
  CommerceBuyer,
  CommerceConnectedAccount,
  CommerceCustomer,
  CommerceSellerProfile,
} from "../../commerce/types";

type Row = Record<string, unknown>;

export class PostgresCommerceSupportStore implements CommerceSupportStore {
  constructor(
    private readonly database: PostgresDatabaseCapability,
    private readonly premium: { isPremium(guildId: string): Promise<boolean> },
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {}

  async readConfigByGuild(guildId: string): Promise<CommerceSupportConfig | null> {
    const row = await this.database
      .query<Row>("SELECT * FROM commerce_support_configs WHERE guild_id = $1 LIMIT 1", [guildId])
      .then((rows) => rows[0] ?? null);
    return row ? configFromRow(row) : null;
  }

  async readContextByGuild(
    guildId: string,
    termsVersion = "",
  ): Promise<CommerceSupportContext | null> {
    const row = await this.database
      .query<Row>(
        `SELECT
           a.*, s.lifecycle_state, s.approval_state, s.seller_owner_user_id, s.support_contact,
           s.adult_attested_at_ms, s.two_factor_evidence, s.guild_created_at_ms,
           s.ownership_transferred_at_ms, s.guild_good_standing, s.seller_good_standing,
           s.requirements_currently_due_json, s.requirements_eventually_due_json,
           s.requirements_pending_verification_json, s.disabled_reason,
           s.reviewed_by_user_id, s.reviewed_at_ms, s.capabilities_updated_at_ms,
           s.created_at_ms seller_created_at_ms, s.updated_at_ms seller_updated_at_ms,
           EXISTS(SELECT 1 FROM commerce_seller_acceptances sa
             WHERE sa.connected_account_id = a.id
               AND sa.terms_version = $1) terms_accepted,
           EXISTS(SELECT 1 FROM commerce_seller_controls c
             WHERE c.suspended = 1 AND (
               (c.scope_type = 'global' AND c.scope_id = 'commerce') OR
               (c.scope_type = 'guild' AND c.scope_id = a.guild_id)
             )) seller_suspended
         FROM commerce_connected_accounts a
         JOIN commerce_seller_profiles s ON s.connected_account_id = a.id
         WHERE a.guild_id = $2 AND a.status <> 'archived'
         LIMIT 1`,
        [termsVersion, guildId],
      )
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    return {
      account: accountFromRow(row),
      seller: sellerFromRow(row),
      termsAccepted: Boolean(row.terms_accepted),
      premiumActive: await this.premium.isPremium(guildId),
      suspended: Boolean(row.seller_suspended),
    };
  }

  async saveConfig(config: CommerceSupportConfig): Promise<void> {
    await this.database.queryResult(
      `INSERT INTO commerce_support_configs(
           connected_account_id, guild_id, enabled, explanation, currency,
           suggested_amounts_json, support_contact, terms_version, created_at_ms, updated_at_ms
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT(connected_account_id) DO UPDATE SET
           enabled = excluded.enabled,
           explanation = excluded.explanation,
           currency = excluded.currency,
           suggested_amounts_json = excluded.suggested_amounts_json,
           support_contact = excluded.support_contact,
           terms_version = excluded.terms_version,
           updated_at_ms = excluded.updated_at_ms`,
      [
        config.connectedAccountId,
        config.guildId,
        config.enabled ? 1 : 0,
        config.explanation,
        config.currency,
        JSON.stringify(config.suggestedAmountsMinor),
        config.supportContact,
        config.termsVersion,
        config.createdAtMs,
        config.updatedAtMs,
      ],
    );
  }

  async getOrCreateBuyer(discordUserId: string, nowMs: number): Promise<CommerceBuyer> {
    let buyer = await this.readBuyer(discordUserId);
    if (buyer) return buyer;
    await this.database.queryResult(
      `INSERT INTO commerce_buyers(id, discord_user_id, created_at_ms, updated_at_ms)
         VALUES ($1, $2, $3, $4) ON CONFLICT(discord_user_id) DO NOTHING`,
      [this.createId(), discordUserId, nowMs, nowMs],
    );
    buyer = await this.readBuyer(discordUserId);
    if (!buyer) throw new Error("commerce_buyer_persistence_failed");
    return buyer;
  }

  async readCustomer(
    connectedAccountId: string,
    buyerId: string,
  ): Promise<CommerceCustomer | null> {
    const row = await this.database
      .query<Row>(
        `SELECT * FROM commerce_customers
         WHERE connected_account_id = $1 AND buyer_id = $2 LIMIT 1`,
        [connectedAccountId, buyerId],
      )
      .then((rows) => rows[0] ?? null);
    return row ? customerFromRow(row) : null;
  }

  async saveCustomer(customer: CommerceCustomer): Promise<void> {
    await this.database.queryResult(
      `INSERT INTO commerce_customers(
           id, connected_account_id, buyer_id, stripe_customer_id, created_at_ms, updated_at_ms
         ) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT(connected_account_id, buyer_id) DO UPDATE SET
           updated_at_ms = excluded.updated_at_ms`,
      [
        customer.id,
        customer.connectedAccountId,
        customer.buyerId,
        customer.stripeCustomerId,
        customer.createdAtMs,
        customer.updatedAtMs,
      ],
    );
  }

  async claimRateLimit(input: {
    buyerId: string;
    guildId: string;
    nowMs: number;
    windowMs: number;
    maximumAttempts: number;
  }): Promise<boolean> {
    const cutoff = input.nowMs - input.windowMs;
    await this.database.queryResult(
      `INSERT INTO commerce_support_rate_limits(
           buyer_id, guild_id, window_started_at_ms, attempt_count, updated_at_ms
         ) VALUES ($1, $2, $3, 1, $4)
         ON CONFLICT(buyer_id, guild_id) DO UPDATE SET
           window_started_at_ms = CASE
             WHEN commerce_support_rate_limits.window_started_at_ms <= $5
             THEN excluded.window_started_at_ms
             ELSE commerce_support_rate_limits.window_started_at_ms END,
           attempt_count = CASE
             WHEN commerce_support_rate_limits.window_started_at_ms <= $6 THEN 1
             ELSE commerce_support_rate_limits.attempt_count + 1 END,
           updated_at_ms = excluded.updated_at_ms`,
      [input.buyerId, input.guildId, input.nowMs, input.nowMs, cutoff, cutoff],
    );
    const row = await this.database
      .query<{ attempt_count: number }>(
        `SELECT attempt_count FROM commerce_support_rate_limits
         WHERE buyer_id = $1 AND guild_id = $2`,
        [input.buyerId, input.guildId],
      )
      .then((rows) => rows[0] ?? null);
    return Number(row?.attempt_count ?? input.maximumAttempts + 1) <= input.maximumAttempts;
  }

  async reserveCheckout(attempt: CommerceSupportCheckoutAttempt): Promise<boolean> {
    await this.database.queryResult(
      `UPDATE commerce_support_checkout_attempts
         SET status = 'expired', updated_at_ms = $1
         WHERE connected_account_id = $2 AND buyer_id = $3 AND guild_id = $4
           AND status IN ('creating', 'open', 'returned') AND expires_at_ms <= $5`,
      [
        attempt.createdAtMs,
        attempt.connectedAccountId,
        attempt.buyerId,
        attempt.guildId,
        attempt.createdAtMs,
      ],
    );
    try {
      const result = await this.database.queryResult(
        `INSERT INTO commerce_support_checkout_attempts(
             id, connected_account_id, guild_id, buyer_id, currency, amount_minor,
             application_fee_minor, stripe_checkout_session_id, status, expires_at_ms,
             returned_at_ms, created_at_ms, updated_at_ms
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT(id) DO NOTHING`,
        [
          attempt.id,
          attempt.connectedAccountId,
          attempt.guildId,
          attempt.buyerId,
          attempt.currency,
          attempt.amountMinor,
          attempt.applicationFeeMinor,
          attempt.stripeCheckoutSessionId,
          attempt.status,
          attempt.expiresAtMs,
          attempt.returnedAtMs,
          attempt.createdAtMs,
          attempt.updatedAtMs,
        ],
      );
      return result.rowCount > 0;
    } catch {
      return false;
    }
  }

  async attachCheckoutSession(attemptId: string, sessionId: string, nowMs: number): Promise<void> {
    const result = await this.database.queryResult(
      `UPDATE commerce_support_checkout_attempts
         SET stripe_checkout_session_id = $1, status = 'open', updated_at_ms = $2
         WHERE id = $3 AND status = 'creating'`,
      [sessionId, nowMs, attemptId],
    );
    if (result.rowCount !== 1) throw new Error("commerce_support_checkout_not_claimed");
  }

  async failCheckout(attemptId: string, nowMs: number): Promise<void> {
    await this.database.queryResult(
      `UPDATE commerce_support_checkout_attempts
         SET status = 'failed', updated_at_ms = $1
         WHERE id = $2 AND status = 'creating'`,
      [nowMs, attemptId],
    );
  }

  async markCheckoutReturned(input: {
    attemptId: string;
    guildId: string;
    buyerId: string;
    nowMs: number;
  }): Promise<CommerceSupportCheckoutAttempt | null> {
    await this.database.queryResult(
      `UPDATE commerce_support_checkout_attempts
         SET status = 'returned', returned_at_ms = COALESCE(returned_at_ms, $1), updated_at_ms = $2
         WHERE id = $3 AND guild_id = $4 AND buyer_id = $5
           AND status IN ('open', 'returned') AND expires_at_ms > $6`,
      [input.nowMs, input.nowMs, input.attemptId, input.guildId, input.buyerId, input.nowMs],
    );
    const row = await this.database
      .query<Row>(
        `SELECT * FROM commerce_support_checkout_attempts
         WHERE id = $1 AND guild_id = $2 AND buyer_id = $3 AND status = 'returned' LIMIT 1`,
        [input.attemptId, input.guildId, input.buyerId],
      )
      .then((rows) => rows[0] ?? null);
    return row ? attemptFromRow(row) : null;
  }

  async readPaymentStatus(input: {
    checkoutAttemptId: string;
    buyerId: string;
  }): Promise<CommerceSupportPayment | null> {
    const row = await this.database
      .query<Row>(
        `SELECT * FROM commerce_support_payments
         WHERE checkout_attempt_id = $1 AND buyer_id = $2 LIMIT 1`,
        [input.checkoutAttemptId, input.buyerId],
      )
      .then((rows) => rows[0] ?? null);
    return row ? paymentFromRow(row) : null;
  }

  async readPayment(paymentId: string): Promise<CommerceSupportPayment | null> {
    const row = await this.database
      .query<Row>("SELECT * FROM commerce_support_payments WHERE id = $1 LIMIT 1", [paymentId])
      .then((rows) => rows[0] ?? null);
    return row ? paymentFromRow(row) : null;
  }

  async readReport(connectedAccountId: string): Promise<CommerceSupportReport[]> {
    const result = await this.database.queryResult<Row>(
      `SELECT p.currency, COUNT(*) payment_count,
                COALESCE(SUM(amount_received_minor), 0) gross_minor,
                COALESCE(SUM(application_fee_minor), 0) haf_fee_minor,
                CASE WHEN COUNT(stripe_fee_minor) = COUNT(*) THEN SUM(stripe_fee_minor) ELSE NULL END stripe_fee_minor,
                COALESCE(SUM(amount_refunded_minor), 0) refunded_minor,
                COALESCE((SELECT SUM(d.amount_minor) FROM commerce_support_disputes d
                          WHERE d.connected_account_id = p.connected_account_id
                            AND d.currency = p.currency AND d.status NOT IN ('won', 'warning_closed')), 0) disputed_minor,
                COALESCE((SELECT COUNT(*) FROM commerce_support_disputes d
                          WHERE d.connected_account_id = p.connected_account_id
                            AND d.currency = p.currency
                            AND d.status IN ('warning_needs_response', 'warning_under_review', 'needs_response', 'under_review')), 0) open_dispute_count
         FROM commerce_support_payments p
         WHERE p.connected_account_id = $1 AND p.status = 'succeeded'
         GROUP BY p.connected_account_id, p.currency ORDER BY p.currency`,
      [connectedAccountId],
    );
    return result.rows.map((row) => ({
      currency: String(row.currency) as CommerceSupportReport["currency"],
      paymentCount: Number(row.payment_count),
      grossMinor: Number(row.gross_minor),
      hafFeeMinor: Number(row.haf_fee_minor),
      stripeFeeMinor: nullableNumber(row.stripe_fee_minor),
      refundedMinor: Number(row.refunded_minor),
      disputedMinor: Number(row.disputed_minor),
      openDisputeCount: Number(row.open_dispute_count),
      netBeforeStripeFeesMinor:
        Number(row.gross_minor) - Number(row.haf_fee_minor) - Number(row.refunded_minor),
    }));
  }

  private async readBuyer(discordUserId: string): Promise<CommerceBuyer | null> {
    const row = await this.database
      .query<Row>("SELECT * FROM commerce_buyers WHERE discord_user_id = $1 LIMIT 1", [
        discordUserId,
      ])
      .then((rows) => rows[0] ?? null);
    return row
      ? {
          id: String(row.id),
          discordUserId: String(row.discord_user_id),
          createdAtMs: Number(row.created_at_ms),
          updatedAtMs: Number(row.updated_at_ms),
        }
      : null;
  }
}

function configFromRow(row: Row): CommerceSupportConfig {
  return {
    connectedAccountId: String(row.connected_account_id),
    guildId: String(row.guild_id),
    enabled: Boolean(row.enabled),
    explanation: String(row.explanation),
    currency: String(row.currency) as CommerceSupportConfig["currency"],
    suggestedAmountsMinor: parseAmounts(row.suggested_amounts_json),
    supportContact: String(row.support_contact),
    termsVersion: String(row.terms_version),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function accountFromRow(row: Row): CommerceConnectedAccount {
  return {
    id: String(row.id),
    guildId: String(row.guild_id),
    stripeAccountId: String(row.stripe_account_id),
    status: String(row.status) as CommerceConnectedAccount["status"],
    country: nullableString(row.country),
    defaultCurrency: nullableString(
      row.default_currency,
    ) as CommerceConnectedAccount["defaultCurrency"],
    chargesEnabled: Boolean(row.charges_enabled),
    payoutsEnabled: Boolean(row.payouts_enabled),
    detailsSubmitted: Boolean(row.details_submitted),
    providerCreatedAtMs: nullableNumber(row.provider_created_at_ms),
    archivedAtMs: nullableNumber(row.archived_at_ms),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function sellerFromRow(row: Row): CommerceSellerProfile {
  return {
    connectedAccountId: String(row.id),
    guildId: String(row.guild_id),
    sellerOwnerUserId: String(row.seller_owner_user_id),
    lifecycleState: String(row.lifecycle_state) as CommerceSellerProfile["lifecycleState"],
    approvalState: String(row.approval_state) as CommerceSellerProfile["approvalState"],
    supportContact: String(row.support_contact),
    adultAttestedAtMs: Number(row.adult_attested_at_ms),
    twoFactorEvidence: String(
      row.two_factor_evidence,
    ) as CommerceSellerProfile["twoFactorEvidence"],
    guildCreatedAtMs: Number(row.guild_created_at_ms),
    ownershipTransferredAtMs: nullableNumber(row.ownership_transferred_at_ms),
    guildGoodStanding: Boolean(row.guild_good_standing),
    sellerGoodStanding: Boolean(row.seller_good_standing),
    requirementsCurrentlyDueJson: String(row.requirements_currently_due_json),
    requirementsEventuallyDueJson: String(row.requirements_eventually_due_json),
    requirementsPendingVerificationJson: String(row.requirements_pending_verification_json),
    disabledReason: nullableString(row.disabled_reason),
    reviewedByUserId: nullableString(row.reviewed_by_user_id),
    reviewedAtMs: nullableNumber(row.reviewed_at_ms),
    capabilitiesUpdatedAtMs: nullableNumber(row.capabilities_updated_at_ms),
    createdAtMs: Number(row.seller_created_at_ms),
    updatedAtMs: Number(row.seller_updated_at_ms),
  };
}

function customerFromRow(row: Row): CommerceCustomer {
  return {
    id: String(row.id),
    connectedAccountId: String(row.connected_account_id),
    buyerId: String(row.buyer_id),
    stripeCustomerId: String(row.stripe_customer_id),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function attemptFromRow(row: Row): CommerceSupportCheckoutAttempt {
  return {
    id: String(row.id),
    connectedAccountId: String(row.connected_account_id),
    guildId: String(row.guild_id),
    buyerId: String(row.buyer_id),
    currency: String(row.currency) as CommerceSupportCheckoutAttempt["currency"],
    amountMinor: Number(row.amount_minor),
    applicationFeeMinor: Number(row.application_fee_minor),
    stripeCheckoutSessionId: nullableString(row.stripe_checkout_session_id),
    status: String(row.status) as CommerceSupportCheckoutAttempt["status"],
    expiresAtMs: Number(row.expires_at_ms),
    returnedAtMs: nullableNumber(row.returned_at_ms),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function paymentFromRow(row: Row): CommerceSupportPayment {
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
    currency: String(row.currency) as CommerceSupportPayment["currency"],
    amountMinor: Number(row.amount_minor),
    amountReceivedMinor: Number(row.amount_received_minor),
    amountRefundedMinor: Number(row.amount_refunded_minor),
    applicationFeeMinor: Number(row.application_fee_minor),
    stripeFeeMinor: nullableNumber(row.stripe_fee_minor),
    stripeFeeTaxMinor: nullableNumber(row.stripe_fee_tax_minor),
    status: String(row.status) as CommerceSupportPayment["status"],
    providerCreatedAtMs: nullableNumber(row.provider_created_at_ms),
    paidAtMs: nullableNumber(row.paid_at_ms),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function parseAmounts(value: unknown): number[] {
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.filter((item) => Number.isSafeInteger(item)) : [];
  } catch {
    return [];
  }
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
