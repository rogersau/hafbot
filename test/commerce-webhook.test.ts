import type { CommerceReconciliationMessage } from "../src/runtime/commerce/reconciliation";
/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import {
  createCommerceStripeWebhookHandler,
  type CommerceWebhookMetadata,
  type CommerceWebhookStore,
} from "../src/runtime/commerce/webhook";

const secret = "whsec_commerce_test";
const timestamp = 2_000;
const account = "acct_seller123";

test("Commerce webhook rejects an invalid signature without billing or commerce work", async () => {
  const store = new MemoryStore();
  const queue = new MemoryQueue();
  const handler = createCommerceStripeWebhookHandler({
    secret,
    store,
    queue,
    now: () => timestamp * 1_000,
  });

  const response = await handler(request(eventBody(), "t=2000,v1=bad"));
  assert.equal(response?.status, 400);
  assert.equal(store.events.length, 0);
  assert.equal(queue.messages.length, 0);
});

test("Commerce webhook requires top-level connected-account context", async () => {
  const store = new MemoryStore();
  const handler = createCommerceStripeWebhookHandler({
    secret,
    store,
    queue: new MemoryQueue(),
    now: () => timestamp * 1_000,
  });
  const body = eventBody({ account: undefined });
  const signature = sign(body, timestamp);

  const response = await handler(request(body, `t=${timestamp},v1=${signature}`));
  assert.equal(response?.status, 400);
  assert.equal(store.events.length, 0);
});

test("Commerce webhook stores safe metadata and queues a refresh trigger", async () => {
  const store = new MemoryStore();
  const queue = new MemoryQueue();
  const body = eventBody({
    id: "evt_commerce_1",
    type: "checkout.session.completed",
    data: { object: { id: "cs_1", customer: "cus_private", amount_total: 2999 } },
    metadata: { email: "buyer@example.com" },
  });
  const handler = createCommerceStripeWebhookHandler({
    secret,
    store,
    queue,
    now: () => timestamp * 1_000,
  });

  const response = await handler(request(body, `t=${timestamp},v1=${sign(body, timestamp)}`));
  assert.equal(response?.status, 200);
  assert.deepEqual(queue.messages, [
    {
      eventId: "evt_commerce_1",
      connectedAccountId: account,
      resourceType: "seller",
      resourceId: account,
      generation: 7,
    },
  ]);
  assert.deepEqual(store.events[0], {
    eventId: "evt_commerce_1",
    eventType: "checkout.session.completed",
    objectId: "cs_1",
    connectedAccountId: account,
    providerCreatedAtMs: 1_999_000,
    payloadHash: store.events[0]?.payloadHash,
    apiVersion: "2026-06-24.dahlia",
  });
  assert.equal("rawBody" in (store.events[0] ?? {}), false);
  assert.equal("customer" in (store.events[0] ?? {}), false);
});

test("duplicate events are idempotent while a pending outbox can be repaired", async () => {
  const store = new MemoryStore();
  const queue = new MemoryQueue();
  const handler = createCommerceStripeWebhookHandler({
    secret,
    store,
    queue,
    now: () => timestamp * 1_000,
  });
  const body = eventBody({ id: "evt_duplicate" });
  const signed = `t=${timestamp},v1=${sign(body, timestamp)}`;

  assert.equal((await handler(request(body, signed)))?.status, 200);
  assert.equal((await handler(request(body, signed)))?.status, 200);
  assert.deepEqual(await (await handler(request(body, signed)))?.json(), {
    received: true,
    duplicate: true,
  });
  assert.equal(store.events.length, 1);
  assert.equal(queue.messages.length, 3);
});

test("queue failures leave the webhook acknowledged for durable outbox repair", async () => {
  const store = new MemoryStore();
  const handler = createCommerceStripeWebhookHandler({
    secret,
    store,
    queue: {
      async send() {
        throw new Error("queue unavailable");
      },
    },
    now: () => timestamp * 1_000,
  });
  const body = eventBody({ id: "evt_queue_gap" });

  const response = await handler(request(body, `t=${timestamp},v1=${sign(body, timestamp)}`));
  assert.equal(response?.status, 200);
  assert.deepEqual(await response?.json(), { received: true, duplicate: false });
  assert.deepEqual(store.sent, []);
});

test("verified but unsupported events are acknowledged without persistence", async () => {
  const store = new MemoryStore();
  const queue = new MemoryQueue();
  const handler = createCommerceStripeWebhookHandler({
    secret,
    store,
    queue,
    now: () => timestamp * 1_000,
  });
  const body = eventBody({ id: "evt_ignored", type: "customer.created" });
  const response = await handler(request(body, `t=${timestamp},v1=${sign(body, timestamp)}`));

  assert.equal(response?.status, 200);
  assert.deepEqual(await response?.json(), { received: true, ignored: true });
  assert.deepEqual(store.events, []);
  assert.deepEqual(queue.messages, []);
});

function eventBody(overrides: Record<string, unknown> = {}): string {
  const base = {
    id: "evt_default",
    type: "payment_intent.succeeded",
    account,
    api_version: "2026-06-24.dahlia",
    created: 1_999,
    data: { object: { id: "pi_1", amount: 2999, customer: "cus_private" } },
  };
  return JSON.stringify({ ...base, ...overrides });
}

function sign(body: string, at: number): string {
  return createHmac("sha256", secret).update(`${at}.${body}`).digest("hex");
}

function request(body: string, signature: string): Request {
  return new Request("https://hafbot.test/api/commerce/stripe-webhook", {
    method: "POST",
    headers: { "stripe-signature": signature },
    body,
  });
}

class MemoryStore implements CommerceWebhookStore {
  readonly events: CommerceWebhookMetadata[] = [];
  readonly sent: string[] = [];

  async accept(
    event: CommerceWebhookMetadata,
  ): Promise<{ accepted: boolean; outboxPending: boolean; generation: number }> {
    const accepted = !this.events.some((candidate) => candidate.eventId === event.eventId);
    if (accepted) this.events.push(event);
    return { accepted, outboxPending: true, generation: 7 };
  }

  async markOutboxSent(message: CommerceReconciliationMessage): Promise<void> {
    this.sent.push(message.eventId);
  }
}

class MemoryQueue {
  readonly messages: Array<{
    eventId: string;
    connectedAccountId: string;
    resourceType: "seller";
    resourceId: string;
    generation: number;
  }> = [];

  async send(message: {
    eventId: string;
    connectedAccountId: string;
    resourceType: "seller";
    resourceId: string;
    generation: number;
  }): Promise<void> {
    this.messages.push(message);
  }
}
