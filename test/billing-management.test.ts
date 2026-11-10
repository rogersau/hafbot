/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />
import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { createBillingCatalog } from "../src/runtime/billing/catalog";
import {
  createBillingManagementService,
  type BillingManagementProvider,
  type BillingManagementStore,
} from "../src/runtime/billing/management";
import type { BillingSubscriptionProjection } from "../src/runtime/billing/types";

const catalog = createBillingCatalog({
  founderPremiumMonthlyPriceId: "fpm",
  founderPremiumYearlyPriceId: "fpy",
  legacyFounderPremiumYearlyPriceId: "legacy_fpy",
  founderPremiumPlusMonthlyPriceId: "fppm",
  founderPremiumPlusYearlyPriceId: "fppy",
  premiumMonthlyPriceId: "pm",
  premiumMonthlyProductId: "p",
  premiumYearlyPriceId: "py",
  premiumYearlyProductId: "p",
  premiumPlusMonthlyPriceId: "ppm",
  premiumPlusMonthlyProductId: "pp",
  premiumPlusYearlyPriceId: "ppy",
  premiumPlusYearlyProductId: "pp",
});

test("Premium upgrade is immediate, prorated, pending-payment safe, and sync-only locally", async () => {
  const provider = new FakeProvider();
  const store = new FakeStore("premium", "pm");
  const sync: unknown[] = [];
  const service = createBillingManagementService({
    provider,
    store,
    catalog,
    publicBaseUrl: "https://haf",
    async syncOwner(input) {
      sync.push(input);
      return store.projection;
    },
  });
  assert.deepEqual(await service.changePrice("owner", "ppm", "intent_upgrade"), {
    effective: "immediate",
    chargeImpact: "prorated",
    url: "https://portal",
  });
  assert.deepEqual(provider.updated[0], {
    subscriptionId: "sub",
    priceId: "ppm",
    idempotencyKey: "update-price:owner:intent_upgrade",
    proration: "always_invoice",
    pendingIfIncomplete: true,
  });
  assert.equal(sync.length, 1);
});

test("Premium Plus downgrade schedules renewal and blocks excess assignments or White-Label obligations", async () => {
  const provider = new FakeProvider();
  const store = new FakeStore("premium_plus", "ppm");
  const service = createBillingManagementService({
    provider,
    store,
    catalog,
    publicBaseUrl: "https://haf",
    async syncOwner() {
      return store.projection;
    },
  });
  store.assignmentCount = 2;
  await assert.rejects(() => service.changePrice("owner", "pm", "intent_blocked"), /obligations/);
  store.assignmentCount = 1;
  store.whiteLabel = true;
  await assert.rejects(() => service.changePrice("owner", "pm", "intent_blocked2"), /obligations/);
  store.whiteLabel = false;
  assert.deepEqual(await service.changePrice("owner", "pm", "intent_downgrade"), {
    effective: "renewal",
    effectiveAtMs: 2_000,
    url: "https://portal",
  });
  assert.equal(provider.scheduled.length, 1);
});

test("Portal is ephemeral, cancellation is period-end reversible, and Grace/quarantine block commercial changes", async () => {
  const provider = new FakeProvider();
  const store = new FakeStore("premium", "pm");
  const service = createBillingManagementService({
    provider,
    store,
    catalog,
    publicBaseUrl: "https://haf",
    async syncOwner() {
      return store.projection;
    },
  });
  assert.deepEqual(await service.createPortal("owner", "intent_portal"), {
    url: "https://portal",
  });
  await service.setCancellation("owner", true, "intent_cancel");
  await service.setCancellation("owner", false, "intent_reverse");
  assert.deepEqual(
    provider.cancellations.map((row) => row.cancelAtPeriodEnd),
    [true, false],
  );
  store.projection.status = "past_due";
  await assert.rejects(
    () => service.changePrice("owner", "ppm", "intent_grace"),
    /billing_in_grace/,
  );
  store.projection.status = "active";
  store.projection.quarantineReason = "duplicate";
  await assert.rejects(
    () => service.changePrice("owner", "ppm", "intent_quarantine"),
    /quarantined/,
  );
});

