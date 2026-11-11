/// <reference types="node/assert" />
import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { SqliteCommerceOfferingStore } from "./support/sqlite/runtime/commerce/sqlite-offering-store";
import { SqlitePaidRoleStore } from "./support/sqlite/runtime/commerce/sqlite-paid-role-store";
import { createTestDatabase } from "./support/sqlite-d1-database";

test("offering dashboard aggregates currency-safe financials and exposes active price without wallet fields", async () => {
  const database = await createTestDatabase();
  try {
    database.execRaw(`
      INSERT INTO commerce_connected_accounts(id,guild_id,stripe_account_id,status,charges_enabled,payouts_enabled,details_submitted,created_at_ms,updated_at_ms)
        VALUES ('acct_1','guild-1','acct_1','active',1,1,1,1,1);
      INSERT INTO commerce_offerings(id,connected_account_id,guild_id,discord_role_id,name,description,purchase_type,status,created_at_ms,updated_at_ms)
        VALUES ('off-1','acct_1','guild-1','role-1','Gold','desc','subscription','active',1,1);
      INSERT INTO commerce_offering_lifecycles(offering_id,connected_account_id,guild_id,state,terms_version,included_benefits_json,support_contact,role_manageable,published_at_ms,created_at_ms,updated_at_ms)
        VALUES ('off-1','acct_1','guild-1','published','v1','["Private role"]','seller@example.test',1,1,1,1);
      INSERT INTO commerce_prices(id,connected_account_id,offering_id,stripe_product_id,stripe_price_id,currency,unit_amount_minor,price_type,recurring_interval,status,created_at_ms)
        VALUES ('price-1','acct_1','off-1','prod_1','price_1','AUD',500,'recurring','month','active',1);
      INSERT INTO commerce_payments(id,connected_account_id,customer_id,buyer_id,offering_id,price_id,stripe_payment_intent_id,currency,amount_minor,amount_received_minor,amount_refunded_minor,status,created_at_ms,updated_at_ms)
        VALUES ('pay-1','acct_1','cus-1','buyer-1','off-1','price-1','pi-1','AUD',500,500,0,'succeeded',1,1);
    `);
    const dashboard = await new SqliteCommerceOfferingStore(database.d1).readDashboard("acct_1");
    assert.equal(dashboard.offerings[0]?.activePrices[0]?.stripePriceId, "price_1");
    assert.equal(dashboard.offerings[0]?.grossByCurrency.AUD, 500);
    assert.equal(dashboard.offerings[0]?.supportContact, "seller@example.test");
    assert.equal(dashboard.estimatedProceedsAreNonAuthoritative, true);
    assert.equal("walletBalance" in dashboard, false);
  } finally {
    database.close();
  }
});

