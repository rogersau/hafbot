/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { createBillingCatalog } from "../src/runtime/billing/catalog";
import {
  createBillingCheckoutService,
  type BillingCheckoutProvider,
  type BillingCheckoutStore,
} from "../src/runtime/billing/checkout";
import type { BillingSubscriptionProjection } from "../src/runtime/billing/types";

const catalog = createBillingCatalog({
  founderPremiumMonthlyPriceId: "price_fpm",
  founderPremiumYearlyPriceId: "price_fpy",
  legacyFounderPremiumYearlyPriceId: "price_legacy_fpy",
  founderPremiumPlusMonthlyPriceId: "price_fppm",
  founderPremiumPlusYearlyPriceId: "price_fppy",
  legacyFounderPremiumPlusYearlyPriceId: "price_legacy_fppy",
  premiumMonthlyPriceId: "price_pm",
  premiumMonthlyProductId: "prod_p",
  premiumYearlyPriceId: "price_py",
  premiumYearlyProductId: "prod_p",
  premiumPlusMonthlyPriceId: "price_ppm",
  premiumPlusMonthlyProductId: "prod_pp",
  premiumPlusYearlyPriceId: "price_ppy",
  premiumPlusYearlyProductId: "prod_pp",
});

test("Billing catalogue requires unique Price identities with explicit cohorts", () => {
  assert.equal(catalog.size, 10);
  assert.deepEqual(
    new Set([...catalog.values()].map((entry) => entry.cohort)),
    new Set(["founder", "standard"]),
  );
  assert.throws(
    () =>
      createBillingCatalog({
        founderPremiumMonthlyPriceId: "duplicate",
        founderPremiumYearlyPriceId: "fpy",
        founderPremiumPlusMonthlyPriceId: "fppm",
        founderPremiumPlusYearlyPriceId: "fppy",
        premiumMonthlyPriceId: "duplicate",
        premiumMonthlyProductId: "p",
        premiumYearlyPriceId: "py",
        premiumYearlyProductId: "p",
        premiumPlusMonthlyPriceId: "ppm",
        premiumPlusMonthlyProductId: "pp",
        premiumPlusYearlyPriceId: "ppy",
        premiumPlusYearlyProductId: "pp",
      }),
    /unique/,
  );
});

test("Checkout binds a Customer first and supports the currently purchasable cohort", async () => {
  const provider = new FakeProvider();
  const store = new MemoryStore();
  const service = createService(provider, store);
  for (const { priceId } of [...catalog.values()].filter((entry) => entry.cohort === "standard")) {
    const result = await service.startCheckout({
      ownerId: "owner",
      email: "owner@example.test",
      priceId,
      intentId: `intent_${priceId}`,
    });
    assert.equal(result.url, "https://checkout.stripe.test/session");
  }
  assert.equal(provider.customerCalls.length, 1);
  assert.equal(provider.checkoutCalls.length, 4);
  assert.ok(provider.checkoutCalls.every((call) => call.customerId === "cus_1"));
  await assert.rejects(
    service.startCheckout({
      ownerId: "owner",
      email: null,
      priceId: "price_unknown",
      intentId: "intent_unknown",
    }),
    /unsupported_price/,
  );
});

test("duplicate submission reuses a stable business-intent idempotency key", async () => {
  const provider = new FakeProvider();
  const service = createService(provider, new MemoryStore());
  const input = {
    ownerId: "owner",
    email: null,
    priceId: "price_pm",
    intentId: "intent_duplicate",
  };
  await service.startCheckout(input);
  await service.startCheckout(input);
  assert.deepEqual(
    provider.checkoutCalls.map((call) => call.idempotencyKey),
    ["checkout:owner:intent_duplicate", "checkout:owner:intent_duplicate"],
  );
});

test("Founder Checkout admission switches at 50 without reserving in-flight places", async () => {
  const provider = new FakeProvider();
  const store = new MemoryStore();
  const service = createService(provider, store);
  store.founderCount = 49;
  assert.deepEqual(
    (await service.listCatalog()).map((entry) => entry.cohort),
    ["founder", "founder", "founder", "founder"],
  );
  await assert.rejects(
    service.startCheckout({
      ownerId: "owner",
      email: null,
      priceId: "price_legacy_fpy",
      intentId: "intent_legacy_founder",
    }),
    /unsupported_price/,
  );
  await service.startCheckout({
    ownerId: "owner",
    email: null,
    priceId: "price_fpm",
    intentId: "intent_founder_open",
  });
  await assert.rejects(
    service.startCheckout({
      ownerId: "owner",
      email: null,
      priceId: "price_pm",
      intentId: "intent_forged_standard",
    }),
    /stale_pricing_cohort/,
  );

  store.founderCount = 50;
  assert.ok((await service.listCatalog()).every((entry) => entry.cohort === "standard"));
  await assert.rejects(
    service.startCheckout({
      ownerId: "owner",
      email: null,
      priceId: "price_fpm",
      intentId: "intent_stale_founder",
    }),
    /stale_pricing_cohort/,
  );

  store.projection = projection({
    subscriptionId: "sub_founder",
    priceId: "price_fpm",
    productId: "prod_p",
    plan: "premium",
    frequency: "monthly",
    status: "active",
    pricingCohort: "founder",
    founderAwardedAtMs: 1,
  });
  assert.ok((await service.listCatalog("owner")).every((entry) => entry.cohort === "founder"));
});

