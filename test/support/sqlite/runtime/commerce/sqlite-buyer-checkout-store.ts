import type {
  CommerceBuyerCheckoutStore,
  CommerceBuyerStatus,
  CommerceCheckoutAttempt,
  CommerceStorefront,
} from "../../../../../src/commerce/buyer-checkout";
import type {
  CommerceBuyer,
  CommerceConnectedAccount,
  CommerceCustomer,
  CommerceOffering,
  CommerceOfferingLifecycle,
  CommercePrice,
  CommerceSellerProfile,
} from "../../../../../src/commerce/types";

type Row = Record<string, unknown>;
const GRACE_MS = 7 * 24 * 60 * 60 * 1_000;

export class SqliteCommerceBuyerCheckoutStore implements CommerceBuyerCheckoutStore {
  constructor(
    private readonly database: D1Database,
    private readonly premium: { isPremium(guildId: string): Promise<boolean> },
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {}

  async readStorefront(offeringId: string): Promise<CommerceStorefront | null> {
    const row = await this.database
      .prepare(
        `SELECT
           o.id offering_id, o.connected_account_id, o.guild_id, o.discord_role_id,
           o.name offering_name, o.description, o.purchase_type,
           o.state, o.terms_version, o.included_benefits_json, o.support_contact,
           o.role_manageable, o.repair_deadline_at_ms, o.repair_previous_state,
           o.retire_at_ms, o.published_at_ms,
           o.archived_at_ms offering_archived_at_ms, o.created_at_ms offering_created_at_ms,
           o.updated_at_ms offering_updated_at_ms,
           a.stripe_account_id, a.status account_status, a.country, a.default_currency,
           a.charges_enabled, a.payouts_enabled, a.details_submitted,
           a.provider_created_at_ms, a.archived_at_ms account_archived_at_ms,
           a.created_at_ms account_created_at_ms, a.updated_at_ms account_updated_at_ms,
            s.lifecycle_state seller_lifecycle_state, s.approval_state,
            s.seller_owner_user_id,
           s.support_contact seller_support_contact, s.adult_attested_at_ms,
           s.two_factor_evidence, s.guild_created_at_ms, s.ownership_transferred_at_ms,
           s.guild_good_standing, s.seller_good_standing,
           s.requirements_currently_due_json, s.requirements_eventually_due_json,
           s.requirements_pending_verification_json, s.disabled_reason,
           s.reviewed_by_user_id, s.reviewed_at_ms, s.capabilities_updated_at_ms,
           s.created_at_ms seller_created_at_ms, s.updated_at_ms seller_updated_at_ms,
           EXISTS(SELECT 1 FROM commerce_seller_acceptances sa
             WHERE sa.connected_account_id = o.connected_account_id
               AND sa.terms_version = o.terms_version) terms_accepted,
           EXISTS(SELECT 1 FROM commerce_seller_controls c
             WHERE c.suspended = 1 AND (
               (c.scope_type = 'global' AND c.scope_id = 'commerce') OR
               (c.scope_type = 'guild' AND c.scope_id = o.guild_id)
             )) seller_suspended
         FROM commerce_offerings o
         JOIN commerce_connected_accounts a ON a.id = o.connected_account_id
         JOIN commerce_seller_profiles s ON s.connected_account_id = o.connected_account_id
         WHERE o.id = ? LIMIT 1`,
      )
      .bind(offeringId)
      .first<Row>();
    if (!row) return null;
    const priceRow = await this.database
      .prepare(
        `SELECT * FROM commerce_prices
         WHERE offering_id = ? AND connected_account_id = ? AND status = 'active'
         ORDER BY created_at_ms DESC LIMIT 1`,
      )
      .bind(offeringId, String(row.connected_account_id))
      .first<Row>();
    if (!priceRow) return null;

    const offering = offeringFromRow(row);
    const account = accountFromRow(row);
    const seller = sellerFromRow(row);
    const sellerEligible =
      account.status === "active" &&
      account.chargesEnabled &&
      account.payoutsEnabled &&
      account.detailsSubmitted &&
      seller.lifecycleState === "active" &&
      seller.approvalState === "approved" &&
      !row.seller_suspended;
    return {
      offering,
      price: priceFromRow(priceRow),
      account,
      seller,
      publishContext: {
        premiumActive: await this.premium.isPremium(offering.guildId),
        sellerEligible,
        termsAccepted: Boolean(row.terms_accepted),
        roleManageable: offering.roleManageable,
      },
    };
  }

  async listStorefrontsForGuild(guildId: string): Promise<CommerceStorefront[]> {
    const rows = await this.database
      .prepare(
        `SELECT id FROM commerce_offerings
           WHERE guild_id = ? AND state <> 'archived'
           ORDER BY created_at_ms ASC`,
      )
      .bind(guildId)
      .all<{ id: string }>();
    const storefronts = await Promise.all(
      (rows.results ?? []).map((row) => this.readStorefront(String(row.id))),
    );
    return storefronts.filter(
      (storefront): storefront is CommerceStorefront => storefront !== null,
    );
  }

  async getOrCreateBuyer(discordUserId: string, nowMs: number): Promise<CommerceBuyer> {
    const existing = await this.readBuyer(discordUserId);
    if (existing) return existing;
    await this.database
      .prepare(
        `INSERT INTO commerce_buyers (id, discord_user_id, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?) ON CONFLICT(discord_user_id) DO NOTHING`,
      )
      .bind(this.createId(), discordUserId, nowMs, nowMs)
      .run();
    const buyer = await this.readBuyer(discordUserId);
    if (!buyer) throw new Error("commerce_buyer_persistence_failed");
    return buyer;
  }

  async readCustomer(
    connectedAccountId: string,
    buyerId: string,
  ): Promise<CommerceCustomer | null> {
    const row = await this.database
      .prepare(
        `SELECT * FROM commerce_customers
         WHERE connected_account_id = ? AND buyer_id = ? LIMIT 1`,
      )
      .bind(connectedAccountId, buyerId)
      .first<Row>();
    return row ? customerFromRow(row) : null;
  }

  async saveCustomer(customer: CommerceCustomer): Promise<void> {
    await this.database
      .prepare(
        `INSERT INTO commerce_customers
          (id, connected_account_id, buyer_id, stripe_customer_id, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(connected_account_id, buyer_id) DO UPDATE SET
           updated_at_ms = excluded.updated_at_ms`,
      )
      .bind(
        customer.id,
        customer.connectedAccountId,
        customer.buyerId,
        customer.stripeCustomerId,
        customer.createdAtMs,
        customer.updatedAtMs,
      )
      .run();
  }

  async hasActiveSubscription(
    connectedAccountId: string,
    buyerId: string,
    offeringId: string,
  ): Promise<boolean> {
    const row = await this.database
      .prepare(
        `SELECT 1 found FROM commerce_subscriptions
         WHERE connected_account_id = ? AND buyer_id = ? AND offering_id = ?
           AND status NOT IN ('canceled', 'ended') LIMIT 1`,
      )
      .bind(connectedAccountId, buyerId, offeringId)
      .first<{ found: number }>();
    return Boolean(row?.found);
  }

  async readActiveCheckout(input: {
    connectedAccountId: string;
    buyerId: string;
    offeringId: string;
    nowMs: number;
  }): Promise<CommerceCheckoutAttempt | null> {
    const row = await this.database
      .prepare(
        `SELECT * FROM commerce_checkout_attempts
         WHERE connected_account_id = ? AND buyer_id = ? AND offering_id = ?
           AND status IN ('creating', 'open', 'returned') AND expires_at_ms > ?
         ORDER BY created_at_ms DESC LIMIT 1`,
      )
      .bind(input.connectedAccountId, input.buyerId, input.offeringId, input.nowMs)
      .first<Row>();
    return row ? attemptFromRow(row) : null;
  }

  async claimCheckoutRateLimit(input: {
    buyerId: string;
    offeringId: string;
    nowMs: number;
    windowMs: number;
    maximumAttempts: number;
  }): Promise<boolean> {
    const cutoff = input.nowMs - input.windowMs;
    await this.database
      .prepare(
        `INSERT INTO commerce_checkout_rate_limits
          (buyer_id, offering_id, window_started_at_ms, attempt_count, updated_at_ms)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(buyer_id, offering_id) DO UPDATE SET
           window_started_at_ms = CASE
             WHEN commerce_checkout_rate_limits.window_started_at_ms <= ?
             THEN excluded.window_started_at_ms
             ELSE commerce_checkout_rate_limits.window_started_at_ms END,
           attempt_count = CASE
             WHEN commerce_checkout_rate_limits.window_started_at_ms <= ? THEN 1
             ELSE commerce_checkout_rate_limits.attempt_count + 1 END,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .bind(input.buyerId, input.offeringId, input.nowMs, input.nowMs, cutoff, cutoff)
      .run();
    const row = await this.database
      .prepare(
        `SELECT attempt_count FROM commerce_checkout_rate_limits
         WHERE buyer_id = ? AND offering_id = ?`,
      )
      .bind(input.buyerId, input.offeringId)
      .first<{ attempt_count: number }>();
    return Number(row?.attempt_count ?? input.maximumAttempts + 1) <= input.maximumAttempts;
  }

  async reserveCheckout(attempt: CommerceCheckoutAttempt): Promise<boolean> {
    await this.database
      .prepare(
        `UPDATE commerce_checkout_attempts SET status = 'expired', updated_at_ms = ?
         WHERE connected_account_id = ? AND buyer_id = ? AND offering_id = ?
           AND status IN ('creating', 'open', 'returned') AND expires_at_ms <= ?`,
      )
      .bind(
        attempt.createdAtMs,
        attempt.connectedAccountId,
        attempt.buyerId,
        attempt.offeringId,
        attempt.createdAtMs,
      )
      .run();
    try {
      const result = await this.database
        .prepare(
          `INSERT INTO commerce_checkout_attempts
            (id, connected_account_id, guild_id, offering_id, price_id, buyer_id,
             stripe_checkout_session_id, status, expires_at_ms, returned_at_ms,
             created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
        )
        .bind(
          attempt.id,
          attempt.connectedAccountId,
          attempt.guildId,
          attempt.offeringId,
          attempt.priceId,
          attempt.buyerId,
          attempt.stripeCheckoutSessionId,
          attempt.status,
          attempt.expiresAtMs,
          attempt.returnedAtMs,
          attempt.createdAtMs,
          attempt.updatedAtMs,
        )
        .run();
      return result.meta.changes > 0;
    } catch {
      return false;
    }
  }

  async attachCheckoutSession(attemptId: string, sessionId: string, nowMs: number): Promise<void> {
    const result = await this.database
      .prepare(
        `UPDATE commerce_checkout_attempts
         SET stripe_checkout_session_id = ?, status = 'open', updated_at_ms = ?
         WHERE id = ? AND status = 'creating'`,
      )
      .bind(sessionId, nowMs, attemptId)
      .run();
    if (result.meta.changes !== 1) throw new Error("commerce_checkout_attempt_not_claimed");
  }

  async expireCheckout(attemptId: string, nowMs: number): Promise<boolean> {
    const result = await this.database
      .prepare(
        `UPDATE commerce_checkout_attempts SET status = 'expired', provider_terminal_at_ms = ?, updated_at_ms = ?
         WHERE id = ? AND status IN ('open', 'returned')`,
      )
      .bind(nowMs, nowMs, attemptId)
      .run();
    return result.meta.changes === 1;
  }

  async failCheckout(
    attemptId: string,
    nowMs: number,
    outcome: "confirmed_not_sent" | "unknown" = "unknown",
  ): Promise<void> {
    await this.database
      .prepare(
        `UPDATE commerce_checkout_attempts SET status = 'failed', pre_session_failed_at_ms = ?, updated_at_ms = ?
         WHERE id = ? AND status = 'creating'`,
      )
      .bind(outcome === "confirmed_not_sent" ? nowMs : null, nowMs, attemptId)
      .run();
  }

  async markCheckoutReturned(input: {
    attemptId: string;
    offeringId: string;
    buyerId: string;
    nowMs: number;
  }): Promise<CommerceCheckoutAttempt | null> {
    await this.database
      .prepare(
        `UPDATE commerce_checkout_attempts
         SET status = 'returned', returned_at_ms = COALESCE(returned_at_ms, ?), updated_at_ms = ?
         WHERE id = ? AND offering_id = ? AND buyer_id = ?
           AND status IN ('open', 'returned') AND expires_at_ms > ?`,
      )
      .bind(input.nowMs, input.nowMs, input.attemptId, input.offeringId, input.buyerId, input.nowMs)
      .run();
    const row = await this.database
      .prepare(
        `SELECT * FROM commerce_checkout_attempts
         WHERE id = ? AND offering_id = ? AND buyer_id = ? AND status = 'returned' LIMIT 1`,
      )
      .bind(input.attemptId, input.offeringId, input.buyerId)
      .first<Row>();
    return row ? attemptFromRow(row) : null;
  }

  async readBuyerStatus(input: {
    connectedAccountId: string;
    buyerId: string;
    offeringId: string;
    nowMs: number;
  }): Promise<CommerceBuyerStatus & { checkoutAttemptId: string | null }> {
    const customer = await this.readCustomer(input.connectedAccountId, input.buyerId);
    // The unique non-terminal subscription is current, regardless of snapshot time.
    // Otherwise use purchase chronology: full snapshots refresh historical rows too.
    const row = await this.database
      .prepare(
        `SELECT e.status entitlement_status, s.status subscription_status, s.checkout_attempt_id,
                (SELECT ra.status FROM commerce_role_assignments ra WHERE ra.entitlement_id=e.id ORDER BY ra.updated_at_ms DESC LIMIT 1) role_delivery_status,
                s.cancel_at_period_end, s.current_period_end_ms,
                COALESCE(s.grace_started_at_ms, prs.failed_payment_at_ms) failed_payment_at_ms
         FROM commerce_subscriptions s
         LEFT JOIN commerce_offerings o
            ON o.id = s.offering_id AND o.connected_account_id = s.connected_account_id
         LEFT JOIN commerce_checkout_attempts c
            ON c.id = s.checkout_attempt_id
           AND c.connected_account_id = s.connected_account_id
           AND c.buyer_id = s.buyer_id AND c.offering_id = s.offering_id
           AND c.price_id = s.price_id AND c.guild_id = o.guild_id
         LEFT JOIN commerce_entitlements e
            ON e.connected_account_id = s.connected_account_id
           AND e.source_type = 'subscription' AND e.source_id = s.stripe_subscription_id
         LEFT JOIN commerce_paid_role_states prs ON prs.entitlement_id = e.id
         WHERE s.connected_account_id = ? AND s.buyer_id = ? AND s.offering_id = ?
         ORDER BY CASE WHEN s.status IN ('canceled', 'ended') THEN 1 ELSE 0 END,
                  COALESCE(c.created_at_ms, s.created_at_ms) DESC,
                  s.created_at_ms DESC, s.id DESC LIMIT 1`,
      )
      .bind(input.connectedAccountId, input.buyerId, input.offeringId)
      .first<Row>();
    const failedAt = nullableNumber(row?.failed_payment_at_ms);
    // A separate repurchase may be awaiting payment after the previous subscription ended.
    const pending =
      !row || row.subscription_status === "canceled" || row.subscription_status === "ended"
        ? await this.readActiveCheckout(input)
        : null;
    return {
      checkoutAttemptId: pending?.id ?? nullableString(row?.checkout_attempt_id),
      customerExists: customer !== null,
      roleDeliveryStatus: nullableString(row?.role_delivery_status),
      entitlementStatus: nullableString(row?.entitlement_status) as never,
      subscriptionStatus: nullableString(row?.subscription_status) as never,
      cancelAtPeriodEnd: Boolean(row?.cancel_at_period_end),
      currentPeriodEndMs: nullableNumber(row?.current_period_end_ms),
      graceEndsAtMs:
        failedAt === null || failedAt + GRACE_MS <= input.nowMs ? null : failedAt + GRACE_MS,
    };
  }

  private async readBuyer(discordUserId: string): Promise<CommerceBuyer | null> {
    const row = await this.database
      .prepare("SELECT * FROM commerce_buyers WHERE discord_user_id = ? LIMIT 1")
      .bind(discordUserId)
      .first<Row>();
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

function offeringFromRow(row: Row): CommerceOffering {
  return {
    id: String(row.offering_id),
    connectedAccountId: String(row.connected_account_id),
    guildId: String(row.guild_id),
    discordRoleId: String(row.discord_role_id),
    name: String(row.offering_name),
    description: nullableString(row.description),
    purchaseType: String(row.purchase_type) as CommerceOffering["purchaseType"],
    state: String(row.state) as CommerceOfferingLifecycle,
    termsVersion: nullableString(row.terms_version),
    includedBenefits: parseStringArray(row.included_benefits_json),
    supportContact: nullableString(row.support_contact),
    roleManageable: Boolean(row.role_manageable),
    repairDeadlineAtMs: nullableNumber(row.repair_deadline_at_ms),
    repairPreviousState:
      row.repair_previous_state == null
        ? null
        : (String(row.repair_previous_state) as CommerceOfferingLifecycle),
    retireAtMs: nullableNumber(row.retire_at_ms),
    publishedAtMs: nullableNumber(row.published_at_ms),
    archivedAtMs: nullableNumber(row.offering_archived_at_ms),
    createdAtMs: Number(row.offering_created_at_ms),
    updatedAtMs: Number(row.offering_updated_at_ms),
  };
}

function accountFromRow(row: Row): CommerceConnectedAccount {
  return {
    id: String(row.connected_account_id),
    guildId: String(row.guild_id),
    stripeAccountId: String(row.stripe_account_id),
    status: String(row.account_status) as CommerceConnectedAccount["status"],
    country: nullableString(row.country),
    defaultCurrency: nullableString(
      row.default_currency,
    ) as CommerceConnectedAccount["defaultCurrency"],
    chargesEnabled: Boolean(row.charges_enabled),
    payoutsEnabled: Boolean(row.payouts_enabled),
    detailsSubmitted: Boolean(row.details_submitted),
    providerCreatedAtMs: nullableNumber(row.provider_created_at_ms),
    archivedAtMs: nullableNumber(row.account_archived_at_ms),
    createdAtMs: Number(row.account_created_at_ms),
    updatedAtMs: Number(row.account_updated_at_ms),
  };
}

function sellerFromRow(row: Row): CommerceSellerProfile {
  return {
    connectedAccountId: String(row.connected_account_id),
    guildId: String(row.guild_id),
    sellerOwnerUserId: String(row.seller_owner_user_id),
    lifecycleState: String(row.seller_lifecycle_state) as CommerceSellerProfile["lifecycleState"],
    approvalState: String(row.approval_state) as CommerceSellerProfile["approvalState"],
    supportContact: String(row.seller_support_contact),
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

function priceFromRow(row: Row): CommercePrice {
  return {
    id: String(row.id),
    connectedAccountId: String(row.connected_account_id),
    offeringId: String(row.offering_id),
    stripeProductId: String(row.stripe_product_id),
    stripePriceId: String(row.stripe_price_id),
    currency: String(row.currency) as CommercePrice["currency"],
    unitAmountMinor: Number(row.unit_amount_minor),
    priceType: String(row.price_type) as CommercePrice["priceType"],
    recurringInterval: nullableString(row.recurring_interval) as CommercePrice["recurringInterval"],
    status: String(row.status) as CommercePrice["status"],
    providerCreatedAtMs: nullableNumber(row.provider_created_at_ms),
    retiredAtMs: nullableNumber(row.retired_at_ms),
    createdAtMs: Number(row.created_at_ms),
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

function attemptFromRow(row: Row): CommerceCheckoutAttempt {
  return {
    id: String(row.id),
    connectedAccountId: String(row.connected_account_id),
    guildId: String(row.guild_id),
    offeringId: String(row.offering_id),
    priceId: String(row.price_id),
    buyerId: String(row.buyer_id),
    stripeCheckoutSessionId: nullableString(row.stripe_checkout_session_id),
    status: String(row.status) as CommerceCheckoutAttempt["status"],
    expiresAtMs: Number(row.expires_at_ms),
    returnedAtMs: nullableNumber(row.returned_at_ms),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function parseStringArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}
