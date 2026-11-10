/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import {
  processBillingSyncMessage,
  sweepBillingSyncOutbox,
  type BillingQueueEventStore,
} from "../src/runtime/billing/sync-queue";
import type { BillingSyncQueueMessage } from "../src/runtime/billing/webhook";

test("queue delivery and redelivery converge through full-owner sync", async () => {
  const store = new MemoryQueueStore();
  const calls: unknown[] = [];
  const options = {
    message: { eventId: "evt_1", customerId: "cus_1" },
    attempts: 1,
    store,
    async syncOwner(input: unknown) {
      calls.push(input);
    },
  };
  assert.equal(await processBillingSyncMessage(options), "processed");
  assert.equal(await processBillingSyncMessage(options), "already_processed");
  assert.deepEqual(calls, [
    { ownerId: "owner_1", source: "webhook", correlationId: "evt_1" },
    { ownerId: "owner_1", source: "webhook", correlationId: "evt_1" },
  ]);
});

test("out-of-order events both refresh current owner state and terminal exhaustion is observable", async () => {
  const store = new MemoryQueueStore();
  const order: string[] = [];
  for (const eventId of ["evt_new", "evt_old"]) {
    assert.equal(
      await processBillingSyncMessage({
        message: { eventId, customerId: "cus_1" },
        attempts: 1,
        store,
        async syncOwner(input) {
          order.push(input.correlationId ?? "");
        },
      }),
      "processed",
    );
  }
  assert.deepEqual(order, ["evt_new", "evt_old"]);
  store.ownerId = null;
  assert.equal(
    await processBillingSyncMessage({
      message: { eventId: "evt_missing", customerId: "cus_missing" },
      attempts: 5,
      store,
      async syncOwner() {},
    }),
    "terminal",
  );
  assert.deepEqual(store.terminals, [["evt_missing", "customer_binding_missing"]]);
});

test("outbox sweep repairs commit-success and Queue-send failure", async () => {
  const store = new MemoryQueueStore();
  store.pending = [{ eventId: "evt_1", customerId: "cus_1" }];
  const queued: BillingSyncQueueMessage[] = [];
  assert.equal(
    await sweepBillingSyncOutbox({
      store,
      queue: {
        async send(message) {
          queued.push(message);
        },
      },
      now: () => 10,
    }),
    1,
  );
  assert.deepEqual(queued, store.pending);
  assert.deepEqual(store.sent, ["evt_1"]);
});

class MemoryQueueStore implements BillingQueueEventStore {
  ownerId: string | null = "owner_1";
  pending: BillingSyncQueueMessage[] = [];
  readonly processed = new Set<string>();
  readonly sent: string[] = [];
  readonly terminals: Array<[string, string]> = [];
  async readOwnerId(): Promise<string | null> {
    return this.ownerId;
  }
  async markProcessed(eventId: string): Promise<boolean> {
    const first = !this.processed.has(eventId);
    this.processed.add(eventId);
    return first;
  }
  async markTerminal(eventId: string, reason: string): Promise<void> {
    this.terminals.push([eventId, reason]);
  }
  async listPendingOutbox(): Promise<BillingSyncQueueMessage[]> {
    return this.pending;
  }
  async markOutboxSent(eventId: string): Promise<void> {
    this.sent.push(eventId);
  }
}
