/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />
import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import {
  createBillingAdverseService,
  type BillingAdverseProvider,
  type BillingAdverseStore,
  type StripeDisputeState,
} from "../src/runtime/billing/adverse";
import type { BillingSubscriptionProjection } from "../src/runtime/billing/types";

test("refunds and resolved disputes do not alter entitlement", async () => {
  for (const eventType of ["charge.refunded", "refund.created", "charge.dispute.closed"]) {
    const harness = createHarness(eventType, {
      id: "dp_1",
      status: eventType === "charge.dispute.closed" ? "won" : "lost",
      amount: 100,
      chargeAmount: 100,
      paymentMethodType: "card",
    });
    await harness.service.handleEvent("evt_1", "owner");
    assert.equal(harness.provider.cancelled.length, 0);
    assert.equal(harness.store.ended, 0);
    assert.equal(harness.store.cases.length, 0);
  }
});

test("full card disputes cancel immediately without proration and end assignments", async () => {
  const harness = createHarness("charge.dispute.created", {
    id: "dp_1",
    status: "needs_response",
    amount: 100,
    chargeAmount: 100,
    paymentMethodType: "card",
  });
  await harness.service.handleEvent("evt_1", "owner");
  assert.deepEqual(harness.provider.cancelled, [
    { subscriptionId: "sub_1", idempotencyKey: "dispute-cancel:dp_1" },
  ]);
  assert.equal(harness.store.ended, 1);
  assert.equal(harness.store.cases[0]?.kind, "supported_card_dispute");

  harness.store.projection = { ...harness.store.projection!, status: "cancelled", plan: "free" };
  await harness.service.handleEvent("evt_1", "owner");
  assert.equal(harness.provider.cancelled.length, 1);
  assert.equal(harness.store.ended, 1);
});

test("partial and non-card disputes require operator review without cancellation", async () => {
  for (const dispute of [
    { amount: 50, chargeAmount: 100, paymentMethodType: "card" },
    { amount: 100, chargeAmount: 100, paymentMethodType: "paypal" },
  ]) {
    const harness = createHarness("charge.dispute.created", {
      id: "dp_review",
      status: "under_review",
      ...dispute,
    });
    await harness.service.handleEvent("evt_review", "owner");
    assert.equal(harness.provider.cancelled.length, 0);
    assert.equal(harness.store.ended, 0);
    assert.equal(harness.store.cases[0]?.kind, "unsupported_dispute");
  }
});

function createHarness(eventType: string, dispute: StripeDisputeState) {
  const provider = new MemoryProvider(dispute);
  const store = new MemoryStore();
  return {
    provider,
    store,
    service: createBillingAdverseService({
      provider,
      store,
      readEvent: async () => ({ eventType, objectId: dispute.id }),
      now: () => 10,
    }),
  };
}

class MemoryProvider implements BillingAdverseProvider {
  readonly cancelled: Array<{ subscriptionId: string; idempotencyKey: string }> = [];
  constructor(private readonly dispute: StripeDisputeState) {}
  async readDispute() {
    return this.dispute;
  }
  async cancelImmediately(subscriptionId: string, idempotencyKey: string) {
    this.cancelled.push({ subscriptionId, idempotencyKey });
  }
}

class MemoryStore implements BillingAdverseStore {
  ended = 0;
  readonly cases: Array<Parameters<BillingAdverseStore["openCase"]>[0]> = [];
  projection: BillingSubscriptionProjection | null = {
    ownerId: "owner",
    customerId: "cus_1",
    subscriptionId: "sub_1",
    priceId: "price_pm",
    productId: "prod_p",
    plan: "premium",
    frequency: "monthly",
    status: "active",
    currentPeriodStartMs: 1,
    currentPeriodEndMs: 2,
    cancelAtPeriodEnd: false,
    cancelledAtMs: null,
    latestInvoiceId: null,
    scheduleId: null,
    observedAtMs: 1,
    quarantineReason: null,
  };
  async readProjection() {
    return this.projection;
  }
  async endAssignments() {
    this.ended += 1;
  }
  async openCase(input: Parameters<BillingAdverseStore["openCase"]>[0]) {
    this.cases.push(input);
  }
}
