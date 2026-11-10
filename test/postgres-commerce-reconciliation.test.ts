import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { createCloudflareCommerceStore } from "../src/runtime/cloudflare-commerce-store";
import { CloudflareCommerceBuyerCheckoutStore } from "../src/runtime/commerce/cloudflare-buyer-checkout-store";
import { CloudflarePaidRoleStore } from "../src/runtime/commerce/cloudflare-paid-role-store";
import { CloudflareCommerceReconciliationStore } from "../src/runtime/commerce/cloudflare-reconciliation-store";
import {
  processCommerceReconciliationMessage,
  requestCommerceRefresh,
  sweepCommerceSyncOutbox,
  type CommerceReconciliationMessage,
  type CommerceSellerSnapshot,
} from "../src/runtime/commerce/reconciliation";
import { createCommerceStripeWebhookHandler } from "../src/runtime/commerce/webhook";
import { createPostgresDatabaseCapabilityFromEnvironment } from "../src/runtime/postgres/postgres-capability";
import { createPostgresD1CompatibilityDatabase } from "../src/runtime/postgres/postgres-d1-compat";
import {
  applyPostgresMigrations,
  readPostgresMigrations,
} from "../src/runtime/postgres/postgres-migrations";

const postgresUrl = process.env.TEST_POSTGRES_URL;
const NOW = 1_800_000_000_000;

