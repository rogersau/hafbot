/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import {
  createStripeWebhookHandler,
  type BillingWebhookStore,
} from "../src/runtime/billing/webhook";
import type { VerifiedBillingWebhook } from "../src/runtime/billing/webhook";

const secret = "whsec_test";
const timestamp = 2_000;
const rawBody = JSON.stringify({
  id: "evt_1",
  type: "customer.subscription.updated",
  created: 1_999,
  data: { object: { id: "sub_1", customer: "cus_1", status: "active", secret: "discard" } },
});

test("Stripe webhook rejects invalid signatures without persistence or queue work", async () => {
  const store = new MemoryWebhookStore();
  const messages: unknown[] = [];
  const handler = createStripeWebhookHandler({
    secret,
    store,
    queue: {
      async send(message) {
        messages.push(message);
      },
    },
    now: () => timestamp * 1_000,
  });
  const response = await handler(request("t=2000,v1=bad"));
  assert.equal(response?.status, 400);
  assert.equal(store.events.length, 0);
  assert.equal(messages.length, 0);
});

test("verified raw webhook retains metadata and hash only, then enqueues a refresh trigger", async () => {
  const store = new MemoryWebhookStore();
  const messages: unknown[] = [];
  const handler = createStripeWebhookHandler({
    secret,
    store,
    queue: {
      async send(message) {
        messages.push(message);
      },
    },
    now: () => timestamp * 1_000,
  });
  const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const response = await handler(request(`t=${timestamp},v1=${signature}`));
  assert.equal(response?.status, 200);
  assert.equal(store.events.length, 1);
  assert.deepEqual(messages, [{ eventId: "evt_1", customerId: "cus_1" }]);
  assert.equal(store.events[0]?.eventType, "customer.subscription.updated");
  assert.equal("rawBody" in (store.events[0] ?? {}), false);
  assert.notEqual(store.events[0]?.payloadHash, rawBody);
});

test("Premium Billing rejects verified connected-account events", async () => {
  const store = new MemoryWebhookStore();
  const messages: unknown[] = [];
  const connectedBody = JSON.stringify({
    ...JSON.parse(rawBody),
    account: "acct_seller",
  });
  const handler = createStripeWebhookHandler({
    secret,
    store,
    queue: {
      async send(message) {
        messages.push(message);
      },
    },
    now: () => timestamp * 1_000,
  });
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${connectedBody}`)
    .digest("hex");
  const response = await handler(
    new Request("https://hafbot.test/api/billing/stripe-webhook", {
      method: "POST",
      headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
      body: connectedBody,
    }),
  );

  assert.equal(response?.status, 400);
  assert.deepEqual(store.events, []);
  assert.deepEqual(messages, []);
});

test("verified Stripe events outside the billing allow-list are acknowledged without work", async () => {
  const store = new MemoryWebhookStore();
  const messages: unknown[] = [];
  const ignoredBody = JSON.stringify({
    id: "evt_ignored",
    type: "customer.created",
    created: 1_999,
    data: { object: { id: "cus_ignored" } },
  });
  const handler = createStripeWebhookHandler({
    secret,
    store,
    queue: {
      async send(message) {
        messages.push(message);
      },
    },
    now: () => timestamp * 1_000,
  });
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${ignoredBody}`)
    .digest("hex");
  const response = await handler(
    new Request("https://hafbot.test/api/billing/stripe-webhook", {
      method: "POST",
      headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
      body: ignoredBody,
    }),
  );

  assert.equal(response?.status, 200);
  assert.deepEqual(await response?.json(), { received: true, ignored: true });
  assert.deepEqual(store.events, []);
  assert.deepEqual(messages, []);
});

test("stale webhook signatures and queue-send failures are safe", async () => {
  const store = new MemoryWebhookStore();
  const handler = createStripeWebhookHandler({
    secret,
    store,
    queue: {
      async send() {
        throw new Error("queue unavailable");
      },
    },
    now: () => timestamp * 1_000,
  });
  const staleTimestamp = timestamp - 301;
  const staleSignature = createHmac("sha256", secret)
    .update(`${staleTimestamp}.${rawBody}`)
    .digest("hex");
  assert.equal((await handler(request(`t=${staleTimestamp},v1=${staleSignature}`)))?.status, 400);

  const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  assert.equal((await handler(request(`t=${timestamp},v1=${signature}`)))?.status, 200);
  assert.equal(store.sent.length, 0);
});

test("D1 outage rejects webhook handling before queue delivery so Stripe can retry", async () => {
  const messages: unknown[] = [];
  const handler = createStripeWebhookHandler({
    secret,
    store: {
      async accept() {
        throw new Error("D1 unavailable");
      },
      async markOutboxSent() {},
    },
    queue: {
      async send(message) {
        messages.push(message);
      },
    },
    now: () => timestamp * 1_000,
  });
  const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");

  await assert.rejects(handler(request(`t=${timestamp},v1=${signature}`)), /D1 unavailable/);
  assert.deepEqual(messages, []);
});

test("verified dispute webhooks resolve their Plan Owner through the related Charge", async () => {
  const store = new MemoryWebhookStore();
  const messages: unknown[] = [];
  const disputeBody = JSON.stringify({
    id: "evt_dispute",
    type: "charge.dispute.created",
    created: 1_999,
    data: { object: { id: "dp_1", charge: "ch_1", amount: 2_900 } },
  });
  const handler = createStripeWebhookHandler({
    secret,
    store,
    customerResolver: {
      async resolveChargeCustomer(chargeId) {
        assert.equal(chargeId, "ch_1");
        return "cus_disputed";
      },
    },
    queue: {
      async send(message) {
        messages.push(message);
      },
    },
    now: () => timestamp * 1_000,
  });
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${disputeBody}`)
    .digest("hex");
  const response = await handler(
    new Request("https://hafbot.test/api/billing/stripe-webhook", {
      method: "POST",
      headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
      body: disputeBody,
    }),
  );
  assert.equal(response?.status, 200);
  assert.equal(store.events[0]?.objectId, "dp_1");
  assert.deepEqual(messages, [{ eventId: "evt_dispute", customerId: "cus_disputed" }]);
});

function request(signature: string): Request {
  return new Request("https://hafbot.test/api/billing/stripe-webhook", {
    method: "POST",
    headers: { "stripe-signature": signature },
    body: rawBody,
  });
}

class MemoryWebhookStore implements BillingWebhookStore {
  readonly events: VerifiedBillingWebhook[] = [];
  readonly sent: string[] = [];
  async accept(
    event: VerifiedBillingWebhook,
  ): Promise<{ accepted: boolean; outboxPending: boolean }> {
    const accepted = !this.events.some((candidate) => candidate.eventId === event.eventId);
    if (accepted) this.events.push(event);
    return { accepted, outboxPending: !this.sent.includes(event.eventId) };
  }
  async markOutboxSent(eventId: string): Promise<void> {
    this.sent.push(eventId);
  }
}
