import type { QueueProducer } from "../src/runtime/queue-types";
/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import type { Env } from "../src/env";
import { createCloudflareCommerceRuntime } from "../src/runtime/commerce/cloudflare-commerce-runtime";
import { CloudflareCommerceReconciliationStore } from "../src/runtime/commerce/cloudflare-reconciliation-store";
import {
  CommerceProjectionQuarantineError,
  processCommerceReconciliationMessage,
  requestCommerceRefresh,
  scheduleCommerceReconciliation,
  sweepCommerceSyncOutbox,
  type CommerceReconciliationMessage,
  type CommerceSellerSnapshot,
  type CommerceTerminalEventHandler,
} from "../src/runtime/commerce/reconciliation";
import { createTestDatabase } from "./support/sqlite-d1-database";

const NOW = 1_800_000_000_000;

test("duplicate and out-of-order triggers allocate one durable generation each", async () => {
  const database = await createTestDatabase();
  try {
    const store = new CloudflareCommerceReconciliationStore(database.d1, () => NOW);
    const first = await store.accept(webhook("evt-1", "customer.subscription.updated"));
    const duplicate = await store.accept(webhook("evt-1", "customer.subscription.updated"));
    const second = await store.accept({
      ...webhook("evt-2", "invoice.paid"),
      providerCreatedAtMs: NOW - 10_000,
    });
    assert.deepEqual(first, {
      accepted: true,
      outboxPending: true,
      generation: 1,
    });
    assert.deepEqual(duplicate, {
      accepted: false,
      outboxPending: true,
      generation: 1,
    });
    assert.deepEqual(second, {
      accepted: true,
      outboxPending: true,
      generation: 2,
    });
    assert.equal(count(database, "commerce_webhook_events"), 2);
    assert.equal(count(database, "commerce_sync_outbox"), 2);

    assert.equal(
      await store.claim({
        message: message("evt-1", 1),
        leaseToken: "lease-old",
        nowMs: NOW,
        leaseMs: 60_000,
      }),
      "stale",
    );
    assert.equal(
      await store.claim({
        message: message("evt-2", 2),
        leaseToken: "lease-current",
        nowMs: NOW,
        leaseMs: 60_000,
      }),
      "claimed",
    );
  } finally {
    database.close();
  }
});

test("Commerce outbox marks preserve generation, seller scope and first sent time on SQLite", async () => {
  const database = await createTestDatabase();
  try {
    const store = new CloudflareCommerceReconciliationStore(database.d1, () => NOW);
    await store.accept(webhook("evt-earlier", "invoice.paid"));
    await store.accept(webhook("evt-current", "invoice.paid"));
    await store.accept({
      ...webhook("evt-current", "invoice.paid"),
      connectedAccountId: "acct_other",
    });
    const first = message("evt-earlier", 1);
    const current = message("evt-current", 2);
    const otherSeller = {
      ...message("evt-current", 1),
      connectedAccountId: "acct_other",
      resourceId: "acct_other",
    };
    const readSentAt = async (outbox: CommerceReconciliationMessage) => {
      const row = await database.d1
        .prepare(
          "SELECT sent_at_ms FROM commerce_sync_outbox WHERE connected_account_id = ? AND event_id = ?",
        )
        .bind(outbox.connectedAccountId, outbox.eventId)
        .first<{ sent_at_ms: number | null }>();
      assert.ok(row);
      return row.sent_at_ms;
    };
    await store.markOutboxSent({ ...current, generation: first.generation }, NOW);
    assert.equal(await readSentAt(current), null, "stale generation cannot mark newer work");
    assert.equal(await readSentAt(first), null);
    assert.equal(await readSentAt(otherSeller), null);

    await store.markOutboxSent(current, NOW + 2);
    assert.equal(await readSentAt(current), NOW + 2);
    assert.equal(await readSentAt(first), null, "other events remain pending");
    assert.equal(await readSentAt(otherSeller), null, "other sellers remain pending");
    await store.markOutboxSent(first, NOW + 1);
    assert.equal(await readSentAt(first), NOW + 1, "its own older outbox can still be marked");
    await store.markOutboxSent(current, NOW + 3);
    await store.markOutboxSent(current.eventId, current.connectedAccountId, NOW + 4);
    assert.equal(await readSentAt(current), NOW + 2, "both overloads retain the first timestamp");
    await store.markOutboxSent(otherSeller.eventId, otherSeller.connectedAccountId, NOW + 5);
    assert.equal(await readSentAt(otherSeller), NOW + 5);
    const sent: CommerceReconciliationMessage[] = [];
    assert.equal(
      await sweepCommerceSyncOutbox({
        store,
        queue: {
          async send(next) {
            sent.push(next);
          },
        },
      }),
      0,
    );
    assert.deepEqual(sent, [], "marked outboxes are not sent again");
  } finally {
    database.close();
  }
});

