/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { CloudflareBillingSyncStore } from "../src/runtime/billing/cloudflare-billing-sync-store";
import type { BillingSubscriptionProjection } from "../src/runtime/billing/types";
import {
  BillingOwnerSyncBusyError,
  createBillingOwnerSync,
  reconcileAllBillingOwners,
} from "../src/runtime/billing/owner-sync";
import { processBillingSyncMessage } from "../src/runtime/billing/sync-queue";
import { CloudflareBillingWebhookStore } from "../src/runtime/billing/cloudflare-webhook-store";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("D1 Billing sync store binds Customer identity in both directions", async () => {
  const store = new CloudflareBillingSyncStore(new SqliteD1Database() as unknown as D1Database);
  await store.bindCustomer("owner-1", "cus_1", 1);
  assert.equal(await store.readCustomerId("owner-1"), "cus_1");
  await assert.rejects(() => store.bindCustomer("owner-2", "cus_1", 2), /already bound/);
  await assert.rejects(() => store.bindCustomer("owner-1", "cus_2", 2), /already bound/);
});

test("D1 Billing sync store commits projection and ledger together only for the current generation", async () => {
  const database = new SqliteD1Database();
  const store = new CloudflareBillingSyncStore(database as unknown as D1Database);
  await store.bindCustomer("owner-1", "cus_1", 1);
  const generation = await store.acquireOwnerSync("owner-1", 10, 100);
  assert.equal(generation, 1);
  assert.equal(await store.acquireOwnerSync("owner-1", 11, 100), null);
  const committed = await store.commitOwnerSync({
    ownerId: "owner-1",
    generation: 1,
    projection: projection(),
    operation: {
      id: "op-1",
      ownerId: "owner-1",
      kind: "owner_sync_observed",
      source: "operator",
      correlationId: null,
      summaryJson: "{}",
      createdAtMs: 20,
    },
  });
  assert.equal(committed, true);
  assert.equal(
    (await database.prepare("SELECT plan FROM billing_subscriptions").first<{ plan: string }>())
      ?.plan,
    "premium",
  );
  assert.equal(
    (
      await database
        .prepare("SELECT COUNT(*) AS count FROM billing_operations_ledger")
        .first<{ count: number }>()
    )?.count,
    1,
  );
  assert.equal(
    await store.commitOwnerSync({
      ownerId: "owner-1",
      generation: 0,
      projection: { ...projection(), plan: "free" },
      operation: {
        id: "op-stale",
        ownerId: "owner-1",
        kind: "owner_sync_observed",
        source: "scheduled",
        correlationId: null,
        summaryJson: "{}",
        createdAtMs: 21,
      },
    }),
    false,
  );
  assert.equal(
    (
      await database
        .prepare("SELECT COUNT(*) AS count FROM billing_operations_ledger")
        .first<{ count: number }>()
    )?.count,
    1,
  );
});

test("D1 Billing sync store projects assigned Guilds free when a Subscription is cancelled", async () => {
  const database = new SqliteD1Database();
  const store = new CloudflareBillingSyncStore(database as unknown as D1Database);
  await store.bindCustomer("owner-1", "cus_1", 1);
  const firstGeneration = await store.acquireOwnerSync("owner-1", 10, 100);
  assert.equal(firstGeneration, 1);
  assert.equal(
    await store.commitOwnerSync({
      ownerId: "owner-1",
      generation: 1,
      projection: projection(),
      operation: null,
    }),
    true,
  );
  await database
    .prepare(
      "INSERT INTO billing_guild_assignments(guild_id, owner_id, stripe_subscription_id, assigned_at_ms) VALUES (?, ?, ?, ?)",
    )
    .bind("guild-1", "owner-1", "sub_1", 20)
    .run();
  await database
    .prepare(
      "INSERT INTO guild_entitlements(guild_id, tier, plan, updated_at_ms) VALUES (?, ?, ?, ?)",
    )
    .bind("guild-1", "premium", "premium", 20)
    .run();

  const secondGeneration = await store.acquireOwnerSync("owner-1", 30, 100);
  assert.equal(secondGeneration, 2);
  assert.equal(
    await store.commitOwnerSync({
      ownerId: "owner-1",
      generation: 2,
      projection: {
        ...projection(),
        plan: "free",
        status: "cancelled",
        cancelledAtMs: 30,
        observedAtMs: 30,
      },
      operation: null,
    }),
    true,
  );
  assert.equal(
    (
      await database
        .prepare("SELECT plan FROM guild_entitlements WHERE guild_id = ?")
        .bind("guild-1")
        .first<{ plan: string }>()
    )?.plan,
    "free",
  );
  assert.equal(
    (
      await database
        .prepare("SELECT COUNT(*) AS count FROM billing_guild_assignments WHERE owner_id = ?")
        .bind("owner-1")
        .first<{ count: number }>()
    )?.count,
    0,
  );
});

