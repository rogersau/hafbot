import assert from "node:assert/strict";
import test from "node:test";

import {
  CommerceBuyerCheckoutService,
  type CommerceBuyerCheckoutProvider,
  type CommerceBuyerCheckoutStore,
  type CommerceBuyerStatus,
  type CommerceCheckoutAttempt,
  type CommercePurchasePolicy,
  type CommerceStorefront,
} from "../src/commerce/buyer-checkout";
import type { CommerceBuyer, CommerceCustomer } from "../src/commerce/types";

const NOW = 1_900_000_000_000;

test("public catalog keeps only currently purchase-eligible offerings", async () => {
  const store = new MemoryBuyerStore();
  store.catalog = [
    storefront(),
    {
      ...storefront(),
      offering: {
        ...storefront().offering,
        id: "22222222-2222-4222-8222-222222222222",
        state: "draft",
      },
    },
    {
      ...storefront(),
      offering: { ...storefront().offering, id: "33333333-3333-4333-8333-333333333333" },
      publishContext: { ...storefront().publishContext, sellerEligible: false },
    },
  ];
  const visible = await serviceFor(store, new RecordingProvider()).storefrontsForGuild(
    "111111111111111111",
  );
  assert.deepEqual(
    visible.map(({ offering }) => offering.id),
    [OFFERING_ID],
  );
});

test("public catalog excludes offerings blocked by the effective purchase policy", async () => {
  const store = new MemoryBuyerStore();
  const blockedId = "22222222-2222-4222-8222-222222222222";
  store.catalog = [
    storefront(),
    { ...storefront(), offering: { ...storefront().offering, id: blockedId } },
  ];
  const policy: CommercePurchasePolicy = {
    async assertPurchaseAllowed() {},
    async isStorefrontPurchaseAllowed(candidate) {
      return candidate.offering.id !== blockedId;
    },
  };
  const visible = await serviceFor(store, new RecordingProvider(), policy).storefrontsForGuild(
    "111111111111111111",
  );
  assert.deepEqual(
    visible.map(({ offering }) => offering.id),
    [OFFERING_ID],
  );
});

test("subscription checkout is seller scoped, applies five percent, and does not grant entitlement", async () => {
  const store = new MemoryBuyerStore();
  store.customer = null;
  const provider = new RecordingProvider();
  const service = serviceFor(store, provider);

  const result = await service.startSubscriptionCheckout({
    offeringId: OFFERING_ID,
    discordUserId: "123456789012345678",
    checkoutAttemptId: ATTEMPT_ID,
    successUrl: "https://hafbot.xyz/commerce/return?state=signed",
    cancelUrl: `https://hafbot.xyz/commerce/offers/${OFFERING_ID}?checkout=cancelled`,
    preflight: VALID_PREFLIGHT,
  });

  assert.equal(result.url, "https://checkout.stripe.com/c/pay/cs_test");
  assert.equal(provider.customers.length, 1);
  assert.equal(provider.checkouts.length, 1);
  assert.deepEqual(
    {
      account: provider.checkouts[0]?.connectedAccountId,
      buyer: provider.checkouts[0]?.buyerId,
      guild: provider.checkouts[0]?.guildId,
      offering: provider.checkouts[0]?.offeringId,
      fee: provider.checkouts[0]?.applicationFeePercent,
    },
    {
      account: "acct_seller",
      buyer: "buyer_1",
      guild: "111111111111111111",
      offering: OFFERING_ID,
      fee: 5,
    },
  );
  assert.equal(store.entitlementWrites, 0);
  assert.equal(store.attempt?.status, "open");

  const resumed = await service.startSubscriptionCheckout({
    offeringId: OFFERING_ID,
    discordUserId: "123456789012345678",
    checkoutAttemptId: "22222222-2222-4222-8222-222222222222",
    successUrl: "https://hafbot.xyz/commerce/return?state=second",
    cancelUrl: `https://hafbot.xyz/commerce/offers/${OFFERING_ID}`,
    preflight: VALID_PREFLIGHT,
  });
  assert.equal(provider.customers.length, 1, "seller-scoped customer is reused");
  assert.equal(provider.checkouts.length, 1, "an open Stripe Checkout is not duplicated");
  assert.equal(provider.retrievals.length, 1);
  assert.equal(resumed.checkoutSessionId, "cs_test");
  assert.equal(store.rateLimitClaims, 1, "resuming does not consume another attempt");
});

