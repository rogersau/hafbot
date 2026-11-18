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

const alias = {
  priceId: "price_historical_plus_yearly",
  productId: "prod_historical_plus",
  plan: "premium_plus",
  frequency: "yearly",
};

test("reviewed historical aliases add recognition identities without replacing current prices", () => {
  const catalog = createBillingCatalog({
    ...config,
    historicalPricesJson: JSON.stringify([alias]),
  });
  assert.equal(catalog.size, 5);
  assert.deepEqual(catalog.get(alias.priceId), { ...alias, historical: true });
  assert.equal(catalog.get("price_ppy")?.frequency, "yearly");
});

test("historical configuration rejects malformed, incomplete, duplicate and conflicting identities", () => {
  for (const json of [
    "",
    " ",
    "{",
    "null",
    "{}",
    "[null]",
    JSON.stringify([{ ...alias, plan: "free" }]),
    JSON.stringify([{ ...alias, frequency: "weekly" }]),
    JSON.stringify([{ ...alias, priceId: " " }]),
    JSON.stringify([{ ...alias, productId: "prod_wrong space" }]),
    JSON.stringify([{ ...alias, priceId: 123 }]),
    JSON.stringify([{ priceId: alias.priceId }]),
    JSON.stringify([{ ...alias, historical: false }]),
    JSON.stringify([{ ...alias, priceId: "price_ppy" }]),
    JSON.stringify([alias, alias]),
    JSON.stringify([
      alias,
      { ...alias, priceId: "price_other", frequency: "monthly" },
      { ...alias, priceId: "price_conflict", plan: "premium" },
    ]),
    JSON.stringify([{ ...alias, productId: "prod_p" }]),
  ])
    assert.throws(
      () => createBillingCatalog({ ...config, historicalPricesJson: json }),
      /Invalid|unique|one plan/,
    );
  assert.equal(createBillingCatalog({ ...config, historicalPricesJson: "[]" }).size, 4);
});
