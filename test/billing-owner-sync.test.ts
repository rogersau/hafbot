/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { createBillingCatalog } from "../src/runtime/billing/catalog";
import {
  createBillingOwnerSync,
  BillingOwnerSyncBusyError,
  reconcileAllBillingOwners,
  type BillingSyncStore,
  type StripeOwnerStateReader,
} from "../src/runtime/billing/owner-sync";
import type {
  BillingLedgerOperation,
  BillingSubscriptionProjection,
  StripeOwnerState,
  StripeSubscriptionState,
} from "../src/runtime/billing/types";

const catalog = createBillingCatalog({
  premiumMonthlyPriceId: "price_pm",
  premiumMonthlyProductId: "prod_p",
  premiumYearlyPriceId: "price_py",
  premiumYearlyProductId: "prod_p",
  premiumPlusMonthlyPriceId: "price_ppm",
  premiumPlusMonthlyProductId: "prod_pp",
  premiumPlusYearlyPriceId: "price_ppy",
  premiumPlusYearlyProductId: "prod_pp",
});

test("full-owner sync projects every Stripe lifecycle state through the catalog", async () => {
  const cases: Array<
    [StripeSubscriptionState["status"], BillingSubscriptionProjection["status"], string]
  > = [
    ["active", "active", "premium"],
    ["incomplete", "incomplete", "free"],
    ["past_due", "past_due", "premium"],
    ["unpaid", "unpaid", "premium"],
    ["canceled", "cancelled", "free"],
  ];
  for (const [stripeStatus, expectedStatus, expectedPlan] of cases) {
    const store = new MemoryBillingSyncStore();
    const sync = createBillingOwnerSync({
      stripe: new FakeStripe(ownerState([subscription(stripeStatus)])),
      store,
      catalog,
      now: () => 2_000,
      createId: () => `op-${stripeStatus}`,
    });
    const projection = await sync({ ownerId: "owner", customerId: "cus_1", source: "operator" });
    assert.equal(projection.status, expectedStatus);
    assert.equal(projection.plan, expectedPlan);
    assert.equal(store.operations.length, 1);
  }
});

test("missing and unknown catalog observations fail closed", async () => {
  const missing = await run(ownerState([]));
  assert.equal(missing.status, "missing");
  assert.equal(missing.plan, "free");

  const unknown = await run(ownerState([{ ...subscription("active"), priceId: "price_unknown" }]));
  assert.equal(unknown.status, "quarantined");
  assert.equal(unknown.quarantineReason, "unknown_catalog");
  assert.equal(unknown.plan, "free");
});

test("private retired prices are unknown to public subscription reconciliation", async () => {
  for (const priceId of ["price_fpm", "price_legacy_fpy", "price_legacy_fppy"]) {
    const projected = await run(ownerState([{ ...subscription("active"), priceId }]));
    assert.equal(projected.status, "quarantined");
    assert.equal(projected.quarantineReason, "unknown_catalog");
    assert.equal(projected.plan, "free");
  }
});

test("quarantine preserves only established access and recovers from an unambiguous catalog match", async () => {
  const store = new MemoryBillingSyncStore();
  const initial = createBillingOwnerSync({
    stripe: new FakeStripe(ownerState([subscription("active")])),
    store,
    catalog,
  });
  await initial({ ownerId: "owner", customerId: "cus_1", source: "operator" });

  const duplicate = createBillingOwnerSync({
    stripe: new FakeStripe(
      ownerState([subscription("active"), { ...subscription("active"), id: "sub_2" }]),
    ),
    store,
    catalog,
  });
  const quarantined = await duplicate({ ownerId: "owner", source: "webhook" });
  assert.equal(quarantined.status, "quarantined");
  assert.equal(quarantined.plan, "premium");
  assert.equal(quarantined.subscriptionId, "sub_1");

  const unknown = createBillingOwnerSync({
    stripe: new FakeStripe(
      ownerState([{ ...subscription("active"), priceId: "price_ppm", productId: "unknown" }]),
    ),
    store,
    catalog,
  });
  assert.equal((await unknown({ ownerId: "owner", source: "webhook" })).plan, "premium");

  const recovered = await initial({ ownerId: "owner", source: "operator" });
  assert.equal(recovered.status, "active");
  assert.equal(recovered.quarantineReason, null);
});

