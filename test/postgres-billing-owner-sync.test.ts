import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { CloudflareBillingSyncStore } from "../src/runtime/billing/cloudflare-billing-sync-store";
import {
  createBillingOwnerSync,
  reconcileAllBillingOwners,
} from "../src/runtime/billing/owner-sync";
import type {
  BillingCatalogEntry,
  StripeOwnerState,
  StripeSubscriptionState,
} from "../src/runtime/billing/types";
import { createPostgresDatabaseCapabilityFromEnvironment } from "../src/runtime/postgres/postgres-capability";
import { createPostgresD1CompatibilityDatabase } from "../src/runtime/postgres/postgres-d1-compat";
import {
  applyPostgresMigrations,
  readPostgresMigrations,
} from "../src/runtime/postgres/postgres-migrations";

const postgresUrl = process.env.TEST_POSTGRES_URL;
const NOW = 1_800_000_000_000;

test(
  "PostgreSQL Billing owner synchronization commits nullable Founder and quarantine state",
  { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
  async (t) => {
    assert.ok(postgresUrl);
    const url = new URL(postgresUrl);
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || !url.pathname.endsWith("_test")) {
      throw new Error("PostgreSQL integration tests require a local database ending in _test.");
    }
    const database = createPostgresDatabaseCapabilityFromEnvironment({
      DATABASE_URL: postgresUrl,
      NODE_ENV: "test",
      PG_POOL_MAX: "4",
    });
    try {
      await database.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
      await applyPostgresMigrations(
        database,
        await readPostgresMigrations(resolve("migrations/postgres")),
      );
      const d1 = createPostgresD1CompatibilityDatabase(database);
      const store = new CloudflareBillingSyncStore(d1);
      const catalog = new Map<string, BillingCatalogEntry>(
        (["standard", "founder"] as const).map((cohort) => [
          `price_${cohort}`,
          {
            priceId: `price_${cohort}`,
            productId: "prod_1",
            plan: "premium",
            frequency: "monthly",
            cohort,
          },
        ]),
      );
      let nowMs = NOW;
      let nextId = 0;
      const subscriptions = new Map<string, StripeSubscriptionState[]>();
      const syncOwner = createBillingOwnerSync({
        store,
        catalog,
        now: () => nowMs,
        createId: () => `op_${++nextId}`,
        stripe: {
          async readOwnerState(customerId): Promise<StripeOwnerState> {
            const state = subscriptions.get(customerId);
            assert.ok(state, "fake Stripe Customer exists");
            return {
              customer: { id: customerId, email: null },
              subscriptions: state,
              observedAtMs: nowMs,
            };
          },
        },
      });
      const assertCompleted = async (ownerId: string, generation: number) => {
        assert.deepEqual(
          await d1
            .prepare(
              "SELECT generation, completed_generation, lease_until_ms, updated_at_ms FROM billing_owner_sync_state WHERE owner_id = ?",
            )
            .bind(ownerId)
            .first(),
          {
            generation,
            completed_generation: generation,
            lease_until_ms: null,
            updated_at_ms: nowMs,
          },
        );
        assert.equal((await store.readProjection(ownerId))?.observedAtMs, nowMs);
      };
      const assertOperations = async (ownerId: string, expected: number) => {
        for (const sql of [
          "SELECT COUNT(*) AS count FROM billing_operations_ledger WHERE owner_id = ?",
          "SELECT COUNT(*) AS count FROM billing_operation_delivery d JOIN billing_operations_ledger l ON l.id = d.operation_id WHERE l.owner_id = ?",
          "SELECT COUNT(*) AS count FROM billing_delivery_outbox d JOIN billing_operations_ledger l ON l.id = d.operation_id WHERE l.owner_id = ?",
        ]) {
          assert.equal(await d1.prepare(sql).bind(ownerId).first("count"), expected);
        }
      };

      await t.test(
        "scheduled refresh preserves NULLs, awards Founders once and completes every lease",
        async () => {
          const fixtures = [
            { ownerId: "missing", subscription: null, founder: false },
            { ownerId: "standard", subscription: subscription("standard"), founder: false },
            {
              ownerId: "founder-unpaid",
              subscription: subscription("founder-unpaid", { priceId: "price_founder" }),
              founder: false,
            },
            {
              ownerId: "founder-paid",
              subscription: subscription("founder-paid", {
                priceId: "price_founder",
                livemode: true,
                latestInvoicePaid: true,
                latestInvoiceAmountPaid: 100,
                latestInvoiceBillingReason: "subscription_create",
              }),
              founder: true,
            },
          ];
          for (const fixture of fixtures) {
            const customerId = `cus_${fixture.ownerId}`;
            subscriptions.set(customerId, fixture.subscription ? [fixture.subscription] : []);
            await syncOwner({ ownerId: fixture.ownerId, customerId, source: "operator" });
            await assertCompleted(fixture.ownerId, 1);
          }

          nowMs += 5 * 60_000;
          assert.equal(
            await reconcileAllBillingOwners({
              listOwnerIds: () => store.listBoundOwnerIds(),
              syncOwner,
              now: () => nowMs,
            }),
            fixtures.length,
          );
          for (const fixture of fixtures) {
            const projection = await store.readProjection(fixture.ownerId);
            assert.ok(projection);
            assert.equal(projection.subscriptionId, fixture.subscription?.id ?? null);
            assert.equal(projection.founderAwardedAtMs, fixture.founder ? NOW : null);
            assert.equal(projection.quarantineReason, null);
            assert.equal(projection.cancelledAtMs, null);
            assert.equal(projection.scheduleId, null);
            assert.equal(projection.plan, fixture.subscription ? "premium" : "free");
            await assertCompleted(fixture.ownerId, 2);
            await assertOperations(fixture.ownerId, fixture.subscription ? 1 : 0);
            // Both an expired generation and a repeated completed generation remain fenced.
            for (const generation of [1, 2]) {
              assert.equal(
                await store.commitOwnerSync({
                  ownerId: fixture.ownerId,
                  generation,
                  projection: { ...projection, observedAtMs: nowMs + 1, quarantineReason: "stale" },
                  operation: {
                    id: `stale_${fixture.ownerId}_${generation}`,
                    ownerId: fixture.ownerId,
                    kind: "subscription_quarantined",
                    source: "scheduled",
                    correlationId: null,
                    summaryJson: "{}",
                    createdAtMs: nowMs + 1,
                  },
                }),
                generation === 2,
              );
              assert.deepEqual(await store.readProjection(fixture.ownerId), projection);
              await assertOperations(fixture.ownerId, fixture.subscription ? 1 : 0);
            }
          }
          assert.equal(await store.countFounderPlaces(), 1);
          assert.deepEqual(
            await d1
              .prepare("SELECT * FROM billing_founder_places")
              .all()
              .then((result) => result.results),
            [
              {
                stripe_subscription_id: "sub_founder-paid",
                owner_id: "founder-paid",
                awarded_at_ms: NOW,
              },
            ],
          );
          assert.equal(
            await d1.prepare("SELECT COUNT(*) AS count FROM billing_support_cases").first("count"),
            0,
          );
        },
      );

      await t.test(
        "quarantine opens, resolves and reopens without duplicate lifecycle delivery",
        async () => {
          const ownerId = "quarantine";
          const customerId = "cus_quarantine";
          const healthy = subscription(ownerId);
          subscriptions.set(customerId, [healthy]);
          await syncOwner({ ownerId, customerId, source: "operator" });
          let generation = 1;
          let operations = 1;
          for (const reason of [
            "multiple_non_terminal_subscriptions",
            null,
            "unknown_catalog",
            null,
          ]) {
            subscriptions.set(
              customerId,
              reason === "multiple_non_terminal_subscriptions"
                ? [healthy, { ...healthy, id: "sub_other" }]
                : [
                    {
                      ...healthy,
                      priceId: reason === "unknown_catalog" ? "price_unknown" : healthy.priceId,
                    },
                  ],
            );
            nowMs += 5 * 60_000;
            const changedAtMs = nowMs;
            operations += 1;
            for (let attempt = 0; attempt < 2; attempt += 1) {
              await syncOwner({ ownerId, source: "scheduled" });
              generation += 1;
              const projection = await store.readProjection(ownerId);
              assert.equal(projection?.quarantineReason, reason);
              assert.equal(projection?.status, reason ? "quarantined" : "active");
              assert.equal(projection?.founderAwardedAtMs, null);
              assert.deepEqual(
                await d1
                  .prepare(
                    "SELECT status, resolved_at_ms, updated_at_ms FROM billing_support_cases WHERE id = ?",
                  )
                  .bind(`quarantine:${ownerId}`)
                  .first(),
                {
                  status: reason ? "open" : "resolved",
                  resolved_at_ms: reason ? null : nowMs,
                  updated_at_ms: nowMs,
                },
              );
              await assertCompleted(ownerId, generation);
              await assertOperations(ownerId, operations);
              nowMs = changedAtMs + 1;
            }
          }
          assert.equal(await store.countFounderPlaces(), 1);
        },
      );
    } finally {
      await database.close();
    }
  },
);

function subscription(
  ownerId: string,
  overrides: Partial<StripeSubscriptionState> = {},
): StripeSubscriptionState {
  return {
    id: `sub_${ownerId}`,
    customerId: `cus_${ownerId}`,
    priceId: "price_standard",
    productId: "prod_1",
    status: "active",
    currentPeriodStartMs: NOW,
    currentPeriodEndMs: NOW + 30 * 24 * 60 * 60_000,
    cancelAtPeriodEnd: false,
    cancelledAtMs: null,
    latestInvoiceId: null,
    scheduleId: null,
    ...overrides,
  };
}
