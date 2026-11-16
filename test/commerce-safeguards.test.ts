/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import {
  COMMERCE_CONTROL_EFFECTS,
  COMMERCE_PILOT_LIMITS,
  CommerceSafeguardsService,
} from "../src/commerce/safeguards";
import { SqliteCommerceSafeguardStore } from "./support/sqlite/runtime/commerce/sqlite-safeguard-store";
import { createTestDatabase } from "./support/sqlite-d1-database";

const NOW = Date.UTC(2030, 5, 15);

test("atomic capacity claims enforce subscriber and per-currency volume limits", async () => {
  const database = await createTestDatabase();
  seedSeller(database);
  for (let index = 0; index < 99; index += 1) {
    insertSubscription(database, `sub-${index}`);
  }
  const store = new SqliteCommerceSafeguardStore(database.d1);
  assert.equal(await store.claimCapacity(claim("claim-100", "AUD", 100)), true);
  assert.equal(
    await store.claimCapacity(claim("claim-101", "AUD", 100)),
    false,
    "in-flight claims close the 100-subscriber race",
  );
  await store.releaseCapacity("claim-100");
  database.execRaw("DELETE FROM commerce_subscriptions;");

  insertPayment(database, "payment-aud", "AUD", 499_900);
  assert.equal(await store.claimCapacity(claim("claim-aud-limit", "AUD", 100)), true);
  assert.equal(await store.claimCapacity(claim("claim-aud-over", "AUD", 20)), false);
  assert.equal(
    await store.claimCapacity(claim("claim-usd-independent", "USD", 20)),
    true,
    "AUD and USD limits must not be combined",
  );
  database.close();
});

test("control switches block only their declared financial surface and expire safely", async () => {
  const database = await createTestDatabase();
  seedSeller(database);
  const store = new SqliteCommerceSafeguardStore(database.d1);
  const service = new CommerceSafeguardsService(
    store,
    () => NOW,
    () => "control-1",
  );
  await service.setControl({
    scopeType: "guild",
    scopeId: "guild-1",
    controlType: "new_checkout",
    enabled: true,
    reasonCode: "operator_pause",
    actorUserId: "operator-1",
  });
  assert.equal(await store.claimCapacity(claim("blocked", "AUD", 100)), false);
  assert.deepEqual(COMMERCE_CONTROL_EFFECTS.new_checkout, {
    newPurchases: true,
    existingRenewals: false,
    supportPayments: false,
    webhookIngestion: false,
    customerPortal: false,
    reconciliation: false,
    roleDelivery: false,
    refunds: false,
    sellerDashboard: false,
  });
  const dashboard = await service.readDashboard("guild-1");
  assert.match(dashboard?.blockReasons[0] ?? "", /new_checkout/);

  const expiring = new CommerceSafeguardsService(
    store,
    () => NOW,
    () => "control-2",
  );
  await expiring.setControl({
    scopeType: "guild",
    scopeId: "guild-1",
    controlType: "new_checkout",
    enabled: true,
    reasonCode: "short_pause",
    actorUserId: "operator-1",
    expiresAtMs: NOW + 1,
  });
  const afterExpiry = new SqliteCommerceSafeguardStore(database.d1);
  assert.equal(
    await afterExpiry.claimCapacity({ ...claim("after-expiry", "AUD", 100), nowMs: NOW + 2 }),
    true,
  );
  database.close();
});

test("renewal shutdown blocks new subscriptions but preserves support checkout", async () => {
  const database = await createTestDatabase();
  seedSeller(database);
  const store = new SqliteCommerceSafeguardStore(database.d1);
  const service = new CommerceSafeguardsService(
    store,
    () => NOW,
    () => "renewal-shutdown",
  );
  await service.setControl({
    scopeType: "global",
    scopeId: "commerce",
    controlType: "renewal_shutdown",
    enabled: true,
    reasonCode: "operator_pause",
    actorUserId: "operator-1",
  });

  assert.equal(await store.claimCapacity(claim("subscription-blocked", "AUD", 100)), false);
  assert.equal(
    await store.claimCapacity({
      ...claim("support-allowed", "AUD", 100),
      checkoutKind: "support",
      offeringId: null,
    }),
    true,
  );
  database.close();
});

test("storefront visibility applies global and offering-scoped purchase controls", async () => {
  const database = await createTestDatabase();
  seedSeller(database);
  const store = new SqliteCommerceSafeguardStore(database.d1);
  let sequence = 0;
  const service = new CommerceSafeguardsService(
    store,
    () => NOW,
    () => `visibility-control-${++sequence}`,
  );
  await service.setControl({
    scopeType: "offering",
    scopeId: "offering-1",
    controlType: "offering_suspension",
    enabled: true,
    reasonCode: "offering_pause",
    actorUserId: "operator-1",
  });
  assert.equal(
    await service.isStorefrontPurchaseAllowed({
      offering: { guildId: "guild-1", id: "offering-1" },
    } as never),
    false,
  );
  assert.equal(
    await service.isStorefrontPurchaseAllowed({
      offering: { guildId: "guild-1", id: "another-offering" },
    } as never),
    true,
  );

  await service.setControl({
    scopeType: "guild",
    scopeId: "guild-1",
    controlType: "new_checkout",
    enabled: true,
    reasonCode: "guild_pause",
    actorUserId: "operator-1",
  });
  assert.equal(
    await service.isStorefrontPurchaseAllowed({
      offering: { guildId: "guild-1", id: "another-offering" },
    } as never),
    false,
  );
  database.close();
});

