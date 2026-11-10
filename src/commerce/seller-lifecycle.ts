import type {
  CommerceConnectedAccount,
  CommerceSellerControl,
  CommerceSellerEligibility,
  CommerceSellerEligibilityAction,
  CommerceSellerEligibilityReason,
  CommerceSellerLifecycleState,
  CommerceSellerProfile,
} from "./types";
import type { CommerceStore } from "./store";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;

export interface CommerceSellerEligibilityInput {
  action: CommerceSellerEligibilityAction;
  nowMs: number;
  premiumActive: boolean;
  ownerAuthorized: boolean;
  adultAttestedAtMs: number | null;
  twoFactorEvidence: "discord_verified" | "seller_attested" | null;
  guildCreatedAtMs: number;
  ownershipTransferredAtMs: number | null;
  guildGoodStanding: boolean;
  sellerGoodStanding: boolean;
  supportContact: string;
  currentTermsAccepted: boolean;
  approvalState: "pending" | "approved" | "rejected";
  stripeDetailsSubmitted: boolean;
  stripeChargesEnabled: boolean;
  stripePayoutsEnabled: boolean;
  globallySuspended: boolean;
  guildSuspended: boolean;
}

export interface StripeConnectedAccountProjection {
  id: string;
  country: string;
  defaultCurrency: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  disabledReason: string | null;
  currentlyDue: string[];
  eventuallyDue: string[];
  pendingVerification: string[];
  providerCreatedAtMs: number | null;
}

export interface CommerceSellerAccountProvider {
  createConnectedAccount(input: {
    guildId: string;
    sellerUserId: string;
    idempotencyKey: string;
    sellerEmail?: string;
    businessProfileUrl?: string;
  }): Promise<StripeConnectedAccountProjection>;
  createOnboardingLink(input: {
    connectedAccountId: string;
    refreshUrl: string;
    returnUrl: string;
    idempotencyKey: string;
  }): Promise<{ url: string }>;
  readConnectedAccount(connectedAccountId: string): Promise<StripeConnectedAccountProjection>;
}

export interface CommercePremiumReader {
  isPremium(guildId: string): Promise<boolean>;
}

export interface BeginSellerOnboardingInput {
  guildId: string;
  sellerUserId: string;
  ownerAuthorized: boolean;
  supportContact: string;
  adultAttestedAtMs: number | null;
  twoFactorEvidence: "discord_verified" | "seller_attested" | null;
  guildCreatedAtMs: number;
  ownershipTransferredAtMs: number | null;
  guildGoodStanding: boolean;
  sellerGoodStanding: boolean;
  termsVersion: string;
  termsAccepted: boolean;
  refreshUrl: string;
  returnUrl: string;
  attemptId: string;
  sellerEmail?: string;
  businessProfileUrl?: string;
}

export function evaluateCommerceSellerEligibility(
  input: CommerceSellerEligibilityInput,
): CommerceSellerEligibility {
  const baseReasons: CommerceSellerEligibilityReason[] = [];
  if (input.globallySuspended) baseReasons.push("commerce_globally_suspended");
  if (input.guildSuspended) baseReasons.push("commerce_guild_suspended");
  if (!input.premiumActive) baseReasons.push("premium_required");
  if (!input.ownerAuthorized) baseReasons.push("owner_authorization_required");
  if (input.adultAttestedAtMs === null) baseReasons.push("adult_attestation_required");
  if (input.twoFactorEvidence === null) baseReasons.push("two_factor_evidence_required");
  if (
    input.ownershipTransferredAtMs !== null &&
    input.nowMs - input.ownershipTransferredAtMs < THIRTY_DAYS_MS
  ) {
    baseReasons.push("recent_ownership_transfer");
  }
  if (!input.guildGoodStanding) baseReasons.push("guild_not_in_good_standing");
  if (!input.sellerGoodStanding) baseReasons.push("seller_not_in_good_standing");
  if (!isValidSupportContact(input.supportContact)) baseReasons.push("support_contact_required");
  if (!input.currentTermsAccepted) baseReasons.push("current_terms_required");

  const publishReasons = [...baseReasons];
  if (input.approvalState !== "approved") publishReasons.push("hafbot_approval_required");
  if (!input.stripeDetailsSubmitted) publishReasons.push("stripe_onboarding_incomplete");
  if (!input.stripeChargesEnabled) publishReasons.push("stripe_charges_unavailable");
  if (!input.stripePayoutsEnabled) publishReasons.push("stripe_payouts_unavailable");

  const reasons = input.action === "connect" ? baseReasons : publishReasons;
  return {
    action: input.action,
    eligible: reasons.length === 0,
    purchaseAvailable: publishReasons.length === 0,
    reasons,
  };
}

