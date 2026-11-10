/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />
import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { createBillingAssignmentService } from "../src/runtime/billing/assignments";
import { CloudflareBillingAssignmentStore } from "../src/runtime/billing/cloudflare-assignment-store";
import { CloudflareBillingSyncStore } from "../src/runtime/billing/cloudflare-billing-sync-store";
import { CloudflareBillingGraceStore } from "../src/runtime/billing/cloudflare-grace-store";
import { createBillingGraceProcessor } from "../src/runtime/billing/grace";
import { createBillingOwnerSync } from "../src/runtime/billing/owner-sync";
import { StripeHttpClient } from "../src/runtime/billing/stripe-http-client";
import type { BillingSubscriptionProjection } from "../src/runtime/billing/types";
import { createTestDatabase, SqliteD1Database } from "./support/sqlite-d1-database";

test("zero-value first invoices use normal assignments and renewal Grace with or without a saved method", async (t) => {
  for (const savedMethod of [null, "pm_saved"]) {
    await t.test(savedMethod ? "saved payment method" : "no payment method", async (t) => {
      const database = await createTestDatabase();
      t.after(() => database.close());
      const syncStore = new CloudflareBillingSyncStore(database.d1);
      const assignments = new CloudflareBillingAssignmentStore(database.d1);
      let nowMs = 1_000;
      let status: "active" | "past_due" | "unpaid" = "active";
      let renewal = false;
      let paymentMethod = savedMethod;
      let operationId = 0;
      const stripe = new StripeHttpClient("unused", "2025-06-30.basil", "unused", async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/customers/cus") {
          return Response.json({
            id: "cus",
            invoice_settings: { default_payment_method: paymentMethod },
          });
        }
        assert.equal(url.pathname, "/v1/subscriptions");
        assert.equal(url.searchParams.get("customer"), "cus");
        return Response.json({
          data: [
            {
              id: "sub",
              customer: "cus",
              status,
              default_payment_method: paymentMethod,
              items: {
                data: [
                  {
                    price: { id: "price", product: "prod" },
                    current_period_start: renewal ? 31_536_001 : 1,
                    current_period_end: renewal ? 63_072_001 : 31_536_001,
                  },
                ],
              },
              cancel_at_period_end: false,
              latest_invoice: {
                id: renewal ? "in_renewal" : "in_zero",
                paid: status === "active",
                amount_due: renewal ? 13_500 : 0,
                amount_paid: renewal && status === "active" ? 13_500 : 0,
                billing_reason: renewal ? "subscription_cycle" : "subscription_create",
              },
            },
          ],
        });
      });
      const syncOwner = createBillingOwnerSync({
        stripe: {
          async readOwnerState(customerId) {
            return { ...(await stripe.readOwnerState(customerId)), observedAtMs: nowMs };
          },
        },
        store: syncStore,
        catalog: new Map([
          [
            "price",
            {
              priceId: "price",
              productId: "prod",
              plan: "premium",
              frequency: "yearly",
              cohort: "standard",
            },
          ],
        ]),
        now: () => nowMs,
        createId: () => `sync-${++operationId}`,
      });
      await syncStore.bindCustomer("owner", "cus", nowMs);
      const observed = await stripe.readOwnerState("cus");
      assert.equal(observed.subscriptions[0]?.latestInvoicePaid, true);
      assert.equal(observed.subscriptions[0]?.latestInvoiceAmountPaid, 0);
      const initial = await syncOwner({
        ownerId: "owner",
        source: "checkout",
        correlationId: "cs_zero",
      });
      assert.equal(initial.status, "active");
      assert.equal(initial.plan, "premium");
      assert.equal(initial.latestInvoiceId, "in_zero");
      const assignmentService = createBillingAssignmentService({
        store: assignments,
        async listEligibleGuilds() {
          return [{ guildId: "guild", name: "Guild", icon: null }];
        },
        now: () => nowMs,
        createId: () => "assignment",
      });
      await assignmentService.assign(
        "owner",
        { discordUserId: "user", displayName: "Plan Owner" },
        "guild",
      );
      const originalAssignments = await assignments.listAssignments("owner");
      assert.equal(originalAssignments[0]?.ownerId, "owner");
      assert.equal(originalAssignments[0]?.subscriptionId, "sub");
      assert.equal((await assignments.readEffectivePlans(["guild"])).get("guild"), "premium");

      // The once-only discount has ended and no usable payment method remains.
      renewal = true;
      paymentMethod = null;
      nowMs = 31_536_001_000;
      const deadline = nowMs + 7 * 86_400_000;
      for (const failedStatus of ["past_due", "unpaid"] as const) {
        status = failedStatus;
        await syncOwner({ ownerId: "owner", source: "webhook" });
        const failed = await syncStore.readProjection("owner");
        assert.equal(failed?.status, failedStatus);
        assert.equal(failed?.graceEndsAtMs, deadline);
        assert.equal((await assignments.readEffectivePlans(["guild"])).get("guild"), "premium");
        nowMs += 1;
      }
      nowMs = deadline;
      await createBillingGraceProcessor({
        store: new CloudflareBillingGraceStore(database.d1),
        syncOwner,
        now: () => nowMs,
      })();
      assert.equal((await syncStore.readProjection("owner"))?.graceExpiredAtMs, deadline);
      assert.equal((await assignments.readEffectivePlans(["guild"])).get("guild"), "free");
      assert.deepEqual(await assignments.listAssignments("owner"), originalAssignments);

      nowMs += 1;
      paymentMethod = "pm_recovered";
      status = "active";
      await syncOwner({ ownerId: "owner", source: "webhook" });
      assert.equal((await syncStore.readProjection("owner"))?.graceEndsAtMs, null);
      assert.equal((await assignments.readEffectivePlans(["guild"])).get("guild"), "premium");
      assert.deepEqual(await assignments.listAssignments("owner"), originalAssignments);
      assert.equal(await syncStore.readCustomerId("owner"), "cus");
    });
  }
});