test("support claims enforce the 500-unit payment ceiling and threshold alerts are durable", async () => {
  const database = await createTestDatabase();
  seedSeller(database);
  const store = new SqliteCommerceSafeguardStore(database.d1);
  assert.equal(
    await store.claimCapacity({
      ...claim("support-max", "USD", COMMERCE_PILOT_LIMITS.supportPaymentMinor),
      checkoutKind: "support",
      offeringId: null,
    }),
    true,
  );
  assert.equal(
    await store.claimCapacity({
      ...claim("support-over", "USD", COMMERCE_PILOT_LIMITS.supportPaymentMinor + 1),
      checkoutKind: "support",
      offeringId: null,
    }),
    false,
  );
  insertPayment(database, "payment-alert", "AUD", 450_000);
  await store.refreshLimitAlerts("acct_1", "guild-1", NOW);
  const thresholds = database
    .query<{ threshold_percent: number }>(
      `SELECT threshold_percent FROM commerce_limit_alerts
       WHERE metric = 'monthly_gross' AND currency = 'AUD' ORDER BY threshold_percent`,
    )
    .map((row) => row.threshold_percent);
  assert.deepEqual(thresholds, [70, 90]);
  database.close();
});

function claim(id: string, currency: "AUD" | "USD", amountMinor: number) {
  return {
    id,
    checkoutKind: "subscription" as const,
    connectedAccountId: "acct_1",
    guildId: "guild-1",
    offeringId: "offering-1",
    currency,
    amountMinor,
    expiresAtMs: NOW + 31 * 60_000,
    nowMs: NOW,
  };
}

function seedSeller(database: Awaited<ReturnType<typeof createTestDatabase>>): void {
  database.execRaw(`
    INSERT INTO commerce_connected_accounts
      (id,guild_id,stripe_account_id,status,country,default_currency,charges_enabled,
       payouts_enabled,details_submitted,provider_created_at_ms,archived_at_ms,created_at_ms,updated_at_ms)
    VALUES ('acct_1','guild-1','acct_1','active','AU','AUD',1,1,1,${NOW},NULL,${NOW},${NOW});
    INSERT INTO commerce_seller_profiles
      (connected_account_id,guild_id,lifecycle_state,approval_state,support_contact,
       adult_attested_at_ms,two_factor_evidence,guild_created_at_ms,ownership_transferred_at_ms,
       guild_good_standing,seller_good_standing,requirements_currently_due_json,
       requirements_eventually_due_json,requirements_pending_verification_json,disabled_reason,
       reviewed_by_user_id,reviewed_at_ms,capabilities_updated_at_ms,created_at_ms,updated_at_ms)
    VALUES ('acct_1','guild-1','active','approved','seller@example.test',${NOW},
      'discord_verified',0,NULL,1,1,'[]','[]','[]',NULL,'operator-1',${NOW},${NOW},${NOW},${NOW});
    INSERT INTO commerce_offerings
      (id,connected_account_id,guild_id,discord_role_id,name,description,purchase_type,state,
       terms_version,included_benefits_json,support_contact,role_manageable,
       repair_deadline_at_ms,repair_previous_state,retire_at_ms,published_at_ms,
       archived_at_ms,created_at_ms,updated_at_ms)
    VALUES ('offering-1','acct_1','guild-1','role-1','Role',NULL,'subscription','published',
      'terms','["Role"]','seller@example.test',1,NULL,NULL,NULL,${NOW},NULL,${NOW},${NOW});
  `);
}

function insertSubscription(
  database: Awaited<ReturnType<typeof createTestDatabase>>,
  id: string,
): void {
  database.execRaw(`
    INSERT INTO commerce_subscriptions
      (id,connected_account_id,customer_id,buyer_id,offering_id,price_id,stripe_subscription_id,
       status,cancel_at_period_end,current_period_start_ms,current_period_end_ms,canceled_at_ms,
       ended_at_ms,provider_updated_at_ms,created_at_ms,updated_at_ms)
    VALUES ('${id}','acct_1','customer-${id}','buyer-${id}','offering-1','price-1',
      'stripe-${id}','active',0,${NOW},${NOW + 1000},NULL,NULL,${NOW},${NOW},${NOW});
  `);
}

function insertPayment(
  database: Awaited<ReturnType<typeof createTestDatabase>>,
  id: string,
  currency: "AUD" | "USD",
  amount: number,
): void {
  database.execRaw(`
    INSERT INTO commerce_payments
      (id,connected_account_id,customer_id,buyer_id,offering_id,price_id,
       stripe_payment_intent_id,stripe_charge_id,stripe_checkout_session_id,currency,
       amount_minor,amount_received_minor,amount_refunded_minor,status,provider_created_at_ms,
       paid_at_ms,created_at_ms,updated_at_ms)
    VALUES ('${id}','acct_1','customer-1','buyer-1','offering-1','price-1','pi-${id}',
      'ch-${id}','cs-${id}','${currency}',${amount},${amount},0,'succeeded',
      ${NOW},${NOW},${NOW},${NOW});
  `);
}
