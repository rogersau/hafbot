import assert from "node:assert/strict";
import test from "node:test";
import { createProductionRuntimeStores } from "./support/production-runtime-stores";
import type { TestDatabase } from "./support/sqlite-d1-database";
import {
  CommerceBuyerCheckoutService,
  type CommerceBuyerCheckoutProvider,
  type CommercePurchasePolicy,
} from "../src/commerce/buyer-checkout";
import {
  createSqliteGameAccessStore,
  createGameAccessRuntime,
  handleCommerceGameQueueBatch,
} from "./support/sqlite/runtime/commerce/game-access-runtime";
import { SqliteCommerceBuyerCheckoutStore } from "./support/sqlite/runtime/commerce/sqlite-buyer-checkout-store";
import { createSqliteCommerceStore } from "./support/sqlite/runtime/sqlite-commerce-store";
import { SqliteCommerceReconciliationStore } from "./support/sqlite/runtime/commerce/sqlite-reconciliation-store";
import { StripeCommerceSnapshotProvider } from "./support/sqlite/runtime/commerce/stripe-snapshot-provider";
import {
  processCommerceReconciliationMessage,
  type CommerceSellerSnapshot,
} from "../src/runtime/commerce/reconciliation";
import type { GameAccessMessage } from "../src/commerce/game-access/model";
import {
  createWardogsAccessProvider,
  type GameAccessProvider,
} from "../src/commerce/game-access/provider";
import type { CommerceSubscription, CommerceEntitlement } from "../src/commerce/types";
import { createWebhookCredentialKeyRing } from "../src/security/webhook-credentials";
import type { NetworkPolicy } from "../src/wardogs/model";
import { WardogsService } from "../src/wardogs/service";
import { createSqliteWardogsStore } from "./support/sqlite/runtime/sqlite-wardogs-store";
const NOW = 1_900_000_000_000;
const OFFERING_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_OFFERING = "22222222-2222-4222-8222-222222222222";
const GUILD = "111111111111111111";
const USER = "123456789012345678";
const SUBJECT = "76561198000000001";
const SECOND_SUBJECT = "76561198000000002";
async function workflow(options: { realWardogs?: boolean; policy?: CommercePurchasePolicy } = {}) {
  const fixture = createProductionRuntimeStores();
  const db = fixture.database;
  await seedStorefront(db);
  db.execRaw(
    `INSERT INTO commerce_offerings SELECT '${SECOND_OFFERING}',connected_account_id,guild_id,'333333333333333333','Second',description,purchase_type,status,archived_at_ms,created_at_ms,updated_at_ms FROM commerce_offerings WHERE id='${OFFERING_ID}';`,
  );
  db.execRaw(
    `INSERT INTO commerce_offering_lifecycles SELECT '${SECOND_OFFERING}',connected_account_id,guild_id,state,terms_version,included_benefits_json,support_contact,role_manageable,repair_deadline_at_ms,retire_at_ms,published_at_ms,archived_at_ms,created_at_ms,updated_at_ms FROM commerce_offering_lifecycles WHERE offering_id='${OFFERING_ID}';`,
  );
  db.execRaw(
    `INSERT INTO commerce_prices SELECT 'price_second',connected_account_id,'${SECOND_OFFERING}',stripe_product_id,'price_second',currency,unit_amount_minor,price_type,recurring_interval,status,provider_created_at_ms,retired_at_ms,created_at_ms FROM commerce_prices WHERE id='price_local';`,
  );
  let now = NOW;
  const control = {
    premium: true,
    member: true,
    memberOutage: false,
    ready: true,
    generation: 1,
    mode: "normal",
    beforeSend: async () => {},
  };
  const stripeCalls: string[] = [];
  const discordCalls: string[] = [];
  const providerCalls: string[] = [];
  const reservations = new Set<string>();
  const queue: GameAccessMessage[] = [];
  const wardogsCalls: { url: string; method: string; atMs: number }[] = [];
  const wait = async (ms: number) => {
    now += ms;
  };
  const policy: NetworkPolicy = {
    enabled: true,
    origins: [
      {
        id: "fixture",
        origin: "https://fixture.example",
        securePathEvidence: "Synthetic only",
      },
    ],
    approvals: [],
  };
  const wardogs = new WardogsService({
    store: createSqliteWardogsStore(db.d1),
    ...(options.realWardogs
      ? {
          policy,
          mutationsEnabled: true,
          reservedAccessEnabled: true,
          commerceGrantsEnabled: true,
          keyRing: () => createWebhookCredentialKeyRing({ keyV1: btoa("k".repeat(32)) }),
          now: () => now,
          wait,
          transport: async (url: string, init: RequestInit) => {
            const method = init.method!;
            wardogsCalls.push({ url, method, atMs: now });
            if (method === "POST") reservations.add(JSON.parse(String(init.body)).steamId);
            if (method === "DELETE") reservations.delete(url.split("/").at(-1)!);
            if (control.mode === "lost" && method !== "GET") throw new Error("Response lost");
            if (control.mode === "http-failure" && method !== "GET")
              return new Response(null, { status: 503 });
            if (control.mode === "rate-limited")
              return new Response(null, { status: 429, headers: { "retry-after": "60" } });
            return Response.json(
              url.endsWith("capabilities")
                ? {
                    routes: [
                      "GET /v1/status",
                      "GET /v1/reserved-slots",
                      "POST /v1/reserved-slots",
                      "DELETE /v1/reserved-slots/{steamId}",
                    ],
                  }
                : url.endsWith("status")
                  ? { players: { current: 0, max: 64 } }
                  : { reservedSlots: [...reservations] },
            );
          },
        }
      : {}),
  });
  let targetId = "target";
  if (options.realWardogs) {
    let target = await wardogs.create(GUILD, "Synthetic", "fixture");
    target = await wardogs.change({
      guildId: GUILD,
      targetId: target.id,
      generation: target.generation,
      enabled: true,
      commerceEnabled: true,
      secret: "synthetic-password",
    });
    targetId = target.id;
    policy.approvals = [
      {
        targetId,
        generation: target.generation,
        originRef: "fixture",
        origin: policy.origins[0].origin,
        reservedContract: {
          physicalTargetId: "physical",
          evidence: "Synthetic only",
          completeList: true,
          capacityMeaning: "saleable-entries",
          entryCapacity: 4,
        },
      },
    ];
    await wardogs.verify({
      guildId: GUILD,
      targetId,
      generation: target.generation,
      roster: false,
    });
  }
  const store = createSqliteGameAccessStore(db.d1);
  const premium = { isPremium: async () => control.premium };
  const provider: GameAccessProvider = {
    async readiness(guildId, targetId) {
      return {
        guildId,
        targetId,
        generation: control.generation,
        physicalTarget: "physical",
        origin: "https://fixture.example",
        capacity: 4,
        ready: control.ready,
      };
    },
    async capabilities() {
      return true;
    },
    async list() {
      providerCalls.push("GET");
      if (control.mode === "outage") throw new Error("fixture failure");
      return new Set(reservations);
    },
    async mutate(_target, subject, action, beforeSend) {
      await control.beforeSend();
      await beforeSend();
      providerCalls.push(`${action}:${subject}`);
      if (action === "grant") reservations.add(subject);
      else reservations.delete(subject);
      if (control.mode === "lost") throw new Error("response lost");
    },
  };
  const runtime = createGameAccessRuntime({
    database: db.d1,
    store,
    wardogs,
    platformLink: fixture.stores.platformLink,
    botUserId: "fixture-bot",
    botToken: "synthetic-only",
    provider: options.realWardogs ? createWardogsAccessProvider(wardogs) : provider,
    enabled: true,
    steamEnabled: true,
    premium,
    now: () => now,
    wait,
    memberState: async (g, u) => {
      discordCalls.push(`member:${g}:${u}`);
      if (control.memberOutage) throw new Error("Discord unavailable");
      return control.member ? "present" : "left";
    },
    queue: {
      send: async (message) => {
        queue.push(message);
      },
    },
  });
  const link = (subject = SUBJECT, active = true, manual = false, guildId = GUILD, userId = USER) =>
    fixture.stores.platformLink.upsertPlatformLink({
      guildId,
      userId,
      platform: "steam",
      platformId: subject,
      active,
      manual,
      linkedAtMs: now,
      actionedByUserId: null,
      metadataJson: null,
    });
  await link();
  for (const offeringId of [OFFERING_ID, SECOND_OFFERING])
    await runtime.service.configure({
      offeringId,
      guildId: GUILD,
      targetId,
      allocationCeiling: 3,
      acceptingSales: true,
      actorId: "seller",
    });
  const buyerStore = new SqliteCommerceBuyerCheckoutStore(db.d1, premium);
  const stripe: CommerceBuyerCheckoutProvider = {
    async createCustomer() {
      stripeCalls.push("customer");
      return { id: "cus_fixture" };
    },
    async createSubscriptionCheckout(input) {
      stripeCalls.push(`checkout:${input.checkoutAttemptId}`);
      return { id: `cs_${input.checkoutAttemptId}`, url: "https://checkout.stripe.com/fixture" };
    },
    async retrieveSubscriptionCheckout(input) {
      stripeCalls.push("retrieve");
      return { id: input.checkoutSessionId, url: "https://checkout.stripe.com/fixture" };
    },
    async expireSubscriptionCheckout() {
      stripeCalls.push("expire");
    },
    async createCustomerPortal() {
      stripeCalls.push("portal");
      return { url: "https://billing.stripe.com/fixture" };
    },
  };
  const redirects: string[] = [];
  const buyerService = new CommerceBuyerCheckoutService(
    buyerStore,
    stripe,
    {
      request: async (input) => {
        redirects.push(input.correlationId);
      },
    },
    options.policy,
    () => now,
    () => crypto.randomUUID(),
    runtime.hooks,
  );
  const checkout = (offeringId = OFFERING_ID, subject?: string) =>
    buyerService.startSubscriptionCheckout({
      offeringId,
      discordUserId: USER,
      checkoutAttemptId: crypto.randomUUID(),
      subject,
      successUrl: "https://fixture.example/return",
      cancelUrl: "https://fixture.example/cancel",
      preflight: {
        memberPresent: control.member,
        memberIsBot: false,
        memberBanned: false,
        roleManageable: true,
      },
    });
  const finance = createSqliteCommerceStore(db.d1);
  const sync = new SqliteCommerceReconciliationStore(db.d1, () => now);
  const subscriptions: CommerceSubscription[] = [];
  const entitlements: CommerceEntitlement[] = [];
  let serial = 0;
  const project = async (providerSnapshot?: CommerceSellerSnapshot) => {
    const buyer = await buyerStore.getOrCreateBuyer(USER, now);
    const customer = await buyerStore.readCustomer("acct_seller", buyer.id);
    assert.ok(customer);
    const account = await finance.readConnectedAccountByGuild(GUILD);
    assert.ok(account);
    const eventId = `evt_${++serial}`;
    const accepted = await sync.accept({
      eventId,
      eventType: "invoice.paid",
      objectId: null,
      connectedAccountId: account.id,
      providerCreatedAtMs: now,
      payloadHash: "fixture",
    });
    const snapshot: CommerceSellerSnapshot = {
      connectedAccount: account,
      buyers: [buyer],
      customers: [customer],
      subscriptions,
      entitlements,
      payments: [],
      refunds: [],
      disputes: [],
      roleAssignments: [],
      observedAtMs: now,
    };
    assert.equal(
      await processCommerceReconciliationMessage({
        store: sync,
        provider: { readSellerSnapshot: async () => providerSnapshot ?? snapshot },
        attempts: 1,
        now: () => now,
        message: {
          connectedAccountId: account.id,
          eventId,
          resourceType: "seller",
          resourceId: account.id,
          generation: accepted.generation,
        },
      }),
      "processed",
    );
  };
  const pay = async (offeringId = OFFERING_ID) => {
    const buyer = await buyerStore.getOrCreateBuyer(USER, now);
    const customer = await buyerStore.readCustomer("acct_seller", buyer.id);
    assert.ok(customer);
    const attempts = db.query<{ id: string }>(
      "SELECT c.id FROM commerce_checkout_attempts c JOIN commerce_game_selections gs ON gs.checkout_id=c.id WHERE c.offering_id=? ORDER BY c.created_at_ms DESC",
      offeringId,
    );
    assert.ok(attempts[0]);
    const id = `subscription_${subscriptions.length}`;
    subscriptions.push({
      id,
      connectedAccountId: "acct_seller",
      buyerId: buyer.id,
      customerId: customer.id,
      offeringId,
      priceId: offeringId === OFFERING_ID ? "price_local" : "price_second",
      stripeSubscriptionId: `sub_${id}`,
      checkoutAttemptId: attempts[0].id,
      status: "active",
      cancelAtPeriodEnd: false,
      currentPeriodStartMs: now,
      currentPeriodEndMs: now + 30 * 86400000,
      canceledAtMs: null,
      endedAtMs: null,
      providerUpdatedAtMs: now,
      latestInvoiceId: null,
      latestInvoiceStatus: "paid",
      latestPaymentIntentId: null,
      latestPaymentStatus: "succeeded",
      graceStartedAtMs: null,
      graceEndsAtMs: null,
      createdAtMs: now,
      updatedAtMs: now,
    });
    entitlements.push({
      id: `entitlement_${subscriptions.length}`,
      connectedAccountId: "acct_seller",
      buyerId: buyer.id,
      offeringId,
      sourceType: "subscription",
      sourceId: `sub_${id}`,
      status: "active",
      effectiveAtMs: now,
      expiresAtMs: null,
      revokedAtMs: null,
      createdAtMs: now,
      updatedAtMs: now,
    });
    await project();
  };
  const drain = async () => {
    for (const message of queue.splice(0)) await runtime.service.processMessage(message);
  };
  const cycle = async () => {
    now += 900001;
    await runtime.sweepOutbox();
    await drain();
  };
  const assignment = async () => (await store.list())[0]!;
  return {
    fixture,
    db,
    control,
    runtime,
    store,
    buyerService,
    buyerStore,
    stripe,
    wardogs,
    wardogsCalls,
    targetId,
    checkout,
    pay,
    project,
    subscriptions,
    entitlements,
    cycle,
    drain,
    queue,
    link,
    assignment,
    reservations,
    stripeCalls,
    discordCalls,
    providerCalls,
    redirects,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("real checkout snapshots the selected identity; financial reconciliation aggregates purchases without role writes", async (t) => {
  const h = await workflow();
  t.after(() => h.fixture.close());
  await h.link(SECOND_SUBJECT);
  await assert.rejects(h.checkout(), /Choose/);
  assert.equal(h.stripeCalls.length, 0);
  await h.checkout(OFFERING_ID, SUBJECT);
  const selected = (await h.store.selections((await h.assignment()).id))[0];
  assert.equal(selected.subject, SUBJECT);
  await assert.rejects(h.checkout(OFFERING_ID, SECOND_SUBJECT), /substituted/);
  await h.buyerService.handleBrowserReturn({
    offeringId: OFFERING_ID,
    discordUserId: USER,
    checkoutAttemptId: selected.checkoutId,
  });
  assert.equal(h.redirects.length, 1);
  assert.equal(h.providerCalls.filter((x) => x !== "GET").length, 0);
  await h.pay();
  await h.cycle();
  assert.equal((await h.assignment()).state, "managed");
  await h.checkout(SECOND_OFFERING, SUBJECT);
  await h.pay(SECOND_OFFERING);
  await h.cycle();
  assert.equal((await h.assignment()).entitlementIds.length, 2);
  h.subscriptions[0].status = "ended";
  await h.project();
  await h.cycle();
  assert.ok(h.reservations.has(SUBJECT));
  h.subscriptions[1].status = "ended";
  await h.project();
  await h.cycle();
  assert.equal((await h.assignment()).state, "removed");
  assert.deepEqual(
    h.providerCalls.filter((x) => x !== "GET"),
    [`grant:${SUBJECT}`, `remove:${SUBJECT}`],
  );
  assert.equal(h.db.query("SELECT * FROM commerce_role_assignments").length, 0);
  assert.ok(h.discordCalls.every((x) => x.startsWith("member:")));
  assert.deepEqual(
    h.subscriptions.map((s) => s.status),
    ["ended", "ended"],
  );
});

test("queued versions are fenced by trusted financial commits and concurrent duplicates", async (t) => {
  const h = await workflow();
  t.after(() => h.fixture.close());
  await h.checkout();
  await h.pay();
  await h.runtime.sweepOutbox();
  const stale = h.queue.shift()!;
  assert.ok(stale);
  h.subscriptions[0].status = "ended";
  await h.project();
  await h.runtime.service.processMessage(stale);
  assert.equal(h.providerCalls.filter((x) => x !== "GET").length, 0);
  h.subscriptions[0].status = "active";
  await h.project();
  await h.runtime.sweepOutbox();
  const current = h.queue.shift()!;
  await Promise.all([
    h.runtime.service.processMessage(current),
    h.runtime.service.processMessage(current),
  ]);
  assert.equal(h.providerCalls.filter((x) => x.startsWith("grant")).length, 1);
  await h.runtime.service.processMessage(stale);
  assert.equal(h.providerCalls.filter((x) => x.startsWith("grant")).length, 1);
  assert.ok(!JSON.stringify(current).includes(SUBJECT));
  assert.deepEqual(Object.keys(current.assignments[0]).sort(), [
    "assignmentId",
    "generation",
    "revision",
  ]);
});

test("unlink, departure and same-account rejoin use original selection; saved replacement cannot migrate access", async (t) => {
  const h = await workflow();
  t.after(() => h.fixture.close());
  await h.checkout();
  await h.pay();
  await h.link(SUBJECT, false);
  await h.link(SECOND_SUBJECT);
  await h.cycle();
  assert.equal(h.reservations.size, 0);
  await h.link();
  await h.cycle();
  assert.ok(h.reservations.has(SUBJECT));
  h.control.member = false;
  await h.cycle();
  assert.equal(h.reservations.size, 0);
  h.control.member = true;
  await h.cycle();
  assert.ok(h.reservations.has(SUBJECT));
  assert.ok(!h.reservations.has(SECOND_SUBJECT));
  await h.link(SUBJECT, false);
  await h.cycle();
  assert.equal((await h.assignment()).state, "removed");
});

for (const condition of ["free", "dormant", "suspended"] as const)
  test(`${condition} stops checkout before Stripe`, async (t) => {
    const h = await workflow();
    t.after(() => h.fixture.close());
    if (condition === "free") h.control.premium = false;
    if (condition === "dormant")
      h.db.execRaw("UPDATE commerce_offering_lifecycles SET state='unpublished'");
    if (condition === "suspended")
      h.db.execRaw(
        `INSERT INTO commerce_seller_controls(id,scope_type,scope_id,suspended,reason_code,actor_user_id,created_at_ms,updated_at_ms) VALUES('control','guild','${GUILD}',1,'review','staff',1,1)`,
      );
    await assert.rejects(h.checkout());
    assert.equal(h.stripeCalls.length, 0);
  });

test("offboarding prevents new grants while servicing cleanup and preserving financial state", async (t) => {
  const h = await workflow();
  t.after(() => h.fixture.close());
  await h.checkout();
  await h.pay();
  await h.cycle();
  h.control.premium = false;
  h.db.execRaw("UPDATE commerce_offering_lifecycles SET state='archived',archived_at_ms=1");
  h.subscriptions[0].status = "ended";
  await h.project();
  await h.cycle();
  assert.equal((await h.assignment()).state, "removed");
  h.subscriptions[0].status = "active";
  await h.project();
  await h.cycle();
  assert.equal((await h.assignment()).state, "withheld");
  assert.equal(
    h.db.query<{ status: string }>("SELECT status FROM commerce_subscriptions")[0].status,
    "active",
  );
  assert.equal(h.db.query("SELECT * FROM commerce_role_assignments").length, 0);
});

test("lost acknowledgement retains obligation and honest buyer state without financial mutation", async (t) => {
  const h = await workflow();
  t.after(() => h.fixture.close());
  await h.checkout();
  await h.pay();
  h.control.mode = "lost";
  await h.cycle();
  h.db.execRaw(
    `INSERT INTO commerce_role_assignments(id,entitlement_id,guild_id,discord_user_id,discord_role_id,status,attempt_count,last_error_code,next_attempt_at_ms,assigned_at_ms,removed_at_ms,created_at_ms,updated_at_ms) VALUES('role-assignment','entitlement_1','${GUILD}','${USER}','222222222222222222','assigned',1,NULL,NULL,1,NULL,1,1)`,
  );
  const status = await h.buyerService.buyerStatus(OFFERING_ID, USER);
  assert.equal(status.subscriptionStatus, "active");
  assert.equal(status.gameAccess?.state, "needs-attention");
  assert.equal(status.roleDeliveryStatus, "assigned");
  h.subscriptions[0].status = "ended";
  await h.project();
  h.control.mode = "normal";
  await h.cycle();
  assert.equal((await h.assignment()).obligation, true);
  assert.equal(h.providerCalls.filter((x) => x !== "GET").length, 1);
  assert.equal(
    h.db.query<{ status: string }>("SELECT status FROM commerce_role_assignments")[0].status,
    "assigned",
  );
});

test("Queue input cannot substitute a subject or command; dispatch rechecks target generation", async (t) => {
  const h = await workflow();
  t.after(() => h.fixture.close());
  await h.checkout();
  await h.pay();
  await h.runtime.sweepOutbox();
  const work = h.queue.shift()!;
  let acked = false;
  const body = { ...work, subject: SECOND_SUBJECT, action: "grant" };
  await handleCommerceGameQueueBatch(
    {
      queue: "fixture",
      messages: [
        {
          id: "message",
          timestamp: new Date(NOW),
          attempts: 1,
          body,
          ack() {
            acked = true;
          },
          retry() {
            throw new Error("unexpected retry");
          },
        },
      ],
      ackAll() {},
      retryAll() {},
    },
    h.runtime,
  );
  assert.ok(acked);
  assert.equal(h.providerCalls.filter((x) => x !== "GET").length, 0);
  h.control.beforeSend = async () => {
    h.control.generation++;
  };
  await h.runtime.service.processMessage(work);
  assert.equal(h.providerCalls.filter((x) => x !== "GET").length, 0);
});

async function seedStorefront(database: TestDatabase) {
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

test("Discord outage cannot block financial or original-identity cleanup", async (t) => {
  const h = await workflow();
  t.after(() => h.fixture.close());
  await h.checkout();
  await h.pay();
  await h.cycle();
  h.control.memberOutage = true;
  h.subscriptions[0].status = "ended";
  await h.project();
  await h.cycle();
  assert.equal((await h.assignment()).state, "removed");
  h.subscriptions[0].status = "active";
  await h.project();
  await h.cycle();
  assert.equal((await h.assignment()).state, "needs-attention");
  assert.equal((await h.assignment()).reason, "eligibility_unavailable");
  h.control.memberOutage = false;
  await h.cycle();
  assert.equal((await h.assignment()).state, "managed");
  h.control.memberOutage = true;
  await h.link(SUBJECT, false);
  await h.cycle();
  assert.equal((await h.assignment()).state, "removed");
});

for (const existingCustomer of [false, true])
  test(`real WARDOGS budgets permit public checkout and resume with existing customer=${existingCustomer}`, async (t) => {
    const h = await workflow({ realWardogs: true });
    t.after(() => h.fixture.close());
    if (existingCustomer) {
      const buyer = await h.buyerStore.getOrCreateBuyer(USER, NOW);
      await h.buyerStore.saveCustomer({
        id: "customer",
        connectedAccountId: "acct_seller",
        buyerId: buyer.id,
        stripeCustomerId: "cus_fixture",
        createdAtMs: NOW,
        updatedAtMs: NOW,
      });
    }
    const session = await h.checkout();
    assert.equal(h.stripeCalls.filter((c) => c.startsWith("checkout:")).length, 1);
    assert.equal(h.stripeCalls.includes("customer"), !existingCustomer);
    assert.deepEqual(await h.checkout(), session);
    assert.equal(h.stripeCalls.filter((c) => c.startsWith("checkout:")).length, 1);
    assert.ok(h.wardogsCalls.every((call) => call.method === "GET"));
    for (let i = 1; i < h.wardogsCalls.length; i++)
      assert.ok(h.wardogsCalls[i].atMs - h.wardogsCalls[i - 1].atMs >= 5000);
    const buyer = await h.buyerStore.getOrCreateBuyer(USER, NOW);
    const attempt = await h.buyerStore.readActiveCheckout({
      connectedAccountId: "acct_seller",
      buyerId: buyer.id,
      offeringId: OFFERING_ID,
      nowMs: NOW,
    });
    assert.ok(attempt);
    await h.link(SUBJECT, false);
    await assert.rejects(
      h.runtime.service.revalidateCheckout(attempt.id, GUILD, USER),
      /original selected/,
    );
    await h.link();
    h.reservations.add("76561198000000003");
    h.reservations.add("76561198000000004");
    await assert.rejects(h.runtime.service.revalidateCheckout(attempt.id, GUILD, USER), /capacity/);
    assert.equal(h.stripeCalls.filter((c) => c.startsWith("checkout:")).length, 1);
  });

test("real adapter preserves upstream cooldown instead of replaying a rate-limited read", async (t) => {
  const h = await workflow({ realWardogs: true });
  t.after(() => h.fixture.close());
  h.control.mode = "rate-limited";
  const before = h.wardogsCalls.length;
  await assert.rejects(h.checkout(), { code: "rate_limited" });
  assert.equal(h.wardogsCalls.length - before, 1);
  h.control.mode = "normal";
  await assert.rejects(h.checkout(), { code: "rate_limited" });
  assert.equal(h.wardogsCalls.length - before, 1);
  assert.equal(h.stripeCalls.length, 0);
});

for (const boundary of ["customer-save", "purchase-claim", "final-identity"] as const)
  test(`confirmed pre-session ${boundary} failure releases its unpaid allocation`, async (t) => {
    let rejectPolicy = boundary === "purchase-claim";
    const h = await workflow({
      policy: {
        assertPurchaseAllowed: async () => {},
        claimPurchase: async () => {
          if (rejectPolicy) throw new Error("local purchase failure");
        },
      },
    });
    t.after(() => h.fixture.close());
    await h.runtime.service.configure({
      offeringId: OFFERING_ID,
      guildId: GUILD,
      targetId: h.targetId,
      allocationCeiling: 1,
      acceptingSales: true,
      actorId: "seller",
    });
    const save = h.buyerStore.saveCustomer.bind(h.buyerStore);
    h.buyerStore.saveCustomer = async (customer) => {
      if (boundary === "customer-save") throw new Error("local customer failure");
      await save(customer);
      if (boundary === "final-identity") await h.link(SUBJECT, false);
    };
    await assert.rejects(h.checkout(), /local|original selected/);
    h.buyerStore.saveCustomer = save;
    rejectPolicy = false;
    assert.equal(h.stripeCalls.filter((c) => c.startsWith("checkout:")).length, 0);
    const failed = h.db.query<{
      status: string;
      pre_session_failed_at_ms: number;
      provider_terminal_at_ms: number | null;
    }>(
      "SELECT status,pre_session_failed_at_ms,provider_terminal_at_ms FROM commerce_checkout_attempts",
    )[0];
    assert.equal(failed.status, "failed");
    assert.ok(failed.pre_session_failed_at_ms);
    assert.equal(failed.provider_terminal_at_ms, null);
    h.advance(86400000);
    await h.cycle();
    assert.equal((await h.assignment()).slot, null);
    assert.equal((await h.assignment()).obligation, false);
    const other = "223456789012345678";
    await h.link(SECOND_SUBJECT, true, false, GUILD, other);
    h.stripe.createCustomer = async () => ({ id: "cus_other" });
    await h.buyerService.startSubscriptionCheckout({
      offeringId: OFFERING_ID,
      discordUserId: other,
      checkoutAttemptId: crypto.randomUUID(),
      successUrl: "https://fixture.example/return",
      cancelUrl: "https://fixture.example/cancel",
      preflight: {
        memberPresent: true,
        memberIsBot: false,
        memberBanned: false,
        roleManageable: true,
      },
    });
    assert.equal(h.stripeCalls.filter((c) => c.startsWith("checkout:")).length, 1);
    assert.equal((await h.store.list()).filter((a) => a.slot !== null).length, 1);
  });

for (const boundary of ["response-loss", "session-save"] as const)
  test(`${boundary} after invoking Stripe never becomes confirmed pre-session failure`, async (t) => {
    const h = await workflow();
    t.after(() => h.fixture.close());
    if (boundary === "response-loss") {
      const create = h.stripe.createSubscriptionCheckout;
      h.stripe.createSubscriptionCheckout = async (input) => {
        await create(input);
        throw new Error("response lost");
      };
    } else
      h.buyerStore.attachCheckoutSession = async () => {
        throw new Error("local write failed after Stripe");
      };
    await assert.rejects(h.checkout());
    assert.equal(h.stripeCalls.filter((c) => c.startsWith("checkout:")).length, 1);
    const attempt = h.db.query<{ id: string; pre_session_failed_at_ms: number | null }>(
      "SELECT id,pre_session_failed_at_ms FROM commerce_checkout_attempts",
    )[0];
    assert.equal(attempt.pre_session_failed_at_ms, null);
    h.advance(86400000);
    await h.cycle();
    assert.notEqual((await h.assignment()).slot, null);
    assert.equal((await h.assignment()).state, "pending");
    await assert.rejects(
      h.buyerService.startSubscriptionCheckout({
        offeringId: OFFERING_ID,
        discordUserId: USER,
        checkoutAttemptId: attempt.id,
        successUrl: "https://fixture.example/return",
        cancelUrl: "https://fixture.example/cancel",
        preflight: {
          memberPresent: true,
          memberIsBot: false,
          memberBanned: false,
          roleManageable: true,
        },
      }),
      /already_open/,
    );
    assert.equal(h.stripeCalls.filter((c) => c.startsWith("checkout:")).length, 1);
  });

test("delayed and lost publication retains claimable grant and removal work across repeated sweeps", async (t) => {
  const h = await workflow();
  t.after(() => h.fixture.close());
  await h.checkout();
  await h.pay();
  for (const action of ["grant", "remove"] as const) {
    if (action === "remove") {
      h.subscriptions[0].status = "ended";
      await h.project();
    }
    await assert.rejects(
      h.runtime.service.sweepOutbox({
        send: async () => {
          throw new Error("Queue unavailable");
        },
      }),
    );
    h.advance(60001);
    await h.runtime.sweepOutbox();
    const delayed = h.queue.shift()!;
    for (let n = 0; n < 8; n++) {
      h.advance(60001);
      await h.runtime.sweepOutbox();
    }
    for (const message of h.queue) assert.deepEqual(message, delayed);
    await Promise.all([
      h.runtime.service.processMessage(delayed),
      h.runtime.service.processMessage(delayed),
    ]);
    await h.drain();
    assert.equal(h.providerCalls.filter((c) => c.startsWith(`${action}:`)).length, 1);
    assert.equal((await h.assignment()).state, action === "grant" ? "managed" : "removed");
  }
});

for (const action of ["grant", "remove"] as const)
  test(`real adapter: slow durable ${action} recording is proven unsent and safely repairable`, async (t) => {
    const h = await workflow({ realWardogs: true });
    t.after(() => h.fixture.close());
    await h.checkout();
    await h.pay();
    if (action === "remove") {
      await h.cycle();
      h.subscriptions[0].status = "ended";
      await h.project();
    }
    const save = h.store.save.bind(h.store);
    let inject = true;
    h.store.save = async (value, revision) => {
      const saved = await save(value, revision);
      if (saved && value.transmitted && !value.transmitted.acknowledged && inject) {
        inject = false;
        h.advance(1001);
      }
      return saved;
    };
    const before = h.wardogsCalls.filter((c) => c.method !== "GET").length;
    await h.cycle();
    const a = await h.assignment();
    assert.equal(h.wardogsCalls.filter((c) => c.method !== "GET").length, before);
    assert.equal(a.transmitted, null);
    assert.equal(a.ownership, action === "grant" ? "none" : "haf");
    assert.equal(a.obligation, action === "remove");
    assert.equal(a.reason, "timeout");
    await h.runtime.service.repair({
      guildId: GUILD,
      id: a.id,
      actorId: "seller",
      reason: "Database latency recovered",
    });
    await h.cycle();
    assert.equal((await h.assignment()).state, action === "grant" ? "managed" : "removed");
    assert.equal(h.wardogsCalls.filter((c) => c.method !== "GET").length, before + 1);
  });

test("proven unsent recording clears only its marker when financial truth changes during the callback", async (t) => {
  const h = await workflow({ realWardogs: true });
  t.after(() => h.fixture.close());
  await h.checkout();
  await h.pay();
  const save = h.store.save.bind(h.store);
  let inject = true;
  h.store.save = async (value, revision) => {
    const saved = await save(value, revision);
    if (saved && value.transmitted && !value.transmitted.acknowledged && inject) {
      inject = false;
      h.subscriptions[0].status = "ended";
      await h.project();
      h.advance(1001);
    }
    return saved;
  };
  await h.cycle();
  assert.equal((await h.assignment()).transmitted, null);
  await h.cycle();
  assert.equal((await h.assignment()).state, "removed");
  assert.equal(h.wardogsCalls.filter((c) => c.method !== "GET").length, 0);
});

for (const mode of ["lost", "http-failure"])
  test(`real adapter ${mode} after transport invocation remains fenced`, async (t) => {
    const h = await workflow({ realWardogs: true });
    t.after(() => h.fixture.close());
    await h.checkout();
    await h.pay();
    h.control.mode = mode;
    await h.cycle();
    assert.equal((await h.assignment()).ownership, "uncertain");
    assert.equal((await h.assignment()).transmitted?.acknowledged, false);
    h.control.mode = "normal";
    h.subscriptions[0].status = "ended";
    await h.project();
    await h.cycle();
    assert.equal(h.wardogsCalls.filter((c) => c.method !== "GET").length, 1);
    await assert.rejects(
      h.runtime.service.repair({
        guildId: GUILD,
        id: (await h.assignment()).id,
        actorId: "seller",
        reason: "Provider needs investigation",
      }),
      /possible late/,
    );
  });

test("public buyer status follows a pending/current repurchase selection and preserves historical cleanup", async (t) => {
  const h = await workflow();
  t.after(() => h.fixture.close());
  const empty = await h.buyerService.buyerStatus(OFFERING_ID, USER);
  assert.equal(empty.subscriptionStatus, null);
  assert.equal(empty.gameAccess?.state, "pending");
  await h.checkout();
  await h.pay();
  await h.cycle();
  h.subscriptions[0].status = "ended";
  h.entitlements[0].status = "expired";
  await h.project();
  await h.cycle();
  const original = await h.assignment();
  assert.equal(original.state, "removed");
  await h.link(SUBJECT, false);
  await h.link(SECOND_SUBJECT);
  h.advance(86400000);
  await h.checkout();
  assert.equal((await h.buyerService.buyerStatus(OFFERING_ID, USER)).gameAccess?.state, "pending");
  await h.pay();
  await h.cycle();
  // A real full snapshot refreshes every subscription at once, including history.
  // Its observation time cannot identify the current purchase.
  const reader = new StripeCommerceSnapshotProvider({
    database: h.db.d1,
    now: h.now,
    stripe: {
      async readConnectedAccount(id) {
        assert.equal(id, "acct_seller");
        return {
          id,
          country: "AU",
          defaultCurrency: "aud",
          chargesEnabled: true,
          payoutsEnabled: true,
          detailsSubmitted: true,
          disabledReason: null,
          currentlyDue: [],
          eventuallyDue: [],
          pendingVerification: [],
          providerCreatedAtMs: NOW,
          state: {
            capabilities: {},
            requirements: {
              currentlyDue: [],
              eventuallyDue: [],
              pastDue: [],
              pendingVerification: [],
              errors: [],
              disabledReason: null,
              currentDeadlineMs: null,
            },
          },
        };
      },
      async requestForConnectedAccount(id, path) {
        assert.equal(id, "acct_seller");
        if (path.includes("/subscriptions?"))
          return {
            data: h.subscriptions.map((s) => ({
              id: s.stripeSubscriptionId,
              customer: "cus_fixture",
              status: s.status === "ended" ? "canceled" : s.status,
              created: Math.floor(s.createdAtMs / 1000),
              current_period_start: Math.floor(s.currentPeriodStartMs! / 1000),
              current_period_end: Math.floor(s.currentPeriodEndMs! / 1000),
              ended_at: s.status === "ended" ? Math.floor(h.now() / 1000) : null,
              cancel_at_period_end: s.cancelAtPeriodEnd,
              latest_invoice: {
                id: `in_${s.id}`,
                paid: true,
                status: "paid",
                payment_intent: { id: `pi_${s.id}`, status: "succeeded" },
              },
              metadata: {
                haf_checkout_attempt_id: s.checkoutAttemptId,
                haf_buyer_id: s.buyerId,
                haf_offering_id: s.offeringId,
              },
              items: { data: [{ price: { id: "price_current", product: "prod_vip" } }] },
            })),
            has_more: false,
          };
        if (path.includes("/customers?"))
          return { data: [{ id: "cus_fixture", metadata: {} }], has_more: false };
        if (path.startsWith("/v1/checkout/sessions/")) {
          const sessionId = path.split("/").at(-1);
          const subscription = h.subscriptions.find(
            (s) => `cs_${s.checkoutAttemptId}` === sessionId,
          );
          assert.ok(subscription);
          return {
            id: sessionId,
            status: "complete",
            mode: "subscription",
            customer: "cus_fixture",
            subscription: subscription.stripeSubscriptionId,
            metadata: {
              haf_checkout_attempt_id: subscription.checkoutAttemptId,
              haf_buyer_id: subscription.buyerId,
              haf_offering_id: subscription.offeringId,
              haf_guild_id: GUILD,
            },
          };
        }
        return { data: [], has_more: false };
      },
    },
  });
  const refresh = async () => {
    const snapshot = await reader.readSellerSnapshot({
      connectedAccountId: "acct_seller",
      trigger: { eventType: "commerce.refresh.scheduled", objectId: null, source: "scheduled" },
    });
    assert.equal(snapshot.subscriptions.length, 2);
    assert.ok(snapshot.subscriptions.every((s) => s.updatedAtMs === h.now()));
    await h.project(snapshot);
  };
  h.subscriptions[1].cancelAtPeriodEnd = true;
  await refresh();
  h.advance(32 * 60_000);
  await h.cycle();
  assert.equal(
    await h.buyerStore.readActiveCheckout({
      connectedAccountId: "acct_seller",
      buyerId: h.subscriptions[1].buyerId,
      offeringId: OFFERING_ID,
      nowMs: h.now(),
    }),
    null,
  );
  const status = await h.buyerService.buyerStatus(OFFERING_ID, USER);
  assert.equal(status.subscriptionStatus, "active");
  assert.equal(status.entitlementStatus, "active");
  assert.equal(status.roleDeliveryStatus, "pending");
  assert.equal(status.cancelAtPeriodEnd, true);
  assert.equal(
    status.currentPeriodEndMs,
    Math.floor(h.subscriptions[1].currentPeriodEndMs! / 1000) * 1000,
  );
  assert.equal(status.gameAccess?.state, "managed");
  assert.equal((await h.store.read(original.id))?.state, "removed");
  assert.equal((await h.store.read(original.id))?.subject, SUBJECT);
  assert.equal(
    (await h.buyerService.buyerStatus(OFFERING_ID, "223456789012345678")).gameAccess?.state,
    "pending",
  );
  assert.equal(
    (await h.buyerService.buyerStatus(SECOND_OFFERING, USER)).gameAccess?.state,
    "pending",
  );
  const selected = (
    await h.store.selections((await h.store.list()).find((a) => a.subject === SECOND_SUBJECT)!.id)
  )[0];
  const context = {
    offeringId: OFFERING_ID,
    guildId: GUILD,
    buyerId: selected.buyerId,
    userId: USER,
    checkoutId: selected.checkoutId,
  };
  assert.equal(await h.runtime.hooks.status({ ...context, guildId: "other-guild" }), null);
  assert.equal(
    (await h.runtime.hooks.status({ ...context, buyerId: "other-buyer" }))?.state,
    "pending",
  );
  assert.equal(
    (await h.runtime.hooks.status({ ...context, userId: "other-user" }))?.state,
    "pending",
  );
  // With no current subscription, retain the latest purchase's cleanup context.
  // A lost removal acknowledgement leaves B needing attention while A is removed.
  h.subscriptions[1].status = "ended";
  h.subscriptions[1].cancelAtPeriodEnd = false;
  await refresh();
  h.control.mode = "lost";
  await h.cycle();
  const terminal = await h.buyerService.buyerStatus(OFFERING_ID, USER);
  const currentAssignment = await h.store.read(selected.assignmentId);
  assert.equal(terminal.subscriptionStatus, "canceled");
  assert.equal(terminal.entitlementStatus, "revoked");
  assert.deepEqual(terminal.gameAccess, {
    state: currentAssignment!.state,
    reason: currentAssignment!.reason,
  });
  assert.notEqual(terminal.gameAccess?.state, "removed");
  assert.equal((await h.store.read(original.id))?.subject, SUBJECT);
  assert.equal((await h.store.read(original.id))?.state, "removed");
});

test("real adapter: authority revoked after durable recording proves no request was sent", async (t) => {
  const h = await workflow({ realWardogs: true });
  t.after(() => h.fixture.close());
  await h.checkout();
  await h.pay();
  const save = h.store.save.bind(h.store);
  let inject = true;
  h.store.save = async (value, revision) => {
    const saved = await save(value, revision);
    if (saved && value.transmitted && !value.transmitted.acknowledged && inject) {
      inject = false;
      const target = (await h.wardogs.list(GUILD))[0];
      await h.wardogs.change({
        guildId: GUILD,
        targetId: target.id,
        generation: target.generation,
        enabled: false,
      });
    }
    return saved;
  };
  await h.cycle();
  const a = await h.assignment();
  assert.equal(h.wardogsCalls.filter((c) => c.method !== "GET").length, 0);
  assert.equal(a.transmitted, null);
  assert.equal(a.ownership, "none");
  assert.equal(a.obligation, false);
  assert.equal(a.reason, "disabled");
});

test("a rejected stale callback cannot clear another operation's marker with the same timestamp", async (t) => {
  const h = await workflow({ realWardogs: true });
  t.after(() => h.fixture.close());
  await h.checkout();
  await h.pay();
  const save = h.store.save.bind(h.store);
  let inject = true;
  const otherOperationId = crypto.randomUUID();
  h.store.save = async (value, revision) => {
    if (value.transmitted && !value.transmitted.acknowledged && inject) {
      inject = false;
      // Model a competing worker winning the CAS while the rejected callback was paused.
      await save(
        { ...value, transmitted: { ...value.transmitted, operationId: otherOperationId } },
        revision,
      );
      return null;
    }
    return save(value, revision);
  };
  await h.cycle();
  assert.equal((await h.assignment()).transmitted?.operationId, otherOperationId);
  assert.equal((await h.assignment()).ownership, "uncertain");
  assert.equal((await h.assignment()).obligation, true);
  assert.equal(h.wardogsCalls.filter((c) => c.method !== "GET").length, 0);
  await assert.rejects(
    h.runtime.service.repair({
      guildId: GUILD,
      id: (await h.assignment()).id,
      actorId: "seller",
      reason: "Other operation requires investigation",
    }),
    /possible late/,
  );
});