test("Founder subscriptions can change only among Founder Prices", async () => {
  const provider = new FakeProvider();
  const store = new FakeStore("premium", "fpm");
  store.projection.pricingCohort = "founder";
  store.projection.founderAwardedAtMs = 1;
  const service = createBillingManagementService({
    provider,
    store,
    catalog,
    publicBaseUrl: "https://haf",
    async syncOwner() {
      return store.projection;
    },
  });

  await service.changePrice("owner", "fppm", "intent_founder_upgrade");
  assert.equal(provider.updated[0]?.priceId, "fppm");
  await assert.rejects(
    service.changePrice("owner", "ppm", "intent_standard_bypass"),
    /pricing_cohort_mismatch/,
  );
});

test("a Founder TEST price with no live cohort keeps the plan-change guard", async () => {
  const provider = new FakeProvider();
  const store = new FakeStore("premium", "fpm");
  store.projection.pricingCohort = null;
  const service = createBillingManagementService({
    provider,
    store,
    catalog,
    publicBaseUrl: "https://haf",
    async syncOwner() {
      return store.projection;
    },
  });
  await assert.rejects(
    service.changePrice("owner", "fppm", "intent_test_founder"),
    /pricing_cohort_mismatch/,
  );
  assert.equal(provider.updated.length, 0);
  assert.equal(store.projection.pricingCohort, null);
});

test("legacy Founder Prices are valid sources but cannot be selected as targets", async () => {
  const provider = new FakeProvider();
  const store = new FakeStore("premium", "legacy_fpy");
  store.projection.frequency = "yearly";
  store.projection.pricingCohort = "founder";
  store.projection.founderAwardedAtMs = 1;
  const service = createBillingManagementService({
    provider,
    store,
    catalog,
    publicBaseUrl: "https://haf",
    async syncOwner() {
      return store.projection;
    },
  });

  await service.changePrice("owner", "fpm", "intent_from_legacy");
  await assert.rejects(
    () => service.changePrice("owner", "legacy_fpy", "intent_to_legacy"),
    /unsupported_price/,
  );
});

class FakeProvider implements BillingManagementProvider {
  updated: Array<Parameters<BillingManagementProvider["updatePrice"]>[0]> = [];
  scheduled: Array<Parameters<BillingManagementProvider["schedulePrice"]>[0]> = [];
  cancellations: Array<Parameters<BillingManagementProvider["setCancelAtPeriodEnd"]>[0]> = [];
  async createPortal() {
    return { url: "https://portal" };
  }
  async updatePrice(input: Parameters<BillingManagementProvider["updatePrice"]>[0]) {
    this.updated.push(input);
  }
  async schedulePrice(input: Parameters<BillingManagementProvider["schedulePrice"]>[0]) {
    this.scheduled.push(input);
  }
  async setCancelAtPeriodEnd(
    input: Parameters<BillingManagementProvider["setCancelAtPeriodEnd"]>[0],
  ) {
    this.cancellations.push(input);
  }
}
class FakeStore implements BillingManagementStore {
  assignmentCount = 0;
  whiteLabel = false;
  projection: BillingSubscriptionProjection;
  constructor(plan: "premium" | "premium_plus", priceId: string) {
    this.projection = {
      ownerId: "owner",
      customerId: "cus",
      subscriptionId: "sub",
      priceId,
      productId: "prod",
      plan,
      frequency: "monthly",
      status: "active",
      currentPeriodStartMs: 1_000,
      currentPeriodEndMs: 2_000,
      cancelAtPeriodEnd: false,
      cancelledAtMs: null,
      latestInvoiceId: null,
      scheduleId: null,
      observedAtMs: 1,
      quarantineReason: null,
    };
  }
  async readProjection() {
    return this.projection;
  }
  async countAssignments() {
    return this.assignmentCount;
  }
  async hasWhiteLabelObligation() {
    return this.whiteLabel;
  }
}
