/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import type {
  CommerceConnectedAccount,
  CommerceOffering,
  CommercePrice,
  CommerceSubscription,
} from "../src/commerce";
import { createCloudflareCommerceStore } from "../src/runtime/cloudflare-commerce-store";
import { createTestDatabase } from "./support/sqlite-d1-database";

const NOW = 1_800_000_000_000;

test("notified seller reviews do not consume the pending notification batch", async () => {
  const database = await createTestDatabase();
  try {
    const store = createCloudflareCommerceStore(database.d1);
    for (let index = 0; index < 3; index += 1) {
      const connectedAccountId = `acct_review_${index}`;
      await store.ensureSellerReviewRequest({
        id: `seller-review:${connectedAccountId}`,
        connectedAccountId,
        guildId: `guild-${index}`,
        sellerOwnerUserId: `seller-${index}`,
        guildCreatedAtMs: NOW - 45 * 24 * 60 * 60 * 1_000,
        stripeDetailsSubmitted: true,
        stripeChargesEnabled: true,
        stripePayoutsEnabled: true,
        nowMs: NOW + index,
      });
    }
    await store.claimSellerReviewNotification({
      connectedAccountId: "acct_review_0",
      leaseToken: "notification-lease",
      nowMs: NOW + 3,
      leaseMs: 60_000,
    });
    assert.equal(
      await store.completeSellerReviewNotification({
        connectedAccountId: "acct_review_0",
        leaseToken: "notification-lease",
        channelId: "review-channel",
        messageId: "review-message",
        nowMs: NOW + 4,
      }),
      true,
    );

    assert.equal((await store.readSellerReviewRequest("acct_review_0"))?.state, "pending");
    assert.deepEqual(
      (await store.listPendingSellerReviewNotifications(1)).map((row) => row.connectedAccountId),
      ["acct_review_1"],
    );
    assert.deepEqual(
      (await store.listPendingSellerReviewNotifications()).map((row) => row.connectedAccountId),
      ["acct_review_1", "acct_review_2"],
    );
  } finally {
    database.close();
  }
});

test("seller review decisions remain retryable until the seller approval is persisted", async () => {
  const database = await createTestDatabase();
  try {
    const store = createCloudflareCommerceStore(database.d1);
    const connectedAccountId = "acct_review_1";
    await store.ensureSellerReviewRequest({
      id: `seller-review:${connectedAccountId}`,
      connectedAccountId,
      guildId: "guild-1",
      sellerOwnerUserId: "seller-1",
      guildCreatedAtMs: NOW - 45 * 24 * 60 * 60 * 1_000,
      stripeDetailsSubmitted: true,
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
      nowMs: NOW,
    });

    const claimed = await store.claimSellerReviewDecision({
      connectedAccountId,
      state: "approved",
      actorUserId: "operator-1",
      reason: "discord_button_approved",
      leaseToken: "lease-1",
      nowMs: NOW,
      leaseMs: 60_000,
    });
    assert.equal(claimed?.state, "processing");
    assert.equal(claimed?.decisionState, "approved");
    assert.equal((await store.readSellerReviewRequest(connectedAccountId))?.state, "processing");

    const retryClaim = await store.reclaimExpiredSellerReviewDecision({
      connectedAccountId,
      leaseToken: "lease-2",
      nowMs: NOW + 60_001,
      leaseMs: 60_000,
    });
    assert.equal(retryClaim?.state, "processing");
    const completed = await store.completeSellerReviewDecision({
      connectedAccountId,
      state: "approved",
      leaseToken: "lease-2",
      nowMs: NOW + 3,
    });
    assert.equal(completed?.state, "approved");
    assert.equal(completed?.decisionState, null);
    const notification = await store.claimSellerReviewDecisionNotification({
      connectedAccountId,
      leaseToken: "notification-lease",
      nowMs: NOW + 4,
      leaseMs: 60_000,
    });
    assert.equal(notification?.state, "approved");
    assert.equal(
      await store.completeSellerReviewDecisionNotification({
        connectedAccountId,
        leaseToken: "notification-lease",
        nowMs: NOW + 5,
      }),
      true,
    );
    assert.deepEqual(await store.listUnnotifiedSellerReviewDecisions(), []);
  } finally {
    database.close();
  }
});

