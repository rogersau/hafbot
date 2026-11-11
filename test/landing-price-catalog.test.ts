/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createBillingCatalog } from "../src/runtime/billing/catalog";
import { createLandingPriceCatalog } from "../src/runtime/billing/landing-catalog";

const billingCatalog = createBillingCatalog({
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
    ["price_pm", stripePrice("price_pm", "prod_premium", 2900, "month")],
    ["price_py", stripePrice("price_py", "prod_premium", 29000, "year")],
    ["price_ppm", stripePrice("price_ppm", "prod_plus", 4900, "month")],
    ["price_ppy", stripePrice("price_ppy", "prod_plus", 49000, "year")],
  ]);
  const catalogue = createLandingPriceCatalog({
    catalog: billingCatalog,
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
  assert.deepEqual(requested.sort(), ["price_pm", "price_ppm", "price_ppy", "price_py"]);
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
  partialCatalog.delete("price_ppy");
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