test("unqualified Founder TEST subscriptions offer no unsupported plan changes while standard subscriptions keep their cohort", async () => {
  const store = new MemoryStore();
  const service = createService(new FakeProvider(), store);
  store.projection = projection({
    subscriptionId: "sub_founder_test",
    priceId: "price_fpm",
    productId: "prod_p",
    plan: "premium",
    frequency: "monthly",
    status: "active",
    pricingCohort: null,
  });
  assert.deepEqual(await service.listCatalog("owner"), []);
  store.projection = { ...store.projection, priceId: "price_pm" };
  const supported = await service.listCatalog("owner");
  assert.ok(supported.length > 0);
  assert.ok(supported.every((entry) => entry.cohort === "standard"));
});

test("usable Subscription and quarantine block Checkout while abandonment grants nothing", async () => {
  const store = new MemoryStore();
  const service = createService(new FakeProvider(), store);
  for (const status of ["active", "past_due", "unpaid", "incomplete"] as const) {
    store.projection = projection({
      status,
      plan: status === "incomplete" ? "free" : "premium",
      subscriptionId: "sub_1",
    });
    await assert.rejects(
      service.startCheckout({
        ownerId: "owner",
        email: null,
        priceId: "price_pm",
        intentId: `intent_${status}`,
      }),
      /subscription_already_exists/,
    );
  }
  store.projection = projection({ status: "quarantined", quarantineReason: "unknown_catalog" });
  await assert.rejects(
    service.startCheckout({
      ownerId: "owner",
      email: null,
      priceId: "price_pm",
      intentId: "intent_quarantine",
    }),
    /billing_quarantined/,
  );
  assert.equal(store.projection.plan, "free");
});

test("Checkout success requests full-owner sync and does not project redirect data", async () => {
  const syncCalls: unknown[] = [];
  const service = createBillingCheckoutService({
    provider: new FakeProvider(),
    store: new MemoryStore(),
    catalog,
    publicBaseUrl: "https://hafbot.test",
    async syncOwner(input) {
      syncCalls.push(input);
      return projection({ status: "active", plan: "premium" });
    },
  });
  const result = await service.requestSync("owner", "cs_1");
  assert.equal(result.plan, "premium");
  assert.deepEqual(syncCalls, [{ ownerId: "owner", source: "checkout", correlationId: "cs_1" }]);
});

function createService(provider: FakeProvider, store: MemoryStore) {
  return createBillingCheckoutService({
    provider,
    store,
    catalog,
    publicBaseUrl: "https://hafbot.test",
    async syncOwner() {
      return projection({ status: "active", plan: "premium" });
    },
  });
}

class FakeProvider implements BillingCheckoutProvider {
  readonly customerCalls: Array<{ ownerId: string; email: string | null; idempotencyKey: string }> =
    [];
  readonly checkoutCalls: Array<Parameters<BillingCheckoutProvider["createCheckout"]>[0]> = [];
  async createCustomer(input: {
    ownerId: string;
    email: string | null;
    idempotencyKey: string;
  }): Promise<string> {
    this.customerCalls.push(input);
    return "cus_1";
  }
  async createCheckout(input: Parameters<BillingCheckoutProvider["createCheckout"]>[0]) {
    this.checkoutCalls.push(input);
    return { id: "cs_1", url: "https://checkout.stripe.test/session" };
  }
}

class MemoryStore implements BillingCheckoutStore {
  founderCount = 50;
  customerId: string | null = null;
  projection: BillingSubscriptionProjection | null = null;
  async readCustomerId(): Promise<string | null> {
    return this.customerId;
  }
  async bindCustomer(_ownerId: string, customerId: string): Promise<void> {
    this.customerId = customerId;
  }
  async readProjection(): Promise<BillingSubscriptionProjection | null> {
    return this.projection;
  }
  async countFounderPlaces(): Promise<number> {
    return this.founderCount;
  }
}

function projection(
  overrides: Partial<BillingSubscriptionProjection>,
): BillingSubscriptionProjection {
  return {
    ownerId: "owner",
    customerId: "cus_1",
    subscriptionId: null,
    priceId: null,
    productId: null,
    plan: "free",
    frequency: null,
    status: "missing",
    currentPeriodStartMs: null,
    currentPeriodEndMs: null,
    cancelAtPeriodEnd: false,
    cancelledAtMs: null,
    latestInvoiceId: null,
    scheduleId: null,
    observedAtMs: 1,
    quarantineReason: null,
    ...overrides,
  };
}