test(
  "native PostgreSQL Commerce commits only the current generation and lease owner",
  { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
  async () => {
    await withPostgres(async (database, accountId) => {
      const store = new CloudflareCommerceReconciliationStore(database, () => NOW);
      const commerce = createCloudflareCommerceStore(database);
      const paid = paidSnapshot(accountId);
      const first = await accept(store, accountId, "first");
      const claim = (message: CommerceReconciliationMessage, leaseToken: string, nowMs = NOW) =>
        store.claim({ message, leaseToken, nowMs, leaseMs: 1_000 });
      const commit = (message: CommerceReconciliationMessage, leaseToken: string) =>
        store.commit({ message, leaseToken, snapshot: paid, nowMs: NOW });

      assert.equal(await claim(first, "original"), "claimed");
      assert.equal(await claim(first, "competitor"), "leased");
      assert.equal(await commit(first, "competitor"), false);
      assert.equal(await commerce.readConnectedAccountByGuild(accountId), null);

      assert.equal(await claim(first, "replacement", NOW + 1_000), "claimed");
      assert.equal(await commit(first, "original"), false, "expired ownership cannot commit");
      assert.equal(await commerce.readConnectedAccountByGuild(accountId), null);

      const second = await accept(store, accountId, "second");
      assert.equal(await claim(first, "replacement"), "stale");
      assert.equal(await commit(first, "replacement"), false, "a newer generation fences old work");
      assert.equal(await commerce.readConnectedAccountByGuild(accountId), null);

      assert.equal(await claim(second, "current", NOW + 2_000), "claimed");
      assert.equal((await commerce.listSubscriptions(paid.buyers[0].id)).length, 0);
      assert.equal(await commit(second, "current"), true);
      assert.equal((await commerce.readConnectedAccountByGuild(accountId))?.status, "active");
      assert.equal((await commerce.listSubscriptions(paid.buyers[0].id)).length, 1);
      assert.equal(await claim(second, "duplicate", NOW + 3_000), "complete");
      assert.equal(await claim(first, "duplicate", NOW + 3_000), "complete");
    });
  },
);

test(
  "native PostgreSQL Commerce publishes scoped refreshes and projects paid access idempotently",
  { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
  async () => {
    await withPostgres(async (database, accountId) => {
      const store = new CloudflareCommerceReconciliationStore(database, () => NOW);
      const commerce = createCloudflareCommerceStore(database);
      const buyerStore = new CloudflareCommerceBuyerCheckoutStore(database, {
        isPremium: async () => true,
      });
      const roles = new CloudflarePaidRoleStore(database);
      const paid = paidSnapshot(accountId);
      const request = await store.requestRefresh({
        connectedAccountId: accountId,
        source: "checkout",
        correlationId: accountId,
        requestedAtMs: NOW,
      });
      assert.equal(request.accepted, true);
      assert.equal(request.outboxPending, true, "an unsent durable refresh needs queue delivery");
      const first = request.message;
      const pending = await store.listPendingOutbox();
      assert.deepEqual(
        pending.filter((message) => message.connectedAccountId === accountId),
        [first],
        "the pending message retains its complete scope",
      );
      const sent: CommerceReconciliationMessage[] = [];
      const queue = {
        async send(message: CommerceReconciliationMessage) {
          sent.push(message);
        },
      };
      assert.equal(await sweepCommerceSyncOutbox({ store, queue, now: () => NOW }), pending.length);
      const queued = sent.filter((message) => message.connectedAccountId === accountId);
      assert.deepEqual(queued, [first]);
      assert.equal(await readSentAt(database, first), NOW);
      assert.equal(await sweepCommerceSyncOutbox({ store, queue, now: () => NOW + 1 }), 0);
      assert.deepEqual(
        await requestCommerceRefresh({
          connectedAccountId: accountId,
          source: "checkout",
          correlationId: accountId,
          store,
          queue,
          now: () => NOW,
        }),
        first,
      );
      assert.equal(sent.length, pending.length, "sent refreshes are not published again");

      const readStatus = () =>
        buyerStore.readBuyerStatus({
          connectedAccountId: accountId,
          buyerId: paid.buyers[0].id,
          offeringId: paid.subscriptions[0].offeringId,
          nowMs: NOW,
        });
      let providerReads = 0;
      let commits = 0;
      const process = (message: CommerceReconciliationMessage) =>
        processCommerceReconciliationMessage({
          message,
          attempts: 1,
          store,
          provider: {
            async readSellerSnapshot(input) {
              providerReads += 1;
              assert.deepEqual(input, {
                connectedAccountId: accountId,
                trigger:
                  message.generation === 1
                    ? {
                        eventType: "commerce.refresh.checkout",
                        objectId: accountId,
                        source: "checkout",
                      }
                    : {
                        eventType: "invoice.paid",
                        objectId: `in_${accountId}`,
                        source: "webhook",
                      },
              });
              return paid;
            },
          },
          async afterCommit() {
            commits += 1;
            assert.equal((await readStatus()).entitlementStatus, "active");
          },
          now: () => NOW,
        });
      assert.equal(await process(queued[0]), "processed");
      assert.equal(await process(queued[0]), "complete");
      assert.equal(providerReads, 1, "duplicate delivery does not read the provider again");
      assert.equal(commits, 1, "successful commit publishes its follow-up once");
      assert.deepEqual(await readStatus(), {
        checkoutAttemptId: null,
        customerExists: true,
        roleDeliveryStatus: "pending",
        entitlementStatus: "active",
        subscriptionStatus: "active",
        cancelAtPeriodEnd: false,
        currentPeriodEndMs: NOW + 2_592_000_000,
        graceEndsAtMs: null,
      });

      const second = await accept(store, accountId, "second");
      assert.equal(second.generation, 2);
      sent.length = 0;
      assert.equal(await sweepCommerceSyncOutbox({ store, queue, now: () => NOW + 2 }), 1);
      assert.deepEqual(sent, [second]);
      assert.equal(await readSentAt(database, second), NOW + 2);
      assert.equal(await process(sent[0]), "processed");
      assert.equal(providerReads, 2);
      assert.equal(commits, 2);
      assert.equal((await commerce.listSubscriptions(paid.buyers[0].id)).length, 1);
      const outbox = (await roles.listPendingRoleOutbox(NOW)).filter(
        (message) => message.guildId === accountId,
      );
      assert.deepEqual(
        outbox
          .map((message) => ({
            action: message.action,
            payload: JSON.parse(message.payloadJson),
          }))
          .sort((left, right) => left.payload.generation - right.payload.generation),
        [
          { action: "assign", payload: { generation: 1 } },
          { action: "assign", payload: { generation: 2 } },
        ],
      );
    });
  },
);

test(
  "native PostgreSQL Commerce outbox marks preserve generation, seller scope and first sent time",
  { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
  async () => {
    await withPostgres(async (database, accountId) => {
      const store = new CloudflareCommerceReconciliationStore(database, () => NOW);
      const first = await accept(store, accountId, "earlier");
      const current = await accept(store, accountId, "current");
      const otherSeller = await accept(store, `${accountId}:other`, "current");
      await store.markOutboxSent({ ...current, generation: first.generation }, NOW);
      assert.equal(
        await readSentAt(database, current),
        null,
        "stale generation cannot mark newer work",
      );
      assert.equal(await readSentAt(database, first), null);
      assert.equal(await readSentAt(database, otherSeller), null);

      await store.markOutboxSent(current, NOW + 2);
      assert.equal(await readSentAt(database, current), NOW + 2);
      assert.equal(await readSentAt(database, first), null, "other events remain pending");
      assert.equal(await readSentAt(database, otherSeller), null, "other sellers remain pending");
      await store.markOutboxSent(first, NOW + 1);
      assert.equal(
        await readSentAt(database, first),
        NOW + 1,
        "its own older outbox can still be marked",
      );
      await store.markOutboxSent(current, NOW + 3);
      await store.markOutboxSent(current.eventId, accountId, NOW + 4);
      assert.equal(
        await readSentAt(database, current),
        NOW + 2,
        "both overloads retain the first timestamp",
      );
      await store.markOutboxSent(otherSeller.eventId, otherSeller.connectedAccountId, NOW + 5);
      assert.equal(await readSentAt(database, otherSeller), NOW + 5);
    });
  },
);

test(
  "native PostgreSQL Commerce webhook publication marks the legacy outbox once",
  { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
  async () => {
    await withPostgres(async (database, fixtureId) => {
      const accountId = `acct_${fixtureId.replaceAll("-", "")}`;
      let nowMs = NOW;
      const store = new CloudflareCommerceReconciliationStore(database, () => nowMs);
      await accept(store, accountId, "earlier");
      const sent: CommerceReconciliationMessage[] = [];
      const secret = "synthetic-local-webhook-signing-secret";
      const body = JSON.stringify({
        id: "legacy",
        type: "invoice.paid",
        account: accountId,
        created: NOW / 1_000,
        data: { object: { id: `in_${accountId}` } },
      });
      const signature = createHmac("sha256", secret)
        .update(`${NOW / 1_000}.${body}`)
        .digest("hex");
      const request = () =>
        new Request("https://hafbot.test/api/commerce/stripe-webhook", {
          method: "POST",
          headers: { "stripe-signature": `t=${NOW / 1_000},v1=${signature}` },
          body,
        });
      const handler = createCommerceStripeWebhookHandler({
        secret,
        store,
        queue: {
          async send(message) {
            sent.push(message);
          },
        },
        now: () => nowMs,
      });
      assert.equal((await handler(request()))?.status, 200);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].generation, 2, "legacy publication is not fenced to generation one");
      assert.equal(await readSentAt(database, sent[0]), NOW);
      nowMs += 10;
      const duplicate = await handler(request());
      assert.deepEqual(await duplicate?.json(), { received: true, duplicate: true });
      assert.equal(sent.length, 1, "a duplicate webhook does not send again");
      await store.markOutboxSent("legacy", accountId, nowMs);
      assert.equal(await readSentAt(database, sent[0]), NOW, "the first sent timestamp survives");
    });
  },
);

test(
  "native PostgreSQL Commerce rolls back a failed projection and lets its owner retry",
  { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
  async () => {
    await withPostgres(async (database, accountId) => {
      const store = new CloudflareCommerceReconciliationStore(database, () => NOW);
      const commerce = createCloudflareCommerceStore(database);
      const paid = paidSnapshot(accountId);
      const message = await accept(store, accountId, "atomic");
      const claim = (leaseToken: string) =>
        store.claim({ message, leaseToken, nowMs: NOW, leaseMs: 1_000 });
      assert.equal(await claim("owner"), "claimed");
      await assert.rejects(
        store.commit({
          message,
          leaseToken: "owner",
          snapshot: {
            ...paid,
            customers: [
              paid.customers[0],
              { ...paid.customers[0], id: `${accountId}:conflicting-customer` },
            ],
          },
          nowMs: NOW,
        }),
        /duplicate key/,
      );
      assert.equal(await commerce.readConnectedAccountByGuild(accountId), null);
      assert.equal((await commerce.listSubscriptions(paid.buyers[0].id)).length, 0);
      assert.equal(await claim("competitor"), "leased", "rollback preserves the current owner");
      assert.equal(await claim("owner"), "claimed");
      assert.equal(
        await store.commit({ message, leaseToken: "owner", snapshot: paid, nowMs: NOW }),
        true,
      );
      assert.equal((await commerce.listSubscriptions(paid.buyers[0].id)).length, 1);
      assert.equal(await claim("duplicate"), "complete");
    });
  },
);

for (const leaseToken of [null, "fixture-lease"]) {
  test(
    `PostgreSQL nullable recovery: quarantine accepts ${leaseToken === null ? "null unrestricted" : "the current text"} lease`,
    { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
    async () => {
      await withPostgres(async (database, accountId) => {
        const store = new CloudflareCommerceReconciliationStore(database, () => NOW);
        await createCloudflareCommerceStore(database).saveConnectedAccount(
          snapshot(accountId).connectedAccount,
        );
        const message = await accept(store, accountId, "nullable-lease");
        assert.equal(
          await store.claim({ message, leaseToken: "fixture-lease", nowMs: NOW, leaseMs: 1_000 }),
          "claimed",
        );
        await store.quarantine({
          message,
          leaseToken,
          reasonCode: "fixture_quarantine",
          nowMs: NOW + 1,
        });
        await assertQuarantined(database, message);
      });
    },
  );
}

test(
  "PostgreSQL nullable recovery: wrong text lease cannot quarantine fresh work or record an incident",
  { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
  async () => {
    await withPostgres(async (database, accountId) => {
      const store = new CloudflareCommerceReconciliationStore(database, () => NOW);
      await createCloudflareCommerceStore(database).saveConnectedAccount(
        snapshot(accountId).connectedAccount,
      );
      const message = await accept(store, accountId, "wrong-lease");
      assert.equal(
        await store.claim({ message, leaseToken: "fixture-lease", nowMs: NOW, leaseMs: 1_000 }),
        "claimed",
      );
      const before = await readRecoveryState(database, accountId);
      assert.equal(before.incidents.length, 0);
      await store.quarantine({
        message,
        leaseToken: "wrong-fixture-lease",
        reasonCode: "fixture_quarantine",
        nowMs: NOW + 1,
      });
      assert.deepEqual(await readRecoveryState(database, accountId), before);
    });
  },
);

test(
  "PostgreSQL nullable recovery: stale generation cannot quarantine newer eligible work",
  { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
  async () => {
    await withPostgres(async (database, accountId) => {
      const store = new CloudflareCommerceReconciliationStore(database, () => NOW);
      await createCloudflareCommerceStore(database).saveConnectedAccount(
        snapshot(accountId).connectedAccount,
      );
      const stale = await accept(store, accountId, "stale-quarantine");
      const current = await accept(store, accountId, "current-quarantine");
      assert.ok(current.generation > stale.generation);
      const before = await readRecoveryState(database, accountId);
      assert.equal(before.incidents.length, 0);
      await store.quarantine({
        message: stale,
        leaseToken: null,
        reasonCode: "fixture_quarantine",
        nowMs: NOW + 1,
      });
      assert.deepEqual(await readRecoveryState(database, accountId), before);
      assert.equal(
        await store.claim({
          message: current,
          leaseToken: "new-fixture-lease",
          nowMs: NOW + 2,
          leaseMs: 1_000,
        }),
        "claimed",
      );
    });
  },
);

test(
  "PostgreSQL nullable recovery: the same quarantine reason stays scoped to each seller and guild",
  { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
  async () => {
    await withPostgres(async (database, accountId) => {
      const store = new CloudflareCommerceReconciliationStore(database, () => NOW);
      const commerce = createCloudflareCommerceStore(database);
      const otherAccountId = `${accountId}:other-seller`;
      for (const id of [accountId, otherAccountId]) {
        await commerce.saveConnectedAccount(snapshot(id).connectedAccount);
      }
      const original = await accept(store, accountId, "same-reason");
      const other = await accept(store, otherAccountId, "same-reason");
      const otherBefore = await readRecoveryState(database, otherAccountId);
      await store.quarantine({
        message: original,
        leaseToken: null,
        reasonCode: "fixture_quarantine",
        nowMs: NOW + 1,
      });
      await assertQuarantined(database, original);
      assert.deepEqual(await readRecoveryState(database, otherAccountId), otherBefore);
      const originalBefore = await readRecoveryState(database, accountId);
      assert.equal(
        await store.claim({
          message: other,
          leaseToken: "other-fixture-lease",
          nowMs: NOW,
          leaseMs: 1_000,
        }),
        "claimed",
      );
      await store.quarantine({
        message: other,
        leaseToken: "other-fixture-lease",
        reasonCode: "fixture_quarantine",
        nowMs: NOW + 1,
      });
      await assertQuarantined(database, other);
      assert.deepEqual(await readRecoveryState(database, accountId), originalBefore);
      assert.deepEqual(
        await commerce.readConnectedAccountByGuild(accountId),
        snapshot(accountId).connectedAccount,
      );
      assert.deepEqual(
        await commerce.readConnectedAccountByGuild(otherAccountId),
        snapshot(otherAccountId).connectedAccount,
      );
    });
  },
);

async function readRecoveryState(database: D1Database, accountId: string) {
  const sync = await database
    .prepare("SELECT * FROM commerce_sync_state WHERE connected_account_id = ? ORDER BY id")
    .bind(accountId)
    .all();
  const events = await database
    .prepare("SELECT * FROM commerce_webhook_events WHERE connected_account_id = ? ORDER BY id")
    .bind(accountId)
    .all();
  const incidents = await database
    .prepare("SELECT * FROM commerce_incidents WHERE connected_account_id = ? ORDER BY id")
    .bind(accountId)
    .all();
  return { sync: sync.results, events: events.results, incidents: incidents.results };
}

async function assertQuarantined(database: D1Database, message: CommerceReconciliationMessage) {
  assert.deepEqual(
    await database
      .prepare(`SELECT generation, applied_generation, status, last_error_code, lease_token, lease_expires_at_ms, updated_at_ms
    FROM commerce_sync_state WHERE connected_account_id = ? AND resource_type = ? AND resource_id = ?`)
      .bind(message.connectedAccountId, message.resourceType, message.resourceId)
      .first(),
    {
      generation: message.generation,
      applied_generation: 0,
      status: "quarantined",
      last_error_code: "fixture_quarantine",
      lease_token: null,
      lease_expires_at_ms: null,
      updated_at_ms: NOW + 1,
    },
  );
  assert.deepEqual(
    await database
      .prepare(`SELECT generation, status, attempt_count, last_error_code, processed_at_ms, updated_at_ms
    FROM commerce_webhook_events WHERE connected_account_id = ? AND stripe_event_id = ?`)
      .bind(message.connectedAccountId, message.eventId)
      .first(),
    {
      generation: message.generation,
      status: "failed",
      attempt_count: 1,
      last_error_code: "fixture_quarantine",
      processed_at_ms: NOW + 1,
      updated_at_ms: NOW + 1,
    },
  );
  const incidents = await database
    .prepare(`SELECT connected_account_id, guild_id, incident_key, severity, status, summary_code, entity_type, entity_id,
      safe_args_json, occurrence_count, first_seen_at_ms, last_seen_at_ms, resolved_at_ms, created_at_ms, updated_at_ms
    FROM commerce_incidents WHERE connected_account_id = ?`)
    .bind(message.connectedAccountId)
    .all();
  assert.deepEqual(incidents.results, [
    {
      connected_account_id: message.connectedAccountId,
      guild_id: message.connectedAccountId,
      incident_key: `commerce-reconciliation:${message.connectedAccountId}:fixture_quarantine`,
      severity: "error",
      status: "open",
      summary_code: "commerce_reconciliation_quarantined",
      entity_type: "seller",
      entity_id: message.connectedAccountId,
      safe_args_json: '{"reasonCode":"fixture_quarantine"}',
      occurrence_count: 1,
      first_seen_at_ms: NOW + 1,
      last_seen_at_ms: NOW + 1,
      resolved_at_ms: null,
      created_at_ms: NOW + 1,
      updated_at_ms: NOW + 1,
    },
  ]);
}

async function withPostgres(operation: (database: D1Database, accountId: string) => Promise<void>) {
  assert.ok(postgresUrl);
  const url = new URL(postgresUrl);
  assert.ok(url.hostname === "127.0.0.1" || url.hostname === "localhost");
  assert.match(url.pathname, /_test$/);
  const database = createPostgresDatabaseCapabilityFromEnvironment({
    DATABASE_URL: postgresUrl,
    NODE_ENV: "test",
  });
  try {
    await applyPostgresMigrations(
      database,
      await readPostgresMigrations(resolve("migrations/postgres")),
    );
    await operation(createPostgresD1CompatibilityDatabase(database), crypto.randomUUID());
  } finally {
    await database.close();
  }
}

async function accept(
  store: CloudflareCommerceReconciliationStore,
  accountId: string,
  eventId: string,
): Promise<CommerceReconciliationMessage> {
  const accepted = await store.accept({
    connectedAccountId: accountId,
    eventId,
    eventType: "invoice.paid",
    objectId: `in_${accountId}`,
    providerCreatedAtMs: NOW,
    payloadHash: `synthetic-${eventId}`,
  });
  return {
    connectedAccountId: accountId,
    eventId,
    resourceType: "seller",
    resourceId: accountId,
    generation: accepted.generation,
  };
}

async function readSentAt(database: D1Database, message: CommerceReconciliationMessage) {
  const row = await database
    .prepare(
      "SELECT sent_at_ms FROM commerce_sync_outbox WHERE connected_account_id = ? AND event_id = ?",
    )
    .bind(message.connectedAccountId, message.eventId)
    .first<{ sent_at_ms: number | null }>();
  assert.ok(row, "the durable outbox row exists");
  return row.sent_at_ms;
}

function snapshot(accountId: string): CommerceSellerSnapshot {
  return {
    connectedAccount: {
      id: accountId,
      guildId: accountId,
      stripeAccountId: accountId,
      status: "active",
      country: "AU",
      defaultCurrency: "AUD",
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      providerCreatedAtMs: NOW,
      archivedAtMs: null,
      createdAtMs: NOW,
      updatedAtMs: NOW,
    },
    buyers: [],
    customers: [],
    subscriptions: [],
    payments: [],
    refunds: [],
    disputes: [],
    entitlements: [],
    roleAssignments: [],
    observedAtMs: NOW,
  };
}

function paidSnapshot(accountId: string): CommerceSellerSnapshot {
  const buyerId = `${accountId}:buyer`;
  const customerId = `${accountId}:customer`;
  const offeringId = `${accountId}:offering`;
  const priceId = `${accountId}:price`;
  const subscriptionId = `sub_${accountId}`;
  const entitlementId = `${accountId}:entitlement`;
  return {
    ...snapshot(accountId),
    buyers: [{ id: buyerId, discordUserId: buyerId, createdAtMs: NOW, updatedAtMs: NOW }],
    customers: [
      {
        id: customerId,
        connectedAccountId: accountId,
        buyerId,
        stripeCustomerId: `cus_${accountId}`,
        createdAtMs: NOW,
        updatedAtMs: NOW,
      },
    ],
    subscriptions: [
      {
        id: subscriptionId,
        connectedAccountId: accountId,
        customerId,
        buyerId,
        offeringId,
        priceId,
        stripeSubscriptionId: subscriptionId,
        status: "active",
        cancelAtPeriodEnd: false,
        currentPeriodStartMs: NOW,
        currentPeriodEndMs: NOW + 2_592_000_000,
        canceledAtMs: null,
        endedAtMs: null,
        providerUpdatedAtMs: NOW,
        latestInvoiceId: `in_${accountId}`,
        latestInvoiceStatus: "paid",
        latestPaymentIntentId: `pi_${accountId}`,
        latestPaymentStatus: "succeeded",
        graceStartedAtMs: null,
        graceEndsAtMs: null,
        createdAtMs: NOW,
        updatedAtMs: NOW,
      },
    ],
    payments: [
      {
        id: `${accountId}:payment`,
        connectedAccountId: accountId,
        customerId,
        buyerId,
        offeringId,
        priceId,
        stripePaymentIntentId: `pi_${accountId}`,
        stripeChargeId: `ch_${accountId}`,
        stripeCheckoutSessionId: `cs_${accountId}`,
        stripeInvoiceId: `in_${accountId}`,
        stripeSubscriptionId: subscriptionId,
        billingPeriodStartMs: NOW,
        billingPeriodEndMs: NOW + 2_592_000_000,
        isLatestSubscriptionInvoice: true,
        currency: "AUD",
        amountMinor: 500,
        amountReceivedMinor: 500,
        amountRefundedMinor: 0,
        applicationFeeMinor: 25,
        stripeFeeMinor: 45,
        stripeFeeTaxMinor: 4,
        status: "succeeded",
        providerCreatedAtMs: NOW,
        paidAtMs: NOW,
        createdAtMs: NOW,
        updatedAtMs: NOW,
      },
    ],
    entitlements: [
      {
        id: entitlementId,
        connectedAccountId: accountId,
        buyerId,
        offeringId,
        sourceType: "subscription",
        sourceId: subscriptionId,
        status: "active",
        effectiveAtMs: NOW,
        expiresAtMs: null,
        revokedAtMs: null,
        createdAtMs: NOW,
        updatedAtMs: NOW,
      },
    ],
    roleAssignments: [
      {
        id: `${accountId}:role-assignment`,
        entitlementId,
        guildId: accountId,
        discordUserId: buyerId,
        discordRoleId: `${accountId}:role`,
        status: "pending",
        attemptCount: 0,
        lastErrorCode: null,
        nextAttemptAtMs: NOW,
        assignedAtMs: null,
        removedAtMs: null,
        createdAtMs: NOW,
        updatedAtMs: NOW,
      },
    ],
  };
}
