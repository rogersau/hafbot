import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresBillingRuntime } from "../src/runtime/billing/postgres-runtime";
import type { Env } from "../src/env";
import type { PostgresDatabaseCapability } from "../src/runtime/postgres/postgres-capability";

const env: Env = {
  DISCORD_BOT_TOKEN: "fictional-bot-token",
  BOT_USER_ID: "fictional-bot-user",
  DISCORD_PUBLIC_KEY: "fictional-public-key",
  GATEWAY_EVENT_QUEUE: { send: async () => undefined, sendBatch: async () => undefined },
  BILLING_SYNC_QUEUE: { send: async () => undefined, sendBatch: async () => undefined },
  STRIPE_SECRET_KEY: "sk_test_fictional",
  STRIPE_WEBHOOK_SECRET: "whsec_fictional",
  STRIPE_API_VERSION: "2026-06-24.dahlia",
  STRIPE_PORTAL_CONFIGURATION_ID: "bpc_fictional",
  BETTER_AUTH_URL: "https://billing.example.test",
  STRIPE_PREMIUM_MONTHLY_PRICE_ID: "price_pm",
  STRIPE_PREMIUM_YEARLY_PRICE_ID: "price_py",
  STRIPE_PREMIUM_PRODUCT_ID: "prod_p",
  STRIPE_PREMIUM_PLUS_MONTHLY_PRICE_ID: "price_ppm",
  STRIPE_PREMIUM_PLUS_YEARLY_PRICE_ID: "price_ppy",
  STRIPE_PREMIUM_PLUS_PRODUCT_ID: "prod_pp",
};
// Runtime construction and catalog reads must need neither database nor Stripe I/O.
const database = {} as PostgresDatabaseCapability;

test("Postgres Billing runtime wires optional historical configuration and exposes only current offers", async () => {
  for (const historical of [
    undefined,
    "[]",
    JSON.stringify([
      {
        priceId: "price_historical",
        productId: "prod_historical",
        plan: "premium_plus",
        frequency: "yearly",
      },
    ]),
  ]) {
    const runtime = createPostgresBillingRuntime(
      { ...env, STRIPE_HISTORICAL_PRICES_JSON: historical },
      database,
    );
    assert.ok(runtime);
    assert.deepEqual(
      (await runtime.checkoutService.listCatalog()).map(({ priceId }) => priceId),
      ["price_pm", "price_py", "price_ppm", "price_ppy"],
    );
    await assert.rejects(
      runtime.checkoutService.startCheckout({
        ownerId: "owner",
        email: null,
        priceId: "price_historical",
        intentId: "intent_historical",
      }),
      /unsupported_price/,
    );
  }
});

test("Postgres Billing runtime rejects invalid alias configuration", () => {
  for (const json of [
    "",
    "{",
    "null",
    JSON.stringify([
      { priceId: "price_ppy", productId: "prod_pp", plan: "premium_plus", frequency: "yearly" },
    ]),
  ]) {
    assert.throws(
      () => createPostgresBillingRuntime({ ...env, STRIPE_HISTORICAL_PRICES_JSON: json }, database),
      /Invalid|unique/,
    );
  }
});
