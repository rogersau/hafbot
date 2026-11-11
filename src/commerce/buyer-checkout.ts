import {
  transitionCheckout,
  checkoutFailureRecovery,
  type CheckoutWorkflow,
} from "./checkout-workflow";
import type { DeliveryState } from "./game-access/model";
import type {
  CommerceBuyer,
  CommerceConnectedAccount,
  CommerceCustomer,
  CommerceEntitlementStatus,
  CommerceOffering,
  CommercePrice,
  CommerceSellerProfile,
  CommerceSubscriptionStatus,
} from "./types";
import type { CommerceOfferingPublishContext } from "./offering-service";

// Stripe Checkout requires expires_at to be at least 30 minutes in the future.
// One extra minute avoids crossing that boundary during the API request.
const CHECKOUT_TTL_MS = 31 * 60 * 1_000;

export interface CommerceStorefront {
  offering: CommerceOffering;
  price: CommercePrice;
  account: CommerceConnectedAccount;
  seller: CommerceSellerProfile;
  publishContext: CommerceOfferingPublishContext;
  reservedAccess?: { acceptingSales: boolean };
}

export interface CommerceBuyerStatus {
  roleDeliveryStatus?: string | null;
  gameAccess?: { state: DeliveryState; reason: string } | null;
  customerExists: boolean;
  entitlementStatus: CommerceEntitlementStatus | null;
  subscriptionStatus: CommerceSubscriptionStatus | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodEndMs: number | null;
  graceEndsAtMs: number | null;
}

