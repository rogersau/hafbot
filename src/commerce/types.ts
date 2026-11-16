export type CommerceCurrency = "AUD" | "USD";
export type CommercePurchaseType = "subscription" | "one_time";
export type CommerceRecurringInterval = "month" | "year";
export type CommerceConnectedAccountStatus =
  | "pending"
  | "active"
  | "restricted"
  | "disconnected"
  | "archived";
export type CommerceOfferingLifecycle =
  | "draft"
  | "published"
  | "unpublished"
  | "repair_required"
  | "retiring"
  | "archived"
  | "suspended";
export type CommercePriceStatus = "active" | "retired";
export type CommerceSubscriptionStatus =
  | "incomplete"
  | "trialing"
  | "active"
  | "past_due"
  | "paused"
  | "unpaid"
  | "canceled"
  | "ended";
export type CommerceEntitlementStatus = "pending" | "active" | "revoked" | "expired";
export type CommerceRoleAssignmentStatus =
  | "pending"
  | "assigned"
  | "removing"
  | "removed"
  | "failed";
export type CommercePaymentStatus =
  | "requires_action"
  | "processing"
  | "succeeded"
  | "failed"
  | "canceled";
export type CommerceWebhookStatus = "pending" | "processing" | "processed" | "failed" | "ignored";
export type CommerceSellerLifecycleState =
  | "onboarding_incomplete"
  | "pending_review"
  | "active"
  | "restricted"
  | "repair_required"
  | "offboarding"
  | "disconnected"
  | "suspended";
export type CommerceSellerApprovalState = "pending" | "approved" | "rejected";
export type CommerceCapability =
  | "commerce.read"
  | "commerce.offerings.manage"
  | "commerce.subscribers.manage"
  | "commerce.finance.refund"
  | "commerce.finance.cancel"
  | "commerce.seller.manage"
  | "commerce.risk.manage";
export type CommerceSellerEligibilityAction = "connect" | "publish" | "resume" | "purchase";
export type CommerceSellerEligibilityReason =
  | "commerce_globally_suspended"
  | "commerce_guild_suspended"
  | "premium_required"
  | "owner_authorization_required"
  | "adult_attestation_required"
  | "two_factor_evidence_required"
  | "recent_ownership_transfer"
  | "guild_not_in_good_standing"
  | "seller_not_in_good_standing"
  | "support_contact_required"
  | "current_terms_required"
  | "hafbot_approval_required"
  | "stripe_onboarding_incomplete"
  | "stripe_charges_unavailable"
  | "stripe_payouts_unavailable";