test("commerce store keeps seller consent, catalog, buyers, and provider events isolated", async () => {
  const database = await createTestDatabase();
  try {
    const store = createCloudflareCommerceStore(database.d1);
    const account = connectedAccount();
    await store.saveConnectedAccount(account);
    assert.deepEqual(await store.readConnectedAccountByGuild(account.guildId), account);

    const panel = {
      connectedAccountId: account.id,
      guildId: account.guildId,
      channelId: "channel-sales",
      title: "Join our community",
      description: "Pick the access that works for you.",
      messageId: null,
      lastErrorCode: null,
      createdAtMs: NOW,
      updatedAtMs: NOW,
    };
    await store.saveSalesPanel(panel);
    assert.deepEqual(await store.readSalesPanel(account.id), panel);
    await store.saveSalesPanel({
      ...panel,
      messageId: "message-sales",
      updatedAtMs: NOW + 1,
    });
    assert.deepEqual(await store.readSalesPanel(account.id), {
      ...panel,
      messageId: "message-sales",
      updatedAtMs: NOW + 1,
    });

    const acceptance = {
      id: "acceptance-1",
      connectedAccountId: account.id,
      termsVersion: "seller-terms-2026-07",
      acceptedByUserId: "seller-user-1",
      acceptedAtMs: NOW,
      createdAtMs: NOW,
    };
    assert.equal(await store.appendSellerAcceptance(acceptance), true);
    assert.equal(await store.appendSellerAcceptance({ ...acceptance, id: "acceptance-2" }), false);

    const monthly = offering("offering-monthly", "role-monthly", "subscription");
    const oneTime = offering("offering-one-time", "role-supporter", "one_time");
    await store.saveOffering(monthly);
    await store.saveOffering(oneTime);
    assert.equal(
      await store.createPrice(price("price-aud-month", monthly.id, "AUD", "month")),
      true,
    );
    assert.equal(await store.createPrice(price("price-usd-year", monthly.id, "USD", "year")), true);
    assert.equal(
      await store.createPrice({
        ...price("price-aud-once", oneTime.id, "AUD", null),
        priceType: "one_time",
      }),
      true,
    );

    await store.saveBuyer({
      id: "buyer-1",
      discordUserId: "buyer-user-1",
      createdAtMs: NOW,
      updatedAtMs: NOW,
    });
    await store.saveCustomer({
      id: "customer-1",
      connectedAccountId: account.id,
      buyerId: "buyer-1",
      stripeCustomerId: "cus_connected_1",
      createdAtMs: NOW,
      updatedAtMs: NOW,
    });

    const event = {
      id: "webhook-1",
      connectedAccountId: account.id,
      stripeEventId: "evt_connected_1",
      eventType: "customer.subscription.updated",
      objectId: "sub_connected_1",
      payloadHash: "hash-connected-1",
      generation: 1,
      apiVersion: "2025-04-30.basil",
      providerCreatedAtMs: NOW - 100,
      receivedAtMs: NOW,
      status: "pending" as const,
      attemptCount: 0,
      lastErrorCode: null,
      processedAtMs: null,
      updatedAtMs: NOW,
    };
    assert.equal(await store.acceptWebhookEvent(event), true);
    assert.equal(await store.acceptWebhookEvent({ ...event, id: "webhook-duplicate" }), false);

    assert.equal(count(database, "commerce_webhook_events"), 1);
    assert.equal(count(database, "billing_webhook_events"), 0);
    assert.equal(count(database, "timed_roles"), 0);
  } finally {
    database.close();
  }
});

