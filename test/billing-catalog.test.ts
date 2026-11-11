import assert from "node:assert/strict";
import test from "node:test";
import { createBillingCatalog, type BillingCatalogConfig } from "../src/runtime/billing/catalog";

const config: BillingCatalogConfig = {
  premiumMonthlyPriceId: "price_pm",
  premiumMonthlyProductId: "prod_p",
  premiumYearlyPriceId: "price_py",
  premiumYearlyProductId: "prod_p",
  premiumPlusMonthlyPriceId: "price_ppm",
  premiumPlusMonthlyProductId: "prod_pp",
  premiumPlusYearlyPriceId: "price_ppy",
  premiumPlusYearlyProductId: "prod_pp",
};

test("the public Billing catalogue contains only four configured plan prices", () => {
  const catalog = createBillingCatalog(config);
  assert.deepEqual(
    [...catalog.values()],
    [
      { priceId: "price_pm", productId: "prod_p", plan: "premium", frequency: "monthly" },
      { priceId: "price_py", productId: "prod_p", plan: "premium", frequency: "yearly" },
      { priceId: "price_ppm", productId: "prod_pp", plan: "premium_plus", frequency: "monthly" },
      { priceId: "price_ppy", productId: "prod_pp", plan: "premium_plus", frequency: "yearly" },
    ],
  );
  assert.equal(catalog.has("price_legacy_fpy"), false);
});

test("the public Billing catalogue rejects missing and duplicate identities", () => {
  for (const key of Object.keys(config) as Array<keyof BillingCatalogConfig>) {
    assert.throws(() => createBillingCatalog({ ...config, [key]: " " }), /required/);
  }
  assert.throws(
    () => createBillingCatalog({ ...config, premiumYearlyPriceId: "price_pm" }),
    /unique/,
  );
});
