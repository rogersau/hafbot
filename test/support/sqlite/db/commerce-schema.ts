import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const commerceStoreBranding = sqliteTable(
  "commerce_store_branding",
  {
    guildId: text("guild_id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    accentColor: integer("accent_color").notNull().default(0x5865f2),
    tagline: text("tagline").notNull().default(""),
    createdByUserId: text("created_by_user_id").notNull(),
    updatedByUserId: text("updated_by_user_id").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
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

export const commerceConnectedAccounts = sqliteTable(
  "commerce_connected_accounts",
  {
    id: text("id").primaryKey().notNull(),
    guildId: text("guild_id").notNull(),
    stripeAccountId: text("stripe_account_id").notNull(),
    status: text("status").notNull(),
    country: text("country"),
    defaultCurrency: text("default_currency"),
    chargesEnabled: integer("charges_enabled", { mode: "boolean" }).notNull().default(false),
    payoutsEnabled: integer("payouts_enabled", { mode: "boolean" }).notNull().default(false),
    detailsSubmitted: integer("details_submitted", { mode: "boolean" }).notNull().default(false),
    providerCreatedAtMs: integer("provider_created_at_ms"),
    archivedAtMs: integer("archived_at_ms"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_connected_accounts_provider").on(table.stripeAccountId),
    uniqueIndex("commerce_connected_accounts_current_guild")
      .on(table.guildId)
      .where(sql`${table.status} <> 'archived'`),
    index("commerce_connected_accounts_guild_status").on(table.guildId, table.status),
  ],
);

export const commerceSellerAcceptances = sqliteTable(
  "commerce_seller_acceptances",
  {
    id: text("id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    termsVersion: text("terms_version").notNull(),
    acceptedByUserId: text("accepted_by_user_id").notNull(),
    acceptedAtMs: integer("accepted_at_ms").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
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

export const commerceSellerProfiles = sqliteTable(
  "commerce_seller_profiles",
  {
    connectedAccountId: text("connected_account_id").primaryKey().notNull(),
    guildId: text("guild_id").notNull(),
    sellerOwnerUserId: text("seller_owner_user_id").notNull().default(""),
    lifecycleState: text("lifecycle_state").notNull(),
    approvalState: text("approval_state").notNull(),
    supportContact: text("support_contact").notNull(),
    adultAttestedAtMs: integer("adult_attested_at_ms").notNull(),
    twoFactorEvidence: text("two_factor_evidence").notNull(),
    guildCreatedAtMs: integer("guild_created_at_ms").notNull(),
    ownershipTransferredAtMs: integer("ownership_transferred_at_ms"),
    guildGoodStanding: integer("guild_good_standing", { mode: "boolean" }).notNull().default(false),
    sellerGoodStanding: integer("seller_good_standing", { mode: "boolean" })
      .notNull()
      .default(false),
    requirementsCurrentlyDueJson: text("requirements_currently_due_json").notNull().default("[]"),
    requirementsEventuallyDueJson: text("requirements_eventually_due_json").notNull().default("[]"),
    requirementsPendingVerificationJson: text("requirements_pending_verification_json")
      .notNull()
      .default("[]"),
    disabledReason: text("disabled_reason"),
    reviewedByUserId: text("reviewed_by_user_id"),
    reviewedAtMs: integer("reviewed_at_ms"),
    capabilitiesUpdatedAtMs: integer("capabilities_updated_at_ms"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
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

export const commerceSellerReviewRequests = sqliteTable(
  "commerce_seller_review_requests",
  {
    id: text("id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    guildId: text("guild_id").notNull(),
    sellerOwnerUserId: text("seller_owner_user_id").notNull(),
    guildCreatedAtMs: integer("guild_created_at_ms"),
    state: text("state").notNull().default("pending"),
    stripeDetailsSubmitted: integer("stripe_details_submitted", { mode: "boolean" }).notNull(),
    stripeChargesEnabled: integer("stripe_charges_enabled", { mode: "boolean" }).notNull(),
    stripePayoutsEnabled: integer("stripe_payouts_enabled", { mode: "boolean" }).notNull(),
    reviewChannelId: text("review_channel_id"),
    reviewMessageId: text("review_message_id"),
    notificationLeaseToken: text("notification_lease_token"),
    notificationLeaseExpiresAtMs: integer("notification_lease_expires_at_ms"),
    decisionActorUserId: text("decision_actor_user_id"),
    decisionState: text("decision_state"),
    decisionReason: text("decision_reason"),
    decidedAtMs: integer("decided_at_ms"),
    decisionNotifiedAtMs: integer("decision_notified_at_ms"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_seller_review_requests_account").on(table.connectedAccountId),
    index("commerce_seller_review_requests_pending").on(table.state, table.createdAtMs),
    index("commerce_seller_review_requests_lease").on(table.notificationLeaseExpiresAtMs),
  ],
);

export const commerceAuthorityGrants = sqliteTable(
  "commerce_authority_grants",
  {
    connectedAccountId: text("connected_account_id").notNull(),
    discordUserId: text("discord_user_id").notNull(),
    capability: text("capability").notNull(),
    grantedByUserId: text("granted_by_user_id").notNull(),
    grantedAtMs: integer("granted_at_ms").notNull(),
    revokedAtMs: integer("revoked_at_ms"),
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

export const commerceSellerControls = sqliteTable(
  "commerce_seller_controls",
  {
    id: text("id").primaryKey().notNull(),
    scopeType: text("scope_type").notNull(),
    scopeId: text("scope_id").notNull(),
    suspended: integer("suspended", { mode: "boolean" }).notNull().default(false),
    reasonCode: text("reason_code"),
    actorUserId: text("actor_user_id").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
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

export const commerceOfferings = sqliteTable(
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
    roleManageable: integer("role_manageable", { mode: "boolean" }).notNull().default(false),
    repairDeadlineAtMs: integer("repair_deadline_at_ms"),
    repairPreviousState: text("repair_previous_state"),
    retireAtMs: integer("retire_at_ms"),
    publishedAtMs: integer("published_at_ms"),
    archivedAtMs: integer("archived_at_ms"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
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

export const commerceSalesPanels = sqliteTable(
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
    publicationLeaseExpiresAtMs: integer("publication_lease_expires_at_ms"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
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
export const commercePrices = sqliteTable(
  "commerce_prices",
  {
    id: text("id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    offeringId: text("offering_id").notNull(),
    stripeProductId: text("stripe_product_id").notNull(),
    stripePriceId: text("stripe_price_id").notNull(),
    currency: text("currency").notNull(),
    unitAmountMinor: integer("unit_amount_minor").notNull(),
    priceType: text("price_type").notNull(),
    recurringInterval: text("recurring_interval"),
    status: text("status").notNull(),
    providerCreatedAtMs: integer("provider_created_at_ms"),
    retiredAtMs: integer("retired_at_ms"),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_prices_provider").on(table.connectedAccountId, table.stripePriceId),
    index("commerce_prices_offering_status").on(table.offeringId, table.status),
  ],
);

export const commerceBuyers = sqliteTable(
  "commerce_buyers",
  {
    id: text("id").primaryKey().notNull(),
    discordUserId: text("discord_user_id").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [uniqueIndex("commerce_buyers_discord_user").on(table.discordUserId)],
);

export const commerceCustomers = sqliteTable(
  "commerce_customers",
  {
    id: text("id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    buyerId: text("buyer_id").notNull(),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_customers_seller_buyer").on(table.connectedAccountId, table.buyerId),
    uniqueIndex("commerce_customers_provider").on(table.connectedAccountId, table.stripeCustomerId),
  ],
);

export const commerceCheckoutAttempts = sqliteTable(
  "commerce_checkout_attempts",
  {
    id: text("id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    guildId: text("guild_id").notNull(),
    offeringId: text("offering_id").notNull(),
    priceId: text("price_id").notNull(),
    buyerId: text("buyer_id").notNull(),
    stripeCheckoutSessionId: text("stripe_checkout_session_id"),
    providerTerminalAtMs: integer("provider_terminal_at_ms"),
    preSessionFailedAtMs: integer("pre_session_failed_at_ms"),
    status: text("status").notNull(),
    expiresAtMs: integer("expires_at_ms").notNull(),
    returnedAtMs: integer("returned_at_ms"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
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

export const commerceCheckoutRateLimits = sqliteTable(
  "commerce_checkout_rate_limits",
  {
    buyerId: text("buyer_id").notNull(),
    offeringId: text("offering_id").notNull(),
    windowStartedAtMs: integer("window_started_at_ms").notNull(),
    attemptCount: integer("attempt_count").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [primaryKey({ columns: [table.buyerId, table.offeringId] })],
);

export const commerceSupportConfigs = sqliteTable(
  "commerce_support_configs",
  {
    connectedAccountId: text("connected_account_id").primaryKey().notNull(),
    guildId: text("guild_id").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    explanation: text("explanation").notNull(),
    currency: text("currency").notNull(),
    suggestedAmountsJson: text("suggested_amounts_json").notNull(),
    supportContact: text("support_contact").notNull(),
    termsVersion: text("terms_version").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_support_configs_guild").on(table.guildId),
    index("commerce_support_configs_enabled").on(table.enabled, table.updatedAtMs),
  ],
);

export const commerceSupportCheckoutAttempts = sqliteTable(
  "commerce_support_checkout_attempts",
  {
    id: text("id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    guildId: text("guild_id").notNull(),
    buyerId: text("buyer_id").notNull(),
    currency: text("currency").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    applicationFeeMinor: integer("application_fee_minor").notNull(),
    stripeCheckoutSessionId: text("stripe_checkout_session_id"),
    status: text("status").notNull(),
    expiresAtMs: integer("expires_at_ms").notNull(),
    returnedAtMs: integer("returned_at_ms"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
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

export const commerceSupportRateLimits = sqliteTable(
  "commerce_support_rate_limits",
  {
    buyerId: text("buyer_id").notNull(),
    guildId: text("guild_id").notNull(),
    windowStartedAtMs: integer("window_started_at_ms").notNull(),
    attemptCount: integer("attempt_count").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [primaryKey({ columns: [table.buyerId, table.guildId] })],
);

export const commerceSupportPayments = sqliteTable(
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
    amountMinor: integer("amount_minor").notNull(),
    amountReceivedMinor: integer("amount_received_minor").notNull().default(0),
    amountRefundedMinor: integer("amount_refunded_minor").notNull().default(0),
    applicationFeeMinor: integer("application_fee_minor").notNull(),
    stripeFeeMinor: integer("stripe_fee_minor"),
    stripeFeeTaxMinor: integer("stripe_fee_tax_minor"),
    status: text("status").notNull(),
    providerCreatedAtMs: integer("provider_created_at_ms"),
    paidAtMs: integer("paid_at_ms"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
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

export const commerceSupportRefunds = sqliteTable(
  "commerce_support_refunds",
  {
    id: text("id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    supportPaymentId: text("support_payment_id").notNull(),
    stripeRefundId: text("stripe_refund_id").notNull(),
    currency: text("currency").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    applicationFeeRefundedMinor: integer("application_fee_refunded_minor"),
    status: text("status").notNull(),
    reason: text("reason"),
    providerCreatedAtMs: integer("provider_created_at_ms"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_support_refunds_provider").on(
      table.connectedAccountId,
      table.stripeRefundId,
    ),
    index("commerce_support_refunds_payment_time").on(table.supportPaymentId, table.createdAtMs),
  ],
);

export const commerceSubscriptions = sqliteTable(
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
    cancelAtPeriodEnd: integer("cancel_at_period_end", { mode: "boolean" })
      .notNull()
      .default(false),
    currentPeriodStartMs: integer("current_period_start_ms"),
    currentPeriodEndMs: integer("current_period_end_ms"),
    canceledAtMs: integer("canceled_at_ms"),
    endedAtMs: integer("ended_at_ms"),
    providerUpdatedAtMs: integer("provider_updated_at_ms"),
    latestInvoiceId: text("latest_invoice_id"),
    latestInvoiceStatus: text("latest_invoice_status"),
    latestPaymentIntentId: text("latest_payment_intent_id"),
    latestPaymentStatus: text("latest_payment_status"),
    graceStartedAtMs: integer("grace_started_at_ms"),
    graceEndsAtMs: integer("grace_ends_at_ms"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
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

export const commerceEntitlements = sqliteTable(
  "commerce_entitlements",
  {
    id: text("id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    buyerId: text("buyer_id").notNull(),
    offeringId: text("offering_id").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    status: text("status").notNull(),
    effectiveAtMs: integer("effective_at_ms").notNull(),
    expiresAtMs: integer("expires_at_ms"),
    revokedAtMs: integer("revoked_at_ms"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
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

export const commerceRoleAssignments = sqliteTable(
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
    attemptCount: integer("attempt_count").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    nextAttemptAtMs: integer("next_attempt_at_ms"),
    assignedAtMs: integer("assigned_at_ms"),
    removedAtMs: integer("removed_at_ms"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_role_assignments_entitlement").on(table.entitlementId),
    index("commerce_role_assignments_due").on(table.status, table.nextAttemptAtMs),
    index("commerce_role_assignments_member").on(table.guildId, table.discordUserId),
  ],
);

export const commercePayments = sqliteTable(
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
    billingPeriodStartMs: integer("invoice_period_start_ms"),
    billingPeriodEndMs: integer("invoice_period_end_ms"),
    isLatestSubscriptionInvoice: integer("is_latest_subscription_invoice", { mode: "boolean" })
      .notNull()
      .default(false),
    currency: text("currency").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    amountReceivedMinor: integer("amount_received_minor").notNull().default(0),
    amountRefundedMinor: integer("amount_refunded_minor").notNull().default(0),
    applicationFeeMinor: integer("application_fee_minor"),
    stripeFeeMinor: integer("stripe_fee_minor"),
    stripeFeeTaxMinor: integer("stripe_fee_tax_minor"),
    status: text("status").notNull(),
    providerCreatedAtMs: integer("provider_created_at_ms"),
    paidAtMs: integer("paid_at_ms"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
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

export const commerceRefunds = sqliteTable(
  "commerce_refunds",
  {
    id: text("id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    paymentId: text("payment_id").notNull(),
    stripeRefundId: text("stripe_refund_id").notNull(),
    currency: text("currency").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    applicationFeeRefundedMinor: integer("application_fee_refunded_minor"),
    status: text("status").notNull(),
    reason: text("reason"),
    providerCreatedAtMs: integer("provider_created_at_ms"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_refunds_provider").on(table.connectedAccountId, table.stripeRefundId),
    index("commerce_refunds_payment").on(table.paymentId, table.createdAtMs),
  ],
);

export const commerceDisputes = sqliteTable(
  "commerce_disputes",
  {
    id: text("id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    paymentId: text("payment_id").notNull(),
    stripeDisputeId: text("stripe_dispute_id").notNull(),
    currency: text("currency").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    status: text("status").notNull(),
    reason: text("reason"),
    providerCreatedAtMs: integer("provider_created_at_ms"),
    closedAtMs: integer("closed_at_ms"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_disputes_provider").on(table.connectedAccountId, table.stripeDisputeId),
    index("commerce_disputes_payment").on(table.paymentId, table.createdAtMs),
  ],
);

export const commerceWebhookEvents = sqliteTable(
  "commerce_webhook_events",
  {
    id: text("id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    stripeEventId: text("stripe_event_id").notNull(),
    eventType: text("event_type").notNull(),
    objectId: text("object_id"),
    payloadHash: text("payload_hash"),
    generation: integer("generation").notNull().default(0),
    apiVersion: text("api_version"),
    providerCreatedAtMs: integer("provider_created_at_ms").notNull(),
    receivedAtMs: integer("received_at_ms").notNull(),
    status: text("status").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    processedAtMs: integer("processed_at_ms"),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_webhook_events_provider").on(
      table.connectedAccountId,
      table.stripeEventId,
    ),
    index("commerce_webhook_events_pending").on(table.status, table.receivedAtMs),
  ],
);

export const commerceSyncState = sqliteTable(
  "commerce_sync_state",
  {
    id: text("id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    status: text("status").notNull(),
    providerUpdatedAtMs: integer("provider_updated_at_ms"),
    providerEventId: text("provider_event_id"),
    lastSyncedAtMs: integer("last_synced_at_ms"),
    lastErrorCode: text("last_error_code"),
    generation: integer("generation").notNull().default(0),
    appliedGeneration: integer("applied_generation").notNull().default(0),
    leaseToken: text("lease_token"),
    leaseExpiresAtMs: integer("lease_expires_at_ms"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
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

export const commerceSyncOutbox = sqliteTable(
  "commerce_sync_outbox",
  {
    id: text("id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    eventId: text("event_id").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    generation: integer("generation").notNull(),
    sentAtMs: integer("sent_at_ms"),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_sync_outbox_event").on(table.connectedAccountId, table.eventId),
    index("commerce_sync_outbox_pending").on(table.sentAtMs, table.createdAtMs),
  ],
);

export const commerceOperationsLedger = sqliteTable(
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
    createdAtMs: integer("created_at_ms").notNull(),
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

export const commerceReportingLedger = sqliteTable(
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
    grossAmountMinor: integer("gross_amount_minor").notNull(),
    applicationFeeMinor: integer("application_fee_minor"),
    stripeFeeMinor: integer("stripe_fee_minor"),
    stripeFeeTaxMinor: integer("stripe_fee_tax_minor"),
    occurredAtMs: integer("occurred_at_ms").notNull(),
    reportingPeriod: text("reporting_period").notNull(),
    correctionOfTransactionType: text("correction_of_transaction_type"),
    correctionOfSourceRecordId: text("correction_of_source_record_id"),
    audAmountMinor: integer("aud_amount_minor"),
    audConversionRate: text("aud_conversion_rate"),
    audConversionSource: text("aud_conversion_source"),
    audConversionAtMs: integer("aud_conversion_at_ms"),
    recordedAtMs: integer("recorded_at_ms").notNull(),
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

export const commerceDeliveryOutbox = sqliteTable(
  "commerce_delivery_outbox",
  {
    id: text("id").primaryKey().notNull(),
    operationId: text("operation_id").notNull(),
    destinationType: text("destination_type").notNull(),
    destinationId: text("destination_id").notNull(),
    payloadJson: text("payload_json").notNull(),
    status: text("status").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    availableAtMs: integer("available_at_ms").notNull(),
    lastErrorCode: text("last_error_code"),
    deliveredAtMs: integer("delivered_at_ms"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
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

export const commerceIncidents = sqliteTable(
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
    occurrenceCount: integer("occurrence_count").notNull().default(1),
    firstSeenAtMs: integer("first_seen_at_ms").notNull(),
    lastSeenAtMs: integer("last_seen_at_ms").notNull(),
    resolvedAtMs: integer("resolved_at_ms"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
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

export const commerceFinancialActions = sqliteTable(
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
    amountMinor: integer("amount_minor"),
    currency: text("currency"),
    status: text("status").notNull(),
    providerResultId: text("provider_result_id"),
    accessAction: text("access_action"),
    attemptCount: integer("attempt_count").notNull().default(1),
    lastErrorCode: text("last_error_code"),
    leaseToken: text("lease_token"),
    claimedAtMs: integer("claimed_at_ms"),
    leaseExpiresAtMs: integer("lease_expires_at_ms"),
    availableAtMs: integer("available_at_ms").notNull().default(0),
    providerCompletedAtMs: integer("provider_completed_at_ms"),
    reconciliationRequestedAtMs: integer("reconciliation_requested_at_ms"),
    quarantinedAtMs: integer("quarantined_at_ms"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
    completedAtMs: integer("completed_at_ms"),
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

export const commerceFinancialProviderActions = sqliteTable(
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
    attemptCount: integer("attempt_count").notNull().default(0),
    availableAtMs: integer("available_at_ms").notNull(),
    leaseToken: text("lease_token"),
    claimedAtMs: integer("claimed_at_ms"),
    leaseExpiresAtMs: integer("lease_expires_at_ms"),
    providerCompletedAtMs: integer("provider_completed_at_ms"),
    reconciliationRequestedAtMs: integer("reconciliation_requested_at_ms"),
    completedAtMs: integer("completed_at_ms"),
    lastErrorCode: text("last_error_code"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
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

export const commerceOfferingRetirements = sqliteTable(
  "commerce_offering_retirements",
  {
    id: text("id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    guildId: text("guild_id").notNull(),
    offeringId: text("offering_id").notNull(),
    requestedByUserId: text("requested_by_user_id").notNull(),
    reasonCode: text("reason_code").notNull(),
    status: text("status").notNull(),
    activeSubscriptionCount: integer("active_subscription_count").notNull().default(0),
    scheduledCancellationCount: integer("scheduled_cancellation_count").notNull().default(0),
    failedCancellationCount: integer("failed_cancellation_count").notNull().default(0),
    latestPeriodEndMs: integer("latest_period_end_ms"),
    lastErrorCode: text("last_error_code"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
    completedAtMs: integer("completed_at_ms"),
  },
  (table) => [
    uniqueIndex("commerce_offering_retirements_offering").on(table.offeringId),
    index("commerce_offering_retirements_status").on(table.status, table.updatedAtMs),
  ],
);

export const commerceSellerOffboarding = sqliteTable(
  "commerce_seller_offboarding",
  {
    connectedAccountId: text("connected_account_id").primaryKey().notNull(),
    guildId: text("guild_id").notNull(),
    status: text("status").notNull(),
    reasonCode: text("reason_code").notNull(),
    actorUserId: text("actor_user_id"),
    activeSubscriptionCount: integer("active_subscription_count").notNull().default(0),
    latestPaidThroughAtMs: integer("latest_paid_through_at_ms"),
    startedAtMs: integer("started_at_ms").notNull(),
    completedAtMs: integer("completed_at_ms"),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [uniqueIndex("commerce_seller_offboarding_guild").on(table.guildId)],
);

export const commerceSupportDisputes = sqliteTable(
  "commerce_support_disputes",
  {
    id: text("id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    supportPaymentId: text("support_payment_id").notNull(),
    stripeDisputeId: text("stripe_dispute_id").notNull(),
    currency: text("currency").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    status: text("status").notNull(),
    reason: text("reason"),
    providerCreatedAtMs: integer("provider_created_at_ms"),
    closedAtMs: integer("closed_at_ms"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_support_disputes_provider").on(
      table.connectedAccountId,
      table.stripeDisputeId,
    ),
    index("commerce_support_disputes_payment_time").on(table.supportPaymentId, table.createdAtMs),
  ],
);

export const commerceOperationalControls = sqliteTable(
  "commerce_operational_controls",
  {
    id: text("id").primaryKey().notNull(),
    scopeType: text("scope_type").notNull(),
    scopeId: text("scope_id").notNull(),
    controlType: text("control_type").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    reasonCode: text("reason_code"),
    actorUserId: text("actor_user_id").notNull(),
    expiresAtMs: integer("expires_at_ms"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
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

export const commerceCheckoutCapacityClaims = sqliteTable(
  "commerce_checkout_capacity_claims",
  {
    id: text("id").primaryKey().notNull(),
    checkoutKind: text("checkout_kind").notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    guildId: text("guild_id").notNull(),
    offeringId: text("offering_id"),
    currency: text("currency").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    monthStartedAtMs: integer("month_started_at_ms").notNull(),
    expiresAtMs: integer("expires_at_ms").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
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

export const commerceLimitAlerts = sqliteTable(
  "commerce_limit_alerts",
  {
    id: text("id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    guildId: text("guild_id").notNull(),
    metric: text("metric").notNull(),
    currency: text("currency"),
    thresholdPercent: integer("threshold_percent").notNull(),
    observedValue: integer("observed_value").notNull(),
    limitValue: integer("limit_value").notNull(),
    status: text("status").notNull(),
    firstSeenAtMs: integer("first_seen_at_ms").notNull(),
    lastSeenAtMs: integer("last_seen_at_ms").notNull(),
    resolvedAtMs: integer("resolved_at_ms"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [
    index("commerce_limit_alerts_open").on(table.guildId, table.status, table.updatedAtMs),
  ],
);

export const commercePaidRoleStates = sqliteTable(
  "commerce_paid_role_states",
  {
    entitlementId: text("entitlement_id").primaryKey().notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    guildId: text("guild_id").notNull(),
    discordUserId: text("discord_user_id").notNull(),
    discordRoleId: text("discord_role_id").notNull(),
    subscriptionId: text("subscription_id"),
    subscriptionStatus: text("subscription_status").notNull(),
    cancelAtPeriodEnd: integer("cancel_at_period_end", { mode: "boolean" })
      .notNull()
      .default(false),
    currentPeriodEndMs: integer("current_period_end_ms"),
    paymentStatus: text("payment_status"),
    amountMinor: integer("amount_minor"),
    amountRefundedMinor: integer("amount_refunded_minor").notNull().default(0),
    disputeStatus: text("dispute_status"),
    failedPaymentAtMs: integer("failed_payment_at_ms"),
    adminAction: text("admin_action"),
    memberState: text("member_state").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [index("commerce_paid_role_states_guild_role").on(table.guildId, table.discordRoleId)],
);

export const commercePaidRoleOperations = sqliteTable(
  "commerce_paid_role_operations",
  {
    operationKey: text("operation_key").primaryKey().notNull(),
    entitlementId: text("entitlement_id").notNull(),
    operationType: text("operation_type").notNull(),
    status: text("status").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    claimedAtMs: integer("claimed_at_ms").notNull(),
    leaseExpiresAtMs: integer("lease_expires_at_ms").notNull(),
    committedAtMs: integer("committed_at_ms"),
  },
  (table) => [
    index("commerce_paid_role_operations_entitlement").on(table.entitlementId, table.createdAtMs),
  ],
);

export const commercePaidRoleOutbox = sqliteTable(
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
    availableAtMs: integer("available_at_ms").notNull(),
    sentAtMs: integer("sent_at_ms"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_paid_role_outbox_operation").on(table.operationKey),
    index("commerce_paid_role_outbox_due").on(table.status, table.availableAtMs, table.createdAtMs),
  ],
);

export const commercePaidRoleRepairs = sqliteTable(
  "commerce_paid_role_repairs",
  {
    id: text("id").primaryKey().notNull(),
    offeringId: text("offering_id"),
    guildId: text("guild_id").notNull(),
    oldRoleId: text("old_role_id").notNull(),
    replacementRoleId: text("replacement_role_id"),
    startedAtMs: integer("started_at_ms").notNull(),
    deadlineAtMs: integer("deadline_at_ms").notNull(),
    status: text("status").notNull(),
    repairedCount: integer("repaired_count").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [index("commerce_paid_role_repairs_due").on(table.status, table.deadlineAtMs)],
);

export const commercePaidRoleProviderActions = sqliteTable(
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
    attemptCount: integer("attempt_count").notNull().default(0),
    availableAtMs: integer("available_at_ms").notNull(),
    claimedAtMs: integer("claimed_at_ms"),
    leaseExpiresAtMs: integer("lease_expires_at_ms"),
    completedAtMs: integer("completed_at_ms"),
    lastErrorCode: text("last_error_code"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
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

export const commerceGuildDeletionRefundReviews = sqliteTable(
  "commerce_guild_deletion_refund_reviews",
  {
    id: text("id").primaryKey().notNull(),
    guildId: text("guild_id").notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    subscriptionId: text("subscription_id").notNull(),
    buyerId: text("buyer_id").notNull(),
    paymentId: text("payment_id"),
    paymentPaidAtMs: integer("payment_paid_at_ms"),
    paidThroughAtMs: integer("paid_through_at_ms"),
    status: text("status").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("commerce_guild_deletion_refund_reviews_subscription").on(
      table.connectedAccountId,
      table.subscriptionId,
    ),
    index("commerce_guild_deletion_refund_reviews_pending").on(table.status, table.createdAtMs),
  ],
);