export function deriveCommerceSellerLifecycle(input: {
  account: Pick<
    CommerceConnectedAccount,
    "status" | "detailsSubmitted" | "chargesEnabled" | "payoutsEnabled"
  >;
  approvalState: CommerceSellerProfile["approvalState"];
  disabledReason: string | null;
  suspended: boolean;
}): CommerceSellerLifecycleState {
  if (input.suspended) return "suspended";
  if (input.account.status === "disconnected" || input.account.status === "archived") {
    return "disconnected";
  }
  if (!input.account.detailsSubmitted) return "onboarding_incomplete";
  if (input.disabledReason || !input.account.chargesEnabled) return "restricted";
  if (!input.account.payoutsEnabled) return "repair_required";
  if (input.approvalState !== "approved") return "pending_review";
  return "active";
}

export class CommerceSellerLifecycleService {
  constructor(
    private readonly store: CommerceStore,
    private readonly premium: CommercePremiumReader,
    private readonly provider: CommerceSellerAccountProvider,
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {}

  async beginOnboarding(
    input: BeginSellerOnboardingInput,
  ): Promise<{ account: CommerceConnectedAccount; onboardingUrl: string }> {
    const nowMs = this.now();
    const existing = await this.store.readConnectedAccountByGuild(input.guildId);
    if (existing) {
      const profile = await this.requireProfile(existing.id);
      if (profile.sellerOwnerUserId !== input.sellerUserId) {
        throw new Error("commerce_seller_owner_mismatch");
      }
      const link = await this.createOnboardingLink(existing, input);
      return { account: existing, onboardingUrl: link.url };
    }
    const eligibility = evaluateCommerceSellerEligibility({
      action: "connect",
      nowMs,
      premiumActive: await this.premium.isPremium(input.guildId),
      ownerAuthorized: input.ownerAuthorized,
      adultAttestedAtMs: input.adultAttestedAtMs,
      twoFactorEvidence: input.twoFactorEvidence,
      guildCreatedAtMs: input.guildCreatedAtMs,
      ownershipTransferredAtMs: input.ownershipTransferredAtMs,
      guildGoodStanding: input.guildGoodStanding,
      sellerGoodStanding: input.sellerGoodStanding,
      supportContact: input.supportContact,
      currentTermsAccepted: input.termsAccepted,
      approvalState: "pending",
      stripeDetailsSubmitted: false,
      stripeChargesEnabled: false,
      stripePayoutsEnabled: false,
      globallySuspended: await this.isSuspended("global", "commerce"),
      guildSuspended: await this.isSuspended("guild", input.guildId),
    });
    if (!eligibility.eligible) {
      throw new Error(`commerce_seller_ineligible:${eligibility.reasons.join(",")}`);
    }

    const projection = await this.provider.createConnectedAccount({
      guildId: input.guildId,
      sellerUserId: input.sellerUserId,
      idempotencyKey: `commerce-connect:${input.guildId}:${input.sellerUserId}`,
      ...(input.sellerEmail ? { sellerEmail: input.sellerEmail } : {}),
      ...(input.businessProfileUrl ? { businessProfileUrl: input.businessProfileUrl } : {}),
    });
    if (projection.country !== "AU") throw new Error("commerce_seller_country_unsupported");

    const account = projectionToAccount(projection, input.guildId, nowMs);
    const profile = projectionToProfile({
      projection,
      input,
      nowMs,
      approvalState: "pending",
      reviewedAtMs: null,
      reviewedByUserId: null,
      suspended: false,
    });
    await this.store.saveConnectedAccount(account);
    await this.store.saveSellerProfile(profile);
    await this.store.appendSellerAcceptance({
      id: this.createId(),
      connectedAccountId: account.id,
      termsVersion: input.termsVersion,
      acceptedByUserId: input.sellerUserId,
      acceptedAtMs: nowMs,
      createdAtMs: nowMs,
    });
    await this.audit({
      guildId: input.guildId,
      connectedAccountId: account.id,
      operationKey: `seller:${account.id}:connected`,
      operationType: "seller.connected",
      actorType: "seller",
      actorId: input.sellerUserId,
      payload: { lifecycleState: profile.lifecycleState },
      nowMs,
    });
    const link = await this.createOnboardingLink(account, input);
    return { account, onboardingUrl: link.url };
  }

  async evaluateOnboarding(input: {
    guildId: string;
    ownerAuthorized: boolean;
    supportContact: string;
    adultAttestedAtMs: number | null;
    twoFactorEvidence: "discord_verified" | "seller_attested" | null;
    guildCreatedAtMs: number;
    termsAccepted: boolean;
  }): Promise<CommerceSellerEligibility> {
    return evaluateCommerceSellerEligibility({
      action: "connect",
      nowMs: this.now(),
      premiumActive: await this.premium.isPremium(input.guildId),
      ownerAuthorized: input.ownerAuthorized,
      adultAttestedAtMs: input.adultAttestedAtMs,
      twoFactorEvidence: input.twoFactorEvidence,
      guildCreatedAtMs: input.guildCreatedAtMs,
      ownershipTransferredAtMs: null,
      guildGoodStanding: true,
      sellerGoodStanding: true,
      supportContact: input.supportContact,
      currentTermsAccepted: input.termsAccepted,
      approvalState: "pending",
      stripeDetailsSubmitted: false,
      stripeChargesEnabled: false,
      stripePayoutsEnabled: false,
      globallySuspended: await this.isSuspended("global", "commerce"),
      guildSuspended: await this.isSuspended("guild", input.guildId),
    });
  }

  async refreshAccount(guildId: string): Promise<CommerceSellerProfile> {
    const account = await this.requireAccount(guildId);
    const profile = await this.requireProfile(account.id);
    const projection = await this.provider.readConnectedAccount(account.stripeAccountId);
    if (projection.id !== account.stripeAccountId || projection.country !== "AU") {
      throw new Error("commerce_seller_account_scope_mismatch");
    }
    const nowMs = this.now();
    const nextAccount = projectionToAccount(projection, guildId, account.createdAtMs, account.id);
    nextAccount.updatedAtMs = nowMs;
    const suspended =
      (await this.isSuspended("global", "commerce")) || (await this.isSuspended("guild", guildId));
    const nextProfile: CommerceSellerProfile = {
      ...profile,
      lifecycleState: deriveCommerceSellerLifecycle({
        account: nextAccount,
        approvalState: profile.approvalState,
        disabledReason: projection.disabledReason,
        suspended,
      }),
      requirementsCurrentlyDueJson: JSON.stringify(projection.currentlyDue),
      requirementsEventuallyDueJson: JSON.stringify(projection.eventuallyDue),
      requirementsPendingVerificationJson: JSON.stringify(projection.pendingVerification),
      disabledReason: projection.disabledReason,
      capabilitiesUpdatedAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    await this.store.saveConnectedAccount(nextAccount);
    await this.store.saveSellerProfile(nextProfile);
    await this.audit({
      guildId,
      connectedAccountId: account.id,
      operationKey: `seller:${account.id}:state:${stateFingerprint(nextAccount, nextProfile)}`,
      operationType: "seller.capabilities_synchronized",
      actorType: "stripe",
      actorId: null,
      payload: {
        lifecycleState: nextProfile.lifecycleState,
        chargesEnabled: nextAccount.chargesEnabled,
        payoutsEnabled: nextAccount.payoutsEnabled,
        disabledReason: nextProfile.disabledReason,
      },
      nowMs,
    });
    return nextProfile;
  }

  async reviewSeller(input: {
    guildId: string;
    approvalState: "approved" | "rejected";
    actorUserId: string;
    reasonCode: string;
  }): Promise<CommerceSellerProfile> {
    const account = await this.requireAccount(input.guildId);
    const profile = await this.requireProfile(account.id);
    const nowMs = this.now();
    const suspended =
      (await this.isSuspended("global", "commerce")) ||
      (await this.isSuspended("guild", input.guildId));
    const next = {
      ...profile,
      approvalState: input.approvalState,
      reviewedByUserId: input.actorUserId,
      reviewedAtMs: nowMs,
      lifecycleState: deriveCommerceSellerLifecycle({
        account,
        approvalState: input.approvalState,
        disabledReason: profile.disabledReason,
        suspended,
      }),
      updatedAtMs: nowMs,
    } satisfies CommerceSellerProfile;
    await this.store.saveSellerProfile(next);
    await this.audit({
      guildId: input.guildId,
      connectedAccountId: account.id,
      operationKey: `seller:${account.id}:review:${input.approvalState}:${nowMs}:${this.createId()}`,
      operationType: `seller.${input.approvalState}`,
      actorType: "operator",
      actorId: input.actorUserId,
      payload: {
        approvalState: input.approvalState,
        lifecycleState: next.lifecycleState,
        reasonCode: input.reasonCode,
      },
      nowMs,
    });
    return next;
  }

  async setSuspension(input: {
    scopeType: CommerceSellerControl["scopeType"];
    scopeId: string;
    suspended: boolean;
    reasonCode: string | null;
    actorUserId: string;
  }): Promise<void> {
    if (input.scopeType === "global" && input.scopeId !== "commerce") {
      throw new Error("commerce_global_control_scope_invalid");
    }
    if (input.suspended && !input.reasonCode) {
      throw new Error("commerce_suspension_reason_required");
    }
    const nowMs = this.now();
    await this.store.saveSellerControl({
      id: this.createId(),
      ...input,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
    if (input.scopeType === "guild") {
      const account = await this.store.readConnectedAccountByGuild(input.scopeId);
      const profile = account ? await this.store.readSellerProfile(account.id) : null;
      if (account && profile) {
        await this.store.saveSellerProfile({
          ...profile,
          lifecycleState: deriveCommerceSellerLifecycle({
            account,
            approvalState: profile.approvalState,
            disabledReason: profile.disabledReason,
            suspended: input.suspended,
          }),
          updatedAtMs: nowMs,
        });
      }
    }
    await this.audit({
      guildId: input.scopeType === "guild" ? input.scopeId : "global",
      connectedAccountId: null,
      operationKey: `seller-control:${input.scopeType}:${input.scopeId}:${input.suspended}`,
      operationType: input.suspended ? "seller.suspended" : "seller.suspension_removed",
      actorType: "operator",
      actorId: input.actorUserId,
      payload: {
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        suspended: input.suspended,
        reasonCode: input.reasonCode,
      },
      nowMs,
    });
  }

  async evaluateAction(input: {
    guildId: string;
    action: CommerceSellerEligibilityAction;
    ownerAuthorized: boolean;
    currentTermsVersion: string;
  }): Promise<CommerceSellerEligibility> {
    const account = await this.requireAccount(input.guildId);
    const profile = await this.requireProfile(account.id);
    const acceptance = await this.store.readSellerAcceptance(account.id, input.currentTermsVersion);
    return evaluateCommerceSellerEligibility({
      action: input.action,
      nowMs: this.now(),
      premiumActive: await this.premium.isPremium(input.guildId),
      ownerAuthorized: input.ownerAuthorized,
      adultAttestedAtMs: profile.adultAttestedAtMs,
      twoFactorEvidence: profile.twoFactorEvidence,
      guildCreatedAtMs: profile.guildCreatedAtMs,
      ownershipTransferredAtMs: profile.ownershipTransferredAtMs,
      guildGoodStanding: profile.guildGoodStanding,
      sellerGoodStanding: profile.sellerGoodStanding,
      supportContact: profile.supportContact,
      currentTermsAccepted: acceptance !== null,
      approvalState: profile.approvalState,
      stripeDetailsSubmitted: account.detailsSubmitted,
      stripeChargesEnabled: account.chargesEnabled,
      stripePayoutsEnabled: account.payoutsEnabled,
      globallySuspended: await this.isSuspended("global", "commerce"),
      guildSuspended: await this.isSuspended("guild", input.guildId),
    });
  }

  async createAccountManagementLink(guildId: string): Promise<{ url: string }> {
    await this.requireAccount(guildId);
    return { url: "https://dashboard.stripe.com/" };
  }

  private createOnboardingLink(
    account: CommerceConnectedAccount,
    input: BeginSellerOnboardingInput,
  ): Promise<{ url: string }> {
    return this.provider.createOnboardingLink({
      connectedAccountId: account.stripeAccountId,
      refreshUrl: input.refreshUrl,
      returnUrl: input.returnUrl,
      idempotencyKey: `commerce-onboarding:${account.id}:${input.attemptId}`,
    });
  }

  private async requireAccount(guildId: string): Promise<CommerceConnectedAccount> {
    const account = await this.store.readConnectedAccountByGuild(guildId);
    if (!account) throw new Error("commerce_seller_not_connected");
    return account;
  }

  private async requireProfile(connectedAccountId: string): Promise<CommerceSellerProfile> {
    const profile = await this.store.readSellerProfile(connectedAccountId);
    if (!profile) throw new Error("commerce_seller_profile_missing");
    return profile;
  }

  private async isSuspended(
    scopeType: CommerceSellerControl["scopeType"],
    scopeId: string,
  ): Promise<boolean> {
    return Boolean((await this.store.readSellerControl(scopeType, scopeId))?.suspended);
  }

  private async audit(input: {
    guildId: string;
    connectedAccountId: string | null;
    operationKey: string;
    operationType: string;
    actorType: "stripe" | "seller" | "operator";
    actorId: string | null;
    payload: Record<string, unknown>;
    nowMs: number;
  }): Promise<void> {
    await this.store.appendOperation({
      id: this.createId(),
      connectedAccountId: input.connectedAccountId,
      guildId: input.guildId,
      operationKey: input.operationKey,
      operationType: input.operationType,
      entityType: "seller",
      entityId: input.connectedAccountId ?? input.guildId,
      actorType: input.actorType,
      actorId: input.actorId,
      payloadJson: JSON.stringify(input.payload),
      createdAtMs: input.nowMs,
    });
  }
}

function projectionToAccount(
  projection: StripeConnectedAccountProjection,
  guildId: string,
  createdAtMs: number,
  id = projection.id,
): CommerceConnectedAccount {
  return {
    id,
    guildId,
    stripeAccountId: projection.id,
    status: projection.disabledReason || !projection.chargesEnabled ? "restricted" : "active",
    country: projection.country,
    defaultCurrency:
      projection.defaultCurrency === null
        ? null
        : projection.defaultCurrency.toUpperCase() === "AUD"
          ? "AUD"
          : projection.defaultCurrency.toUpperCase() === "USD"
            ? "USD"
            : null,
    chargesEnabled: projection.chargesEnabled,
    payoutsEnabled: projection.payoutsEnabled,
    detailsSubmitted: projection.detailsSubmitted,
    providerCreatedAtMs: projection.providerCreatedAtMs,
    archivedAtMs: null,
    createdAtMs,
    updatedAtMs: createdAtMs,
  };
}

function projectionToProfile(input: {
  projection: StripeConnectedAccountProjection;
  input: BeginSellerOnboardingInput;
  nowMs: number;
  approvalState: "pending" | "approved" | "rejected";
  reviewedAtMs: number | null;
  reviewedByUserId: string | null;
  suspended: boolean;
}): CommerceSellerProfile {
  const account = projectionToAccount(input.projection, input.input.guildId, input.nowMs);
  return {
    connectedAccountId: account.id,
    guildId: input.input.guildId,
    sellerOwnerUserId: input.input.sellerUserId,
    lifecycleState: deriveCommerceSellerLifecycle({
      account,
      approvalState: input.approvalState,
      disabledReason: input.projection.disabledReason,
      suspended: input.suspended,
    }),
    approvalState: input.approvalState,
    supportContact: input.input.supportContact.trim(),
    adultAttestedAtMs: input.input.adultAttestedAtMs ?? input.nowMs,
    twoFactorEvidence: input.input.twoFactorEvidence ?? "seller_attested",
    guildCreatedAtMs: input.input.guildCreatedAtMs,
    ownershipTransferredAtMs: input.input.ownershipTransferredAtMs,
    guildGoodStanding: input.input.guildGoodStanding,
    sellerGoodStanding: input.input.sellerGoodStanding,
    requirementsCurrentlyDueJson: JSON.stringify(input.projection.currentlyDue),
    requirementsEventuallyDueJson: JSON.stringify(input.projection.eventuallyDue),
    requirementsPendingVerificationJson: JSON.stringify(input.projection.pendingVerification),
    disabledReason: input.projection.disabledReason,
    reviewedByUserId: input.reviewedByUserId,
    reviewedAtMs: input.reviewedAtMs,
    capabilitiesUpdatedAtMs: input.nowMs,
    createdAtMs: input.nowMs,
    updatedAtMs: input.nowMs,
  };
}

function isValidSupportContact(value: string): boolean {
  const normalized = value.trim();
  return (
    normalized.length >= 3 &&
    normalized.length <= 320 &&
    (normalized.includes("@") || /^https:\/\/[^\s]+$/i.test(normalized))
  );
}

function stateFingerprint(
  account: CommerceConnectedAccount,
  profile: CommerceSellerProfile,
): string {
  const input = [
    account.status,
    account.detailsSubmitted,
    account.chargesEnabled,
    account.payoutsEnabled,
    profile.approvalState,
    profile.lifecycleState,
    profile.disabledReason ?? "",
    profile.requirementsCurrentlyDueJson,
    profile.requirementsPendingVerificationJson,
  ].join("|");
  let hash = 2_166_136_261;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16);
}
