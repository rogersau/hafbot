/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import type { Env } from "./support/test-env";
import {
  createSqlitePaidRoleRuntime,
  type CommerceRoleQueueMessage,
} from "./support/sqlite/runtime/commerce/sqlite-paid-role-runtime";
import { createTestDatabase } from "./support/sqlite-d1-database";

const NOW = 1_800_000_000_000;

test("paid-role runtime rejects Stripe keys from the wrong environment", async () => {
  const database = await createTestDatabase();
  try {
    const staging = runtimeEnv(database.d1);
    assert.ok(createSqlitePaidRoleRuntime(staging));
    assert.equal(
      createSqlitePaidRoleRuntime({
        ...staging,
        STRIPE_SECRET_KEY: "sk_live_platform_key_material",
      }),
      null,
    );
    assert.equal(
      createSqlitePaidRoleRuntime({
        ...staging,
        STAGING_MODE: undefined,
      }),
      null,
    );
  } finally {
    database.close();
  }
});

test("paid-role runtime repairs the Queue gap and grants only through its managed consumer", async () => {
  const database = await createTestDatabase();
  const originalFetch = globalThis.fetch;
  const sent: CommerceRoleQueueMessage[] = [];
  const mutations: string[] = [];
  try {
    await seed(database.d1);
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/guilds/guild-1/roles")) {
        return Response.json([
          { id: "guild-1", name: "@everyone", permissions: "0", position: 0 },
          {
            id: "role-bot",
            name: "HAF",
            permissions: String(1n << 28n),
            position: 10,
          },
          { id: "role-paid", name: "Paid", permissions: "0", position: 5 },
        ]);
      }
      if (url.endsWith("/guilds/guild-1/members/bot")) {
        return Response.json({ user: { id: "bot" }, roles: ["role-bot"] });
      }
      if (url.endsWith("/guilds/guild-1/members/buyer-discord")) {
        return Response.json({ user: { id: "buyer-discord" }, roles: [] });
      }
      if (url.endsWith("/members/buyer-discord/roles/role-paid")) {
        mutations.push(init?.method ?? "GET");
        return new Response(null, { status: 204 });
      }
      return new Response("not found", { status: 404 });
    };
    const env = {
      HAF_DB: database.d1,
      COMMERCE_ROLE_QUEUE: {
        async send(message: CommerceRoleQueueMessage) {
          sent.push(message);
        },
      },
      STAGING_MODE: "true",
      STRIPE_SECRET_KEY: "sk_test_platform_key_material",
      STRIPE_API_VERSION: "2026-06-24.dahlia",
      BOT_USER_ID: "bot",
      DISCORD_BOT_TOKEN: "token",
    } as unknown as Env;
    const runtime = createSqlitePaidRoleRuntime(env);
    assert.ok(runtime);
    await runtime.store.enqueueRoleOperation({
      operationKey: "role:assignment-1:1",
      entitlementId: "entitlement-1",
      guildId: "guild-1",
      discordUserId: "buyer-discord",
      discordRoleId: "role-paid",
      action: "assign",
      payloadJson: "{}",
      availableAtMs: 0,
      createdAtMs: NOW,
      updatedAtMs: NOW,
    });

    assert.equal(await runtime.sweepOutbox(), 1);
    assert.equal(sent.length, 1);
    await runtime.processMessage(sent[0]!);

    assert.deepEqual(mutations, ["PUT"]);
    assert.deepEqual(
      database.query(
        `SELECT status, assigned_at_ms IS NOT NULL AS assigned
         FROM commerce_role_assignments WHERE id='assignment-1'`,
      ),
      [{ status: "assigned", assigned: 1 }],
    );
    assert.equal(
      database.query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM commerce_operations_ledger",
      )[0]?.count,
      1,
    );
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test("member leave is recoverable and never creates a role-wide repair", async () => {
  const database = await createTestDatabase();
  const originalFetch = globalThis.fetch;
  try {
    await seed(database.d1);
    database.execRaw(`
      UPDATE commerce_role_assignments SET status='assigned',assigned_at_ms=${NOW}
        WHERE id='assignment-1';
      INSERT INTO commerce_buyers(id,discord_user_id,created_at_ms,updated_at_ms)
        VALUES ('buyer-2','other-buyer',${NOW},${NOW});
      INSERT INTO commerce_entitlements(
        id,connected_account_id,buyer_id,offering_id,source_type,source_id,status,
        effective_at_ms,created_at_ms,updated_at_ms
      ) VALUES (
        'entitlement-2','acct_seller','buyer-2','offering-1','subscription','sub_other','active',
        ${NOW},${NOW},${NOW}
      );
      INSERT INTO commerce_role_assignments(
        id,entitlement_id,guild_id,discord_user_id,discord_role_id,status,attempt_count,
        assigned_at_ms,created_at_ms,updated_at_ms
      ) VALUES (
        'assignment-2','entitlement-2','guild-1','other-buyer','role-paid','assigned',1,
        ${NOW},${NOW},${NOW}
      );
    `);
    globalThis.fetch = async () => {
      throw new Error("member leave must not call Discord");
    };
    const runtime = createSqlitePaidRoleRuntime(runtimeEnv(database.d1));
    assert.ok(runtime);
    await runtime.processMessage({
      outboxId: "leave-1",
      operationKey: "leave-1",
      entitlementId: "entitlement-1",
      memberState: "left",
    });

    assert.deepEqual(
      database.query(`SELECT id,status,withheld_reason FROM commerce_role_assignments ORDER BY id`),
      [
        { id: "assignment-1", status: "withheld", withheld_reason: "member_absent" },
        { id: "assignment-2", status: "assigned", withheld_reason: null },
      ],
    );
    assert.equal(
      database.query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM commerce_paid_role_repairs",
      )[0]?.count,
      0,
    );
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test("a pending Stripe projection never adopts or removes a manually granted role", async () => {
  const database = await createTestDatabase();
  const originalFetch = globalThis.fetch;
  const mutations: string[] = [];
  try {
    await seed(database.d1);
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("api.stripe.com")) return Response.json({});
      if (url.endsWith("/guilds/guild-1/members/buyer-discord")) {
        return Response.json({ user: { id: "buyer-discord" }, roles: ["role-paid"] });
      }
      if (url.endsWith("/members/buyer-discord/roles/role-paid")) {
        mutations.push(init?.method ?? "GET");
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected Discord request: ${url}`);
    };
    const runtime = createSqlitePaidRoleRuntime(runtimeEnv(database.d1));
    assert.ok(runtime);
    const message = {
      outboxId: "manual-active",
      operationKey: "manual-active",
      entitlementId: "entitlement-1",
    };
    await runtime.processMessage(message);
    assert.deepEqual(
      database.query(
        "SELECT status, attempt_count, assigned_at_ms FROM commerce_role_assignments WHERE id='assignment-1'",
      ),
      [{ status: "pending", attempt_count: 0, assigned_at_ms: null }],
    );

    database.execRaw("UPDATE commerce_subscriptions SET status='unpaid'");
    await runtime.processMessage({ ...message, operationKey: "manual-unpaid" });
    assert.deepEqual(mutations, []);
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test("a missing role creates one role-wide repair", async () => {
  const database = await createTestDatabase();
  const originalFetch = globalThis.fetch;
  try {
    await seed(database.d1);
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/guilds/guild-1/roles")) {
        return Response.json([
          { id: "guild-1", name: "@everyone", permissions: "0", position: 0 },
          { id: "role-bot", name: "HAF", permissions: String(1n << 28n), position: 10 },
        ]);
      }
      if (url.endsWith("/guilds/guild-1/members/bot")) {
        return Response.json({ user: { id: "bot" }, roles: ["role-bot"] });
      }
      if (url.endsWith("/guilds/guild-1/members/buyer-discord")) {
        return Response.json({ user: { id: "buyer-discord" }, roles: [] });
      }
      return new Response("not found", { status: 404 });
    };
    const runtime = createSqlitePaidRoleRuntime(runtimeEnv(database.d1));
    assert.ok(runtime);
    for (const operationKey of ["missing-role-1", "missing-role-2"]) {
      await runtime.processMessage({
        outboxId: operationKey,
        operationKey,
        entitlementId: "entitlement-1",
        memberState: "rejoined",
      });
    }
    assert.equal(
      database.query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM commerce_paid_role_repairs",
      )[0]?.count,
      1,
    );
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test("provider cancellation survives Discord success and retries with one identity", async () => {
  const database = await createTestDatabase();
  const originalFetch = globalThis.fetch;
  let stripeAttempts = 0;
  const idempotencyKeys: string[] = [];
  try {
    await seed(database.d1);
    database.execRaw(`
      UPDATE commerce_role_assignments SET status='assigned',assigned_at_ms=${NOW}
        WHERE id='assignment-1';
      UPDATE commerce_payments SET amount_refunded_minor=amount_minor WHERE id='payment-1';
    `);
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("api.stripe.com/v1/subscriptions/sub_buyer")) {
        stripeAttempts += 1;
        idempotencyKeys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
        return stripeAttempts === 1
          ? Response.json({ error: { message: "temporary" } }, { status: 500 })
          : Response.json({ id: "sub_buyer", status: "active", cancel_at_period_end: true });
      }
      if (url.endsWith("/guilds/guild-1/roles")) {
        return Response.json([
          { id: "guild-1", name: "@everyone", permissions: "0", position: 0 },
          { id: "role-bot", name: "HAF", permissions: String(1n << 28n), position: 10 },
          { id: "role-paid", name: "Paid", permissions: "0", position: 5 },
        ]);
      }
      if (url.endsWith("/guilds/guild-1/members/bot")) {
        return Response.json({ user: { id: "bot" }, roles: ["role-bot"] });
      }
      if (url.endsWith("/guilds/guild-1/members/buyer-discord")) {
        return Response.json({ user: { id: "buyer-discord" }, roles: ["role-paid"] });
      }
      if (url.endsWith("/members/buyer-discord/roles/role-paid")) {
        return new Response(null, { status: 204 });
      }
      return new Response("not found", { status: 404 });
    };
    const runtime = createSqlitePaidRoleRuntime(runtimeEnv(database.d1));
    assert.ok(runtime);
    await runtime.processMessage({
      outboxId: "remove-1",
      operationKey: "remove-1",
      entitlementId: "entitlement-1",
    });
    assert.deepEqual(
      database.query(
        `SELECT status,provider_cancellation_state FROM commerce_role_assignments
         WHERE id='assignment-1'`,
      ),
      [{ status: "removed", provider_cancellation_state: "failed" }],
    );
    assert.equal(
      database.query<{ status: string }>(
        "SELECT status FROM commerce_paid_role_provider_actions",
      )[0]?.status,
      "failed",
    );

    database.execRaw("UPDATE commerce_paid_role_provider_actions SET available_at_ms=0");
    assert.equal(await runtime.processProviderActions(), 1);
    assert.equal(
      database.query<{ status: string }>(
        "SELECT status FROM commerce_paid_role_provider_actions",
      )[0]?.status,
      "completed",
    );
    assert.equal(stripeAttempts, 2);
    assert.equal(idempotencyKeys[0], idempotencyKeys[1]);
    await runtime.processMessage({
      outboxId: "remove-duplicate",
      operationKey: "remove-duplicate",
      entitlementId: "entitlement-1",
      memberState: "rejoined",
    });
    assert.equal(
      database.query<{ state: string }>(
        "SELECT provider_cancellation_state AS state FROM commerce_role_assignments",
      )[0]?.state,
      "scheduled",
    );
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test("permanent guild deletion archives sales, queues immediate cancellation and refund review", async () => {
  const database = await createTestDatabase();
  try {
    await seed(database.d1);
    database.execRaw(`
      INSERT INTO commerce_offering_lifecycles(
        offering_id,connected_account_id,guild_id,state,included_benefits_json,
        support_contact,role_manageable,created_at_ms,updated_at_ms
      ) VALUES (
        'offering-1','acct_seller','guild-1','published','["Paid role"]',
        'seller@example.test',1,${NOW},${NOW}
      );
      INSERT INTO commerce_connected_accounts(
        id,guild_id,stripe_account_id,status,charges_enabled,payouts_enabled,details_submitted,
        created_at_ms,updated_at_ms
      ) VALUES ('acct_other','guild-2','acct_other','active',1,1,1,${NOW},${NOW});
      INSERT INTO commerce_subscriptions(
        id,connected_account_id,customer_id,buyer_id,offering_id,price_id,stripe_subscription_id,
        status,cancel_at_period_end,current_period_end_ms,created_at_ms,updated_at_ms
      ) VALUES (
        'subscription-cross-seller','acct_other','customer-other','buyer-1','offering-1','price-1',
        'sub_crossseller','active',0,${NOW + 2_592_000_000},${NOW},${NOW}
      );
    `);
    const runtime = createSqlitePaidRoleRuntime(runtimeEnv(database.d1));
    assert.ok(runtime);
    assert.equal(await runtime.store.enqueueGuildDeletion("guild-1", "delete-1", NOW), 1);
    assert.deepEqual(database.query("SELECT status FROM commerce_offerings"), [
      { status: "archived" },
    ]);
    assert.deepEqual(
      database.query("SELECT action_type,status FROM commerce_paid_role_provider_actions"),
      [{ action_type: "subscription.cancel_immediately", status: "pending" }],
    );
    assert.equal(
      database.query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM commerce_guild_deletion_refund_reviews WHERE status='pending'",
      )[0]?.count,
      1,
    );
    assert.deepEqual(database.query("SELECT status FROM commerce_role_assignments"), [
      { status: "removed" },
    ]);
  } finally {
    database.close();
  }
});

function runtimeEnv(database: D1Database): Env {
  return {
    HAF_DB: database,
    COMMERCE_ROLE_QUEUE: { async send() {} },
    STAGING_MODE: "true",
    STRIPE_SECRET_KEY: "sk_test_platform_key_material",
    STRIPE_API_VERSION: "2026-06-24.dahlia",
    BOT_USER_ID: "bot",
    DISCORD_BOT_TOKEN: "token",
  } as unknown as Env;
}

async function seed(database: D1Database): Promise<void> {
  await database.exec(`
    INSERT INTO commerce_connected_accounts(
      id,guild_id,stripe_account_id,status,charges_enabled,payouts_enabled,details_submitted,
      created_at_ms,updated_at_ms
    ) VALUES ('acct_seller','guild-1','acct_seller','active',1,1,1,${NOW},${NOW});
    INSERT INTO commerce_offerings(
      id,connected_account_id,guild_id,discord_role_id,name,purchase_type,status,created_at_ms,updated_at_ms
    ) VALUES ('offering-1','acct_seller','guild-1','role-paid','Paid','subscription','active',${NOW},${NOW});
    INSERT INTO commerce_prices(
      id,connected_account_id,offering_id,stripe_product_id,stripe_price_id,currency,
      unit_amount_minor,price_type,recurring_interval,status,created_at_ms
    ) VALUES ('price-1','acct_seller','offering-1','prod_1','price_1','AUD',500,'recurring','month','active',${NOW});
    INSERT INTO commerce_buyers(id,discord_user_id,created_at_ms,updated_at_ms)
      VALUES ('buyer-1','buyer-discord',${NOW},${NOW});
    INSERT INTO commerce_customers(
      id,connected_account_id,buyer_id,stripe_customer_id,created_at_ms,updated_at_ms
    ) VALUES ('customer-1','acct_seller','buyer-1','cus_1',${NOW},${NOW});
    INSERT INTO commerce_subscriptions(
      id,connected_account_id,customer_id,buyer_id,offering_id,price_id,stripe_subscription_id,
       status,cancel_at_period_end,current_period_end_ms,latest_invoice_id,latest_invoice_status,
       latest_payment_intent_id,latest_payment_status,created_at_ms,updated_at_ms
    ) VALUES (
      'subscription-1','acct_seller','customer-1','buyer-1','offering-1','price-1','sub_buyer',
       'active',0,${NOW + 2_592_000_000},'in_1','paid','pi_1','succeeded',${NOW},${NOW}
    );
    INSERT INTO commerce_payments(
      id,connected_account_id,customer_id,buyer_id,offering_id,price_id,stripe_payment_intent_id,
      currency,amount_minor,amount_received_minor,amount_refunded_minor,status,created_at_ms,updated_at_ms
    ) VALUES (
      'payment-1','acct_seller','customer-1','buyer-1','offering-1','price-1','pi_1',
      'AUD',500,500,0,'succeeded',${NOW},${NOW}
    );
    INSERT INTO commerce_entitlements(
      id,connected_account_id,buyer_id,offering_id,source_type,source_id,status,
      effective_at_ms,created_at_ms,updated_at_ms
    ) VALUES (
      'entitlement-1','acct_seller','buyer-1','offering-1','subscription','sub_buyer','active',
      ${NOW},${NOW},${NOW}
    );
    INSERT INTO commerce_role_assignments(
      id,entitlement_id,guild_id,discord_user_id,discord_role_id,status,attempt_count,
      next_attempt_at_ms,created_at_ms,updated_at_ms
    ) VALUES (
      'assignment-1','entitlement-1','guild-1','buyer-discord','role-paid','pending',0,
      ${NOW},${NOW},${NOW}
    );
  `);
}

test("reserved access derives trusted subscription checkout identity without changing payment or role state", async () => {
  const { createGameAccessRuntime, createSqliteGameAccessStore } =
    await import("./support/sqlite/runtime/commerce/game-access-runtime");
  const { createSqlitePlatformLinkStore } =
    await import("./support/sqlite/runtime/sqlite-platform-link-store");
  const { createSqliteWardogsStore } =
    await import("./support/sqlite/runtime/sqlite-wardogs-store");
  const { WardogsService } = await import("../src/wardogs/service");
  const database = await createTestDatabase();
  const originalFetch = globalThis.fetch;
  try {
    await seed(database.d1);
    const links = createSqlitePlatformLinkStore(database.d1);
    await links.upsertPlatformLink({
      guildId: "guild-1",
      userId: "buyer-discord",
      platform: "steam",
      platformId: "76561198000000001",
      active: true,
      manual: false,
      actionedByUserId: null,
      metadataJson: null,
      linkedAtMs: 1,
    });
    const store = createSqliteGameAccessStore(database.d1);
    await store.configure({
      offeringId: "offering-1",
      guildId: "guild-1",
      targetId: "target",
      physicalTarget: "physical",
      origin: "https://fixture.example",
      capability: "reserved-slot",
      acceptingSales: false,
      allocationCeiling: 1,
      updatedAtMs: 1,
    });
    const assignment = await store.reserve(
      {
        platform: "steam",
        id: "game-assignment",
        guildId: "guild-1",
        userId: "buyer-discord",
        targetId: "target",
        physicalTarget: "physical",
        origin: "https://fixture.example",
        subject: "76561198000000001",
        ownership: "none",
        generation: 1,
        revision: 1,
        desired: false,
        state: "pending",
        reason: "awaiting_payment",
        entitlementIds: [],
        attempts: 0,
        nextAtMs: 0,
        updatedAtMs: 0,
        transmitted: null,
        observed: null,
        obligation: false,
        slot: null,
      },
      1,
    );
    await store.select({
      platform: "steam",
      checkoutId: "selected-checkout",
      offeringId: "offering-1",
      guildId: "guild-1",
      buyerId: "buyer-1",
      userId: "buyer-discord",
      subject: assignment.subject,
      assignmentId: assignment.id,
      createdAtMs: 1,
    });
    await database.d1
      .prepare("UPDATE commerce_subscriptions SET checkout_attempt_id=? WHERE id=?")
      .bind("selected-checkout", "subscription-1")
      .run();
    const requests: string[] = [];
    globalThis.fetch = async (url, init) => {
      requests.push(`${init?.method ?? "GET"} ${url}`);
      return Response.json({ user: { id: "buyer-discord" }, roles: [] });
    };
    const runtime = createGameAccessRuntime({
      database: database.d1,
      store,
      platformLink: links,
      botUserId: "bot",
      botToken: "fake",
      wardogs: new WardogsService({
        store: createSqliteWardogsStore(database.d1),
      }),
    });
    await runtime.service.processDue();
    assert.deepEqual((await store.read(assignment.id))?.entitlementIds, ["entitlement-1"]);
    assert.equal((await store.read(assignment.id))?.state, "needs-attention");
    assert.deepEqual(await runtime.hooks.configuration("offering-1"), { acceptingSales: false });
    assert.equal(
      (
        await database.d1
          .prepare("SELECT status FROM commerce_incidents WHERE entity_id=?")
          .bind(assignment.id)
          .first<{ status: string }>()
      )?.status,
      "open",
    );
    await assert.rejects(runtime.service.assertPublication("offering-1"), /disabled/);
    assert.ok(requests.every((r) => r.startsWith("GET ") && r.includes("discord")));
    assert.equal(
      (
        await database.d1
          .prepare("SELECT status FROM commerce_subscriptions WHERE id='subscription-1'")
          .first<{ status: string }>()
      )?.status,
      "active",
    );
    assert.equal(
      (
        await database.d1
          .prepare("SELECT status FROM commerce_role_assignments WHERE id='assignment-1'")
          .first<{ status: string }>()
      )?.status,
      "pending",
    );
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});
