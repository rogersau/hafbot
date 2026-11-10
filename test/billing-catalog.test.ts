/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { createBillingCatalog } from "../src/runtime/billing/catalog";

test("legacy annual Prices remain valid Founder catalog identities", () => {
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

  assert.deepEqual(catalog.get("price_legacy_fpy"), {
    priceId: "price_legacy_fpy",
    productId: "prod_p",
    plan: "premium",
    frequency: "yearly",
    cohort: "founder",
    legacy: true,
  });
  assert.deepEqual(catalog.get("price_legacy_fppy"), {
    priceId: "price_legacy_fppy",
    productId: "prod_pp",
    plan: "premium_plus",
    frequency: "yearly",
    cohort: "founder",
    legacy: true,
  });
});