test("webhook quarantine accepts provider events without disabling scheduled reconciliation", async () => {
  const database = await createTestDatabase();
  try {
    database.execRaw(`
      INSERT INTO commerce_connected_accounts
        (id,guild_id,stripe_account_id,status,country,default_currency,charges_enabled,
         payouts_enabled,details_submitted,provider_created_at_ms,archived_at_ms,created_at_ms,updated_at_ms)
      VALUES ('acct_seller','guild-1','acct_seller','active','AU','AUD',1,1,1,${NOW},NULL,${NOW},${NOW});
      INSERT INTO commerce_operational_controls
        (id,scope_type,scope_id,control_type,enabled,reason_code,actor_user_id,
         expires_at_ms,created_at_ms,updated_at_ms)
      VALUES ('control-1','guild','guild-1','webhook_quarantine',1,
        'provider_investigation','operator-1',NULL,${NOW},${NOW});
    `);
    const store = new CloudflareCommerceReconciliationStore(database.d1, () => NOW);
    assert.deepEqual(await store.accept(webhook("evt-quarantine", "invoice.paid")), {
      accepted: true,
      outboxPending: false,
      generation: 0,
    });
    assert.equal(count(database, "commerce_sync_outbox"), 0);
    assert.equal(count(database, "commerce_incidents"), 1);

    const queues: unknown[] = [];
    await requestCommerceRefresh({
      connectedAccountId: "acct_seller",
      source: "scheduled",
      correlationId: "repair",
      store,
      queue: {
        async send(value) {
          queues.push(value);
        },
      },
      now: () => NOW,
    });
    assert.equal(queues.length, 1, "operator and scheduled reconciliation remain available");
  } finally {
    database.close();
  }
});

test("Commerce commit fences replaced leases and newer generations on SQLite", async () => {
  const database = await createTestDatabase();
  try {
    const store = new CloudflareCommerceReconciliationStore(database.d1, () => NOW);
    await store.accept(webhook("evt-old", "invoice.paid"));
    const claim = (eventId: string, generation: number, leaseToken: string, nowMs: number) =>
      store.claim({ message: message(eventId, generation), leaseToken, nowMs, leaseMs: 1_000 });
    const commit = (eventId: string, generation: number, leaseToken: string) =>
      store.commit({
        message: message(eventId, generation),
        leaseToken,
        snapshot: snapshot(),
        nowMs: NOW,
      });
    assert.equal(await claim("evt-old", 1, "original", NOW), "claimed");
    assert.equal(await claim("evt-old", 1, "competitor", NOW), "leased");
    assert.equal(await commit("evt-old", 1, "competitor"), false);
    assert.equal(await claim("evt-old", 1, "replacement", NOW + 1_000), "claimed");
    assert.equal(await commit("evt-old", 1, "original"), false);

    await store.accept(webhook("evt-current", "invoice.paid"));
    assert.equal(await claim("evt-old", 1, "replacement", NOW + 1_000), "stale");
    assert.equal(await commit("evt-old", 1, "replacement"), false);
    assert.equal(count(database, "commerce_subscriptions"), 0);
    assert.equal(count(database, "commerce_payments"), 0);
    assert.equal(count(database, "commerce_entitlements"), 0);
    assert.equal(count(database, "commerce_paid_role_outbox"), 0);

    assert.equal(await claim("evt-current", 2, "current", NOW + 2_000), "claimed");
    assert.equal(await commit("evt-current", 2, "current"), true);
    assert.equal(count(database, "commerce_subscriptions"), 1);
    assert.equal(count(database, "commerce_payments"), 1);
    assert.equal(count(database, "commerce_entitlements"), 1);
    assert.equal(count(database, "commerce_paid_role_outbox"), 1);
    assert.equal(await claim("evt-current", 2, "duplicate", NOW + 3_000), "complete");
  } finally {
    database.close();
  }
});