test("a buyer can subscribe to several offerings but not twice to the same offering", async () => {
  const database = await createTestDatabase();
  try {
    const store = createCloudflareCommerceStore(database.d1);
    await seedBuyerCatalog(store);

    const first = subscription("subscription-1", "offering-monthly", "price-aud-month");
    await store.saveSubscription(first);
    await assert.rejects(
      () =>
        store.saveSubscription({
          ...first,
          id: "subscription-duplicate",
          stripeSubscriptionId: "sub_connected_duplicate",
        }),
      (error: unknown) =>
        error instanceof Error &&
        error.cause instanceof Error &&
        /UNIQUE constraint failed/.test(error.cause.message),
    );

    await store.saveSubscription(
      subscription("subscription-2", "offering-yearly", "price-usd-year"),
    );
    assert.deepEqual(
      (await store.listSubscriptions("buyer-1")).map(({ offeringId }) => offeringId),
      ["offering-monthly", "offering-yearly"],
    );

    await store.saveSubscription({
      ...first,
      status: "ended",
      endedAtMs: NOW + 1,
      updatedAtMs: NOW + 1,
    });
    await store.saveSubscription({
      ...first,
      id: "subscription-replacement",
      stripeSubscriptionId: "sub_connected_replacement",
      createdAtMs: NOW + 2,
      updatedAtMs: NOW + 2,
    });
    assert.equal((await store.listSubscriptions("buyer-1")).length, 3);
  } finally {
    database.close();
  }
});

test("sales panel publication claims serialize and retain interrupted provider intent", async () => {
  const database = await createTestDatabase();
  try {
    const store = createCloudflareCommerceStore(database.d1);
    await store.saveConnectedAccount(connectedAccount());
    const claim = (leaseToken: string, createNonce: string, targetChannelId = "channel-1") =>
      store.claimSalesPanelPublication({
        connectedAccountId: "seller-1",
        guildId: "guild-1",
        targetChannelId,
        title: "Join our community",
        description: "Pick the access that works for you.",
        leaseToken,
        createNonce,
        nowMs: NOW,
        leaseMs: 60_000,
      });
    const [first, second] = await Promise.all([
      claim("lease-1", "nonce-1"),
      claim("lease-2", "nonce-2"),
    ]);
    const winner = first ?? second;
    const winnerLease = first ? "lease-1" : "lease-2";
    assert.ok(winner);
    assert.equal([first, second].filter(Boolean).length, 1);
    assert.equal(winner.recovering, false);

    assert.equal(
      await store.failSalesPanelPublication({
        connectedAccountId: "seller-1",
        leaseToken: winnerLease,
        errorCode: "provider_response_lost",
        nowMs: NOW + 1,
        preservePending: true,
      }),
      true,
    );
    const recovered = await store.claimSalesPanelPublication({
      connectedAccountId: "seller-1",
      guildId: "guild-1",
      targetChannelId: "channel-2",
      title: "A newer title",
      description: "A newer description",
      leaseToken: "lease-recovery",
      createNonce: "nonce-recovery",
      nowMs: NOW + 2,
      leaseMs: 60_000,
    });
    assert.ok(recovered);
    assert.equal(recovered.recovering, true);
    assert.equal(recovered.targetChannelId, "channel-1");
    assert.equal(recovered.title, "Join our community");
    assert.equal(recovered.description, "Pick the access that works for you.");
    assert.equal(recovered.createNonce, winner.createNonce);
    assert.equal(
      await store.completeSalesPanelPublication({
        leaseToken: "lease-recovery",
        panel: {
          ...recovered.panel,
          messageId: "message-1",
          updatedAtMs: NOW + 3,
        },
      }),
      true,
    );
  } finally {
    database.close();
  }
});