test("a failed due-Grace read preserves paid access and the next run safely expires it", async (t) => {
  const database = await createTestDatabase();
  t.after(() => database.close());
  const syncStore = new CloudflareBillingSyncStore(database.d1);
  const graceStore = new CloudflareBillingGraceStore(database.d1);
  const assignments = new CloudflareBillingAssignmentStore(database.d1);
  await syncStore.bindCustomer("owner", "cus", 1);
  await commit(syncStore, pastDue(1_000), "op-1");
  assert.equal(
    await assignments.assign({
      ownerId: "owner",
      subscriptionId: "sub",
      guildId: "guild",
      plan: "premium",
      capacity: 1,
      nowMs: 1_000,
    }),
    true,
  );
  const deadline = 1_000 + 7 * 86_400_000;
  const beforeFailure = await syncStore.readProjection("owner");
  let syncCalls = 0;
  const processor = createBillingGraceProcessor({
    store: graceStore,
    now: () => deadline,
    async syncOwner() {
      syncCalls += 1;
      await commit(syncStore, pastDue(deadline), "op-verified");
      const projection = await syncStore.readProjection("owner");
      assert.ok(projection);
      return projection;
    },
  });
  const failure = new Error("D1_ERROR: internal error");
  t.mock.method(
    graceStore,
    "listDueGraceOwners",
    async () => {
      throw failure;
    },
    { times: 1 },
  );

  await assert.rejects(processor, (error: unknown) => error === failure);
  assert.equal(syncCalls, 0);
  assert.deepEqual(await syncStore.readProjection("owner"), beforeFailure);
  assert.equal((await assignments.readEffectivePlans(["guild"])).get("guild"), "premium");

  await processor();
  await processor();
  assert.equal(syncCalls, 1);
  assert.equal((await syncStore.readProjection("owner"))?.graceExpiredAtMs, deadline);
  assert.equal((await assignments.readEffectivePlans(["guild"])).get("guild"), "free");
  assert.equal((await assignments.listAssignments("owner")).length, 1);
});

test("first failed renewal fixes an exact seven-day deadline and retries do not move it", async () => {
  const database = new SqliteD1Database();
  const store = new CloudflareBillingSyncStore(database as unknown as D1Database);
  await store.bindCustomer("owner", "cus", 1);
  await commit(store, pastDue(1_000), "op-1");
  await commit(store, pastDue(5_000), "op-2");
  const projection = await store.readProjection("owner");
  assert.equal(projection?.graceStartedAtMs, 1_000);
  assert.equal(projection?.graceEndsAtMs, 1_000 + 7 * 86_400_000);
});

