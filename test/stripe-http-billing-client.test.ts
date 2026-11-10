/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { StripeHttpClient } from "../src/runtime/billing/stripe-http-client";

test("Stripe reads and writes report safe HTTP and JSON failures without response fragments", async () => {
  for (const status of [200, 503]) {
    let cancelled = 0;
    const client = new StripeHttpClient("unused", "2025-06-30.basil", "unused", async () => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('private@example.com {"token":"provider-secret"}'),
          );
          if (status === 200) controller.close();
        },
        cancel() {
          cancelled += 1;
        },
      });
      return new Response(body, { status });
    });
    for (const invoke of [
      () => client.readPrice("price_1"),
      () => client.createCustomer({ ownerId: "owner", email: null, idempotencyKey: "test" }),
    ]) {
      await assert.rejects(invoke, (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          status === 200
            ? "Stripe returned an invalid JSON response."
            : "Stripe request failed with HTTP 503.",
        );
        assert.equal(error.cause, undefined);
        assert.doesNotMatch(error.stack ?? "", /private@example\.com|provider-secret/);
        return true;
      });
    }
    assert.equal(cancelled, status === 503 ? 2 : 0);
  }
});

test("Stripe client wraps the runtime fetch instead of invoking it as a class method", async () => {
  const originalFetch = globalThis.fetch;
  let observedThis: unknown;
  globalThis.fetch = async function (this: typeof globalThis, _input) {
    // eslint-disable-next-line typescript-eslint/no-this-alias -- The test's purpose is to prove fetch runs detached from the client.
    observedThis = this;
    return Response.json({
      id: "price_1",
      product: "prod_1",
      active: true,
      unit_amount: 1900,
      currency: "aud",
      recurring: { interval: "month" },
    });
  } as typeof fetch;

  try {
    const client = new StripeHttpClient("sk_test", "2025-06-30.basil", "bpc_staging");
    assert.equal((await client.readPrice("price_1")).unitAmount, 1900);
    assert.notEqual(observedThis, client);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Stripe subscription Checkout delegates payment collection to Stripe and preserves hosted settings", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = new StripeHttpClient(
    "sk_test",
    "2025-06-30.basil",
    "bpc_staging",
    async (input, init) => {
      requests.push({ url: String(input), init });
      return Response.json({ id: "cs_1", url: "https://checkout.stripe.test/cs_1" });
    },
  );
  const checkout = await client.createCheckout({
    customerId: "cus_1",
    priceId: "price_1",
    ownerId: "owner",
    successUrl: "https://haf/success",
    cancelUrl: "https://haf/cancel",
    idempotencyKey: "checkout:owner:intent",
  });
  assert.deepEqual(checkout, { id: "cs_1", url: "https://checkout.stripe.test/cs_1" });
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request?.url, "https://api.stripe.com/v1/checkout/sessions");
  assert.equal(request?.init?.method, "POST");
  const body = new URLSearchParams(String(request?.init?.body));
  assert.equal(
    request?.init?.headers && (request.init.headers as Record<string, string>)["idempotency-key"],
    "checkout:owner:intent",
  );
  assert.equal(
    request?.init?.headers && (request.init.headers as Record<string, string>)["stripe-version"],
    "2025-06-30.basil",
  );
  assert.deepEqual(Object.fromEntries(body), {
    mode: "subscription",
    customer: "cus_1",
    client_reference_id: "owner",
    "line_items[0][price]": "price_1",
    "line_items[0][quantity]": "1",
    success_url: "https://haf/success",
    cancel_url: "https://haf/cancel",
    allow_promotion_codes: "true",
    payment_method_collection: "if_required",
    "automatic_tax[enabled]": "false",
    "adaptive_pricing[enabled]": "true",
    "subscription_data[metadata][haf_owner_id]": "owner",
    "payment_method_types[0]": "card",
    "payment_method_types[1]": "link",
  });
});

test("Stripe Portal sessions use the reviewed configuration and pinned API version", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = new StripeHttpClient(
    "sk_test",
    "2025-06-30.basil",
    "bpc_staging",
    async (input, init) => {
      requests.push({ url: String(input), init });
      return Response.json({ url: "https://billing.stripe.test/session" });
    },
  );
  await client.createPortal({
    customerId: "cus_1",
    returnUrl: "https://haf/admin/billing",
    idempotencyKey: "portal:owner:intent",
  });
  const request = requests[0];
  const body = new URLSearchParams(String(request?.init?.body));
  assert.equal(body.get("configuration"), "bpc_staging");
  assert.equal(
    request?.init?.headers && (request.init.headers as Record<string, string>)["stripe-version"],
    "2025-06-30.basil",
  );
});

test("Stripe owner reads Basil Subscription Item billing periods", async () => {
  const client = new StripeHttpClient(
    "sk_test",
    "2025-06-30.basil",
    "bpc_staging",
    async (input) => {
      const url = String(input);
      if (url.includes("/v1/customers/")) {
        return Response.json({ id: "cus_1", email: "owner@example.test" });
      }
      return Response.json({
        data: [
          {
            id: "sub_1",
            customer: "cus_1",
            status: "active",
            items: {
              data: [
                {
                  id: "si_1",
                  current_period_start: 100,
                  current_period_end: 200,
                  price: { id: "price_1", product: "prod_1" },
                },
              ],
            },
            cancel_at_period_end: false,
            canceled_at: null,
            latest_invoice: "in_1",
            schedule: null,
          },
        ],
      });
    },
  );

  const state = await client.readOwnerState("cus_1");
  assert.equal(state.subscriptions[0]?.currentPeriodStartMs, 100_000);
  assert.equal(state.subscriptions[0]?.currentPeriodEndMs, 200_000);
});

test("Stripe scheduled downgrade creates from the Subscription before updating phases", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = new StripeHttpClient(
    "sk_test",
    "2025-06-30.basil",
    "bpc_staging",
    async (input, init) => {
      requests.push({ url: String(input), init });
      return requests.length === 1
        ? Response.json({ id: "sub_sched_1", phases: [{ start_date: 100 }] })
        : Response.json({ id: "sub_sched_1" });
    },
  );

  await client.schedulePrice({
    subscriptionId: "sub_1",
    currentPriceId: "price_plus",
    nextPriceId: "price_premium",
    currentPeriodEndMs: 200_000,
    idempotencyKey: "schedule:owner:intent",
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.url, "https://api.stripe.com/v1/subscription_schedules");
  assert.equal(
    new URLSearchParams(String(requests[0]?.init?.body)).get("from_subscription"),
    "sub_1",
  );
  assert.equal(
    requests[0]?.init?.headers &&
      (requests[0].init.headers as Record<string, string>)["idempotency-key"],
    "schedule:owner:intent:create",
  );
  assert.equal(requests[1]?.url, "https://api.stripe.com/v1/subscription_schedules/sub_sched_1");
  const updateBody = new URLSearchParams(String(requests[1]?.init?.body));
  assert.equal(updateBody.get("phases[0][start_date]"), "100");
  assert.equal(updateBody.get("phases[0][end_date]"), "200");
  assert.equal(updateBody.get("phases[1][items][0][price]"), "price_premium");
  assert.equal(updateBody.get("proration_behavior"), "none");
});