export interface CommerceCheckoutAttempt {
  id: string;
  connectedAccountId: string;
  guildId: string;
  offeringId: string;
  priceId: string;
  buyerId: string;
  stripeCheckoutSessionId: string | null;
  status: "creating" | "open" | "returned" | "expired" | "failed";
  expiresAtMs: number;
  returnedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CommerceBuyerCheckoutStore {
  readStorefront(offeringId: string): Promise<CommerceStorefront | null>;
  /** Optional catalog read used by the public guild storefront. */
  listStorefrontsForGuild?(guildId: string): Promise<CommerceStorefront[]>;
  getOrCreateBuyer(discordUserId: string, nowMs: number): Promise<CommerceBuyer>;
  readCustomer(connectedAccountId: string, buyerId: string): Promise<CommerceCustomer | null>;
  saveCustomer(customer: CommerceCustomer): Promise<void>;
  hasActiveSubscription(
    connectedAccountId: string,
    buyerId: string,
    offeringId: string,
  ): Promise<boolean>;
  readActiveCheckout(input: {
    connectedAccountId: string;
    buyerId: string;
    offeringId: string;
    nowMs: number;
  }): Promise<CommerceCheckoutAttempt | null>;
  claimCheckoutRateLimit(input: {
    buyerId: string;
    offeringId: string;
    nowMs: number;
    windowMs: number;
    maximumAttempts: number;
  }): Promise<boolean>;
  reserveCheckout(attempt: CommerceCheckoutAttempt): Promise<boolean>;
  attachCheckoutSession(attemptId: string, sessionId: string, nowMs: number): Promise<void>;
  expireCheckout(attemptId: string, nowMs: number): Promise<boolean>;
  failCheckout(
    attemptId: string,
    nowMs: number,
    outcome?: "confirmed_not_sent" | "unknown",
  ): Promise<void>;
  markCheckoutReturned(input: {
    attemptId: string;
    offeringId: string;
    buyerId: string;
    nowMs: number;
  }): Promise<CommerceCheckoutAttempt | null>;
  readBuyerStatus(input: {
    connectedAccountId: string;
    buyerId: string;
    offeringId: string;
    nowMs: number;
  }): Promise<CommerceBuyerStatus & { checkoutAttemptId?: string | null }>;
}

export interface CommerceBuyerCheckoutProvider {
  createCustomer(input: {
    connectedAccountId: string;
    buyerId: string;
    discordUserId: string;
    idempotencyKey: string;
  }): Promise<{ id: string }>;
  createSubscriptionCheckout(input: {
    connectedAccountId: string;
    customerId: string;
    priceId: string;
    buyerId: string;
    guildId: string;
    offeringId: string;
    checkoutAttemptId: string;
    successUrl: string;
    cancelUrl: string;
    expiresAtMs: number;
    applicationFeePercent: number;
    idempotencyKey: string;
  }): Promise<{ id: string; url: string }>;
  retrieveSubscriptionCheckout(input: {
    connectedAccountId: string;
    checkoutSessionId: string;
  }): Promise<{ id: string; url: string }>;
  expireSubscriptionCheckout(input: {
    connectedAccountId: string;
    checkoutSessionId: string;
    idempotencyKey: string;
  }): Promise<void>;
  createCustomerPortal(input: {
    connectedAccountId: string;
    customerId: string;
    returnUrl: string;
    idempotencyKey: string;
  }): Promise<{ url: string }>;
}

export interface CommercePurchasePreflight {
  memberPresent: boolean;
  memberIsBot: boolean;
  memberBanned: boolean;
  roleManageable: boolean;
}

export interface CommercePurchasePolicy {
  assertPurchaseAllowed(input: { storefront: CommerceStorefront; buyerId: string }): Promise<void>;
  isStorefrontPurchaseAllowed?(storefront: CommerceStorefront): Promise<boolean>;
  claimPurchase?(input: {
    storefront: CommerceStorefront;
    buyerId: string;
    checkoutAttemptId: string;
    expiresAtMs: number;
  }): Promise<void>;
  releasePurchase?(checkoutAttemptId: string): Promise<void>;
}

export interface CommerceCheckoutReconciler {
  request(input: { connectedAccountId: string; correlationId: string }): Promise<void>;
}

export interface GameAccessCheckoutHooks {
  revalidate?(checkoutId: string, guildId: string, userId: string): Promise<void>;
  configuration(offeringId: string): Promise<{ acceptingSales: boolean } | null>;
  choices(guildId: string, userId: string): Promise<string[]>;
  prepare(input: {
    offeringId: string;
    guildId: string;
    buyerId: string;
    userId: string;
    checkoutId: string;
    subject?: string;
  }): Promise<void>;
  status(input: {
    offeringId: string;
    guildId: string;
    buyerId: string;
    userId: string;
    checkoutId: string | null;
  }): Promise<CommerceBuyerStatus["gameAccess"]>;
}
export class CommerceBuyerCheckoutService {
  constructor(
    private readonly store: CommerceBuyerCheckoutStore,
    private readonly provider: CommerceBuyerCheckoutProvider,
    private readonly reconciler: CommerceCheckoutReconciler,
    private readonly policy: CommercePurchasePolicy = ALLOW_PURCHASE_POLICY,
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = () => crypto.randomUUID(),
    private readonly gameAccess?: GameAccessCheckoutHooks,
  ) {}

  async storefront(offeringId: string): Promise<CommerceStorefront> {
    const storefront = await this.store.readStorefront(offeringId);
    if (!storefront) throw new Error("commerce_offering_not_found");
    const config = await this.gameAccess?.configuration(offeringId);
    if (config) storefront.reservedAccess = config;
    return storefront;
  }

  async gameIdentityChoices(guildId: string, userId: string) {
    return this.gameAccess?.choices(guildId, userId) ?? [];
  }

  async storefrontsForGuild(guildId: string): Promise<CommerceStorefront[]> {
    const storefronts = this.store.listStorefrontsForGuild
      ? await this.store.listStorefrontsForGuild(guildId)
      : [];
    for (const sf of storefronts) {
      const config = await this.gameAccess?.configuration(sf.offering.id);
      if (config) sf.reservedAccess = config;
    }
    const eligible = storefronts.filter(
      (sf) => isBrowsableStorefront(sf) && (!sf.reservedAccess || sf.reservedAccess.acceptingSales),
    );
    if (!this.policy.isStorefrontPurchaseAllowed) return eligible;
    const allowed = await Promise.all(
      eligible.map((storefront) => this.policy.isStorefrontPurchaseAllowed!(storefront)),
    );
    return eligible.filter((_, index) => allowed[index]);
  }