test("one reconciliation commit converges all seller projections without duplicates", async () => {
  const database = await createTestDatabase();
  try {
    const store = new CloudflareCommerceReconciliationStore(database.d1, () => NOW);
    await store.accept(webhook("evt-1", "invoice.paid"));
    let providerReads = 0;
    const provider = {
      readSellerSnapshot: async () => {
        providerReads += 1;
        return snapshot();
      },
    };
    assert.equal(
      await processCommerceReconciliationMessage({
        message: message("evt-1", 1),
        attempts: 1,
        store,
        provider,
        now: () => NOW,
        createLeaseToken: () => "lease-1",
      }),
      "processed",
    );

    await store.accept(webhook("evt-2", "customer.subscription.updated"));
    assert.equal(
      await processCommerceReconciliationMessage({
        message: message("evt-2", 2),
        attempts: 1,
        store,
        provider,
        now: () => NOW + 1,
        createLeaseToken: () => "lease-2",
      }),
      "processed",
    );

    for (const table of [
      "commerce_customers",
      "commerce_subscriptions",
      "commerce_payments",
      "commerce_refunds",
      "commerce_support_payments",
      "commerce_support_refunds",
      "commerce_disputes",
      "commerce_entitlements",
      "commerce_role_assignments",
    ]) {
      assert.equal(count(database, table), 1, `${table} should remain idempotent`);
    }
    assert.equal(count(database, "commerce_reporting_ledger"), 5);
    assert.deepEqual(
      database.query(
        `SELECT transaction_type AS transactionType, currency, gross_amount_minor AS grossAmountMinor,
                application_fee_minor AS applicationFeeMinor,
                aud_amount_minor AS audAmountMinor,
                correction_of_transaction_type AS correctionType
         FROM commerce_reporting_ledger ORDER BY transaction_type`,
      ),
      [
        {
          transactionType: "membership_dispute",
          currency: "AUD",
          grossAmountMinor: 500,
          applicationFeeMinor: null,
          audAmountMinor: 500,
          correctionType: "membership_payment",
        },
        {
          transactionType: "membership_payment",
          currency: "AUD",
          grossAmountMinor: 500,
          applicationFeeMinor: 25,
          audAmountMinor: 500,
          correctionType: null,
        },
        {
          transactionType: "membership_refund",
          currency: "AUD",
          grossAmountMinor: 100,
          applicationFeeMinor: 5,
          audAmountMinor: 100,
          correctionType: "membership_payment",
        },
        {
          transactionType: "support_payment",
          currency: "AUD",
          grossAmountMinor: 2_000,
          applicationFeeMinor: 100,
          audAmountMinor: 2_000,
          correctionType: null,
        },
        {
          transactionType: "support_refund",
          currency: "AUD",
          grossAmountMinor: 500,
          applicationFeeMinor: 25,
          audAmountMinor: 500,
          correctionType: "support_payment",
        },
      ],
    );
    assert.equal(providerReads, 2, "normal events still use Stripe snapshot reconciliation");
    assert.throws(
      () =>
        database.execRaw(
          "UPDATE commerce_reporting_ledger SET gross_amount_minor = 1 WHERE source_record_id = 'payment-1'",
        ),
      /immutable/,
    );
    assert.equal(count(database, "billing_webhook_events"), 0);
    assert.equal(count(database, "billing_subscriptions"), 0);
    assert.deepEqual(
      database.query(
        `SELECT generation, applied_generation AS appliedGeneration, status
         FROM commerce_sync_state`,
      ),
      [{ generation: 2, appliedGeneration: 2, status: "synced" }],
    );
  } finally {
    database.close();
  }
});

