/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />
import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { SqliteBillingAssignmentStore } from "./support/sqlite/runtime/billing/sqlite-assignment-store";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("D1 assignment capacity and unique Guild ownership are transactional with plan projection", async () => {
  const database = new SqliteD1Database();
  await seedOwner(database, "owner-1", "cus-1", "sub-1", "premium");
  await seedOwner(database, "owner-2", "cus-2", "sub-2", "premium_plus");
  const store = new SqliteBillingAssignmentStore(database as unknown as D1Database);
  assert.equal(
    await store.assign({
      ownerId: "owner-1",
      subscriptionId: "sub-1",
      guildId: "g1",
      plan: "premium",
      capacity: 1,
      nowMs: 1,
    }),
    true,
  );
  assert.equal(
    await store.assign({
      ownerId: "owner-1",
      subscriptionId: "sub-1",
      guildId: "g2",
      plan: "premium",
      capacity: 1,
      nowMs: 2,
    }),
    false,
  );
  assert.equal(
    await store.assign({
      ownerId: "owner-2",
      subscriptionId: "sub-2",
      guildId: "g1",
      plan: "premium_plus",
      capacity: 3,
      nowMs: 2,
    }),
    false,
  );
  assert.equal(
    (
      await database
        .prepare("SELECT plan FROM guild_entitlements WHERE guild_id = 'g1'")
        .first<{ plan: string }>()
    )?.plan,
    "premium",
  );
  assert.equal((await store.readEffectivePlans(["g1"])).get("g1"), "premium");
  assert.equal(
    (
      await database
        .prepare("SELECT plan FROM guild_entitlements WHERE guild_id = 'g1'")
        .first<{ plan: string }>()
    )?.plan,
    "premium",
  );
  assert.equal(
    await store.move({
      ownerId: "owner-1",
      subscriptionId: "sub-1",
      fromGuildId: "g1",
      toGuildId: "g2",
      plan: "premium",
      nowMs: 3,
    }),
    true,
  );
  assert.equal(
    (
      await database
        .prepare("SELECT plan FROM guild_entitlements WHERE guild_id = 'g1'")
        .first<{ plan: string }>()
    )?.plan,
    "free",
  );
  assert.equal(
    await store.unassign({ ownerId: "owner-1", subscriptionId: "sub-1", guildId: "g2", nowMs: 4 }),
    true,
  );
  assert.equal(
    (
      await database
        .prepare("SELECT plan FROM guild_entitlements WHERE guild_id = 'g2'")
        .first<{ plan: string }>()
    )?.plan,
    "free",
  );
});

test("D1 assignment rebinds a retained Guild to a replacement Subscription without bypassing capacity", async () => {
  const database = new SqliteD1Database();
  await seedOwner(database, "owner-1", "cus-1", "sub-old", "premium");
  const store = new SqliteBillingAssignmentStore(database as unknown as D1Database);
  assert.equal(
    await store.assign({
      ownerId: "owner-1",
      subscriptionId: "sub-old",
      guildId: "g1",
      plan: "premium",
      capacity: 1,
      nowMs: 1,
    }),
    true,
  );
  await database
    .prepare("UPDATE billing_subscriptions SET stripe_subscription_id = ? WHERE owner_id = ?")
    .bind("sub-new", "owner-1")
    .run();
  assert.equal(
    await store.assign({
      ownerId: "owner-1",
      subscriptionId: "sub-new",
      guildId: "g1",
      plan: "premium",
      capacity: 1,
      nowMs: 2,
    }),
    true,
  );
  assert.equal(
    (
      await database
        .prepare("SELECT stripe_subscription_id FROM billing_guild_assignments WHERE guild_id = ?")
        .bind("g1")
        .first<{ stripe_subscription_id: string }>()
    )?.stripe_subscription_id,
    "sub-new",
  );
  assert.equal(
    await store.assign({
      ownerId: "owner-1",
      subscriptionId: "sub-new",
      guildId: "g2",
      plan: "premium",
      capacity: 1,
      nowMs: 3,
    }),
    false,
  );
});

test("D1 assignment writes its ledger and delivery records only when the mutation succeeds", async () => {
  const database = new SqliteD1Database();
  await seedOwner(database, "owner-1", "cus-1", "sub-1", "premium");
  const store = new SqliteBillingAssignmentStore(database as unknown as D1Database);
  assert.equal(
    await store.assign({
      ownerId: "owner-1",
      subscriptionId: "sub-1",
      guildId: "g1",
      plan: "premium",
      capacity: 1,
      nowMs: 1,
      operation: operation("op-success", "owner-1"),
    }),
    true,
  );
  assert.equal(
    await store.assign({
      ownerId: "owner-1",
      subscriptionId: "sub-1",
      guildId: "g2",
      plan: "premium",
      capacity: 1,
      nowMs: 2,
      operation: operation("op-rejected", "owner-1"),
    }),
    false,
  );
  assert.deepEqual(
    (
      await database
        .prepare("SELECT id FROM billing_operations_ledger ORDER BY id")
        .all<{ id: string }>()
    ).results.map((row) => row.id),
    ["op-success"],
  );
  assert.equal(
    Number(
      (
        await database
          .prepare("SELECT COUNT(*) AS count FROM billing_operation_delivery")
          .first<{ count: number }>()
      )?.count,
    ),
    1,
  );
  assert.equal(
    Number(
      (
        await database
          .prepare("SELECT COUNT(*) AS count FROM billing_delivery_outbox")
          .first<{ count: number }>()
      )?.count,
    ),
    1,
  );
});

function operation(id: string, ownerId: string) {
  return {
    id,
    ownerId,
    kind: "guild_assignment_assigned",
    source: "dashboard" as const,
    correlationId: null,
    summaryJson: "{}",
    createdAtMs: 1,
  };
}

async function seedOwner(
  database: SqliteD1Database,
  ownerId: string,
  customerId: string,
  subscriptionId: string,
  plan: string,
) {
  await database
    .prepare(
      "INSERT INTO billing_customer_bindings(owner_id, stripe_customer_id, created_at_ms) VALUES (?, ?, 1)",
    )
    .bind(ownerId, customerId)
    .run();
  await database
    .prepare(
      `INSERT INTO billing_subscriptions(owner_id, stripe_customer_id, stripe_subscription_id, plan, status, observed_at_ms, cancel_at_period_end)
     VALUES (?, ?, ?, ?, 'active', 1, 0)`,
    )
    .bind(ownerId, customerId, subscriptionId, plan)
    .run();
}
