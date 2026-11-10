/// <reference types="node/assert" />
import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { CloudflareCommerceOfferingStore } from "../src/runtime/commerce/cloudflare-offering-store";
import { createTestDatabase } from "./support/sqlite-d1-database";

const OFFERING = {
  id: "off-1",
  connectedAccountId: "acct-1",
  guildId: "guild-1",
  discordRoleId: "role-1",
  name: "Gold",
  description: null,
  purchaseType: "subscription" as const,
  status: "active" as const,
  archivedAtMs: null,
  createdAtMs: 1,
  updatedAtMs: 1,
};

test("offering retirement is atomic, deterministic, and preserves the first parent action", async () => {
  const database = await createTestDatabase();
  try {
    database.execRaw(`
      INSERT INTO commerce_connected_accounts(id,guild_id,stripe_account_id,status,charges_enabled,payouts_enabled,details_submitted,created_at_ms,updated_at_ms)
        VALUES ('acct-1','guild-1','acct-1','active',1,1,1,1,1);
      INSERT INTO commerce_offerings(id,connected_account_id,guild_id,discord_role_id,name,purchase_type,status,created_at_ms,updated_at_ms)
        VALUES ('off-1','acct-1','guild-1','role-1','Gold','subscription','active',1,1);
      INSERT INTO commerce_offering_lifecycles(offering_id,connected_account_id,guild_id,state,included_benefits_json,support_contact,role_manageable,created_at_ms,updated_at_ms)
        VALUES ('off-1','acct-1','guild-1','published','["Access"]','seller@example.test',1,1,1);
      INSERT INTO commerce_subscriptions(id,connected_account_id,customer_id,buyer_id,offering_id,price_id,stripe_subscription_id,status,cancel_at_period_end,current_period_end_ms,created_at_ms,updated_at_ms)
        VALUES ('sub-1','acct-1','customer-1','buyer-1','off-1','price-1','sub_stripe_1','active',0,2000,1,1);
      INSERT INTO commerce_subscriptions(id,connected_account_id,customer_id,buyer_id,offering_id,price_id,stripe_subscription_id,status,cancel_at_period_end,current_period_end_ms,created_at_ms,updated_at_ms)
        VALUES ('sub-ended','acct-1','customer-2','buyer-2','off-1','price-1','sub_stripe_ended','ended',0,3000,1,1);
    `);
    const store = new CloudflareCommerceOfferingStore(database.d1);
    const lifecycle = await store.readLifecycle(OFFERING.id);
    assert.ok(lifecycle);

    await store.beginRetirement({
      offering: OFFERING,
      lifecycle,
      actorUserId: "seller-1",
      reasonCode: "seller_requested",
      actionId: "retire-1",
      retireAtMs: 2,
      nowMs: 1,
    });
    await store.beginRetirement({
      offering: OFFERING,
      lifecycle: (await store.readLifecycle(OFFERING.id))!,
      actorUserId: "seller-2",
      reasonCode: "different_reason",
      actionId: "retire-2",
      retireAtMs: 3,
      nowMs: 2,
    });

    const parent = database.query<{
      requested_by_user_id: string;
      reason_code: string;
      status: string;
      active_subscription_count: number;
      latest_period_end_ms: number;
    }>("SELECT * FROM commerce_offering_retirements WHERE offering_id='off-1'")[0];
    assert.deepEqual(
      {
        actor: parent?.requested_by_user_id,
        reason: parent?.reason_code,
        status: parent?.status,
        active: parent?.active_subscription_count,
        latest: parent?.latest_period_end_ms,
      },
      {
        actor: "seller-1",
        reason: "seller_requested",
        status: "scheduling_cancellations",
        active: 1,
        latest: 2000,
      },
    );
    assert.equal(
      database.query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM commerce_financial_provider_actions",
      )[0]?.count,
      1,
    );
    assert.deepEqual(
      database.query<{ operation_key: string; parent_action_id: string; guild_id: string }>(
        "SELECT operation_key,parent_action_id,guild_id FROM commerce_financial_provider_actions",
      )[0],
      {
        operation_key: "commerce:offering-retirement:off-1:sub-1",
        parent_action_id: "retire-1",
        guild_id: "guild-1",
      },
    );
    assert.equal((await store.readOffering(OFFERING.id))?.status, "draft");
    assert.equal((await store.readLifecycle(OFFERING.id))?.state, "retiring");

    database.execRaw(
      "UPDATE commerce_financial_provider_actions SET status='failed' WHERE workflow_id='off-1'; UPDATE commerce_subscriptions SET cancel_at_period_end=1 WHERE id='sub-1'",
    );
    const dashboard = await store.readDashboard("acct-1");
    assert.deepEqual(dashboard.offerings[0]?.retirement, {
      status: "scheduling_cancellations",
      activeSubscriptionCount: 1,
      scheduledCancellationCount: 1,
      failedCancellationCount: 1,
      latestPeriodEndMs: 2000,
      completedAtMs: null,
    });
  } finally {
    database.close();
  }
});

test("offering archive requires complete retirement and no nonterminal subscriptions", async () => {
  const database = await createTestDatabase();
  try {
    database.execRaw(`
      INSERT INTO commerce_offerings(id,connected_account_id,guild_id,discord_role_id,name,purchase_type,status,created_at_ms,updated_at_ms)
        VALUES ('off-1','acct-1','guild-1','role-1','Gold','subscription','draft',1,1);
      INSERT INTO commerce_offering_lifecycles(offering_id,connected_account_id,guild_id,state,included_benefits_json,support_contact,role_manageable,retire_at_ms,created_at_ms,updated_at_ms)
        VALUES ('off-1','acct-1','guild-1','retiring','["Access"]','seller@example.test',1,2,1,1);
      INSERT INTO commerce_offering_retirements(id,connected_account_id,guild_id,offering_id,requested_by_user_id,reason_code,status,active_subscription_count,scheduled_cancellation_count,failed_cancellation_count,created_at_ms,updated_at_ms)
        VALUES ('retire-1','acct-1','guild-1','off-1','seller-1','seller_requested','complete',1,0,0,1,1);
      INSERT INTO commerce_subscriptions(id,connected_account_id,customer_id,buyer_id,offering_id,price_id,stripe_subscription_id,status,cancel_at_period_end,current_period_end_ms,created_at_ms,updated_at_ms)
        VALUES ('sub-1','acct-1','customer-1','buyer-1','off-1','price-1','sub_stripe_1','active',1,2000,1,1);
    `);
    const store = new CloudflareCommerceOfferingStore(database.d1);
    assert.equal(await store.archiveOffering("off-1", 2), false);
    assert.equal((await store.readLifecycle("off-1"))?.state, "retiring");

    database.execRaw(
      "UPDATE commerce_subscriptions SET status='canceled', ended_at_ms=2 WHERE id='sub-1'",
    );
    assert.equal(await store.archiveOffering("off-1", 3), true);
    assert.equal((await store.readLifecycle("off-1"))?.state, "archived");
    assert.equal((await store.readOffering("off-1"))?.status, "archived");
  } finally {
    database.close();
  }
});