test("terminal account events dispatch before snapshot reads and complete duplicate work safely", async () => {
  const database = await createTestDatabase();
  try {
    const store = new CloudflareCommerceReconciliationStore(database.d1, () => NOW);
    const providerReads: string[] = [];
    const dispatches: Array<{ eventId: string; eventType: string; actionId: string }> = [];
    const provider = {
      async readSellerSnapshot() {
        providerReads.push("snapshot");
        throw new Error("terminal events must not read Stripe");
      },
    };
    const terminalEventHandler: CommerceTerminalEventHandler = async ({
      message,
      trigger,
      actionId,
    }) => {
      dispatches.push({ eventId: message.eventId, eventType: trigger.eventType, actionId });
      return snapshot();
    };

    for (const [index, eventType] of [
      "account.application.deauthorized",
      "account.closed",
    ].entries()) {
      const eventId = `evt-terminal-${index + 1}`;
      const accepted = await store.accept(webhook(eventId, eventType));
      assert.equal(
        await processCommerceReconciliationMessage({
          message: message(eventId, accepted.generation),
          attempts: 1,
          store,
          provider,
          terminalEventHandler,
          now: () => NOW + index,
          createLeaseToken: () => `lease-terminal-${index + 1}`,
        }),
        "processed",
      );
    }

    assert.equal(
      await processCommerceReconciliationMessage({
        message: message("evt-terminal-2", 2),
        attempts: 2,
        store,
        provider,
        terminalEventHandler,
        now: () => NOW + 2,
        createLeaseToken: () => "lease-terminal-duplicate",
      }),
      "complete",
    );
    assert.deepEqual(dispatches, [
      {
        eventId: "evt-terminal-1",
        eventType: "account.application.deauthorized",
        actionId: "commerce:stripe-terminal:acct_seller:evt-terminal-1",
      },
      {
        eventId: "evt-terminal-2",
        eventType: "account.closed",
        actionId: "commerce:stripe-terminal:acct_seller:evt-terminal-2",
      },
    ]);
    assert.deepEqual(providerReads, []);
  } finally {
    database.close();
  }
});

test("terminal dispatch failures retry and quarantine without crossing account scope", async () => {
  const database = await createTestDatabase();
  try {
    const store = new CloudflareCommerceReconciliationStore(database.d1, () => NOW);
    await store.accept(webhook("evt-terminal-unknown", "account.closed"));
    const provider = {
      async readSellerSnapshot() {
        throw new Error("must not read Stripe for a terminal failure");
      },
    };
    const terminalEventHandler: CommerceTerminalEventHandler = async ({ message: next }) => {
      assert.equal(next.connectedAccountId, "acct_seller");
      throw new Error("commerce_seller_not_connected");
    };

    assert.equal(
      await processCommerceReconciliationMessage({
        message: message("evt-terminal-unknown", 1),
        attempts: 1,
        store,
        provider,
        terminalEventHandler,
        now: () => NOW,
        createLeaseToken: () => "lease-terminal-failure-1",
      }),
      "retry",
    );
    assert.equal(
      await processCommerceReconciliationMessage({
        message: message("evt-terminal-unknown", 1),
        attempts: 5,
        store,
        provider,
        terminalEventHandler,
        now: () => NOW + 1,
        createLeaseToken: () => "lease-terminal-failure-2",
      }),
      "quarantined",
    );
    assert.equal(count(database, "commerce_incidents"), 0);
    assert.deepEqual(
      database.query("SELECT status, last_error_code AS lastErrorCode FROM commerce_sync_state"),
      [{ status: "quarantined", lastErrorCode: "provider_refresh_exhausted" }],
    );
  } finally {
    database.close();
  }
});

