import assert from "node:assert/strict";
import test from "node:test";

import { CloudflareCommerceBuyerCheckoutStore } from "../src/runtime/commerce/cloudflare-buyer-checkout-store";
import { createTestDatabase } from "./support/sqlite-d1-database";

const NOW = 1_900_000_000_000;
const OFFERING_ID = "11111111-1111-4111-8111-111111111111";

test("D1 buyer checkout store reads only the seller-scoped published price and reserves once", async () => {
  const database = await createTestDatabase();
  await seedStorefront(database);
  const store = new CloudflareCommerceBuyerCheckoutStore(
    database.d1,
    {
      async isPremium() {
        return true;
      },
    },
    () => "buyer_local",
  );

  const view = await store.readStorefront(OFFERING_ID);
  assert.equal(view?.account.stripeAccountId, "acct_seller");
  assert.equal(view?.lifecycle.state, "published");
  assert.equal(view?.price.stripePriceId, "price_current");
  assert.equal(view?.publishContext.sellerEligible, true);
  assert.equal(view?.publishContext.termsAccepted, true);

  const buyer = await store.getOrCreateBuyer("123456789012345678", NOW);
  const attempt = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    connectedAccountId: "acct_seller",
    guildId: "111111111111111111",
    offeringId: OFFERING_ID,
    priceId: "price_local",
    buyerId: buyer.id,
    stripeCheckoutSessionId: null,
    status: "creating" as const,
    expiresAtMs: NOW + 30 * 60_000,
    returnedAtMs: null,
    createdAtMs: NOW,
    updatedAtMs: NOW,
  };
  assert.equal(await store.reserveCheckout(attempt), true);
  assert.equal(
    await store.reserveCheckout({
      ...attempt,
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    }),
    false,
  );
  await store.attachCheckoutSession(attempt.id, "cs_stale", NOW + 1);
  assert.equal(await store.expireCheckout(attempt.id, NOW + 1), true);
  assert.equal(
    await store.reserveCheckout({
      ...attempt,
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      createdAtMs: NOW + 1,
      updatedAtMs: NOW + 1,
    }),
    true,
    "a stale-price Checkout is explicitly expired before its replacement is reserved",
  );
  assert.equal(
    await store.reserveCheckout({
      ...attempt,
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      createdAtMs: attempt.expiresAtMs + 1,
      updatedAtMs: attempt.expiresAtMs + 1,
      expiresAtMs: attempt.expiresAtMs + 30 * 60_000,
    }),
    true,
    "an abandoned Checkout expires and no longer blocks a later attempt",
  );
  await store.attachCheckoutSession(
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "cs_checkout",
    attempt.expiresAtMs + 2,
  );
  const active = await store.readActiveCheckout({
    connectedAccountId: "acct_seller",
    buyerId: buyer.id,
    offeringId: OFFERING_ID,
    nowMs: attempt.expiresAtMs + 2,
  });
  assert.equal(active?.stripeCheckoutSessionId, "cs_checkout");
  assert.equal(active?.status, "open");
  const returned = await store.markCheckoutReturned({
    attemptId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    offeringId: OFFERING_ID,
    buyerId: buyer.id,
    nowMs: attempt.expiresAtMs + 3,
  });
  assert.equal(returned?.status, "returned");
  database.close();
});

test("D1 checkout rate limit resets after its window", async () => {
  const database = await createTestDatabase();
  const store = new CloudflareCommerceBuyerCheckoutStore(database.d1, {
    async isPremium() {
      return true;
    },
  });
  const input = {
    buyerId: "buyer",
    offeringId: OFFERING_ID,
    nowMs: NOW,
    windowMs: 600_000,
    maximumAttempts: 2,
  };
  assert.equal(await store.claimCheckoutRateLimit(input), true);
  assert.equal(await store.claimCheckoutRateLimit(input), true);
  assert.equal(await store.claimCheckoutRateLimit(input), false);
  assert.equal(
    await store.claimCheckoutRateLimit({ ...input, nowMs: NOW + input.windowMs + 1 }),
    true,
  );
  database.close();
});

async function seedStorefront(database: Awaited<ReturnType<typeof createTestDatabase>>) {
  await database.d1
    .prepare(
      `INSERT INTO commerce_connected_accounts
       (id, guild_id, stripe_account_id, status, country, default_currency,
        charges_enabled, payouts_enabled, details_submitted, provider_created_at_ms,
        archived_at_ms, created_at_ms, updated_at_ms)
       VALUES ('acct_seller', '111111111111111111', 'acct_seller', 'active', 'AU', 'AUD',
         1, 1, 1, ?, NULL, ?, ?)`,
    )
    .bind(NOW, NOW, NOW)
    .run();
  await database.d1
    .prepare(
      `INSERT INTO commerce_seller_profiles
       (connected_account_id, guild_id, lifecycle_state, approval_state, support_contact,
        adult_attested_at_ms, two_factor_evidence, guild_created_at_ms,
        ownership_transferred_at_ms, guild_good_standing, seller_good_standing,
        requirements_currently_due_json, requirements_eventually_due_json,
        requirements_pending_verification_json, disabled_reason, reviewed_by_user_id,
        reviewed_at_ms, capabilities_updated_at_ms, created_at_ms, updated_at_ms)
       VALUES ('acct_seller', '111111111111111111', 'active', 'approved',
        'seller@example.test', ?, 'discord_verified', 1, NULL, 1, 1,
        '[]', '[]', '[]', NULL, 'operator', ?, ?, ?, ?)`,
    )
    .bind(NOW, NOW, NOW, NOW, NOW)
    .run();
  await database.d1
    .prepare(
      `INSERT INTO commerce_offerings
       (id, connected_account_id, guild_id, discord_role_id, name, description,
        purchase_type, status, archived_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, 'acct_seller', '111111111111111111', '222222222222222222',
        'VIP', 'VIP access', 'subscription', 'active', NULL, ?, ?)`,
    )
    .bind(OFFERING_ID, NOW, NOW)
    .run();
  await database.d1
    .prepare(
      `INSERT INTO commerce_offering_lifecycles
       (offering_id, connected_account_id, guild_id, state, terms_version,
        included_benefits_json, support_contact, role_manageable, repair_deadline_at_ms,
        retire_at_ms, published_at_ms, archived_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, 'acct_seller', '111111111111111111', 'published', 'terms-v1',
        '["VIP channels"]', 'seller@example.test', 1, NULL, NULL, ?, NULL, ?, ?)`,
    )
    .bind(OFFERING_ID, NOW, NOW, NOW)
    .run();
  await database.d1
    .prepare(
      `INSERT INTO commerce_seller_acceptances
       (id, connected_account_id, terms_version, accepted_by_user_id, accepted_at_ms, created_at_ms)
       VALUES ('acceptance', 'acct_seller', 'terms-v1', 'owner', ?, ?)`,
    )
    .bind(NOW, NOW)
    .run();
  await database.d1
    .prepare(
      `INSERT INTO commerce_prices
       (id, connected_account_id, offering_id, stripe_product_id, stripe_price_id,
        currency, unit_amount_minor, price_type, recurring_interval, status,
        provider_created_at_ms, retired_at_ms, created_at_ms)
       VALUES ('price_local', 'acct_seller', ?, 'prod_vip', 'price_current',
        'AUD', 500, 'recurring', 'month', 'active', ?, NULL, ?)`,
    )
    .bind(OFFERING_ID, NOW, NOW)
    .run();
}
