/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createBillingCatalog } from "../src/runtime/billing/catalog";
import { createLandingPriceCatalog } from "../src/runtime/billing/landing-catalog";

const billingCatalog = createBillingCatalog({
  founderPremiumMonthlyPriceId: "price_fpm",
  founderPremiumYearlyPriceId: "price_fpy",
  legacyFounderPremiumYearlyPriceId: "price_legacy_fpy",
  founderPremiumPlusMonthlyPriceId: "price_fppm",
  founderPremiumPlusYearlyPriceId: "price_fppy",
  legacyFounderPremiumPlusYearlyPriceId: "price_legacy_fppy",
  premiumMonthlyPriceId: "price_pm",
  premiumMonthlyProductId: "prod_premium",
  premiumYearlyPriceId: "price_py",
  premiumYearlyProductId: "prod_premium",
  premiumPlusMonthlyPriceId: "price_ppm",
  premiumPlusMonthlyProductId: "prod_plus",
  premiumPlusYearlyPriceId: "price_ppy",
  premiumPlusYearlyProductId: "prod_plus",
});

test("landing catalogue publishes only a complete approved Stripe Price set and caches it", async () => {
  const requested: string[] = [];
  const values = new Map([
    ["price_fpm", stripePrice("price_fpm", "prod_premium", 2900, "month")],
    ["price_fpy", stripePrice("price_fpy", "prod_premium", 29000, "year")],
    ["price_fppm", stripePrice("price_fppm", "prod_plus", 4900, "month")],
    ["price_fppy", stripePrice("price_fppy", "prod_plus", 49000, "year")],
  ]);
  const catalogue = createLandingPriceCatalog({
    catalog: billingCatalog,
    countFounderPlaces: async () => 3,
    stripe: {
      readPrice: async (priceId) => {
        requested.push(priceId);
        return values.get(priceId)!;
      },
    },
  });

  assert.deepEqual(await catalogue.read(), [
    {
      plan: "premium",
      frequency: "monthly",
      unitAmount: 2900,
      currency: "aud",
      decimalAmount: "29.00",
      formattedAmount: "$29.00",
    },
    {
      plan: "premium",
      frequency: "yearly",
      unitAmount: 29000,
      currency: "aud",
      decimalAmount: "290.00",
      formattedAmount: "$290.00",
    },
    {
      plan: "premium_plus",
      frequency: "monthly",
      unitAmount: 4900,
      currency: "aud",
      decimalAmount: "49.00",
      formattedAmount: "$49.00",
    },
    {
      plan: "premium_plus",
      frequency: "yearly",
      unitAmount: 49000,
      currency: "aud",
      decimalAmount: "490.00",
      formattedAmount: "$490.00",
    },
  ]);
  assert.equal((await catalogue.read())?.length, 4);
  assert.deepEqual(requested.sort(), ["price_fpm", "price_fppm", "price_fppy", "price_fpy"]);
});

test("standard landing prices ignore the retired founder counter", async () => {
  const catalogue = createLandingPriceCatalog({
    catalog: billingCatalog,
    countFounderPlaces: async () => {
      throw new Error("historical counter unavailable");
    },
    stripe: {
      readPrice: async (priceId) => {
        const entry = billingCatalog.get(priceId)!;
        return stripePrice(
          priceId,
          entry.productId,
          499,
          entry.frequency === "monthly" ? "month" : "year",
        );
      },
    },
  });
  assert.equal((await catalogue.read())?.length, 4);
  assert.equal(catalogue.readFounderAdmission, undefined);
});

test("landing catalogue serves bounded stale data and then fails closed", async () => {
  let now = 1_000;
  let active = true;
  const catalogue = createLandingPriceCatalog({
    catalog: billingCatalog,
    now: () => now,
    freshForMs: 100,
    staleForMs: 500,
    cache: new Map(),
    onError: () => {},
    stripe: {
      readPrice: async (priceId) => {
        const entry = billingCatalog.get(priceId)!;
        return {
          ...stripePrice(
            priceId,
            entry.productId,
            entry.plan === "premium" ? 2900 : 4900,
            entry.frequency === "monthly" ? "month" : "year",
          ),
          active,
        };
      },
    },
  });

  assert.equal((await catalogue.read())?.length, 4);
  active = false;
  now += 101;
  assert.equal((await catalogue.read())?.length, 4);
  now += 500;
  assert.equal(await catalogue.read(), null);
});

test("landing catalogue respects Stripe currency minor units", async () => {
  const catalogue = createLandingPriceCatalog({
    catalog: billingCatalog,
    cache: new Map(),
    onError: () => {},
    stripe: {
      readPrice: async (priceId) => {
        const entry = billingCatalog.get(priceId)!;
        return {
          ...stripePrice(
            priceId,
            entry.productId,
            2900,
            entry.frequency === "monthly" ? "month" : "year",
          ),
          currency: "jpy",
        };
      },
    },
  });

  const prices = await catalogue.read();
  assert.equal(prices?.[0]?.decimalAmount, "2900");
  assert.match(prices?.[0]?.formattedAmount ?? "", /2,900/);
  assert.doesNotMatch(prices?.[0]?.formattedAmount ?? "", /\.00/);
});

test("landing catalogue rejects mismatched, partial, and unavailable Stripe data", async () => {
  const mismatched = createLandingPriceCatalog({
    catalog: billingCatalog,
    cache: new Map(),
    onError: () => {},
    stripe: {
      readPrice: async (priceId) => ({
        ...stripePrice(priceId, "prod_wrong", 2900, "month"),
      }),
    },
  });
  const partialCatalog = new Map(billingCatalog);
  partialCatalog.delete("price_fppy");
  const partial = createLandingPriceCatalog({
    catalog: partialCatalog,
    cache: new Map(),
    onError: () => {},
    stripe: {
      readPrice: async (priceId) => {
        const entry = partialCatalog.get(priceId)!;
        return stripePrice(
          priceId,
          entry.productId,
          2900,
          entry.frequency === "monthly" ? "month" : "year",
        );
      },
    },
  });
  const unavailable = createLandingPriceCatalog({
    catalog: billingCatalog,
    cache: new Map(),
    onError: () => {},
    stripe: { readPrice: async () => Promise.reject(new Error("Stripe unavailable")) },
  });

  assert.equal(await mismatched.read(), null);
  assert.equal(await partial.read(), null);
  assert.equal(await unavailable.read(), null);
});

function stripePrice(
  id: string,
  productId: string,
  unitAmount: number,
  interval: "month" | "year",
) {
  return { id, productId, active: true, unitAmount, currency: "aud", interval };
}