test("owner lease prevents overlap and stale generations cannot commit", async () => {
  const store = new MemoryBillingSyncStore();
  store.activeLease = true;
  const sync = createBillingOwnerSync({
    stripe: new FakeStripe(ownerState([subscription("active")])),
    store,
    catalog,
  });
  await assert.rejects(
    sync({ ownerId: "owner", customerId: "cus_1", source: "scheduled" }),
    /already active/,
  );

  store.activeLease = false;
  store.rejectCommit = true;
  await assert.rejects(sync({ ownerId: "owner", source: "operator" }), /stale/);
  assert.equal(store.operations.length, 0);
});

test("Customer identity is unique in both directions and callers reuse the same idempotent boundary", async () => {
  const store = new MemoryBillingSyncStore();
  store.customerOwners.set("cus_other", "another-owner");
  await assert.rejects(() => store.bindCustomer("owner", "cus_other", 1), /already bound/);
  const sync = createBillingOwnerSync({
    stripe: new FakeStripe(ownerState([subscription("active")])),
    store,
    catalog,
    createId: () => `op-${store.operations.length}`,
    async resolveOwnerIdentity() {
      return { discordUserId: "discord-owner", displayName: "Plan Owner" };
    },
    billingUrl: "https://hafbot.xyz/admin/billing",
  });
  const operator = await sync({ ownerId: "owner", customerId: "cus_1", source: "operator" });
  const scheduled = await sync({ ownerId: "owner", source: "scheduled" });
  assert.deepEqual(operator, scheduled);
  assert.deepEqual(
    store.operations.map((operation) => operation.source),
    ["operator"],
  );
  const summary = JSON.parse(store.operations[0]?.summaryJson ?? "{}") as Record<string, unknown>;
  assert.deepEqual(Object.keys(summary).sort(), [
    "billingPath",
    "effectiveAtMs",
    "eventType",
    "notifyOwner",
    "owner",
    "plan",
    "requiredAction",
    "resultingAccess",
    "subscriptionStatus",
    "summary",
  ]);
  assert.deepEqual(summary.owner, {
    discordUserId: "discord-owner",
    displayName: "Plan Owner",
  });
  assert.equal(summary.billingPath, "https://hafbot.xyz/admin/billing");
  assert.equal(summary.effectiveAtMs, 1_000);
});

test("scheduled reconciliation visits every bound Plan Owner and reports failures after continuing", async () => {
  const visited: string[] = [];
  const stripeFailure = new Error("Stripe unavailable");
  const leaseFailure = new BillingOwnerSyncBusyError(null);
  await assert.rejects(
    reconcileAllBillingOwners({
      async listOwnerIds() {
        return ["owner-a", "owner-b", "owner-c", "owner-d"];
      },
      async syncOwner(input) {
        visited.push(input.ownerId);
        assert.equal(input.source, "scheduled");
        if (input.ownerId === "owner-b") throw stripeFailure;
        if (input.ownerId === "owner-c") throw leaseFailure;
        return {} as BillingSubscriptionProjection;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /2 Plan Owner\(s\): owner-b, owner-c/);
      assert.equal(error.errors.length, 2);
      assert.match(error.errors[0].message, /owner-b/);
      assert.equal(error.errors[0].cause, stripeFailure);
      assert.match(error.errors[1].message, /owner-c/);
      assert.equal(error.errors[1].cause, leaseFailure);
      return true;
    },
  );
  assert.deepEqual(visited, ["owner-a", "owner-b", "owner-c", "owner-d"]);
});

test("scheduled reconciliation defers only typed contention with a recent projection", async () => {
  const nowMs = 2_000_000;
  const logs: unknown[] = [];
  const originalInfo = console.info;
  console.info = (entry) => logs.push(entry);
  try {
    for (const ageMs of [0, 15 * 60_000 - 1]) {
      assert.equal(
        await reconcileAllBillingOwners({
          listOwnerIds: async () => ["busy", "available"],
          async syncOwner({ ownerId }) {
            if (ownerId === "busy") throw new BillingOwnerSyncBusyError(nowMs - ageMs);
            return {} as BillingSubscriptionProjection;
          },
          now: () => nowMs,
        }),
        1,
      );
    }
  } finally {
    console.info = originalInfo;
  }
  assert.deepEqual(
    logs,
    [0, 15 * 60_000 - 1].map((projectionAgeMs) => ({
      event: "haf.metric",
      metric: "billing_owner_reconciliation",
      outcome: "deferred",
      reason: "owner_sync_busy",
      projectionAgeMs,
    })),
  );

  for (const failure of [
    new BillingOwnerSyncBusyError(null),
    new BillingOwnerSyncBusyError(nowMs - 15 * 60_000),
    new BillingOwnerSyncBusyError(nowMs - 30 * 60_000),
    new BillingOwnerSyncBusyError(nowMs + 1),
    new Error("A Billing sync is already active for this Plan Owner."),
  ]) {
    const visited: string[] = [];
    await assert.rejects(
      reconcileAllBillingOwners({
        listOwnerIds: async () => ["busy", "available"],
        async syncOwner({ ownerId }) {
          visited.push(ownerId);
          if (ownerId === "busy") throw failure;
          return {} as BillingSubscriptionProjection;
        },
        now: () => nowMs,
      }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors[0].cause, failure);
        return true;
      },
    );
    assert.deepEqual(visited, ["busy", "available"]);
  }
});