  async startSubscriptionCheckout(input: {
    offeringId: string;
    discordUserId: string;
    checkoutAttemptId: string;
    successUrl: string;
    cancelUrl: string;
    subject?: string;
    preflight: CommercePurchasePreflight;
  }): Promise<{ checkoutSessionId: string; url: string }> {
    const nowMs = this.now();
    const storefront = await this.requirePurchasable(input.offeringId);
    if (storefront.reservedAccess && !storefront.reservedAccess.acceptingSales)
      throw new Error("commerce_reserved_access_unavailable");
    assertPreflight(input.preflight);
    const buyer = await this.store.getOrCreateBuyer(input.discordUserId, nowMs);
    await this.policy.assertPurchaseAllowed({ storefront, buyerId: buyer.id });
    if (
      await this.store.hasActiveSubscription(
        storefront.account.id,
        buyer.id,
        storefront.offering.id,
      )
    ) {
      throw new Error("commerce_duplicate_subscription");
    }
    const resumed = await this.resumeOpenCheckout(storefront, buyer, nowMs, input.subject);
    if (resumed) return resumed;
    if (
      !(await this.store.claimCheckoutRateLimit({
        buyerId: buyer.id,
        offeringId: storefront.offering.id,
        nowMs,
        windowMs: 10 * 60 * 1_000,
        maximumAttempts: 5,
      }))
    ) {
      throw new Error("commerce_checkout_rate_limited");
    }
    const attempt: CommerceCheckoutAttempt = {
      id: input.checkoutAttemptId,
      connectedAccountId: storefront.account.id,
      guildId: storefront.offering.guildId,
      offeringId: storefront.offering.id,
      priceId: storefront.price.id,
      buyerId: buyer.id,
      stripeCheckoutSessionId: null,
      status: "creating",
      expiresAtMs: nowMs + CHECKOUT_TTL_MS,
      returnedAtMs: null,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    if (!(await this.store.reserveCheckout(attempt))) {
      const concurrent = await this.resumeOpenCheckout(
        storefront,
        buyer,
        this.now(),
        input.subject,
      );
      if (concurrent) return concurrent;
      throw new Error("commerce_checkout_already_open");
    }

    let workflow: CheckoutWorkflow = { kind: "preparing", capacity: "unclaimed" };
    try {
      await this.gameAccess?.prepare({
        offeringId: input.offeringId,
        guildId: storefront.offering.guildId,
        buyerId: buyer.id,
        userId: buyer.discordUserId,
        checkoutId: attempt.id,
        subject: input.subject,
      });
      let customer = await this.store.readCustomer(storefront.account.id, buyer.id);
      if (!customer) {
        const providerCustomer = await this.provider.createCustomer({
          connectedAccountId: storefront.account.stripeAccountId,
          buyerId: buyer.id,
          discordUserId: buyer.discordUserId,
          idempotencyKey: `commerce:customer:${storefront.account.id}:${buyer.id}`,
        });
        customer = {
          id: this.createId(),
          connectedAccountId: storefront.account.id,
          buyerId: buyer.id,
          stripeCustomerId: providerCustomer.id,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
        };
        await this.store.saveCustomer(customer);
        customer = (await this.store.readCustomer(storefront.account.id, buyer.id)) ?? customer;
      }
      await this.policy.claimPurchase?.({
        storefront,
        buyerId: buyer.id,
        checkoutAttemptId: attempt.id,
        expiresAtMs: attempt.expiresAtMs,
      });
      if (this.policy.claimPurchase)
        workflow = transitionCheckout(workflow, { type: "capacity-claimed" });
      if (storefront.reservedAccess)
        await this.gameAccess?.revalidate?.(
          attempt.id,
          storefront.offering.guildId,
          buyer.discordUserId,
        );
      // Once invoked, even a rejected/response-lost request might have created a session.
      workflow = transitionCheckout(workflow, { type: "provider-invoked" });
      const session = await this.provider.createSubscriptionCheckout({
        connectedAccountId: storefront.account.stripeAccountId,
        customerId: customer.stripeCustomerId,
        priceId: storefront.price.stripePriceId,
        buyerId: buyer.id,
        guildId: storefront.offering.guildId,
        offeringId: storefront.offering.id,
        checkoutAttemptId: attempt.id,
        successUrl: input.successUrl,
        cancelUrl: input.cancelUrl,
        expiresAtMs: attempt.expiresAtMs,
        applicationFeePercent: 5,
        idempotencyKey: `commerce:checkout:${attempt.id}`,
      });
      workflow = transitionCheckout(workflow, { type: "provider-created", sessionId: session.id });
      await this.store.attachCheckoutSession(attempt.id, session.id, this.now());
      workflow = transitionCheckout(workflow, { type: "session-attached" });
      return { checkoutSessionId: session.id, url: session.url };
    } catch (error) {
      try {
        if (checkoutFailureRecovery(workflow).releaseCapacity) {
          await this.policy.releasePurchase?.(attempt.id);
        }
      } finally {
        await this.store.failCheckout(
          attempt.id,
          this.now(),
          checkoutFailureRecovery(workflow).providerOutcome,
        );
      }
      throw error;
    }
  }

  async handleBrowserReturn(input: {
    offeringId: string;
    discordUserId: string;
    checkoutAttemptId: string;
  }): Promise<CommerceBuyerStatus> {
    const storefront = await this.storefront(input.offeringId);
    const buyer = await this.store.getOrCreateBuyer(input.discordUserId, this.now());
    const attempt = await this.store.markCheckoutReturned({
      attemptId: input.checkoutAttemptId,
      offeringId: storefront.offering.id,
      buyerId: buyer.id,
      nowMs: this.now(),
    });
    if (!attempt || attempt.connectedAccountId !== storefront.account.id) {
      throw new Error("commerce_checkout_return_scope_mismatch");
    }
    await this.reconciler.request({
      connectedAccountId: storefront.account.id,
      correlationId: attempt.id,
    });
    const { checkoutAttemptId, ...status } = await this.store.readBuyerStatus({
      connectedAccountId: storefront.account.id,
      buyerId: buyer.id,
      offeringId: storefront.offering.id,
      nowMs: this.now(),
    });
    return {
      ...status,
      gameAccess: await this.gameAccess?.status({
        offeringId: input.offeringId,
        guildId: storefront.offering.guildId,
        buyerId: buyer.id,
        userId: input.discordUserId,
        checkoutId: checkoutAttemptId ?? null,
      }),
    };
  }

  async buyerStatus(offeringId: string, discordUserId: string): Promise<CommerceBuyerStatus> {
    const storefront = await this.storefront(offeringId);
    const buyer = await this.store.getOrCreateBuyer(discordUserId, this.now());
    const { checkoutAttemptId, ...status } = await this.store.readBuyerStatus({
      connectedAccountId: storefront.account.id,
      buyerId: buyer.id,
      offeringId,
      nowMs: this.now(),
    });
    return {
      ...status,
      gameAccess: await this.gameAccess?.status({
        offeringId,
        guildId: storefront.offering.guildId,
        buyerId: buyer.id,
        userId: discordUserId,
        checkoutId: checkoutAttemptId ?? null,
      }),
    };
  }

  async createCustomerPortal(input: {
    offeringId: string;
    discordUserId: string;
    returnUrl: string;
    intentId: string;
  }): Promise<{ url: string }> {
    const storefront = await this.storefront(input.offeringId);
    const buyer = await this.store.getOrCreateBuyer(input.discordUserId, this.now());
    const customer = await this.store.readCustomer(storefront.account.id, buyer.id);
    if (!customer) throw new Error("commerce_customer_not_found");
    return this.provider.createCustomerPortal({
      connectedAccountId: storefront.account.stripeAccountId,
      customerId: customer.stripeCustomerId,
      returnUrl: input.returnUrl,
      idempotencyKey: `commerce:portal:${storefront.account.id}:${buyer.id}:${input.intentId}`,
    });
  }

  private async resumeOpenCheckout(
    storefront: CommerceStorefront,
    buyer: CommerceBuyer,
    nowMs: number,
    subject?: string,
  ): Promise<{ checkoutSessionId: string; url: string } | null> {
    const attempt = await this.store.readActiveCheckout({
      connectedAccountId: storefront.account.id,
      buyerId: buyer.id,
      offeringId: storefront.offering.id,
      nowMs,
    });
    if (!attempt) return null;
    if (attempt.status !== "open" || !attempt.stripeCheckoutSessionId) {
      throw new Error("commerce_checkout_already_open");
    }
    if (attempt.priceId !== storefront.price.id) {
      await this.provider.expireSubscriptionCheckout({
        connectedAccountId: storefront.account.stripeAccountId,
        checkoutSessionId: attempt.stripeCheckoutSessionId,
        idempotencyKey: `commerce:checkout-expire:${attempt.id}`,
      });
      if (!(await this.store.expireCheckout(attempt.id, nowMs))) {
        throw new Error("commerce_checkout_already_open");
      }
      await this.policy.releasePurchase?.(attempt.id);
      return null;
    }
    await this.gameAccess?.prepare({
      offeringId: storefront.offering.id,
      guildId: storefront.offering.guildId,
      buyerId: buyer.id,
      userId: buyer.discordUserId,
      checkoutId: attempt.id,
      subject,
    });
    if (storefront.reservedAccess)
      await this.gameAccess?.revalidate?.(
        attempt.id,
        storefront.offering.guildId,
        buyer.discordUserId,
      );
    const session = await this.provider.retrieveSubscriptionCheckout({
      connectedAccountId: storefront.account.stripeAccountId,
      checkoutSessionId: attempt.stripeCheckoutSessionId,
    });
    return { checkoutSessionId: session.id, url: session.url };
  }

  private async requirePurchasable(offeringId: string): Promise<CommerceStorefront> {
    const storefront = await this.storefront(offeringId);
    if (
      storefront.offering.purchaseType !== "subscription" ||
      storefront.offering.state !== "published" ||
      storefront.price.status !== "active" ||
      storefront.price.priceType !== "recurring"
    ) {
      throw new Error("commerce_offering_not_purchasable");
    }
    if (
      !storefront.publishContext.premiumActive ||
      !storefront.publishContext.sellerEligible ||
      !storefront.publishContext.termsAccepted
    ) {
      throw new Error("commerce_seller_not_purchasable");
    }
    if (!storefront.offering.roleManageable || !storefront.publishContext.roleManageable) {
      throw new Error("commerce_role_unmanageable");
    }
    return storefront;
  }
}

function isBrowsableStorefront(storefront: CommerceStorefront): boolean {
  return (
    storefront.offering.purchaseType === "subscription" &&
    storefront.offering.state === "published" &&
    storefront.price.status === "active" &&
    storefront.price.priceType === "recurring" &&
    storefront.publishContext.premiumActive &&
    storefront.publishContext.sellerEligible &&
    storefront.publishContext.termsAccepted &&
    storefront.offering.roleManageable &&
    storefront.publishContext.roleManageable
  );
}

function assertPreflight(preflight: CommercePurchasePreflight): void {
  if (!preflight.memberPresent) throw new Error("commerce_buyer_not_guild_member");
  if (preflight.memberIsBot) throw new Error("commerce_buyer_bot_forbidden");
  if (preflight.memberBanned) throw new Error("commerce_buyer_banned");
  if (!preflight.roleManageable) throw new Error("commerce_role_unmanageable");
}

const ALLOW_PURCHASE_POLICY: CommercePurchasePolicy = {
  async assertPurchaseAllowed() {},
};