test("role replacement keeps the old Offering role until every assignment is migrated", async () => {
  const database = await createTestDatabase();
  try {
    database.execRaw(`
      INSERT INTO commerce_connected_accounts(id,guild_id,stripe_account_id,status,charges_enabled,payouts_enabled,details_submitted,created_at_ms,updated_at_ms)
        VALUES ('acct_1','guild-1','acct_1','active',1,1,1,1,1);
      INSERT INTO commerce_offerings(id,connected_account_id,guild_id,discord_role_id,name,purchase_type,status,created_at_ms,updated_at_ms)
        VALUES ('off-1','acct_1','guild-1','role-old','Gold','subscription','active',1,1);
      INSERT INTO commerce_offering_lifecycles(offering_id,connected_account_id,guild_id,state,included_benefits_json,support_contact,role_manageable,published_at_ms,created_at_ms,updated_at_ms)
        VALUES ('off-1','acct_1','guild-1','published','["Private role"]','seller@example.test',1,1,1,1);
      INSERT INTO commerce_buyers(id,discord_user_id,created_at_ms,updated_at_ms)
        VALUES ('buyer-1','user-1',1,1);
      INSERT INTO commerce_entitlements(id,connected_account_id,buyer_id,offering_id,source_type,source_id,status,effective_at_ms,created_at_ms,updated_at_ms)
        VALUES ('ent-1','acct_1','buyer-1','off-1','subscription','sub_1','active',1,1,1);
      INSERT INTO commerce_role_assignments(id,entitlement_id,guild_id,discord_user_id,discord_role_id,status,attempt_count,assigned_at_ms,created_at_ms,updated_at_ms)
        VALUES ('assignment-1','ent-1','guild-1','user-1','role-old','assigned',1,1,1,1);
      INSERT INTO commerce_offerings(id,connected_account_id,guild_id,discord_role_id,name,purchase_type,status,created_at_ms,updated_at_ms)
        VALUES ('off-2','acct_1','guild-1','role-old','Historical','subscription','draft',1,1);
      INSERT INTO commerce_offering_lifecycles(offering_id,connected_account_id,guild_id,state,included_benefits_json,support_contact,role_manageable,created_at_ms,updated_at_ms)
        VALUES ('off-2','acct_1','guild-1','unpublished','["Historical role"]','seller@example.test',1,1,1);
      INSERT INTO commerce_entitlements(id,connected_account_id,buyer_id,offering_id,source_type,source_id,status,effective_at_ms,created_at_ms,updated_at_ms)
        VALUES ('ent-2','acct_1','buyer-1','off-2','subscription','sub_2','active',1,1,1);
      INSERT INTO commerce_role_assignments(id,entitlement_id,guild_id,discord_user_id,discord_role_id,status,attempt_count,assigned_at_ms,created_at_ms,updated_at_ms)
        VALUES ('assignment-2','ent-2','guild-1','user-1','role-old','assigned',1,1,1,1);
    `);
    const catalog = new SqliteCommerceOfferingStore(database.d1);
    const offering = await catalog.readOffering("off-1");
    const lifecycle = await catalog.readLifecycle("off-1");
    assert.ok(offering && lifecycle);
    assert.equal(
      await catalog.beginRoleReplacement({
        offering,
        lifecycle,
        replacementRoleId: "role-new",
        nowMs: 2,
      }),
      "replacement_pending",
    );
    assert.equal((await catalog.readOffering("off-1"))?.discordRoleId, "role-old");
    assert.equal((await catalog.readLifecycle("off-1"))?.state, "repair_required");

    const roleStore = new SqlitePaidRoleStore(database.d1);
    const repair = (await roleStore.listPendingRoleRepairs())[0];
    assert.ok(repair);
    database.execRaw(
      "UPDATE commerce_offerings SET discord_role_id='role-concurrent' WHERE id='off-1'",
    );
    await assert.rejects(
      () => roleStore.completeRoleRepair({ ...repair, repairedCount: 1 }, 3),
      /commerce_role_repair_stale/,
    );
    assert.equal((await catalog.readLifecycle("off-1"))?.state, "repair_required");
    database.execRaw("UPDATE commerce_offerings SET discord_role_id='role-old' WHERE id='off-1'");
    database.execRaw(
      "UPDATE commerce_role_assignments SET discord_role_id='role-new' WHERE id='assignment-1'",
    );
    await roleStore.completeRoleRepair({ ...repair, repairedCount: 1 }, 3);

    assert.equal((await catalog.readOffering("off-1"))?.discordRoleId, "role-new");
    assert.equal((await catalog.readLifecycle("off-1"))?.state, "published");
    assert.equal((await catalog.readOffering("off-2"))?.discordRoleId, "role-old");
    assert.equal(
      database.query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM commerce_role_assignments WHERE entitlement_id='ent-1' AND discord_role_id='role-old'",
      )[0]?.count,
      0,
    );
    assert.equal(
      database.query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM commerce_role_assignments WHERE entitlement_id='ent-2' AND discord_role_id='role-old'",
      )[0]?.count,
      1,
    );
  } finally {
    database.close();
  }
});