test("failed sync retains both the original and lease cleanup failure", async () => {
  const store = new MemoryBillingSyncStore();
  const providerFailure = new Error("Stripe unavailable");
  const releaseFailure = new Error("D1 unavailable");
  store.releaseOwnerSync = async () => {
    throw releaseFailure;
  };
  const sync = createBillingOwnerSync({
    stripe: {
      async readOwnerState() {
        throw providerFailure;
      },
    },
    store,
    catalog,
  });
  await assert.rejects(
    sync({ ownerId: "owner", customerId: "cus_1", source: "scheduled" }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [providerFailure, releaseFailure]);
      return true;
    },
  );
});

async function run(state: StripeOwnerState): Promise<BillingSubscriptionProjection> {
  return createBillingOwnerSync({
    stripe: new FakeStripe(state),
    store: new MemoryBillingSyncStore(),
    catalog,
  })({ ownerId: "owner", customerId: "cus_1", source: "operator" });
}

function ownerState(subscriptions: StripeSubscriptionState[]): StripeOwnerState {
  return { customer: { id: "cus_1", email: null }, subscriptions, observedAtMs: 1_000 };
}

function subscription(status: StripeSubscriptionState["status"]): StripeSubscriptionState {
  return {
    id: "sub_1",
    customerId: "cus_1",
    priceId: "price_pm",
    productId: "prod_p",
    status,
    currentPeriodStartMs: 100,
    currentPeriodEndMs: 200,
    cancelAtPeriodEnd: false,
    cancelledAtMs: status === "canceled" ? 150 : null,
    latestInvoiceId: "in_1",
    scheduleId: null,
  };
}

class FakeStripe implements StripeOwnerStateReader {
  constructor(private readonly state: StripeOwnerState) {}
  async readOwnerState(): Promise<StripeOwnerState> {
    return this.state;
  }
}

class MemoryBillingSyncStore implements BillingSyncStore {
  readonly customerIds = new Map<string, string>();
  readonly customerOwners = new Map<string, string>();
  readonly operations: BillingLedgerOperation[] = [];
  projection: BillingSubscriptionProjection | null = null;
  generation = 0;
  activeLease = false;
  rejectCommit = false;

  async readCustomerId(ownerId: string): Promise<string | null> {
    return this.customerIds.get(ownerId) ?? null;
  }
  async readProjection(): Promise<BillingSubscriptionProjection | null> {
    return this.projection;
  }
  async bindCustomer(ownerId: string, customerId: string, _nowMs: number): Promise<void> {
    const existingOwner = this.customerOwners.get(customerId);
    if (existingOwner && existingOwner !== ownerId) throw new Error("Customer already bound");
    this.customerIds.set(ownerId, customerId);
    this.customerOwners.set(customerId, ownerId);
  }
  async acquireOwnerSync(): Promise<number | null> {
    if (this.activeLease) return null;
    this.generation += 1;
    return this.generation;
  }
  async releaseOwnerSync(_ownerId: string, generation: number): Promise<void> {
    if (generation === this.generation) this.activeLease = false;
  }
  async commitOwnerSync(input: {
    ownerId: string;
    generation: number;
    projection: BillingSubscriptionProjection;
    operation: BillingLedgerOperation | null;
  }): Promise<boolean> {
    if (this.rejectCommit || input.generation !== this.generation) return false;
    this.projection = input.projection;
    if (input.operation) this.operations.push(input.operation);
    return true;
  }
}