test("replaces a stale-price Checkout with a session for the current price", async () => {
  const store = new MemoryBuyerStore();
  store.attempt = {
    id: ATTEMPT_ID,
    connectedAccountId: "acct_seller",
    guildId: "111111111111111111",
    offeringId: OFFERING_ID,
    priceId: "price_retired",
    buyerId: "buyer_1",
    stripeCheckoutSessionId: "cs_stale",
    status: "open",
    expiresAtMs: NOW + 10_000,
    returnedAtMs: null,
    createdAtMs: NOW,
    updatedAtMs: NOW,
  };
  const provider = new RecordingProvider();
  const released: string[] = [];
  const service = serviceFor(store, provider, {
    async assertPurchaseAllowed() {},
    async releasePurchase(checkoutAttemptId) {
      released.push(checkoutAttemptId);
    },
  });

  const result = await service.startSubscriptionCheckout({
    ...checkoutInput(),
    checkoutAttemptId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  });

  assert.equal(result.checkoutSessionId, "cs_test");
  assert.deepEqual(provider.expirations, [
    {
      connectedAccountId: "acct_seller",
      checkoutSessionId: "cs_stale",
      idempotencyKey: `commerce:checkout-expire:${ATTEMPT_ID}`,
    },
  ]);
  assert.equal(provider.retrievals.length, 0, "the retired price is never resumed");
  assert.equal(provider.checkouts.length, 1);
  assert.equal(provider.checkouts[0]?.priceId, "price_vip");
  assert.deepEqual(store.expiredAttemptIds, [ATTEMPT_ID]);
  assert.deepEqual(released, [ATTEMPT_ID]);
  assert.equal(store.attempt?.priceId, "price_local");
});

test("checkout rechecks stale offering, seller capability, membership, bot and role state", async () => {
  const cases: Array<[string, (store: MemoryBuyerStore) => void, typeof VALID_PREFLIGHT, string]> =
    [
      [
        "retired offering",
        (store) => {
          store.view.offering.state = "retiring";
        },
        VALID_PREFLIGHT,
        "commerce_offering_not_purchasable",
      ],
      [
        "disabled seller",
        (store) => {
          store.view.publishContext.sellerEligible = false;
        },
        VALID_PREFLIGHT,
        "commerce_seller_not_purchasable",
      ],
      [
        "membership lost",
        () => {},
        { ...VALID_PREFLIGHT, memberPresent: false },
        "commerce_buyer_not_guild_member",
      ],
      [
        "bot buyer",
        () => {},
        { ...VALID_PREFLIGHT, memberIsBot: true },
        "commerce_buyer_bot_forbidden",
      ],
      [
        "role hierarchy changed",
        () => {},
        { ...VALID_PREFLIGHT, roleManageable: false },
        "commerce_role_unmanageable",
      ],
    ];

  for (const [name, mutate, preflight, code] of cases) {
    const store = new MemoryBuyerStore();
    mutate(store);
    const provider = new RecordingProvider();
    await assert.rejects(
      serviceFor(store, provider).startSubscriptionCheckout({
        offeringId: OFFERING_ID,
        discordUserId: "123456789012345678",
        checkoutAttemptId: ATTEMPT_ID,
        successUrl: "https://hafbot.xyz/commerce/return",
        cancelUrl: "https://hafbot.xyz/commerce/cancel",
        preflight,
      }),
      new RegExp(code),
      name,
    );
    assert.equal(provider.checkouts.length, 0, name);
  }
});

test("duplicate subscriptions, open checkout and pilot policy stop provider creation", async () => {
  const duplicate = new MemoryBuyerStore();
  duplicate.activeSubscription = true;
  const duplicateProvider = new RecordingProvider();
  await assert.rejects(
    serviceFor(duplicate, duplicateProvider).startSubscriptionCheckout(checkoutInput()),
    /commerce_duplicate_subscription/,
  );
  assert.equal(duplicateProvider.checkouts.length, 0);

  const open = new MemoryBuyerStore();
  open.reserveAllowed = false;
  const openProvider = new RecordingProvider();
  await assert.rejects(
    serviceFor(open, openProvider).startSubscriptionCheckout(checkoutInput()),
    /commerce_checkout_already_open/,
  );
  assert.equal(openProvider.checkouts.length, 0);

  const policyStore = new MemoryBuyerStore();
  const policyProvider = new RecordingProvider();
  const service = new CommerceBuyerCheckoutService(
    policyStore,
    policyProvider,
    { async request() {} },
    {
      async assertPurchaseAllowed() {
        throw new Error("commerce_pilot_subscriber_limit");
      },
    },
    () => NOW,
    () => "customer_local",
  );
  await assert.rejects(
    service.startSubscriptionCheckout(checkoutInput()),
    /pilot_subscriber_limit/,
  );
  assert.equal(policyProvider.checkouts.length, 0);
});

