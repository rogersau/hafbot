/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />
import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { createBillingGraceProcessor, type BillingGraceStore } from "../src/runtime/billing/grace";
import type { BillingSubscriptionProjection } from "../src/runtime/billing/types";

test("verified Grace expiry projects Free while retaining assignments, and recovery restores paid access", async () => {
  const store = new MemoryGraceStore();
  const processor = createBillingGraceProcessor({
    store,
    now: () => 8 * 86_400_000,
    async syncOwner() {
      return store.projection;
    },
  });
  await processor();
  assert.equal(store.expired, true);
  assert.equal(store.assignmentRetained, true);
  store.projection = {
    ...store.projection,
    status: "active",
    graceStartedAtMs: null,
    graceEndsAtMs: null,
  };
  await processor();
  assert.equal(store.expireCalls, 1);
});

test("Test Clock renewal failure preserves access until the verified Grace deadline", async () => {
  const store = new MemoryGraceStore();
  const beforeDeadline = createBillingGraceProcessor({
    store,
    now: () => 7 * 86_400_000 - 1,
    async syncOwner() {
      return store.projection;
    },
  });
  await beforeDeadline();
  assert.equal(store.expired, false);

  const afterDeadline = createBillingGraceProcessor({
    store,
    now: () => 7 * 86_400_000 + 1,
    async syncOwner() {
      return store.projection;
    },
  });
  await afterDeadline();
  assert.equal(store.expired, true);
});

test("Stripe outage preserves Grace and eventually records a support-visible terminal failure", async () => {
  const store = new MemoryGraceStore();
  const processor = createBillingGraceProcessor({
    store,
    now: () => 8 * 86_400_000,
    terminalAttempt: 3,
    async syncOwner() {
      throw new Error("Stripe unavailable");
    },
  });
  await processor();
  await processor();
  await processor();
  assert.equal(store.expired, false);
  assert.deepEqual(
    store.failures.map((row) => row.terminal),
    [false, false, true],
  );
});

class MemoryGraceStore implements BillingGraceStore {
  projection: BillingSubscriptionProjection = {
    ownerId: "owner",
    customerId: "cus",
    subscriptionId: "sub",
    priceId: "price",
    productId: "prod",
    plan: "premium",
    frequency: "monthly",
    status: "past_due",
    currentPeriodStartMs: 0,
    currentPeriodEndMs: 1,
    cancelAtPeriodEnd: false,
    cancelledAtMs: null,
    latestInvoiceId: null,
    scheduleId: null,
    observedAtMs: 1,
    quarantineReason: null,
    graceStartedAtMs: 0,
    graceEndsAtMs: 7 * 86_400_000,
    graceExpiredAtMs: null,
  };
  expired = false;
  expireCalls = 0;
  assignmentRetained = true;
  failureCount = 0;
  failures: Array<{ terminal: boolean }> = [];
  async listDueGraceOwners() {
    return this.projection.status === "active" ? [] : ["owner"];
  }
  async readProjection() {
    return this.projection;
  }
  async expireGrace() {
    this.expired = true;
    this.expireCalls += 1;
  }
  async recordFailure(_ownerId: string, _reason: string, _now: number, terminalAttempt: number) {
    this.failureCount += 1;
    this.failures.push({ terminal: this.failureCount >= terminalAttempt });
  }
  async clearFailure() {}
}
