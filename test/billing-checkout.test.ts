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

test("Checkout binds a Customer first and supports every current standard Price", async () => {
  const provider = new FakeProvider();
  const store = new MemoryStore();
  const service = createService(provider, store);
  for (const { priceId } of [...catalog.values()].filter((entry) => entry.legacy !== true)) {
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
    priceId: "price_fpm",
    intentId: "intent_duplicate",
  };
  await service.startCheckout(input);
  await service.startCheckout(input);
  assert.deepEqual(
    provider.checkoutCalls.map((call) => call.idempotencyKey),
    ["checkout:owner:intent_duplicate", "checkout:owner:intent_duplicate"],
  );
});

test("current standard Prices remain available before and beyond the former launch limit", async () => {
  const provider = new FakeProvider();
  const store = new MemoryStore();
  const service = createService(provider, store);
  for (const count of [0, 49, 50, 500]) {
    store.founderCount = count;
    const offered = await service.listCatalog();
    assert.deepEqual(
      offered.map((entry) => entry.priceId),
      ["price_fpm", "price_fpy", "price_fppm", "price_fppy"],
    );
    assert.ok(offered.every((entry) => entry.cohort === "standard"));
    await service.startCheckout({
      ownerId: "owner",
      email: null,
      priceId: "price_fpm",
      intentId: `intent_current_${count}`,
    });
  }
  for (const priceId of [
    "price_pm",
    "price_py",
    "price_ppm",
    "price_ppy",
    "price_legacy_fpy",
    "price_legacy_fppy",
  ]) {
    await assert.rejects(
      service.startCheckout({
        ownerId: "owner",
        email: null,
        priceId,
        intentId: "intent_retired_price",
      }),
      /unsupported_price/,
    );
  }
  assert.equal(provider.checkoutCalls.length, 4);
});

test("retired founder counters do not affect standard checkout availability", async () => {
  const store = new MemoryStore();
  store.countFounderPlaces = async () => {
    throw new Error("historical counter unavailable");
  };
  const service = createService(new FakeProvider(), store);
  assert.equal((await service.listCatalog()).length, 4);
  await service.startCheckout({
    ownerId: "owner",
    email: null,
    priceId: "price_fpm",
    intentId: "intent_no_counter",
  });
});

test("a former subscriber can return at the current rate without reclaiming a launch place", async () => {
  const store = new MemoryStore();
  store.founderCount = 500;
  store.projection = projection({
    subscriptionId: "sub_previous",
    priceId: "price_fpm",
    productId: "prod_p",
    plan: "free",
    frequency: "monthly",
    status: "cancelled",
  });
  const provider = new FakeProvider();
  await createService(provider, store).startCheckout({
    ownerId: "owner",
    email: null,
    priceId: "price_fpm",
    intentId: "intent_returning_owner",
  });
  assert.equal(provider.checkoutCalls[0]?.priceId, "price_fpm");
});

test("current Price choices do not depend on a historical subscription cohort", async () => {
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
  for (const cohort of [null, "founder", "standard"] as const) {
    store.projection = { ...store.projection, pricingCohort: cohort };
    const supported = await service.listCatalog("owner");
    assert.equal(supported.length, 4);
    assert.ok(supported.every((entry) => entry.cohort === "standard" && entry.legacy !== true));
  }
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
        priceId: "price_fpm",
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
      priceId: "price_fpm",
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