test("commerce role delivery is a separate projection and seller archive retains history", async () => {
  const database = await createTestDatabase();
  try {
    const store = createCloudflareCommerceStore(database.d1);
    await seedBuyerCatalog(store);
    await store.saveSubscription(
      subscription("subscription-1", "offering-monthly", "price-aud-month"),
    );
    await store.saveEntitlement({
      id: "entitlement-1",
      connectedAccountId: "seller-1",
      buyerId: "buyer-1",
      offeringId: "offering-monthly",
      sourceType: "subscription",
      sourceId: "subscription-1",
      status: "active",
      effectiveAtMs: NOW,
      expiresAtMs: null,
      revokedAtMs: null,
      createdAtMs: NOW,
      updatedAtMs: NOW,
    });
    await store.saveRoleAssignment({
      id: "role-assignment-1",
      entitlementId: "entitlement-1",
      guildId: "guild-1",
      discordUserId: "buyer-user-1",
      discordRoleId: "role-monthly",
      status: "assigned",
      attemptCount: 1,
      lastErrorCode: null,
      nextAttemptAtMs: null,
      assignedAtMs: NOW,
      removedAtMs: null,
      createdAtMs: NOW,
      updatedAtMs: NOW,
    });

    const operation = {
      id: "operation-1",
      connectedAccountId: "seller-1",
      guildId: "guild-1",
      operationKey: "subscription-1:activated",
      operationType: "subscription.activated",
      entityType: "subscription",
      entityId: "subscription-1",
      actorType: "stripe" as const,
      actorId: "evt_connected_1",
      payloadJson: '{"status":"active"}',
      createdAtMs: NOW,
    };
    assert.equal(await store.appendOperation(operation), true);
    assert.equal(await store.appendOperation({ ...operation, id: "operation-duplicate" }), false);

    await store.saveConnectedAccount({
      ...connectedAccount(),
      status: "archived",
      archivedAtMs: NOW + 10,
      updatedAtMs: NOW + 10,
    });
    assert.equal(await store.readConnectedAccountByGuild("guild-1"), null);
    assert.equal(count(database, "commerce_subscriptions"), 1);
    assert.equal(count(database, "commerce_entitlements"), 1);
    assert.equal(count(database, "commerce_role_assignments"), 1);
    assert.equal(count(database, "commerce_operations_ledger"), 1);
    assert.throws(
      () => database.execRaw("DELETE FROM commerce_operations_ledger WHERE id = 'operation-1'"),
      /retained/,
    );
    assert.equal(count(database, "timed_roles"), 0);
  } finally {
    database.close();
  }
});

test("entitlement provider identity is scoped to the connected seller", async () => {
  const database = await createTestDatabase();
  try {
    database.execRaw(`
      INSERT INTO commerce_entitlements
        (id,connected_account_id,buyer_id,offering_id,source_type,source_id,status,effective_at_ms,created_at_ms,updated_at_ms)
      VALUES
        ('entitlement-seller-1','seller-1','buyer-1','offering-1','subscription','sub_same','active',${NOW},${NOW},${NOW}),
        ('entitlement-seller-2','seller-2','buyer-2','offering-2','subscription','sub_same','active',${NOW},${NOW},${NOW});
    `);
    assert.equal(count(database, "commerce_entitlements"), 2);
    assert.throws(
      () =>
        database.execRaw(`
          INSERT INTO commerce_entitlements
            (id,connected_account_id,buyer_id,offering_id,source_type,source_id,status,effective_at_ms,created_at_ms,updated_at_ms)
          VALUES ('duplicate','seller-1','buyer-3','offering-3','subscription','sub_same','active',${NOW},${NOW},${NOW});
        `),
      /UNIQUE constraint failed/,
    );
  } finally {
    database.close();
  }
});

test("Commerce manager capabilities are seller scoped and revocable", async () => {
  const database = await createTestDatabase();
  try {
    const store = createCloudflareCommerceStore(database.d1);
    await store.saveConnectedAccount(connectedAccount());
    await store.saveAuthorityGrant({
      connectedAccountId: "seller-1",
      discordUserId: "manager-1",
      capability: "commerce.finance.refund",
      grantedByUserId: "seller-user-1",
      grantedAtMs: NOW,
      revokedAtMs: null,
    });
    assert.deepEqual(await store.readSellerCapabilities("seller-1", "manager-1"), [
      "commerce.finance.refund",
    ]);
    assert.deepEqual(await store.readSellerCapabilities("seller-2", "manager-1"), []);

    await store.saveAuthorityGrant({
      connectedAccountId: "seller-1",
      discordUserId: "manager-1",
      capability: "commerce.finance.refund",
      grantedByUserId: "seller-user-1",
      grantedAtMs: NOW + 1,
      revokedAtMs: NOW + 1,
    });
    assert.deepEqual(await store.readSellerCapabilities("seller-1", "manager-1"), []);
  } finally {
    database.close();
  }
});