test("D1 Billing sync keeps quarantine cases consistent when expired syncs finish late", async () => {
  const database = new SqliteD1Database();
  const store = new CloudflareBillingSyncStore(database as unknown as D1Database);
  await store.bindCustomer("owner-1", "cus_1", 1);
  const commit = (generation: number, quarantined: boolean, observedAtMs: number) =>
    store.commitOwnerSync({
      ownerId: "owner-1",
      generation,
      projection: {
        ...projection(),
        status: quarantined ? "quarantined" : "active",
        quarantineReason: quarantined ? "multiple_non_terminal_subscriptions" : null,
        observedAtMs,
      },
      operation: null,
    });
  const readCase = () =>
    database
      .prepare(
        "SELECT status, resolved_at_ms, updated_at_ms FROM billing_support_cases WHERE id = ?",
      )
      .bind("quarantine:owner-1")
      .first<{ status: string; resolved_at_ms: number | null; updated_at_ms: number }>();

  // An expired healthy sync must not resolve a quarantine observed by its successor.
  assert.equal(await store.acquireOwnerSync("owner-1", 10, 10), 1);
  assert.equal(await store.acquireOwnerSync("owner-1", 20, 10), 2);
  assert.equal(await commit(2, true, 21), true);
  const quarantinedCase = await readCase();
  assert.equal(quarantinedCase?.status, "open");
  assert.equal(await commit(1, false, 11), false);
  assert.deepEqual(await readCase(), quarantinedCase);

  // An expired quarantined sync must not reopen a case after successful recovery.
  assert.equal(await store.acquireOwnerSync("owner-1", 30, 10), 3);
  assert.equal(await store.acquireOwnerSync("owner-1", 40, 10), 4);
  assert.equal(await commit(4, false, 41), true);
  const resolvedCase = await readCase();
  assert.equal(resolvedCase?.status, "resolved");
  assert.equal(resolvedCase?.resolved_at_ms, 41);
  assert.equal(await commit(3, true, 31), false);
  assert.deepEqual(await readCase(), resolvedCase);

  // A fresh recurrence reopens the case and clears the previous resolution timestamp.
  assert.equal(await store.acquireOwnerSync("owner-1", 50, 10), 5);
  assert.equal(await commit(5, true, 51), true);
  assert.deepEqual(await readCase(), {
    status: "open",
    resolved_at_ms: null,
    updated_at_ms: 51,
  });
});

test("D1 Billing sync store awards each Founder Subscription once and never reopens it", async () => {
  const database = new SqliteD1Database();
  const store = new CloudflareBillingSyncStore(database as unknown as D1Database);
  await store.bindCustomer("owner-1", "cus_1", 1);
  await store.acquireOwnerSync("owner-1", 10, 1);
  const founderProjection = {
    ...projection(),
    pricingCohort: "founder" as const,
    founderAwardedAtMs: 10,
  };
  assert.equal(
    await store.commitOwnerSync({
      ownerId: "owner-1",
      generation: 1,
      projection: founderProjection,
      operation: null,
    }),
    true,
  );
  assert.equal(await store.countFounderPlaces(), 1);

  await store.acquireOwnerSync("owner-1", 20, 1);
  assert.equal(
    await store.commitOwnerSync({
      ownerId: "owner-1",
      generation: 2,
      projection: { ...founderProjection, status: "cancelled", founderAwardedAtMs: null },
      operation: null,
    }),
    true,
  );
  assert.equal(await store.countFounderPlaces(), 1);
});