export interface CommerceConnectedAccount {
  id: string;
  guildId: string;
  stripeAccountId: string;
  status: CommerceConnectedAccountStatus;
  country: string | null;
  defaultCurrency: CommerceCurrency | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  providerCreatedAtMs: number | null;
  archivedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CommerceSellerAcceptance {
  id: string;
  connectedAccountId: string;
  termsVersion: string;
  acceptedByUserId: string;
  acceptedAtMs: number;
  createdAtMs: number;
}

export interface CommerceSellerProfile {
  connectedAccountId: string;
  guildId: string;
  sellerOwnerUserId: string;
  lifecycleState: CommerceSellerLifecycleState;
  approvalState: CommerceSellerApprovalState;
  supportContact: string;
  adultAttestedAtMs: number;
  twoFactorEvidence: "discord_verified" | "seller_attested";
  guildCreatedAtMs: number;
  ownershipTransferredAtMs: number | null;
  guildGoodStanding: boolean;
  sellerGoodStanding: boolean;
  requirementsCurrentlyDueJson: string;
  requirementsEventuallyDueJson: string;
  requirementsPendingVerificationJson: string;
  disabledReason: string | null;
  reviewedByUserId: string | null;
  reviewedAtMs: number | null;
  capabilitiesUpdatedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export type CommerceSellerReviewState = "pending" | "processing" | "approved" | "rejected";

export interface CommerceSellerReviewRequest {
  id: string;
  connectedAccountId: string;
  guildId: string;
  sellerOwnerUserId: string;
  guildCreatedAtMs: number | null;
  state: CommerceSellerReviewState;
  stripeDetailsSubmitted: boolean;
  stripeChargesEnabled: boolean;
  stripePayoutsEnabled: boolean;
  reviewChannelId: string | null;
  reviewMessageId: string | null;
  notificationLeaseToken: string | null;
  notificationLeaseExpiresAtMs: number | null;
  decisionActorUserId: string | null;
  decisionState: Exclude<CommerceSellerReviewState, "pending" | "processing"> | null;
  decisionReason: string | null;
  decidedAtMs: number | null;
  decisionNotifiedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CommerceAuthorityGrant {
  connectedAccountId: string;
  discordUserId: string;
  capability: CommerceCapability;
  grantedByUserId: string;
  grantedAtMs: number;
  revokedAtMs: number | null;
}

export interface CommerceSellerControl {
  id: string;
  scopeType: "global" | "guild";
  scopeId: string;
  suspended: boolean;
  reasonCode: string | null;
  actorUserId: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CommerceSalesPanel {
  connectedAccountId: string;
  guildId: string;
  channelId: string;
  title: string;
  description: string;
  messageId: string | null;
  lastErrorCode: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CommerceSellerEligibility {
  action: CommerceSellerEligibilityAction;
  eligible: boolean;
  purchaseAvailable: boolean;
  reasons: CommerceSellerEligibilityReason[];
}

export interface CommerceOffering {
  id: string;
  connectedAccountId: string;
  guildId: string;
  discordRoleId: string;
  name: string;
  description: string | null;
  purchaseType: CommercePurchaseType;
  state: CommerceOfferingLifecycle;
  termsVersion: string | null;
  includedBenefits: string[];
  supportContact: string | null;
  roleManageable: boolean;
  repairDeadlineAtMs: number | null;
  repairPreviousState: CommerceOfferingLifecycle | null;
  retireAtMs: number | null;
  publishedAtMs: number | null;
  archivedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CommercePrice {
  id: string;
  connectedAccountId: string;
  offeringId: string;
  stripeProductId: string;
  stripePriceId: string;
  currency: CommerceCurrency;
  unitAmountMinor: number;
  priceType: "recurring" | "one_time";
  recurringInterval: CommerceRecurringInterval | null;
  status: CommercePriceStatus;
  providerCreatedAtMs: number | null;
  retiredAtMs: number | null;
  createdAtMs: number;
}

export interface CommerceBuyer {
  id: string;
  discordUserId: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CommerceCustomer {
  id: string;
  connectedAccountId: string;
  buyerId: string;
  stripeCustomerId: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CommerceSubscription {
  checkoutAttemptId?: string | null;
  id: string;
  connectedAccountId: string;
  customerId: string;
  buyerId: string;
  offeringId: string;
  priceId: string;
  stripeSubscriptionId: string;
  status: CommerceSubscriptionStatus;
  cancelAtPeriodEnd: boolean;
  currentPeriodStartMs: number | null;
  currentPeriodEndMs: number | null;
  canceledAtMs: number | null;
  endedAtMs: number | null;
  providerUpdatedAtMs: number | null;
  latestInvoiceId: string | null;
  latestInvoiceStatus: "draft" | "open" | "paid" | "uncollectible" | "void" | null;
  latestPaymentIntentId: string | null;
  latestPaymentStatus: CommercePaymentStatus | null;
  graceStartedAtMs: number | null;
  graceEndsAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CommerceEntitlement {
  id: string;
  connectedAccountId: string;
  buyerId: string;
  offeringId: string;
  sourceType: "subscription" | "payment";
  sourceId: string;
  status: CommerceEntitlementStatus;
  effectiveAtMs: number;
  expiresAtMs: number | null;
  revokedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CommerceRoleAssignment {
  id: string;
  entitlementId: string;
  guildId: string;
  discordUserId: string;
  discordRoleId: string;
  status: CommerceRoleAssignmentStatus;
  attemptCount: number;
  lastErrorCode: string | null;
  nextAttemptAtMs: number | null;
  assignedAtMs: number | null;
  removedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CommercePayment {
  id: string;
  connectedAccountId: string;
  customerId: string;
  buyerId: string;
  offeringId: string;
  priceId: string;
  stripePaymentIntentId: string;
  stripeChargeId: string | null;
  stripeCheckoutSessionId: string | null;
  stripeInvoiceId: string | null;
  stripeSubscriptionId: string | null;
  billingPeriodStartMs: number | null;
  billingPeriodEndMs: number | null;
  isLatestSubscriptionInvoice: boolean;
  currency: CommerceCurrency;
  amountMinor: number;
  amountReceivedMinor: number;
  amountRefundedMinor: number;
  applicationFeeMinor: number | null;
  stripeFeeMinor: number | null;
  stripeFeeTaxMinor: number | null;
  status: CommercePaymentStatus;
  providerCreatedAtMs: number | null;
  paidAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CommerceRefund {
  id: string;
  connectedAccountId: string;
  paymentId: string;
  stripeRefundId: string;
  currency: CommerceCurrency;
  amountMinor: number;
  applicationFeeRefundedMinor: number | null;
  status: "pending" | "succeeded" | "failed" | "canceled";
  reason: string | null;
  providerCreatedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CommerceDispute {
  id: string;
  connectedAccountId: string;
  paymentId: string;
  stripeDisputeId: string;
  currency: CommerceCurrency;
  amountMinor: number;
  status:
    | "warning_needs_response"
    | "warning_under_review"
    | "warning_closed"
    | "needs_response"
    | "under_review"
    | "won"
    | "lost";
  reason: string | null;
  providerCreatedAtMs: number | null;
  closedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CommerceWebhookEvent {
  id: string;
  connectedAccountId: string;
  stripeEventId: string;
  eventType: string;
  objectId: string | null;
  payloadHash: string | null;
  generation: number;
  apiVersion: string | null;
  providerCreatedAtMs: number;
  receivedAtMs: number;
  status: CommerceWebhookStatus;
  attemptCount: number;
  lastErrorCode: string | null;
  processedAtMs: number | null;
  updatedAtMs: number;
}

export interface CommerceSyncState {
  id: string;
  connectedAccountId: string;
  resourceType: string;
  resourceId: string;
  status: "pending" | "synced" | "failed" | "quarantined";
  providerUpdatedAtMs: number | null;
  providerEventId: string | null;
  lastSyncedAtMs: number | null;
  lastErrorCode: string | null;
  generation: number;
  appliedGeneration: number;
  leaseToken: string | null;
  leaseExpiresAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CommerceSyncOutboxRecord {
  id: string;
  connectedAccountId: string;
  eventId: string;
  resourceType: string;
  resourceId: string;
  generation: number;
  sentAtMs: number | null;
  createdAtMs: number;
}

export interface CommerceOperation {
  id: string;
  connectedAccountId: string | null;
  guildId: string;
  operationKey: string;
  operationType: string;
  entityType: string;
  entityId: string;
  actorType: "system" | "stripe" | "buyer" | "seller" | "operator";
  actorId: string | null;
  payloadJson: string;
  createdAtMs: number;
}

export interface CommerceDelivery {
  id: string;
  operationId: string;
  destinationType: "buyer_dm" | "seller_audit" | "admin_audit";
  destinationId: string;
  payloadJson: string;
  status: "pending" | "processing" | "delivered" | "dead_letter";
  attemptCount: number;
  availableAtMs: number;
  lastErrorCode: string | null;
  deliveredAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CommerceIncident {
  id: string;
  connectedAccountId: string | null;
  guildId: string;
  incidentKey: string;
  severity: "warning" | "error" | "critical";
  status: "open" | "resolved";
  summaryCode: string;
  entityType: string | null;
  entityId: string | null;
  safeArgsJson: string;
  occurrenceCount: number;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  resolvedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}