test("capacity is claimed immediately before Stripe and released on provider failure", async () => {
  const store = new MemoryBuyerStore();
  const provider = new RecordingProvider();
  let claimed = false;
  let released = false;
  provider.createSubscriptionCheckout = async () => {
    assert.equal(claimed, true);
    throw new Error("stripe_unavailable");
  };
  const service = new CommerceBuyerCheckoutService(
    store,
    provider,
    { async request() {} },
    {
      async assertPurchaseAllowed() {},
      async claimPurchase(input) {
        assert.equal(provider.checkouts.length, 0);
        assert.equal(input.checkoutAttemptId, ATTEMPT_ID);
        claimed = true;
      },
      async releasePurchase(id) {
        assert.equal(id, ATTEMPT_ID);
        released = true;
      },
    },
    () => NOW,
  );
  await assert.rejects(
    () => service.startSubscriptionCheckout(checkoutInput()),
    /stripe_unavailable/,
  );
  assert.equal(claimed, true);
  assert.equal(released, true);
});

test("browser return requests reconciliation but remains pending until projection is verified", async () => {
  const store = new MemoryBuyerStore();
  store.status = {
    customerExists: true,
    entitlementStatus: "pending",
    subscriptionStatus: "incomplete",
    cancelAtPeriodEnd: false,
    currentPeriodEndMs: null,
    graceEndsAtMs: null,
  };
  store.attempt = {
    id: ATTEMPT_ID,
    connectedAccountId: "acct_seller",
    guildId: "111111111111111111",
    offeringId: OFFERING_ID,
    priceId: "price_local",
    buyerId: "buyer_1",
    stripeCheckoutSessionId: "cs_test",
    status: "open",
    expiresAtMs: NOW + 10_000,
    returnedAtMs: null,
    createdAtMs: NOW,
    updatedAtMs: NOW,
  };
  const reconciliations: unknown[] = [];
  const service = new CommerceBuyerCheckoutService(
    store,
    new RecordingProvider(),
    {
      async request(input) {
        reconciliations.push(input);
      },
    },
    undefined,
    () => NOW,
  );

  const result = await service.handleBrowserReturn({
    offeringId: OFFERING_ID,
    discordUserId: "123456789012345678",
    checkoutAttemptId: ATTEMPT_ID,
  });

  assert.equal(result.entitlementStatus, "pending");
  assert.equal(store.entitlementWrites, 0);
  assert.deepEqual(reconciliations, [
    { connectedAccountId: "acct_seller", correlationId: ATTEMPT_ID },
  ]);
});

test("customer portal is seller scoped and does not require current guild membership", async () => {
  const store = new MemoryBuyerStore();
  const provider = new RecordingProvider();
  const result = await serviceFor(store, provider).createCustomerPortal({
    offeringId: OFFERING_ID,
    discordUserId: "123456789012345678",
    returnUrl: `https://hafbot.xyz/commerce/offers/${OFFERING_ID}`,
    intentId: "portal-intent",
  });
  assert.equal(result.url, "https://billing.stripe.com/p/session");
  assert.equal(provider.portals[0]?.connectedAccountId, "acct_seller");
});

const OFFERING_ID = "11111111-1111-4111-8111-111111111111";
const ATTEMPT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VALID_PREFLIGHT = {
  memberPresent: true,
  memberIsBot: false,
  memberBanned: false,
  roleManageable: true,
};

function checkoutInput() {
  return {
    offeringId: OFFERING_ID,
    discordUserId: "123456789012345678",
    checkoutAttemptId: ATTEMPT_ID,
    successUrl: "https://hafbot.xyz/commerce/return",
    cancelUrl: "https://hafbot.xyz/commerce/cancel",
    preflight: VALID_PREFLIGHT,
  };
}

