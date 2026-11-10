import assert from "node:assert/strict";
import test from "node:test";

import { StripeCommerceBuyerProvider } from "../src/runtime/commerce/stripe-buyer-provider";

test("Stripe buyer provider scopes subscription Checkout and portal to the seller", async () => {
  const calls: Array<{ account: string; path: string; options: any }> = [];
  const provider = new StripeCommerceBuyerProvider({
    async requestForConnectedAccount(account: string, path: string, options: any) {
      calls.push({ account, path, options });
      if (path === "/v1/customers") return { id: "cus_buyer" };
      if (path === "/v1/checkout/sessions")
        return { id: "cs_checkout", url: "https://checkout.stripe.com/c/pay/test" };
      if (path === "/v1/checkout/sessions/cs_checkout")
        return {
          id: "cs_checkout",
          status: "open",
          url: "https://checkout.stripe.com/c/pay/test",
        };
      if (path === "/v1/checkout/sessions/cs_checkout/expire")
        return { id: "cs_checkout", status: "expired" };
      return { url: "https://billing.stripe.com/p/session" };
    },
  });

  await provider.createCustomer({
    connectedAccountId: "acct_seller",
    buyerId: "buyer_opaque",
    discordUserId: "123456789012345678",
    idempotencyKey: "customer-key",
  });
  await provider.createSubscriptionCheckout({
    connectedAccountId: "acct_seller",
    customerId: "cus_buyer",
    priceId: "price_monthly",
    buyerId: "buyer_opaque",
    guildId: "111111111111111111",
    offeringId: "offering_opaque",
    checkoutAttemptId: "attempt_opaque",
    successUrl: "https://hafbot.xyz/commerce/return?state=signed",
    cancelUrl: "https://hafbot.xyz/commerce/offers/offering_opaque",
    expiresAtMs: 1_900_000_000_000,
    applicationFeePercent: 5,
    idempotencyKey: "checkout-key",
  });
  await provider.retrieveSubscriptionCheckout({
    connectedAccountId: "acct_seller",
    checkoutSessionId: "cs_checkout",
  });
  await provider.expireSubscriptionCheckout({
    connectedAccountId: "acct_seller",
    checkoutSessionId: "cs_checkout",
    idempotencyKey: "expire-checkout-key",
  });
  await provider.createCustomerPortal({
    connectedAccountId: "acct_seller",
    customerId: "cus_buyer",
    returnUrl: "https://hafbot.xyz/commerce/offers/offering_opaque",
    idempotencyKey: "portal-key",
  });

  assert.deepEqual(
    calls.map(({ account, path }) => ({ account, path })),
    [
      { account: "acct_seller", path: "/v1/customers" },
      { account: "acct_seller", path: "/v1/checkout/sessions" },
      { account: "acct_seller", path: "/v1/checkout/sessions/cs_checkout" },
      { account: "acct_seller", path: "/v1/checkout/sessions/cs_checkout/expire" },
      { account: "acct_seller", path: "/v1/billing_portal/sessions" },
    ],
  );
  const checkout = calls[1]?.options.body as URLSearchParams;
  assert.equal(checkout.get("mode"), "subscription");
  assert.equal(checkout.get("subscription_data[application_fee_percent]"), "5");
  assert.equal(checkout.get("expires_at"), "1900000000");
  assert.equal(checkout.get("subscription_data[metadata][haf_guild_id]"), "111111111111111111");
  assert.equal(checkout.get("metadata[haf_offering_id]"), "offering_opaque");
  assert.equal(checkout.has("customer_email"), false);
  assert.equal(checkout.has("billing_address_collection"), false);
  assert.equal(calls[3]?.options.method, "POST");
  assert.equal(calls[3]?.options.idempotencyKey, "expire-checkout-key");
});

test("Stripe buyer provider rejects unsafe return URLs before making a request", async () => {
  let calls = 0;
  const provider = new StripeCommerceBuyerProvider({
    async requestForConnectedAccount() {
      calls += 1;
      return {};
    },
  });
  await assert.rejects(
    provider.createCustomerPortal({
      connectedAccountId: "acct_seller",
      customerId: "cus_buyer",
      returnUrl: "javascript:alert(1)",
      idempotencyKey: "portal-key",
    }),
    /HTTPS/,
  );
  assert.equal(calls, 0);
});