test("migration enforces explicit supported currencies and immutable price economics", async () => {
  const database = await createTestDatabase();
  try {
    const store = createCloudflareCommerceStore(database.d1);
    await store.saveConnectedAccount(connectedAccount());
    await store.saveOffering(offering("offering-monthly", "role-monthly", "subscription"));
    await store.createPrice(price("price-aud-month", "offering-monthly", "AUD", "month"));

    assert.throws(
      () =>
        database.execRaw(
          "UPDATE commerce_prices SET unit_amount_minor = 999 WHERE id = 'price-aud-month'",
        ),
      /create a new price/,
    );
    assert.throws(
      () =>
        database.execRaw(
          `INSERT INTO commerce_prices (
            id, connected_account_id, offering_id, stripe_product_id, stripe_price_id,
            currency, unit_amount_minor, price_type, recurring_interval, status,
            provider_created_at_ms, retired_at_ms, created_at_ms
          ) VALUES (
            'price-eur', 'seller-1', 'offering-monthly', 'prod-eur', 'price-eur',
            'EUR', 1000, 'recurring', 'month', 'active', NULL, NULL, ${NOW}
          )`,
        ),
      /CHECK constraint failed/,
    );
  } finally {
    database.close();
  }
});

function connectedAccount(): CommerceConnectedAccount {
  return {
    id: "seller-1",
    guildId: "guild-1",
    stripeAccountId: "acct_connected_1",
    status: "active",
    country: "AU",
    defaultCurrency: "AUD",
    chargesEnabled: true,
    payoutsEnabled: true,
    detailsSubmitted: true,
    providerCreatedAtMs: NOW - 1_000,
    archivedAtMs: null,
    createdAtMs: NOW,
    updatedAtMs: NOW,
  };
}

function offering(
  id: string,
  discordRoleId: string,
  purchaseType: CommerceOffering["purchaseType"],
): CommerceOffering {
  return {
    id,
    connectedAccountId: "seller-1",
    guildId: "guild-1",
    discordRoleId,
    name: id,
    description: null,
    purchaseType,
    status: "active",
    archivedAtMs: null,
    createdAtMs: NOW,
    updatedAtMs: NOW,
  };
}

function price(
  id: string,
  offeringId: string,
  currency: CommercePrice["currency"],
  recurringInterval: CommercePrice["recurringInterval"],
): CommercePrice {
  return {
    id,
    connectedAccountId: "seller-1",
    offeringId,
    stripeProductId: `prod-${id}`,
    stripePriceId: `stripe-${id}`,
    currency,
    unitAmountMinor: 1_500,
    priceType: "recurring",
    recurringInterval,
    status: "active",
    providerCreatedAtMs: NOW,
    retiredAtMs: null,
    createdAtMs: NOW,
  };
}

function subscription(id: string, offeringId: string, priceId: string): CommerceSubscription {
  return {
    id,
    connectedAccountId: "seller-1",
    customerId: "customer-1",
    buyerId: "buyer-1",
    offeringId,
    priceId,
    stripeSubscriptionId: `stripe-${id}`,
    status: "active",
    cancelAtPeriodEnd: false,
    currentPeriodStartMs: NOW,
    currentPeriodEndMs: NOW + 2_592_000_000,
    canceledAtMs: null,
    endedAtMs: null,
    providerUpdatedAtMs: NOW,
    latestInvoiceId: `invoice-${id}`,
    latestInvoiceStatus: "paid",
    latestPaymentIntentId: `payment-${id}`,
    latestPaymentStatus: "succeeded",
    graceStartedAtMs: null,
    graceEndsAtMs: null,
    createdAtMs: NOW,
    updatedAtMs: NOW,
  };
}

async function seedBuyerCatalog(store: ReturnType<typeof createCloudflareCommerceStore>) {
  await store.saveConnectedAccount(connectedAccount());
  await store.saveOffering(offering("offering-monthly", "role-monthly", "subscription"));
  await store.saveOffering(offering("offering-yearly", "role-yearly", "subscription"));
  await store.createPrice(price("price-aud-month", "offering-monthly", "AUD", "month"));
  await store.createPrice(price("price-usd-year", "offering-yearly", "USD", "year"));
  await store.saveBuyer({
    id: "buyer-1",
    discordUserId: "buyer-user-1",
    createdAtMs: NOW,
    updatedAtMs: NOW,
  });
  await store.saveCustomer({
    id: "customer-1",
    connectedAccountId: "seller-1",
    buyerId: "buyer-1",
    stripeCustomerId: "cus_connected_1",
    createdAtMs: NOW,
    updatedAtMs: NOW,
  });
}

function count(
  database: Awaited<ReturnType<typeof createTestDatabase>>,
  table: string,
): number | undefined {
  return database.query<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)[0]?.count;
}
