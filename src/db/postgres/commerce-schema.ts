import { pgTable, text, index, uniqueIndex, primaryKey, check } from "drizzle-orm/pg-core";
import { bigInteger, integerBoolean } from "./column-types";
import { sql } from "drizzle-orm";

export const commerceStoreBranding = pgTable(
  "commerce_store_branding",
  {
    guildId: text("guild_id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    accentColor: bigInteger("accent_color").notNull().default(0x5865f2),
    tagline: text("tagline").notNull().default(""),
    createdByUserId: text("created_by_user_id").notNull(),
    updatedByUserId: text("updated_by_user_id").notNull(),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    check(
      "commerce_store_branding_accent_integer",
      sql`${table.accentColor} = CAST(${table.accentColor} AS INTEGER)`,
    ),
    uniqueIndex("commerce_store_branding_account").on(table.connectedAccountId),
    index("commerce_store_branding_updated").on(table.updatedAtMs),
  ],
);

export const commerceConnectedAccounts = pgTable(
  "commerce_connected_accounts",
  {
    id: text("id").primaryKey().notNull(),
    guildId: text("guild_id").notNull(),
    stripeAccountId: text("stripe_account_id").notNull(),
    status: text("status").notNull(),
    country: text("country"),
    defaultCurrency: text("default_currency"),
    chargesEnabled: integerBoolean("charges_enabled").notNull().default(false),
    payoutsEnabled: integerBoolean("payouts_enabled").notNull().default(false),
    detailsSubmitted: integerBoolean("details_submitted").notNull().default(false),
    providerCreatedAtMs: bigInteger("provider_created_at_ms"),
    archivedAtMs: bigInteger("archived_at_ms"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_connected_accounts_provider").on(table.stripeAccountId),
    uniqueIndex("commerce_connected_accounts_current_guild")
      .on(table.guildId)
      .where(sql`${table.status} <> 'archived'`),
    index("commerce_connected_accounts_guild_status").on(table.guildId, table.status),
  ],
);

export const commerceSellerAcceptances = pgTable(
  "commerce_seller_acceptances",
  {
    id: text("id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    termsVersion: text("terms_version").notNull(),
    acceptedByUserId: text("accepted_by_user_id").notNull(),
    acceptedAtMs: bigInteger("accepted_at_ms").notNull(),
    createdAtMs: bigInteger("created_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_seller_acceptances_version").on(
      table.connectedAccountId,
      table.termsVersion,
    ),
    index("commerce_seller_acceptances_account_time").on(
      table.connectedAccountId,
      table.acceptedAtMs,
    ),
  ],
);

export const commerceSellerProfiles = pgTable(
  "commerce_seller_profiles",
  {
    connectedAccountId: text("connected_account_id").primaryKey().notNull(),
    guildId: text("guild_id").notNull(),
    sellerOwnerUserId: text("seller_owner_user_id").notNull().default(""),
    lifecycleState: text("lifecycle_state").notNull(),
    approvalState: text("approval_state").notNull(),
    supportContact: text("support_contact").notNull(),
    adultAttestedAtMs: bigInteger("adult_attested_at_ms").notNull(),
    twoFactorEvidence: text("two_factor_evidence").notNull(),
    guildCreatedAtMs: bigInteger("guild_created_at_ms").notNull(),
    ownershipTransferredAtMs: bigInteger("ownership_transferred_at_ms"),
    guildGoodStanding: integerBoolean("guild_good_standing").notNull().default(false),
    sellerGoodStanding: integerBoolean("seller_good_standing").notNull().default(false),
    requirementsCurrentlyDueJson: text("requirements_currently_due_json").notNull().default("[]"),
    requirementsEventuallyDueJson: text("requirements_eventually_due_json").notNull().default("[]"),
    requirementsPendingVerificationJson: text("requirements_pending_verification_json")
      .notNull()
      .default("[]"),
    disabledReason: text("disabled_reason"),
    reviewedByUserId: text("reviewed_by_user_id"),
    reviewedAtMs: bigInteger("reviewed_at_ms"),
    capabilitiesUpdatedAtMs: bigInteger("capabilities_updated_at_ms"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_seller_profiles_guild").on(table.guildId),
    index("commerce_seller_profiles_owner").on(table.sellerOwnerUserId, table.guildId),
    index("commerce_seller_profiles_lifecycle").on(
      table.lifecycleState,
      table.approvalState,
      table.updatedAtMs,
    ),
  ],
);

export const commerceSellerReviewRequests = pgTable(
  "commerce_seller_review_requests",
  {
    id: text("id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    guildId: text("guild_id").notNull(),
    sellerOwnerUserId: text("seller_owner_user_id").notNull(),
    guildCreatedAtMs: bigInteger("guild_created_at_ms"),
    state: text("state").notNull().default("pending"),
    stripeDetailsSubmitted: integerBoolean("stripe_details_submitted").notNull(),
    stripeChargesEnabled: integerBoolean("stripe_charges_enabled").notNull(),
    stripePayoutsEnabled: integerBoolean("stripe_payouts_enabled").notNull(),
    reviewChannelId: text("review_channel_id"),
    reviewMessageId: text("review_message_id"),
    notificationLeaseToken: text("notification_lease_token"),
    notificationLeaseExpiresAtMs: bigInteger("notification_lease_expires_at_ms"),
    decisionActorUserId: text("decision_actor_user_id"),
    decisionState: text("decision_state"),
    decisionReason: text("decision_reason"),
    decidedAtMs: bigInteger("decided_at_ms"),
    decisionNotifiedAtMs: bigInteger("decision_notified_at_ms"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_seller_review_requests_account").on(table.connectedAccountId),
    index("commerce_seller_review_requests_pending").on(table.state, table.createdAtMs),
    index("commerce_seller_review_requests_lease").on(table.notificationLeaseExpiresAtMs),
  ],
);

export const commerceAuthorityGrants = pgTable(
  "commerce_authority_grants",
  {
    connectedAccountId: text("connected_account_id").notNull(),
    discordUserId: text("discord_user_id").notNull(),
    capability: text("capability").notNull(),
    grantedByUserId: text("granted_by_user_id").notNull(),
    grantedAtMs: bigInteger("granted_at_ms").notNull(),
    revokedAtMs: bigInteger("revoked_at_ms"),
  },
  (table) => [
    primaryKey({ columns: [table.connectedAccountId, table.discordUserId, table.capability] }),
    index("commerce_authority_grants_active_user").on(
      table.connectedAccountId,
      table.discordUserId,
      table.revokedAtMs,
    ),
  ],
);

export const commerceSellerControls = pgTable(
  "commerce_seller_controls",
  {
    id: text("id").primaryKey().notNull(),
    scopeType: text("scope_type").notNull(),
    scopeId: text("scope_id").notNull(),
    suspended: integerBoolean("suspended").notNull().default(false),
    reasonCode: text("reason_code"),
    actorUserId: text("actor_user_id").notNull(),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_seller_controls_scope").on(table.scopeType, table.scopeId),
    index("commerce_seller_controls_active").on(
      table.suspended,
      table.scopeType,
      table.updatedAtMs,
    ),
  ],
);

export const commerceOfferings = pgTable(
  "commerce_offerings",
  {
    id: text("id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    guildId: text("guild_id").notNull(),
    discordRoleId: text("discord_role_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    purchaseType: text("purchase_type").notNull(),
    state: text("state").notNull(),
    termsVersion: text("terms_version"),
    includedBenefitsJson: text("included_benefits_json").notNull().default("[]"),
    supportContact: text("support_contact"),
    roleManageable: integerBoolean("role_manageable").notNull().default(false),
    repairDeadlineAtMs: bigInteger("repair_deadline_at_ms"),
    repairPreviousState: text("repair_previous_state"),
    retireAtMs: bigInteger("retire_at_ms"),
    publishedAtMs: bigInteger("published_at_ms"),
    archivedAtMs: bigInteger("archived_at_ms"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    check(
      "commerce_offerings_state_check",
      sql`${table.state} IN ('draft', 'published', 'unpublished', 'repair_required', 'retiring', 'archived', 'suspended')`,
    ),
    check(
      "commerce_offerings_archived_check",
      sql`(${table.state} = 'archived') = (${table.archivedAtMs} IS NOT NULL)`,
    ),
    check(
      "commerce_offerings_retiring_check",
      sql`${table.state} <> 'retiring' OR ${table.retireAtMs} IS NOT NULL`,
    ),
    check(
      "commerce_offerings_repair_state_check",
      sql`(${table.state} = 'repair_required') = (${table.repairPreviousState} IS NOT NULL)`,
    ),
    check(
      "commerce_offerings_repair_previous_state_check",
      sql`${table.repairPreviousState} IS NULL OR ${table.repairPreviousState} IN ('draft', 'published', 'unpublished', 'retiring', 'suspended')`,
    ),
    uniqueIndex("commerce_offerings_published_role")
      .on(table.guildId, table.discordRoleId)
      .where(
        sql`${table.state} = 'published' OR (${table.state} = 'repair_required' AND ${table.repairPreviousState} = 'published')`,
      ),
    index("commerce_offerings_seller_state").on(table.connectedAccountId, table.state),
  ],
);

export const commerceSalesPanels = pgTable(
  "commerce_sales_panels",
  {
    connectedAccountId: text("connected_account_id").primaryKey().notNull(),
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull(),
    title: text("title").notNull().default("Support this Discord server"),
    description: text("description")
      .notNull()
      .default("Discover paid Discord role access from this server."),
    messageId: text("message_id"),
    lastErrorCode: text("last_error_code"),
    pendingChannelId: text("pending_channel_id"),
    pendingTitle: text("pending_title"),
    pendingDescription: text("pending_description"),
    publicationNonce: text("publication_nonce"),
    publicationLeaseToken: text("publication_lease_token"),
    publicationLeaseExpiresAtMs: bigInteger("publication_lease_expires_at_ms"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_sales_panels_guild").on(table.guildId),
    index("commerce_sales_panels_message").on(table.channelId, table.messageId),
    index("commerce_sales_panels_lease").on(table.publicationLeaseExpiresAtMs),
  ],
);

/**
 * Current Offering lifecycle state is stored directly on commerce_offerings.
 * Repair restores the explicit original state; there is no projection table.
 */
export const commercePrices = pgTable(
  "commerce_prices",
  {
    id: text("id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    offeringId: text("offering_id").notNull(),
    stripeProductId: text("stripe_product_id").notNull(),
    stripePriceId: text("stripe_price_id").notNull(),
    currency: text("currency").notNull(),
    unitAmountMinor: bigInteger("unit_amount_minor").notNull(),
    priceType: text("price_type").notNull(),
    recurringInterval: text("recurring_interval"),
    status: text("status").notNull(),
    providerCreatedAtMs: bigInteger("provider_created_at_ms"),
    retiredAtMs: bigInteger("retired_at_ms"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_prices_provider").on(table.connectedAccountId, table.stripePriceId),
    index("commerce_prices_offering_status").on(table.offeringId, table.status),
  ],
);

export const commerceBuyers = pgTable(
  "commerce_buyers",
  {
    id: text("id").primaryKey().notNull(),
    discordUserId: text("discord_user_id").notNull(),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [uniqueIndex("commerce_buyers_discord_user").on(table.discordUserId)],
);

export const commerceCustomers = pgTable(
  "commerce_customers",
  {
    id: text("id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    buyerId: text("buyer_id").notNull(),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_customers_seller_buyer").on(table.connectedAccountId, table.buyerId),
    uniqueIndex("commerce_customers_provider").on(table.connectedAccountId, table.stripeCustomerId),
  ],
);

export const commerceCheckoutAttempts = pgTable(
  "commerce_checkout_attempts",
  {
    id: text("id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    guildId: text("guild_id").notNull(),
    offeringId: text("offering_id").notNull(),
    priceId: text("price_id").notNull(),
    buyerId: text("buyer_id").notNull(),
    stripeCheckoutSessionId: text("stripe_checkout_session_id"),
    providerTerminalAtMs: bigInteger("provider_terminal_at_ms"),
    preSessionFailedAtMs: bigInteger("pre_session_failed_at_ms"),
    status: text("status").notNull(),
    expiresAtMs: bigInteger("expires_at_ms").notNull(),
    returnedAtMs: bigInteger("returned_at_ms"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_checkout_attempts_provider").on(
      table.connectedAccountId,
      table.stripeCheckoutSessionId,
    ),
    uniqueIndex("commerce_checkout_attempts_active_buyer_offering")
      .on(table.connectedAccountId, table.buyerId, table.offeringId)
      .where(sql`${table.status} IN ('creating', 'open', 'returned')`),
    index("commerce_checkout_attempts_expiry").on(table.status, table.expiresAtMs),
  ],
);

export const commerceCheckoutRateLimits = pgTable(
  "commerce_checkout_rate_limits",
  {
    buyerId: text("buyer_id").notNull(),
    offeringId: text("offering_id").notNull(),
    windowStartedAtMs: bigInteger("window_started_at_ms").notNull(),
    attemptCount: bigInteger("attempt_count").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [primaryKey({ columns: [table.buyerId, table.offeringId] })],
);

export const commerceSupportConfigs = pgTable(
  "commerce_support_configs",
  {
    connectedAccountId: text("connected_account_id").primaryKey().notNull(),
    guildId: text("guild_id").notNull(),
    enabled: integerBoolean("enabled").notNull().default(false),
    explanation: text("explanation").notNull(),
    currency: text("currency").notNull(),
    suggestedAmountsJson: text("suggested_amounts_json").notNull(),
    supportContact: text("support_contact").notNull(),
    termsVersion: text("terms_version").notNull(),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_support_configs_guild").on(table.guildId),
    index("commerce_support_configs_enabled").on(table.enabled, table.updatedAtMs),
  ],
);

export const commerceSupportCheckoutAttempts = pgTable(
  "commerce_support_checkout_attempts",
  {
    id: text("id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    guildId: text("guild_id").notNull(),
    buyerId: text("buyer_id").notNull(),
    currency: text("currency").notNull(),
    amountMinor: bigInteger("amount_minor").notNull(),
    applicationFeeMinor: bigInteger("application_fee_minor").notNull(),
    stripeCheckoutSessionId: text("stripe_checkout_session_id"),
    status: text("status").notNull(),
    expiresAtMs: bigInteger("expires_at_ms").notNull(),
    returnedAtMs: bigInteger("returned_at_ms"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_support_checkout_provider")
      .on(table.connectedAccountId, table.stripeCheckoutSessionId)
      .where(sql`${table.stripeCheckoutSessionId} IS NOT NULL`),
    uniqueIndex("commerce_support_checkout_active_buyer_guild")
      .on(table.connectedAccountId, table.buyerId, table.guildId)
      .where(sql`${table.status} IN ('creating', 'open', 'returned')`),
    index("commerce_support_checkout_expiry").on(table.status, table.expiresAtMs),
  ],
);

export const commerceSupportRateLimits = pgTable(
  "commerce_support_rate_limits",
  {
    buyerId: text("buyer_id").notNull(),
    guildId: text("guild_id").notNull(),
    windowStartedAtMs: bigInteger("window_started_at_ms").notNull(),
    attemptCount: bigInteger("attempt_count").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [primaryKey({ columns: [table.buyerId, table.guildId] })],
);

export const commerceSupportPayments = pgTable(
  "commerce_support_payments",
  {
    id: text("id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    guildId: text("guild_id").notNull(),
    customerId: text("customer_id").notNull(),
    buyerId: text("buyer_id").notNull(),
    checkoutAttemptId: text("checkout_attempt_id").notNull(),
    stripePaymentIntentId: text("stripe_payment_intent_id").notNull(),
    stripeChargeId: text("stripe_charge_id"),
    stripeCheckoutSessionId: text("stripe_checkout_session_id"),
    currency: text("currency").notNull(),
    amountMinor: bigInteger("amount_minor").notNull(),
    amountReceivedMinor: bigInteger("amount_received_minor").notNull().default(0),
    amountRefundedMinor: bigInteger("amount_refunded_minor").notNull().default(0),
    applicationFeeMinor: bigInteger("application_fee_minor").notNull(),
    stripeFeeMinor: bigInteger("stripe_fee_minor"),
    stripeFeeTaxMinor: bigInteger("stripe_fee_tax_minor"),
    status: text("status").notNull(),
    providerCreatedAtMs: bigInteger("provider_created_at_ms"),
    paidAtMs: bigInteger("paid_at_ms"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_support_payments_intent").on(
      table.connectedAccountId,
      table.stripePaymentIntentId,
    ),
    uniqueIndex("commerce_support_payments_attempt").on(
      table.connectedAccountId,
      table.checkoutAttemptId,
    ),
    index("commerce_support_payments_seller_time").on(table.connectedAccountId, table.createdAtMs),
    index("commerce_support_payments_buyer_time").on(table.buyerId, table.createdAtMs),
  ],
);

export const commerceSupportRefunds = pgTable(
  "commerce_support_refunds",
  {
    id: text("id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    supportPaymentId: text("support_payment_id").notNull(),
    stripeRefundId: text("stripe_refund_id").notNull(),
    currency: text("currency").notNull(),
    amountMinor: bigInteger("amount_minor").notNull(),
    applicationFeeRefundedMinor: bigInteger("application_fee_refunded_minor"),
    status: text("status").notNull(),
    reason: text("reason"),
    providerCreatedAtMs: bigInteger("provider_created_at_ms"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_support_refunds_provider").on(
      table.connectedAccountId,
      table.stripeRefundId,
    ),
    index("commerce_support_refunds_payment_time").on(table.supportPaymentId, table.createdAtMs),
  ],
);

export const commerceSubscriptions = pgTable(
  "commerce_subscriptions",
  {
    id: text("id").primaryKey().notNull(),
    checkoutAttemptId: text("checkout_attempt_id"),
    connectedAccountId: text("connected_account_id").notNull(),
    customerId: text("customer_id").notNull(),
    buyerId: text("buyer_id").notNull(),
    offeringId: text("offering_id").notNull(),
    priceId: text("price_id").notNull(),
    stripeSubscriptionId: text("stripe_subscription_id").notNull(),
    status: text("status").notNull(),
    cancelAtPeriodEnd: integerBoolean("cancel_at_period_end").notNull().default(false),
    currentPeriodStartMs: bigInteger("current_period_start_ms"),
    currentPeriodEndMs: bigInteger("current_period_end_ms"),
    canceledAtMs: bigInteger("canceled_at_ms"),
    endedAtMs: bigInteger("ended_at_ms"),
    providerUpdatedAtMs: bigInteger("provider_updated_at_ms"),
    latestInvoiceId: text("latest_invoice_id"),
    latestInvoiceStatus: text("latest_invoice_status"),
    latestPaymentIntentId: text("latest_payment_intent_id"),
    latestPaymentStatus: text("latest_payment_status"),
    graceStartedAtMs: bigInteger("grace_started_at_ms"),
    graceEndsAtMs: bigInteger("grace_ends_at_ms"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_subscriptions_provider").on(
      table.connectedAccountId,
      table.stripeSubscriptionId,
    ),
    uniqueIndex("commerce_subscriptions_active_buyer_offering")
      .on(table.connectedAccountId, table.buyerId, table.offeringId)
      .where(sql`${table.status} NOT IN ('canceled', 'ended')`),
    index("commerce_subscriptions_customer_status").on(table.customerId, table.status),
  ],
);

export const commerceEntitlements = pgTable(
  "commerce_entitlements",
  {
    id: text("id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    buyerId: text("buyer_id").notNull(),
    offeringId: text("offering_id").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    status: text("status").notNull(),
    effectiveAtMs: bigInteger("effective_at_ms").notNull(),
    expiresAtMs: bigInteger("expires_at_ms"),
    revokedAtMs: bigInteger("revoked_at_ms"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_entitlements_seller_source").on(
      table.connectedAccountId,
      table.sourceType,
      table.sourceId,
    ),
    index("commerce_entitlements_buyer_status").on(table.buyerId, table.status),
    index("commerce_entitlements_offering_status").on(table.offeringId, table.status),
  ],
);

export const commerceRoleAssignments = pgTable(
  "commerce_role_assignments",
  {
    id: text("id").primaryKey().notNull(),
    entitlementId: text("entitlement_id").notNull(),
    guildId: text("guild_id").notNull(),
    discordUserId: text("discord_user_id").notNull(),
    discordRoleId: text("discord_role_id").notNull(),
    status: text("status").notNull(),
    withheldReason: text("withheld_reason"),
    providerCancellationState: text("provider_cancellation_state").notNull().default("none"),
    attemptCount: bigInteger("attempt_count").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    nextAttemptAtMs: bigInteger("next_attempt_at_ms"),
    assignedAtMs: bigInteger("assigned_at_ms"),
    removedAtMs: bigInteger("removed_at_ms"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_role_assignments_entitlement").on(table.entitlementId),
    index("commerce_role_assignments_due").on(table.status, table.nextAttemptAtMs),
    index("commerce_role_assignments_member").on(table.guildId, table.discordUserId),
  ],
);

export const commercePayments = pgTable(
  "commerce_payments",
  {
    id: text("id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    customerId: text("customer_id").notNull(),
    buyerId: text("buyer_id").notNull(),
    offeringId: text("offering_id").notNull(),
    priceId: text("price_id").notNull(),
    stripePaymentIntentId: text("stripe_payment_intent_id").notNull(),
    stripeChargeId: text("stripe_charge_id"),
    stripeCheckoutSessionId: text("stripe_checkout_session_id"),
    stripeInvoiceId: text("stripe_invoice_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    billingPeriodStartMs: bigInteger("invoice_period_start_ms"),
    billingPeriodEndMs: bigInteger("invoice_period_end_ms"),
    isLatestSubscriptionInvoice: integerBoolean("is_latest_subscription_invoice")
      .notNull()
      .default(false),
    currency: text("currency").notNull(),
    amountMinor: bigInteger("amount_minor").notNull(),
    amountReceivedMinor: bigInteger("amount_received_minor").notNull().default(0),
    amountRefundedMinor: bigInteger("amount_refunded_minor").notNull().default(0),
    applicationFeeMinor: bigInteger("application_fee_minor"),
    stripeFeeMinor: bigInteger("stripe_fee_minor"),
    stripeFeeTaxMinor: bigInteger("stripe_fee_tax_minor"),
    status: text("status").notNull(),
    providerCreatedAtMs: bigInteger("provider_created_at_ms"),
    paidAtMs: bigInteger("paid_at_ms"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_payments_intent").on(
      table.connectedAccountId,
      table.stripePaymentIntentId,
    ),
    uniqueIndex("commerce_payments_charge")
      .on(table.connectedAccountId, table.stripeChargeId)
      .where(sql`${table.stripeChargeId} IS NOT NULL`),
    uniqueIndex("commerce_payments_checkout")
      .on(table.connectedAccountId, table.stripeCheckoutSessionId)
      .where(sql`${table.stripeCheckoutSessionId} IS NOT NULL`),
    uniqueIndex("commerce_payments_invoice")
      .on(table.connectedAccountId, table.stripeInvoiceId)
      .where(sql`${table.stripeInvoiceId} IS NOT NULL`),
    index("commerce_payments_subscription_period").on(
      table.connectedAccountId,
      table.stripeSubscriptionId,
      table.billingPeriodEndMs,
    ),
    index("commerce_payments_buyer_created").on(table.buyerId, table.createdAtMs),
  ],
);

export const commerceRefunds = pgTable(
  "commerce_refunds",
  {
    id: text("id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    paymentId: text("payment_id").notNull(),
    stripeRefundId: text("stripe_refund_id").notNull(),
    currency: text("currency").notNull(),
    amountMinor: bigInteger("amount_minor").notNull(),
    applicationFeeRefundedMinor: bigInteger("application_fee_refunded_minor"),
    status: text("status").notNull(),
    reason: text("reason"),
    providerCreatedAtMs: bigInteger("provider_created_at_ms"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_refunds_provider").on(table.connectedAccountId, table.stripeRefundId),
    index("commerce_refunds_payment").on(table.paymentId, table.createdAtMs),
  ],
);

export const commerceDisputes = pgTable(
  "commerce_disputes",
  {
    id: text("id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    paymentId: text("payment_id").notNull(),
    stripeDisputeId: text("stripe_dispute_id").notNull(),
    currency: text("currency").notNull(),
    amountMinor: bigInteger("amount_minor").notNull(),
    status: text("status").notNull(),
    reason: text("reason"),
    providerCreatedAtMs: bigInteger("provider_created_at_ms"),
    closedAtMs: bigInteger("closed_at_ms"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_disputes_provider").on(table.connectedAccountId, table.stripeDisputeId),
    index("commerce_disputes_payment").on(table.paymentId, table.createdAtMs),
  ],
);

export const commerceWebhookEvents = pgTable(
  "commerce_webhook_events",
  {
    id: text("id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    stripeEventId: text("stripe_event_id").notNull(),
    eventType: text("event_type").notNull(),
    objectId: text("object_id"),
    payloadHash: text("payload_hash"),
    generation: bigInteger("generation").notNull().default(0),
    apiVersion: text("api_version"),
    providerCreatedAtMs: bigInteger("provider_created_at_ms").notNull(),
    receivedAtMs: bigInteger("received_at_ms").notNull(),
    status: text("status").notNull(),
    attemptCount: bigInteger("attempt_count").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    processedAtMs: bigInteger("processed_at_ms"),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_webhook_events_provider").on(
      table.connectedAccountId,
      table.stripeEventId,
    ),
    index("commerce_webhook_events_pending").on(table.status, table.receivedAtMs),
  ],
);

export const commerceSyncState = pgTable(
  "commerce_sync_state",
  {
    id: text("id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    status: text("status").notNull(),
    providerUpdatedAtMs: bigInteger("provider_updated_at_ms"),
    providerEventId: text("provider_event_id"),
    lastSyncedAtMs: bigInteger("last_synced_at_ms"),
    lastErrorCode: text("last_error_code"),
    generation: bigInteger("generation").notNull().default(0),
    appliedGeneration: bigInteger("applied_generation").notNull().default(0),
    leaseToken: text("lease_token"),
    leaseExpiresAtMs: bigInteger("lease_expires_at_ms"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_sync_state_resource").on(
      table.connectedAccountId,
      table.resourceType,
      table.resourceId,
    ),
    index("commerce_sync_state_status").on(table.status, table.updatedAtMs),
  ],
);

export const commerceSyncOutbox = pgTable(
  "commerce_sync_outbox",
  {
    id: text("id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    eventId: text("event_id").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    generation: bigInteger("generation").notNull(),
    sentAtMs: bigInteger("sent_at_ms"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_sync_outbox_event").on(table.connectedAccountId, table.eventId),
    index("commerce_sync_outbox_pending").on(table.sentAtMs, table.createdAtMs),
  ],
);

export const commerceOperationsLedger = pgTable(
  "commerce_operations_ledger",
  {
    id: text("id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id"),
    guildId: text("guild_id").notNull(),
    operationKey: text("operation_key").notNull(),
    operationType: text("operation_type").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    payloadJson: text("payload_json").notNull(),
    createdAtMs: bigInteger("created_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_operations_ledger_key").on(table.guildId, table.operationKey),
    index("commerce_operations_ledger_entity").on(
      table.entityType,
      table.entityId,
      table.createdAtMs,
    ),
    index("commerce_operations_ledger_seller_time").on(table.connectedAccountId, table.createdAtMs),
  ],
);

export const commerceReportingLedger = pgTable(
  "commerce_reporting_ledger",
  {
    id: text("id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    guildId: text("guild_id").notNull(),
    sellerCountry: text("seller_country"),
    buyerId: text("buyer_id"),
    transactionType: text("transaction_type").notNull(),
    sourceRecordId: text("source_record_id").notNull(),
    providerTransactionId: text("provider_transaction_id").notNull(),
    providerStatus: text("provider_status").notNull(),
    currency: text("currency").notNull(),
    grossAmountMinor: bigInteger("gross_amount_minor").notNull(),
    applicationFeeMinor: bigInteger("application_fee_minor"),
    stripeFeeMinor: bigInteger("stripe_fee_minor"),
    stripeFeeTaxMinor: bigInteger("stripe_fee_tax_minor"),
    occurredAtMs: bigInteger("occurred_at_ms").notNull(),
    reportingPeriod: text("reporting_period").notNull(),
    correctionOfTransactionType: text("correction_of_transaction_type"),
    correctionOfSourceRecordId: text("correction_of_source_record_id"),
    audAmountMinor: bigInteger("aud_amount_minor"),
    audConversionRate: text("aud_conversion_rate"),
    audConversionSource: text("aud_conversion_source"),
    audConversionAtMs: bigInteger("aud_conversion_at_ms"),
    recordedAtMs: bigInteger("recorded_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_reporting_ledger_source").on(
      table.transactionType,
      table.connectedAccountId,
      table.sourceRecordId,
    ),
    index("commerce_reporting_ledger_period").on(
      table.reportingPeriod,
      table.currency,
      table.transactionType,
    ),
    index("commerce_reporting_ledger_seller").on(table.connectedAccountId, table.occurredAtMs),
    index("commerce_reporting_ledger_buyer").on(table.buyerId, table.occurredAtMs),
  ],
);

export const commerceDeliveryOutbox = pgTable(
  "commerce_delivery_outbox",
  {
    id: text("id").primaryKey().notNull(),
    operationId: text("operation_id").notNull(),
    destinationType: text("destination_type").notNull(),
    destinationId: text("destination_id").notNull(),
    payloadJson: text("payload_json").notNull(),
    status: text("status").notNull(),
    attemptCount: bigInteger("attempt_count").notNull().default(0),
    availableAtMs: bigInteger("available_at_ms").notNull(),
    lastErrorCode: text("last_error_code"),
    deliveredAtMs: bigInteger("delivered_at_ms"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_delivery_outbox_destination").on(
      table.operationId,
      table.destinationType,
      table.destinationId,
    ),
    index("commerce_delivery_outbox_due").on(table.status, table.availableAtMs, table.createdAtMs),
  ],
);

export const commerceIncidents = pgTable(
  "commerce_incidents",
  {
    id: text("id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id"),
    guildId: text("guild_id").notNull(),
    incidentKey: text("incident_key").notNull(),
    severity: text("severity").notNull(),
    status: text("status").notNull(),
    summaryCode: text("summary_code").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    safeArgsJson: text("safe_args_json").notNull(),
    occurrenceCount: bigInteger("occurrence_count").notNull().default(1),
    firstSeenAtMs: bigInteger("first_seen_at_ms").notNull(),
    lastSeenAtMs: bigInteger("last_seen_at_ms").notNull(),
    resolvedAtMs: bigInteger("resolved_at_ms"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_incidents_guild_key").on(table.guildId, table.incidentKey),
    index("commerce_incidents_guild_status").on(
      table.guildId,
      table.status,
      table.severity,
      table.lastSeenAtMs,
    ),
  ],
);

export const commerceFinancialActions = pgTable(
  "commerce_financial_actions",
  {
    id: text("id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    guildId: text("guild_id").notNull(),
    actionType: text("action_type").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    reasonCode: text("reason_code").notNull(),
    amountMinor: bigInteger("amount_minor"),
    currency: text("currency"),
    status: text("status").notNull(),
    providerResultId: text("provider_result_id"),
    accessAction: text("access_action"),
    attemptCount: bigInteger("attempt_count").notNull().default(1),
    lastErrorCode: text("last_error_code"),
    leaseToken: text("lease_token"),
    claimedAtMs: bigInteger("claimed_at_ms"),
    leaseExpiresAtMs: bigInteger("lease_expires_at_ms"),
    availableAtMs: bigInteger("available_at_ms").notNull().default(0),
    providerCompletedAtMs: bigInteger("provider_completed_at_ms"),
    reconciliationRequestedAtMs: bigInteger("reconciliation_requested_at_ms"),
    quarantinedAtMs: bigInteger("quarantined_at_ms"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
    completedAtMs: bigInteger("completed_at_ms"),
  },
  (table) => [
    index("commerce_financial_actions_seller_time").on(table.connectedAccountId, table.createdAtMs),
    index("commerce_financial_actions_entity_time").on(
      table.entityType,
      table.entityId,
      table.createdAtMs,
    ),
    index("commerce_financial_actions_due").on(
      table.status,
      table.availableAtMs,
      table.leaseExpiresAtMs,
    ),
  ],
);

export const commerceFinancialProviderActions = pgTable(
  "commerce_financial_provider_actions",
  {
    id: text("id").primaryKey().notNull(),
    operationKey: text("operation_key").notNull(),
    parentActionId: text("parent_action_id").notNull(),
    workflowType: text("workflow_type").notNull(),
    workflowId: text("workflow_id").notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    guildId: text("guild_id").notNull(),
    offeringId: text("offering_id"),
    subscriptionId: text("subscription_id").notNull(),
    stripeSubscriptionId: text("stripe_subscription_id").notNull(),
    actionType: text("action_type").notNull(),
    reasonCode: text("reason_code").notNull(),
    status: text("status").notNull(),
    attemptCount: bigInteger("attempt_count").notNull().default(0),
    availableAtMs: bigInteger("available_at_ms").notNull(),
    leaseToken: text("lease_token"),
    claimedAtMs: bigInteger("claimed_at_ms"),
    leaseExpiresAtMs: bigInteger("lease_expires_at_ms"),
    providerCompletedAtMs: bigInteger("provider_completed_at_ms"),
    reconciliationRequestedAtMs: bigInteger("reconciliation_requested_at_ms"),
    completedAtMs: bigInteger("completed_at_ms"),
    lastErrorCode: text("last_error_code"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_financial_provider_actions_operation").on(table.operationKey),
    index("commerce_financial_provider_actions_due").on(
      table.status,
      table.availableAtMs,
      table.leaseExpiresAtMs,
    ),
    index("commerce_financial_provider_actions_workflow").on(
      table.workflowType,
      table.workflowId,
      table.status,
    ),
  ],
);

export const commerceOfferingRetirements = pgTable(
  "commerce_offering_retirements",
  {
    id: text("id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    guildId: text("guild_id").notNull(),
    offeringId: text("offering_id").notNull(),
    requestedByUserId: text("requested_by_user_id").notNull(),
    reasonCode: text("reason_code").notNull(),
    status: text("status").notNull(),
    activeSubscriptionCount: bigInteger("active_subscription_count").notNull().default(0),
    scheduledCancellationCount: bigInteger("scheduled_cancellation_count").notNull().default(0),
    failedCancellationCount: bigInteger("failed_cancellation_count").notNull().default(0),
    latestPeriodEndMs: bigInteger("latest_period_end_ms"),
    lastErrorCode: text("last_error_code"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
    completedAtMs: bigInteger("completed_at_ms"),
  },
  (table) => [
    uniqueIndex("commerce_offering_retirements_offering").on(table.offeringId),
    index("commerce_offering_retirements_status").on(table.status, table.updatedAtMs),
  ],
);

export const commerceSellerOffboarding = pgTable(
  "commerce_seller_offboarding",
  {
    connectedAccountId: text("connected_account_id").primaryKey().notNull(),
    guildId: text("guild_id").notNull(),
    status: text("status").notNull(),
    reasonCode: text("reason_code").notNull(),
    actorUserId: text("actor_user_id"),
    activeSubscriptionCount: bigInteger("active_subscription_count").notNull().default(0),
    latestPaidThroughAtMs: bigInteger("latest_paid_through_at_ms"),
    startedAtMs: bigInteger("started_at_ms").notNull(),
    completedAtMs: bigInteger("completed_at_ms"),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [uniqueIndex("commerce_seller_offboarding_guild").on(table.guildId)],
);

export const commerceSupportDisputes = pgTable(
  "commerce_support_disputes",
  {
    id: text("id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    supportPaymentId: text("support_payment_id").notNull(),
    stripeDisputeId: text("stripe_dispute_id").notNull(),
    currency: text("currency").notNull(),
    amountMinor: bigInteger("amount_minor").notNull(),
    status: text("status").notNull(),
    reason: text("reason"),
    providerCreatedAtMs: bigInteger("provider_created_at_ms"),
    closedAtMs: bigInteger("closed_at_ms"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_support_disputes_provider").on(
      table.connectedAccountId,
      table.stripeDisputeId,
    ),
    index("commerce_support_disputes_payment_time").on(table.supportPaymentId, table.createdAtMs),
  ],
);

export const commerceOperationalControls = pgTable(
  "commerce_operational_controls",
  {
    id: text("id").primaryKey().notNull(),
    scopeType: text("scope_type").notNull(),
    scopeId: text("scope_id").notNull(),
    controlType: text("control_type").notNull(),
    enabled: integerBoolean("enabled").notNull().default(false),
    reasonCode: text("reason_code"),
    actorUserId: text("actor_user_id").notNull(),
    expiresAtMs: bigInteger("expires_at_ms"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_operational_controls_scope").on(
      table.scopeType,
      table.scopeId,
      table.controlType,
    ),
    index("commerce_operational_controls_active").on(
      table.enabled,
      table.controlType,
      table.expiresAtMs,
    ),
  ],
);

export const commerceCheckoutCapacityClaims = pgTable(
  "commerce_checkout_capacity_claims",
  {
    id: text("id").primaryKey().notNull(),
    checkoutKind: text("checkout_kind").notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    guildId: text("guild_id").notNull(),
    offeringId: text("offering_id"),
    currency: text("currency").notNull(),
    amountMinor: bigInteger("amount_minor").notNull(),
    monthStartedAtMs: bigInteger("month_started_at_ms").notNull(),
    expiresAtMs: bigInteger("expires_at_ms").notNull(),
    createdAtMs: bigInteger("created_at_ms").notNull(),
  },
  (table) => [
    index("commerce_checkout_capacity_claims_usage").on(
      table.connectedAccountId,
      table.currency,
      table.monthStartedAtMs,
      table.expiresAtMs,
    ),
  ],
);

export const commerceLimitAlerts = pgTable(
  "commerce_limit_alerts",
  {
    id: text("id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    guildId: text("guild_id").notNull(),
    metric: text("metric").notNull(),
    currency: text("currency"),
    thresholdPercent: bigInteger("threshold_percent").notNull(),
    observedValue: bigInteger("observed_value").notNull(),
    limitValue: bigInteger("limit_value").notNull(),
    status: text("status").notNull(),
    firstSeenAtMs: bigInteger("first_seen_at_ms").notNull(),
    lastSeenAtMs: bigInteger("last_seen_at_ms").notNull(),
    resolvedAtMs: bigInteger("resolved_at_ms"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    index("commerce_limit_alerts_open").on(table.guildId, table.status, table.updatedAtMs),
  ],
);

export const commercePaidRoleStates = pgTable(
  "commerce_paid_role_states",
  {
    entitlementId: text("entitlement_id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    guildId: text("guild_id").notNull(),
    discordUserId: text("discord_user_id").notNull(),
    discordRoleId: text("discord_role_id").notNull(),
    subscriptionId: text("subscription_id"),
    subscriptionStatus: text("subscription_status").notNull(),
    cancelAtPeriodEnd: integerBoolean("cancel_at_period_end").notNull().default(false),
    currentPeriodEndMs: bigInteger("current_period_end_ms"),
    paymentStatus: text("payment_status"),
    amountMinor: bigInteger("amount_minor"),
    amountRefundedMinor: bigInteger("amount_refunded_minor").notNull().default(0),
    disputeStatus: text("dispute_status"),
    failedPaymentAtMs: bigInteger("failed_payment_at_ms"),
    adminAction: text("admin_action"),
    memberState: text("member_state").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [index("commerce_paid_role_states_guild_role").on(table.guildId, table.discordRoleId)],
);

export const commercePaidRoleOperations = pgTable(
  "commerce_paid_role_operations",
  {
    operationKey: text("operation_key").primaryKey().notNull(),
    entitlementId: text("entitlement_id").notNull(),
    operationType: text("operation_type").notNull(),
    status: text("status").notNull(),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    claimedAtMs: bigInteger("claimed_at_ms").notNull(),
    leaseExpiresAtMs: bigInteger("lease_expires_at_ms").notNull(),
    committedAtMs: bigInteger("committed_at_ms"),
  },
  (table) => [
    index("commerce_paid_role_operations_entitlement").on(table.entitlementId, table.createdAtMs),
  ],
);

export const commercePaidRoleOutbox = pgTable(
  "commerce_paid_role_outbox",
  {
    id: text("id").primaryKey().notNull(),
    operationKey: text("operation_key").notNull(),
    entitlementId: text("entitlement_id").notNull(),
    guildId: text("guild_id").notNull(),
    discordUserId: text("discord_user_id").notNull(),
    discordRoleId: text("discord_role_id").notNull(),
    action: text("action").notNull(),
    payloadJson: text("payload_json").notNull(),
    status: text("status").notNull(),
    availableAtMs: bigInteger("available_at_ms").notNull(),
    sentAtMs: bigInteger("sent_at_ms"),
    attemptCount: bigInteger("attempt_count").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_paid_role_outbox_operation").on(table.operationKey),
    index("commerce_paid_role_outbox_due").on(table.status, table.availableAtMs, table.createdAtMs),
  ],
);

export const commercePaidRoleRepairs = pgTable(
  "commerce_paid_role_repairs",
  {
    id: text("id").primaryKey().notNull(),
    offeringId: text("offering_id"),
    guildId: text("guild_id").notNull(),
    oldRoleId: text("old_role_id").notNull(),
    replacementRoleId: text("replacement_role_id"),
    startedAtMs: bigInteger("started_at_ms").notNull(),
    deadlineAtMs: bigInteger("deadline_at_ms").notNull(),
    status: text("status").notNull(),
    repairedCount: bigInteger("repaired_count").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [index("commerce_paid_role_repairs_due").on(table.status, table.deadlineAtMs)],
);

export const commercePaidRoleProviderActions = pgTable(
  "commerce_paid_role_provider_actions",
  {
    id: text("id").primaryKey().notNull(),
    operationKey: text("operation_key").notNull(),
    assignmentId: text("assignment_id"),
    connectedAccountId: text("connected_account_id").notNull(),
    stripeSubscriptionId: text("stripe_subscription_id").notNull(),
    actionType: text("action_type").notNull(),
    reasonCode: text("reason_code").notNull(),
    status: text("status").notNull(),
    attemptCount: bigInteger("attempt_count").notNull().default(0),
    availableAtMs: bigInteger("available_at_ms").notNull(),
    claimedAtMs: bigInteger("claimed_at_ms"),
    leaseExpiresAtMs: bigInteger("lease_expires_at_ms"),
    completedAtMs: bigInteger("completed_at_ms"),
    lastErrorCode: text("last_error_code"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_paid_role_provider_actions_operation").on(table.operationKey),
    index("commerce_paid_role_provider_actions_due").on(
      table.status,
      table.availableAtMs,
      table.leaseExpiresAtMs,
    ),
  ],
);

export const commerceGuildDeletionRefundReviews = pgTable(
  "commerce_guild_deletion_refund_reviews",
  {
    id: text("id").primaryKey().notNull(),
    guildId: text("guild_id").notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    subscriptionId: text("subscription_id").notNull(),
    buyerId: text("buyer_id").notNull(),
    paymentId: text("payment_id"),
    paymentPaidAtMs: bigInteger("payment_paid_at_ms"),
    paidThroughAtMs: bigInteger("paid_through_at_ms"),
    status: text("status").notNull(),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_guild_deletion_refund_reviews_subscription").on(
      table.connectedAccountId,
      table.subscriptionId,
    ),
    index("commerce_guild_deletion_refund_reviews_pending").on(table.status, table.createdAtMs),
  ],
);