function serviceFor(
  store: MemoryBuyerStore,
  provider: RecordingProvider,
  policy?: CommercePurchasePolicy,
) {
  return new CommerceBuyerCheckoutService(
    store,
    provider,
    { async request() {} },
    policy,
    () => NOW,
    () => "customer_local",
  );
}

class MemoryBuyerStore implements CommerceBuyerCheckoutStore {
  view = storefront();
  catalog: CommerceStorefront[] = [this.view];
  buyer: CommerceBuyer = {
    id: "buyer_1",
    discordUserId: "123456789012345678",
    createdAtMs: NOW,
    updatedAtMs: NOW,
  };
  customer: CommerceCustomer | null = {
    id: "customer_local",
    connectedAccountId: "acct_seller",
    buyerId: "buyer_1",
    stripeCustomerId: "cus_seller_buyer",
    createdAtMs: NOW,
    updatedAtMs: NOW,
  };
  activeSubscription = false;
  reserveAllowed = true;
  attempt: CommerceCheckoutAttempt | null = null;
  status: CommerceBuyerStatus = {
    customerExists: true,
    entitlementStatus: null,
    subscriptionStatus: null,
    cancelAtPeriodEnd: false,
    currentPeriodEndMs: null,
    graceEndsAtMs: null,
  };
  entitlementWrites = 0;
  rateLimitClaims = 0;
  expiredAttemptIds: string[] = [];

  async readStorefront() {
    return this.view;
  }
  async listStorefrontsForGuild() {
    return this.catalog;
  }
  async getOrCreateBuyer(discordUserId: string) {
    this.buyer.discordUserId = discordUserId;
    return this.buyer;
  }
  async readCustomer() {
    return this.customer;
  }
  async saveCustomer(customer: CommerceCustomer) {
    this.customer = customer;
  }
  async hasActiveSubscription() {
    return this.activeSubscription;
  }
  async readActiveCheckout(input: {
    connectedAccountId: string;
    buyerId: string;
    offeringId: string;
    nowMs: number;
  }) {
    if (
      !this.attempt ||
      this.attempt.connectedAccountId !== input.connectedAccountId ||
      this.attempt.buyerId !== input.buyerId ||
      this.attempt.offeringId !== input.offeringId ||
      !["creating", "open", "returned"].includes(this.attempt.status) ||
      this.attempt.expiresAtMs <= input.nowMs
    )
      return null;
    return this.attempt;
  }
  async claimCheckoutRateLimit() {
    this.rateLimitClaims += 1;
    return true;
  }
  async reserveCheckout(attempt: CommerceCheckoutAttempt) {
    if (!this.reserveAllowed) return false;
    this.attempt = attempt;
    return true;
  }
  async attachCheckoutSession(_attemptId: string, sessionId: string, nowMs: number) {
    if (this.attempt)
      this.attempt = {
        ...this.attempt,
        stripeCheckoutSessionId: sessionId,
        status: "open",
        updatedAtMs: nowMs,
      };
  }
  async expireCheckout(attemptId: string, nowMs: number) {
    if (
      !this.attempt ||
      this.attempt.id !== attemptId ||
      !["open", "returned"].includes(this.attempt.status)
    )
      return false;
    this.expiredAttemptIds.push(attemptId);
    this.attempt = { ...this.attempt, status: "expired", updatedAtMs: nowMs };
    return true;
  }
  async failCheckout() {}
  async markCheckoutReturned(input: {
    attemptId: string;
    offeringId: string;
    buyerId: string;
    nowMs: number;
  }) {
    if (
      !this.attempt ||
      this.attempt.id !== input.attemptId ||
      this.attempt.offeringId !== input.offeringId ||
      this.attempt.buyerId !== input.buyerId
    )
      return null;
    this.attempt = {
      ...this.attempt,
      status: "returned",
      returnedAtMs: input.nowMs,
      updatedAtMs: input.nowMs,
    };
    return this.attempt;
  }
  async readBuyerStatus() {
    return this.status;
  }
}