test("D1 Billing sync releases failures for immediate recovery without duplicate lifecycle delivery", async () => {
  for (const failurePoint of [
    "projection",
    "provider",
    "identity",
    "commit",
    "commit_response",
  ] as const) {
    const database = new SqliteD1Database();
    try {
      const store = new CloudflareBillingSyncStore(database.d1);
      const failure = new Error(`simulated ${failurePoint} failure`);
      const readProjection = store.readProjection.bind(store);
      const commit = store.commitOwnerSync.bind(store);
      let failing = true;
      store.readProjection = async (ownerId) => {
        if (failing && failurePoint === "projection") throw failure;
        return readProjection(ownerId);
      };
      store.commitOwnerSync = async (input) => {
        if (failing && failurePoint === "commit") throw failure;
        const result = await commit(input);
        if (failing && failurePoint === "commit_response") throw failure;
        return result;
      };
      const sync = createBillingOwnerSync({
        store,
        catalog: syncCatalog(),
        now: () => 1_000,
        stripe: {
          async readOwnerState() {
            if (failing && failurePoint === "provider") throw failure;
            return stripeState();
          },
        },
        async resolveOwnerIdentity() {
          if (failing && failurePoint === "identity") throw failure;
          return null;
        },
      });
      await assert.rejects(
        sync({ ownerId: "owner-1", customerId: "cus_1", source: "scheduled" }),
        (error: unknown) => error === failure,
      );
      const [state] = database.query<{
        lease_until_ms: number | null;
        completed_generation: number;
      }>("SELECT lease_until_ms, completed_generation FROM billing_owner_sync_state");
      assert.equal(state?.lease_until_ms, null);
      assert.equal(state?.completed_generation, failurePoint === "commit_response" ? 1 : 0);
      failing = false;
      assert.equal((await sync({ ownerId: "owner-1", source: "webhook" })).plan, "premium");
      assert.equal((await sync({ ownerId: "owner-1", source: "scheduled" })).plan, "premium");
      for (const table of [
        "billing_operations_ledger",
        "billing_delivery_outbox",
        "billing_operation_delivery",
      ]) {
        assert.equal(
          database.query<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)[0]?.count,
          1,
        );
      }
    } finally {
      database.close();
    }
  }
});

test("D1 Billing lease expiry and failed stale executions cannot clear or commit over a successor", async () => {
  const database = new SqliteD1Database();
  try {
    const store = new CloudflareBillingSyncStore(database.d1);
    await store.bindCustomer("owner-1", "cus_1", 1);
    assert.equal(await store.acquireOwnerSync("owner-1", 10, 100), 1);
    assert.equal(await store.acquireOwnerSync("owner-1", 109, 100), null);
    assert.equal(await store.acquireOwnerSync("owner-1", 110, 100), 2);
    await store.releaseOwnerSync("owner-1", 1, 111);
    assert.equal(await store.acquireOwnerSync("owner-1", 111, 100), null);
    assert.equal(
      await store.commitOwnerSync({
        ownerId: "owner-1",
        generation: 1,
        projection: projection(),
        operation: null,
      }),
      false,
    );
    assert.equal(await store.acquireOwnerSync("owner-1", 112, 100), null);
    await store.releaseOwnerSync("owner-1", 2, 112);
    assert.equal(await store.acquireOwnerSync("owner-1", 112, 100), 3);
  } finally {
    database.close();
  }
});