test("Cloudflare terminal dispatch uses the financial workflow without Stripe access", async () => {
  const database = await createTestDatabase();
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("terminal reconciliation must not call Stripe");
  };
  try {
    await seedSeller(database);
    await seedSellerProfile(database);
    const queue = { async send() {}, async sendBatch() {} } as QueueProducer<unknown>;
    const runtime = createCloudflareCommerceRuntime({
      DISCORD_BOT_TOKEN: "",
      BOT_USER_ID: "",
      DISCORD_PUBLIC_KEY: "",
      GATEWAY_SESSION_DO: null!,
      GATEWAY_EVENT_QUEUE: null!,
      HAF_DB: database.d1,
      COMMERCE_SYNC_QUEUE: queue,
      STAGING_MODE: "true",
      STRIPE_SECRET_KEY: "sk_test_runtime_key_material",
      STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_test_runtime_key_material",
      STRIPE_API_VERSION: "2026-06-24.dahlia",
    } as Env);
    assert.ok(runtime);
    const store = new CloudflareCommerceReconciliationStore(database.d1, () => NOW);
    await store.accept(webhook("evt-runtime-terminal", "account.closed"));

    assert.equal(await runtime.processMessage(message("evt-runtime-terminal", 1), 1), "processed");
    assert.deepEqual(database.query("SELECT id FROM commerce_financial_actions"), [
      { id: "commerce:stripe-terminal:acct_seller:evt-runtime-terminal" },
    ]);
    assert.deepEqual(
      database.query(
        "SELECT lifecycle_state AS lifecycleState FROM commerce_seller_profiles WHERE connected_account_id = 'acct_seller'",
      ),
      [{ lifecycleState: "disconnected" }],
    );
    assert.deepEqual(
      database.query(
        "SELECT status, charges_enabled AS chargesEnabled, payouts_enabled AS payoutsEnabled FROM commerce_connected_accounts WHERE id = 'acct_seller'",
      ),
      [{ status: "disconnected", chargesEnabled: 0, payoutsEnabled: 0 }],
    );
    assert.equal(count(database, "commerce_incidents"), 1);
    assert.equal(await runtime.processMessage(message("evt-runtime-terminal", 1), 2), "complete");
    assert.equal(count(database, "commerce_financial_actions"), 1);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test("Commerce runtime rejects malformed or cross-environment Stripe secret bindings", () => {
  const queue = { async send() {}, async sendBatch() {} } as QueueProducer<unknown>;
  const base = {
    DISCORD_BOT_TOKEN: "",
    BOT_USER_ID: "",
    DISCORD_PUBLIC_KEY: "",
    GATEWAY_SESSION_DO: null!,
    GATEWAY_EVENT_QUEUE: null!,
    HAF_DB: {} as D1Database,
    COMMERCE_SYNC_QUEUE: queue,
    STAGING_MODE: "true",
    STRIPE_SECRET_KEY: "sk_test_runtime_key_material",
    STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_test_runtime_key_material",
    STRIPE_API_VERSION: "2026-06-24.dahlia",
  } as Env;

  for (const overrides of [
    { STRIPE_SECRET_KEY: "not-a-stripe-secret" },
    { STRIPE_SECRET_KEY: "sk_test_short" },
    { STRIPE_SECRET_KEY: "sk_live_runtime_key_material" },
    { STRIPE_CONNECT_WEBHOOK_SECRET: "not-a-webhook-secret" },
    { STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_short" },
  ]) {
    assert.equal(createCloudflareCommerceRuntime({ ...base, ...overrides }), null);
  }
  assert.ok(
    createCloudflareCommerceRuntime({
      ...base,
      STAGING_MODE: undefined,
      STRIPE_SECRET_KEY: "sk_live_runtime_key_material",
    }),
  );
});

test("outbox sweep and scheduled reconciliation repair queue gaps and missed webhooks", async () => {
  const database = await createTestDatabase();
  try {
    const store = new CloudflareCommerceReconciliationStore(database.d1, () => NOW);
    const sent: CommerceReconciliationMessage[] = [];
    await store.accept(webhook("evt-gap", "account.updated"));
    assert.equal(
      await sweepCommerceSyncOutbox({
        store,
        queue: {
          async send(next) {
            sent.push(next);
          },
        },
        now: () => NOW,
      }),
      1,
    );
    assert.equal(sent[0]?.eventId, "evt-gap");
    assert.equal((await store.listPendingOutbox()).length, 0);

    await processCommerceReconciliationMessage({
      message: sent[0],
      attempts: 1,
      store,
      provider: { readSellerSnapshot: async () => snapshot() },
      now: () => NOW,
      createLeaseToken: () => "lease-gap",
    });
    await seedSellerProfile(database);
    sent.length = 0;
    assert.equal(
      await scheduleCommerceReconciliation({
        store,
        queue: {
          async send(next) {
            sent.push(next);
          },
        },
        scheduleId: "cron-2026-07-28",
        now: () => NOW + 5_000,
      }),
      1,
    );
    assert.match(sent[0]?.eventId ?? "", /^commerce:scheduled:/);
    assert.equal(sent[0]?.generation, 2);
  } finally {
    database.close();
  }
});

test("checkout success can request refresh but scope mismatch is quarantined without access", async () => {
  const database = await createTestDatabase();
  try {
    const store = new CloudflareCommerceReconciliationStore(database.d1, () => NOW);
    const queued: CommerceReconciliationMessage[] = [];
    const trigger = await requestCommerceRefresh({
      connectedAccountId: "acct_seller",
      source: "checkout",
      correlationId: "checkout-attempt-1",
      store,
      queue: {
        async send(next) {
          queued.push(next);
        },
      },
      now: () => NOW,
    });
    assert.equal(queued.length, 1);
    assert.equal(count(database, "commerce_entitlements"), 0);

    assert.equal(
      await processCommerceReconciliationMessage({
        message: trigger,
        attempts: 1,
        store,
        provider: {
          async readSellerSnapshot() {
            return {
              ...snapshot(),
              connectedAccount: {
                ...snapshot().connectedAccount,
                id: "acct_other",
                stripeAccountId: "acct_other",
              },
            };
          },
        },
        now: () => NOW,
        createLeaseToken: () => "lease-bad-scope",
      }),
      "quarantined",
    );
    assert.equal(count(database, "commerce_entitlements"), 0);
    assert.equal(
      count(database, "commerce_incidents"),
      0,
      "unknown seller cannot be misattributed",
    );
    assert.deepEqual(
      database.query("SELECT status, last_error_code AS lastErrorCode FROM commerce_sync_state"),
      [
        {
          status: "quarantined",
          lastErrorCode: "connected_account_scope_mismatch",
        },
      ],
    );
  } finally {
    database.close();
  }
});

test("explicit unsupported provider state creates a seller-visible incident", async () => {
  const database = await createTestDatabase();
  try {
    const store = new CloudflareCommerceReconciliationStore(database.d1, () => NOW);
    await seedSeller(database);
    await store.accept(webhook("evt-unknown", "customer.subscription.updated"));
    assert.equal(
      await processCommerceReconciliationMessage({
        message: message("evt-unknown", 1),
        attempts: 1,
        store,
        provider: {
          async readSellerSnapshot() {
            throw new CommerceProjectionQuarantineError("unknown_commerce_price");
          },
        },
        now: () => NOW,
        createLeaseToken: () => "lease-unknown",
      }),
      "quarantined",
    );
    assert.equal(count(database, "commerce_incidents"), 1);
    assert.equal(count(database, "commerce_entitlements"), 0);
  } finally {
    database.close();
  }
});

test("a stale leased worker cannot quarantine a newer seller generation", async () => {
  const database = await createTestDatabase();
  try {
    const store = new CloudflareCommerceReconciliationStore(database.d1, () => NOW);
    await seedSeller(database);
    await store.accept(webhook("evt-old", "invoice.paid"));
    assert.equal(
      await store.claim({
        message: message("evt-old", 1),
        leaseToken: "lease-old",
        nowMs: NOW,
        leaseMs: 60_000,
      }),
      "claimed",
    );
    await store.accept(webhook("evt-new", "invoice.payment_failed"));

    await store.quarantine({
      message: message("evt-old", 1),
      leaseToken: "lease-old",
      reasonCode: "unknown_commerce_price",
      nowMs: NOW + 1,
    });

    assert.deepEqual(
      database.query(
        `SELECT generation, status, last_error_code AS lastErrorCode
         FROM commerce_sync_state`,
      ),
      [{ generation: 2, status: "pending", lastErrorCode: null }],
    );
    assert.equal(count(database, "commerce_incidents"), 0);
  } finally {
    database.close();
  }
});

function webhook(eventId: string, eventType: string) {
  return {
    eventId,
    eventType,
    objectId: "sub_seller",
    connectedAccountId: "acct_seller",
    providerCreatedAtMs: NOW,
    payloadHash: `hash-${eventId}`,
    apiVersion: "2026-06-24.dahlia",
  };
}

function message(eventId: string, generation: number): CommerceReconciliationMessage {
  return {
    connectedAccountId: "acct_seller",
    eventId,
    resourceType: "seller",
    resourceId: "acct_seller",
    generation,
  };
}

function snapshot(): CommerceSellerSnapshot {
  return {
    connectedAccount: {
      id: "acct_seller",
      guildId: "guild-1",
      stripeAccountId: "acct_seller",
      status: "active",
      country: "AU",
      defaultCurrency: "AUD",
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      providerCreatedAtMs: NOW - 10_000,
      archivedAtMs: null,
      createdAtMs: NOW - 10_000,
      updatedAtMs: NOW,
    },
    buyers: [
      {
        id: "buyer-1",
        discordUserId: "discord-buyer-1",
        createdAtMs: NOW,
        updatedAtMs: NOW,
      },
    ],
    customers: [
      {
        id: "customer-1",
        connectedAccountId: "acct_seller",
        buyerId: "buyer-1",
        stripeCustomerId: "cus_seller",
        createdAtMs: NOW,
        updatedAtMs: NOW,
      },
    ],
    subscriptions: [
      {
        id: "subscription-1",
        connectedAccountId: "acct_seller",
        customerId: "customer-1",
        buyerId: "buyer-1",
        offeringId: "offering-1",
        priceId: "price-1",
        stripeSubscriptionId: "sub_seller",
        status: "active",
        cancelAtPeriodEnd: false,
        currentPeriodStartMs: NOW,
        currentPeriodEndMs: NOW + 2_592_000_000,
        canceledAtMs: null,
        endedAtMs: null,
        providerUpdatedAtMs: NOW,
        latestInvoiceId: "in_seller",
        latestInvoiceStatus: "paid",
        latestPaymentIntentId: "pi_seller",
        latestPaymentStatus: "succeeded",
        graceStartedAtMs: null,
        graceEndsAtMs: null,
        createdAtMs: NOW,
        updatedAtMs: NOW,
      },
    ],
    payments: [
      {
        id: "payment-1",
        connectedAccountId: "acct_seller",
        customerId: "customer-1",
        buyerId: "buyer-1",
        offeringId: "offering-1",
        priceId: "price-1",
        stripePaymentIntentId: "pi_seller",
        stripeChargeId: "ch_seller",
        stripeCheckoutSessionId: "cs_seller",
        stripeInvoiceId: "in_seller",
        stripeSubscriptionId: "sub_seller",
        billingPeriodStartMs: NOW,
        billingPeriodEndMs: NOW + 2_592_000_000,
        isLatestSubscriptionInvoice: true,
        currency: "AUD",
        amountMinor: 500,
        amountReceivedMinor: 500,
        amountRefundedMinor: 100,
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
    refunds: [
      {
        id: "refund-1",
        connectedAccountId: "acct_seller",
        paymentId: "payment-1",
        stripeRefundId: "re_seller",
        currency: "AUD",
        amountMinor: 100,
        applicationFeeRefundedMinor: 5,
        status: "succeeded",
        reason: null,
        providerCreatedAtMs: NOW,
        createdAtMs: NOW,
        updatedAtMs: NOW,
      },
    ],
    disputes: [
      {
        id: "dispute-1",
        connectedAccountId: "acct_seller",
        paymentId: "payment-1",
        stripeDisputeId: "dp_seller",
        currency: "AUD",
        amountMinor: 500,
        status: "under_review",
        reason: "fraudulent",
        providerCreatedAtMs: NOW,
        closedAtMs: null,
        createdAtMs: NOW,
        updatedAtMs: NOW,
      },
    ],
    entitlements: [
      {
        id: "entitlement-1",
        connectedAccountId: "acct_seller",
        buyerId: "buyer-1",
        offeringId: "offering-1",
        sourceType: "subscription",
        sourceId: "subscription-1",
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
        id: "assignment-1",
        entitlementId: "entitlement-1",
        guildId: "guild-1",
        discordUserId: "discord-buyer-1",
        discordRoleId: "role-paid",
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
    supportPayments: [
      {
        id: "support-payment-1",
        connectedAccountId: "acct_seller",
        guildId: "guild-1",
        customerId: "customer-1",
        buyerId: "buyer-1",
        checkoutAttemptId: "support-attempt-1",
        stripePaymentIntentId: "pi_support",
        stripeChargeId: "ch_support",
        stripeCheckoutSessionId: "cs_support",
        currency: "AUD",
        amountMinor: 2_000,
        amountReceivedMinor: 2_000,
        amountRefundedMinor: 500,
        applicationFeeMinor: 100,
        stripeFeeMinor: 88,
        stripeFeeTaxMinor: 8,
        status: "succeeded",
        providerCreatedAtMs: NOW,
        paidAtMs: NOW,
        createdAtMs: NOW,
        updatedAtMs: NOW,
      },
    ],
    supportRefunds: [
      {
        id: "support-refund-1",
        connectedAccountId: "acct_seller",
        supportPaymentId: "support-payment-1",
        stripeRefundId: "re_support",
        currency: "AUD",
        amountMinor: 500,
        applicationFeeRefundedMinor: 25,
        status: "succeeded",
        reason: null,
        providerCreatedAtMs: NOW,
        createdAtMs: NOW,
        updatedAtMs: NOW,
      },
    ],
    observedAtMs: NOW,
  };
}

async function seedSeller(database: Awaited<ReturnType<typeof createTestDatabase>>) {
  const seller = snapshot().connectedAccount;
  await database.d1
    .prepare(
      `INSERT INTO commerce_connected_accounts(
         id, guild_id, stripe_account_id, status, country, default_currency,
         charges_enabled, payouts_enabled, details_submitted, provider_created_at_ms,
         archived_at_ms, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1, ?, NULL, ?, ?)`,
    )
    .bind(
      seller.id,
      seller.guildId,
      seller.stripeAccountId,
      seller.status,
      seller.country,
      seller.defaultCurrency,
      seller.providerCreatedAtMs,
      seller.createdAtMs,
      seller.updatedAtMs,
    )
    .run();
}

async function seedSellerProfile(database: Awaited<ReturnType<typeof createTestDatabase>>) {
  await database.d1
    .prepare(
      `INSERT INTO commerce_seller_profiles(
         connected_account_id, guild_id, lifecycle_state, approval_state, support_contact,
         adult_attested_at_ms, two_factor_evidence, guild_created_at_ms,
         ownership_transferred_at_ms, guild_good_standing, seller_good_standing,
         requirements_currently_due_json, requirements_eventually_due_json,
         requirements_pending_verification_json, disabled_reason, reviewed_by_user_id,
         reviewed_at_ms, capabilities_updated_at_ms, created_at_ms, updated_at_ms
       ) VALUES (?, ?, 'active', 'approved', ?, ?, 'seller_attested', ?, NULL, 1, 1,
         '[]', '[]', '[]', NULL, ?, ?, ?, ?, ?)`,
    )
    .bind(
      "acct_seller",
      "guild-1",
      "seller@example.test",
      NOW - 20_000,
      NOW - 31_536_000_000,
      "operator-1",
      NOW - 10_000,
      NOW,
      NOW - 10_000,
      NOW,
    )
    .run();
}

function count(
  database: Awaited<ReturnType<typeof createTestDatabase>>,
  table: string,
): number | undefined {
  return database.query<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)[0]?.count;
}