class RecordingProvider implements CommerceBuyerCheckoutProvider {
  customers: Array<Record<string, unknown>> = [];
  checkouts: Array<Record<string, unknown>> = [];
  retrievals: Array<Record<string, unknown>> = [];
  expirations: Array<Record<string, unknown>> = [];
  portals: Array<Record<string, unknown>> = [];
  async createCustomer(input: Record<string, unknown>) {
    this.customers.push(input);
    return { id: "cus_seller_buyer" };
  }
  async createSubscriptionCheckout(input: Record<string, unknown>) {
    this.checkouts.push(input);
    return { id: "cs_test", url: "https://checkout.stripe.com/c/pay/cs_test" };
  }
  async retrieveSubscriptionCheckout(input: Record<string, unknown>) {
    this.retrievals.push(input);
    return { id: "cs_test", url: "https://checkout.stripe.com/c/pay/cs_test" };
  }
  async expireSubscriptionCheckout(input: Record<string, unknown>) {
    this.expirations.push(input);
  }
  async createCustomerPortal(input: Record<string, unknown>) {
    this.portals.push(input);
    return { url: "https://billing.stripe.com/p/session" };
  }
}

function storefront(): CommerceStorefront {
  return {
    offering: {
      id: OFFERING_ID,
      connectedAccountId: "acct_seller",
      guildId: "111111111111111111",
      discordRoleId: "222222222222222222",
      name: "VIP",
      description: "VIP access",
      purchaseType: "subscription",
      state: "published",
      termsVersion: "seller-terms-2026-07",
      includedBenefits: ["VIP channels"],
      supportContact: "seller@example.com",
      roleManageable: true,
      repairDeadlineAtMs: null,
      repairPreviousState: null,
      retireAtMs: null,
      publishedAtMs: NOW,
      archivedAtMs: null,
      createdAtMs: NOW,
      updatedAtMs: NOW,
    },
    price: {
      id: "price_local",
      connectedAccountId: "acct_seller",
      offeringId: OFFERING_ID,
      stripeProductId: "prod_vip",
      stripePriceId: "price_vip",
      currency: "AUD",
      unitAmountMinor: 500,
      priceType: "recurring",
      recurringInterval: "month",
      status: "active",
      providerCreatedAtMs: NOW,
      retiredAtMs: null,
      createdAtMs: NOW,
    },
    account: {
      id: "acct_seller",
      guildId: "111111111111111111",
      stripeAccountId: "acct_seller",
      status: "active",
      country: "AU",
      defaultCurrency: "AUD",
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      providerCreatedAtMs: NOW,
      archivedAtMs: null,
      createdAtMs: NOW,
      updatedAtMs: NOW,
    },
    seller: {
      connectedAccountId: "acct_seller",
      guildId: "111111111111111111",
      sellerOwnerUserId: "seller-user-1",
      lifecycleState: "active",
      approvalState: "approved",
      supportContact: "seller@example.com",
      adultAttestedAtMs: NOW,
      twoFactorEvidence: "discord_verified",
      guildCreatedAtMs: 0,
      ownershipTransferredAtMs: null,
      guildGoodStanding: true,
      sellerGoodStanding: true,
      requirementsCurrentlyDueJson: "[]",
      requirementsEventuallyDueJson: "[]",
      requirementsPendingVerificationJson: "[]",
      disabledReason: null,
      reviewedByUserId: "operator",
      reviewedAtMs: NOW,
      capabilitiesUpdatedAtMs: NOW,
      createdAtMs: NOW,
      updatedAtMs: NOW,
    },
    publishContext: {
      premiumActive: true,
      sellerEligible: true,
      termsAccepted: true,
      roleManageable: true,
    },
  };
}

test("reserved access blocks checkout before Stripe while redirects remain read-only", async () => {
  const store = new MemoryBuyerStore();
  const provider = new RecordingProvider();
  let prepared = 0;
  const service = new CommerceBuyerCheckoutService(
    store,
    provider,
    { request: async () => {} },
    undefined,
    () => NOW,
    () => "buyer-id",
    {
      configuration: async () => ({ acceptingSales: false }),
      choices: async () => [],
      prepare: async () => {
        prepared++;
      },
      status: async () => ({ state: "needs-attention", reason: "provider_validation_required" }),
    },
  );
  await assert.rejects(
    service.startSubscriptionCheckout({
      offeringId: OFFERING_ID,
      discordUserId: "buyer-discord",
      checkoutAttemptId: "attempt",
      successUrl: "https://example.com/return",
      cancelUrl: "https://example.com/cancel",
      preflight: {
        memberPresent: true,
        memberIsBot: false,
        memberBanned: false,
        roleManageable: true,
      },
    }),
    /reserved_access_unavailable/,
  );
  assert.equal(prepared, 0);
  assert.equal(
    (await service.buyerStatus(OFFERING_ID, "buyer-discord")).gameAccess?.state,
    "needs-attention",
  );
});