test("concurrent webhook and scheduled Billing sync defer safely and later converge", async () => {
  const database = new SqliteD1Database();
  const originalInfo = console.info;
  const logs: unknown[] = [];
  console.info = (entry) => logs.push(entry);
  let finishRead!: () => void;
  const blocked = new Promise<void>((resolve) => {
    finishRead = resolve;
  });
  try {
    const store = new CloudflareBillingSyncStore(database.d1);
    let nowMs = 1_000;
    let block = false;
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    const sync = createBillingOwnerSync({
      store,
      catalog: syncCatalog(),
      now: () => nowMs,
      stripe: {
        async readOwnerState() {
          if (block) {
            readStarted();
            await blocked;
          }
          return stripeState(nowMs);
        },
      },
    });
    await sync({ ownerId: "owner-1", customerId: "cus_1", source: "operator" });
    nowMs += 100;
    block = true;
    const webhook = sync({ ownerId: "owner-1", source: "webhook" });
    try {
      await started;
      assert.equal(
        await reconcileAllBillingOwners({
          listOwnerIds: () => store.listBoundOwnerIds(),
          syncOwner: sync,
          now: () => nowMs,
        }),
        0,
      );
      await assert.rejects(
        sync({ ownerId: "owner-1", source: "operator" }),
        BillingOwnerSyncBusyError,
      );
    } finally {
      finishRead();
      await webhook;
    }
    block = false;
    nowMs += 5 * 60_000;
    assert.equal(
      await reconcileAllBillingOwners({
        listOwnerIds: () => store.listBoundOwnerIds(),
        syncOwner: sync,
        now: () => nowMs,
      }),
      1,
    );
    assert.equal((await store.readProjection("owner-1"))?.observedAtMs, nowMs);
    assert.equal(
      database.query<{ count: number }>("SELECT COUNT(*) AS count FROM billing_delivery_outbox")[0]
        ?.count,
      1,
    );
    assert.equal(logs.length, 1);
  } finally {
    finishRead();
    console.info = originalInfo;
    database.close();
  }
});

test("webhook contention retains retry and terminal semantics, then recovers after release", async () => {
  const database = new SqliteD1Database();
  try {
    const store = new CloudflareBillingSyncStore(database.d1);
    const webhookStore = new CloudflareBillingWebhookStore(database.d1);
    await store.bindCustomer("owner-1", "cus_1", 1);
    await webhookStore.accept({
      eventId: "evt_1",
      eventType: "customer.subscription.updated",
      objectId: "sub_1",
      customerId: "cus_1",
      createdAtMs: 1,
      payloadHash: "fixture-hash",
    });
    const generation = await store.acquireOwnerSync("owner-1", 1_000, 60_000);
    assert.equal(generation, 1);
    const syncOwner = createBillingOwnerSync({
      store,
      catalog: syncCatalog(),
      now: () => 1_001,
      stripe: { readOwnerState: async () => stripeState() },
    });
    const process = (attempts: number) =>
      processBillingSyncMessage({
        store: webhookStore,
        syncOwner,
        attempts,
        now: () => 1_001,
        message: { eventId: "evt_1", customerId: "cus_1" },
      });
    assert.equal(await process(1), "retry");
    assert.equal(await process(5), "terminal");
    await store.releaseOwnerSync("owner-1", 1, 1_001);
    assert.equal(
      await reconcileAllBillingOwners({ listOwnerIds: () => store.listBoundOwnerIds(), syncOwner }),
      1,
    );
    assert.equal((await store.readProjection("owner-1"))?.status, "active");
    assert.equal(
      database.query<{ count: number }>("SELECT COUNT(*) AS count FROM billing_delivery_outbox")[0]
        ?.count,
      1,
    );
  } finally {
    database.close();
  }
});

function syncCatalog() {
  return new Map([
    [
      "price_1",
      {
        priceId: "price_1",
        productId: "prod_1",
        plan: "premium" as const,
        frequency: "monthly" as const,
        cohort: "standard" as const,
      },
    ],
  ]);
}

function stripeState(observedAtMs = 1_000) {
  return {
    customer: { id: "cus_1", email: null },
    observedAtMs,
    subscriptions: [
      {
        id: "sub_1",
        customerId: "cus_1",
        priceId: "price_1",
        productId: "prod_1",
        status: "active" as const,
        currentPeriodStartMs: 1,
        currentPeriodEndMs: 2,
        cancelAtPeriodEnd: false,
        cancelledAtMs: null,
        latestInvoiceId: "in_1",
        scheduleId: null,
      },
    ],
  };
}

function projection(): BillingSubscriptionProjection {
  return {
    ownerId: "owner-1",
    customerId: "cus_1",
    subscriptionId: "sub_1",
    priceId: "price_1",
    productId: "prod_1",
    plan: "premium",
    frequency: "monthly",
    status: "active",
    currentPeriodStartMs: 1,
    currentPeriodEndMs: 2,
    cancelAtPeriodEnd: false,
    cancelledAtMs: null,
    latestInvoiceId: "in_1",
    scheduleId: null,
    observedAtMs: 2,
    quarantineReason: null,
  };
}