test("expiry requires verified current state, retains assignment, and active recovery restores it", async () => {
  const database = new SqliteD1Database();
  const syncStore = new CloudflareBillingSyncStore(database as unknown as D1Database);
  const graceStore = new CloudflareBillingGraceStore(database as unknown as D1Database);
  await syncStore.bindCustomer("owner", "cus", 1);
  await commit(syncStore, pastDue(1_000), "op-1");
  await database
    .prepare(
      "INSERT INTO billing_guild_assignments(guild_id, owner_id, stripe_subscription_id, assigned_at_ms) VALUES ('guild', 'owner', 'sub', 1)",
    )
    .run();
  await database
    .prepare(
      "INSERT INTO guild_entitlements(guild_id, tier, plan, updated_at_ms) VALUES ('guild', 'free', 'premium', 1)",
    )
    .run();
  const deadline = 1_000 + 7 * 86_400_000;
  await graceStore.expireGrace("owner", deadline);
  assert.equal(
    (
      await database
        .prepare("SELECT plan FROM guild_entitlements WHERE guild_id = 'guild'")
        .first<{ plan: string }>()
    )?.plan,
    "free",
  );
  assert.equal(
    (
      await database
        .prepare("SELECT COUNT(*) AS count FROM billing_guild_assignments")
        .first<{ count: number }>()
    )?.count,
    1,
  );
  await commit(syncStore, { ...pastDue(deadline + 1), status: "active" }, "op-recovery");
  assert.equal(
    (
      await database
        .prepare("SELECT plan FROM guild_entitlements WHERE guild_id = 'guild'")
        .first<{ plan: string }>()
    )?.plan,
    "premium",
  );
});

test("reconciliation failure attempts persist across Grace store instances", async () => {
  const database = new SqliteD1Database();
  await new CloudflareBillingGraceStore(database as unknown as D1Database).recordFailure(
    "owner",
    "Stripe unavailable",
    1,
    3,
  );
  await new CloudflareBillingGraceStore(database as unknown as D1Database).recordFailure(
    "owner",
    "Stripe unavailable",
    2,
    3,
  );
  await new CloudflareBillingGraceStore(database as unknown as D1Database).recordFailure(
    "owner",
    "Stripe unavailable",
    3,
    3,
  );

  assert.deepEqual(
    await database
      .prepare(
        "SELECT attempt_count, terminal_at_ms FROM billing_reconciliation_failures WHERE owner_id = 'owner'",
      )
      .first(),
    { attempt_count: 3, terminal_at_ms: 3 },
  );
  assert.deepEqual(
    await database
      .prepare(
        "SELECT owner_id, kind, status FROM billing_support_cases WHERE id = 'reconciliation:owner'",
      )
      .first(),
    { owner_id: "owner", kind: "reconciliation_terminal", status: "open" },
  );
});

async function commit(
  store: CloudflareBillingSyncStore,
  projection: BillingSubscriptionProjection,
  id: string,
) {
  const generation = await store.acquireOwnerSync("owner", projection.observedAtMs, 1);
  assert.ok(generation);
  assert.equal(
    await store.commitOwnerSync({
      ownerId: "owner",
      generation,
      projection,
      operation: {
        id,
        ownerId: "owner",
        kind: "sync",
        source: "scheduled",
        correlationId: null,
        summaryJson: "{}",
        createdAtMs: projection.observedAtMs,
      },
    }),
    true,
  );
}
function pastDue(observedAtMs: number): BillingSubscriptionProjection {
  return {
    ownerId: "owner",
    customerId: "cus",
    subscriptionId: "sub",
    priceId: "price",
    productId: "prod",
    plan: "premium",
    frequency: "monthly",
    status: "past_due",
    currentPeriodStartMs: 0,
    currentPeriodEndMs: 100,
    cancelAtPeriodEnd: false,
    cancelledAtMs: null,
    latestInvoiceId: "in",
    scheduleId: null,
    observedAtMs,
    quarantineReason: null,
  };
}
