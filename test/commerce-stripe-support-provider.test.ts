/// <reference types="node/assert/strict" />
import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { StripeCommerceSupportProvider } from "../src/runtime/commerce/stripe-support-provider";

test("creates a direct connected-account support charge with an exact application fee", async () => {
  const calls: Array<{
    accountId: string;
    path: string;
    body: URLSearchParams | undefined;
    idempotencyKey: string | undefined;
  }> = [];
  const provider = new StripeCommerceSupportProvider({
    async requestForConnectedAccount(accountId, path, options) {
      calls.push({
        accountId,
        path,
        body: options?.body,
        idempotencyKey: options?.idempotencyKey,
      });
      return {
        id: "cs_support_1",
        url: "https://checkout.stripe.com/c/pay/support",
      };
    },
  });
  await provider.createSupportCheckout({
    connectedAccountId: "acct_1",
    customerId: "cus_1",
    buyerId: "buyer_1",
    guildId: "guild_1",
    checkoutAttemptId: "attempt_1",
    currency: "AUD",
    amountMinor: 2_000,
    applicationFeeMinor: 100,
    successUrl: "https://hafbot.xyz/commerce/support/return",
    cancelUrl: "https://hafbot.xyz/commerce/support/123",
    expiresAtMs: 1_800_000_000_000,
    idempotencyKey: "commerce:support-checkout:attempt_1",
  });
  assert.equal(calls[0]?.accountId, "acct_1");
  assert.equal(calls[0]?.path, "/v1/checkout/sessions");
  assert.equal(calls[0]?.body?.get("mode"), "payment");
  assert.equal(calls[0]?.body?.get("payment_intent_data[application_fee_amount]"), "100");
  assert.equal(calls[0]?.body?.get("payment_intent_data[metadata][haf_checkout_kind]"), "support");
  assert.equal(calls[0]?.body?.get("line_items[0][price_data][unit_amount]"), "2000");
  assert.equal(calls[0]?.body?.get("line_items[0][price_data][currency]"), "aud");
  assert.equal(calls[0]?.body?.has("subscription_data[application_fee_percent]"), false);
});

test("support refunds proportionally reverse the application fee", async () => {
  let body: URLSearchParams | undefined;
  const provider = new StripeCommerceSupportProvider({
    async requestForConnectedAccount(_accountId, path, options) {
      assert.equal(path, "/v1/refunds");
      body = options?.body;
      return { id: "re_support_1" };
    },
  });
  await provider.createRefund({
    connectedAccountId: "acct_1",
    stripePaymentIntentId: "pi_support_1",
    amountMinor: 500,
    idempotencyKey: "commerce:support-refund:payment-1:intent-1",
  });
  assert.equal(body?.get("payment_intent"), "pi_support_1");
  assert.equal(body?.get("amount"), "500");
  assert.equal(body?.get("refund_application_fee"), "true");
});
