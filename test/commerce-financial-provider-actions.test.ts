/// <reference types="node/assert" />
import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import type { CommerceFinancialAction } from "../src/commerce/financial-operations";
import { SqliteCommerceFinancialOperationsStore } from "./support/sqlite/runtime/commerce/sqlite-financial-operations-store";
import { processCommerceFinancialProviderActions } from "./support/sqlite/runtime/commerce/financial-provider-actions";
import { createTestDatabase } from "./support/sqlite-d1-database";

for (const stage of ["initial", "final"] as const) {
  for (const committed of [false, true]) {
    test(`${stage} workflow progress retries a D1 network failure ${committed ? "after commit" : "before commit"}`, async () => {
      const database = await createTestDatabase();
      try {
        seedRetirement(database);
        database.execRaw(`
          INSERT INTO commerce_seller_offboarding(connected_account_id,guild_id,status,reason_code,actor_user_id,active_subscription_count,started_at_ms,updated_at_ms)
            VALUES ('acct-1','guild-1','canceling','seller_requested','seller-1',0,1,1);
        `);
        let failures = 0;
        let batchCalls = 0;
        let providerCalls = 0;
        let reconciliationCalls = 0;
        const providerKeys: string[] = [];
        const batch = database.d1.batch.bind(database.d1);
        database.d1.batch = async <T>(statements: D1PreparedStatement[]) => {
          batchCalls += 1;
          const atStage = stage === "initial" ? providerCalls === 0 : providerCalls === 1;
          if (atStage && failures < 2) {
            failures += 1;
            if (committed) await batch<T>(statements);
            throw new Error("D1_ERROR: Network connection lost.");
          }
          return batch<T>(statements);
        };

        assert.equal(
          await processCommerceFinancialProviderActions({
            database: database.d1,
            now: () => 100,
            provider: {
              async cancelAtPeriodEnd(input) {
                providerCalls += 1;
                providerKeys.push(input.idempotencyKey);
              },
              async cancelImmediately() {
                throw new Error("unexpected_immediate_cancellation");
              },
            },
            async requestReconciliation() {
              reconciliationCalls += 1;
            },
          }),
          1,
        );
        assert.equal(failures, 2);
        assert.equal(batchCalls, 4);
        assert.equal(providerCalls, 1);
        assert.equal(reconciliationCalls, 1);
        assert.deepEqual(providerKeys, ["commerce:subscription.cancel_at_period_end:sub-1"]);
        assert.deepEqual(
          database.query("SELECT status,attempt_count FROM commerce_financial_provider_actions"),
          [{ status: "completed", attempt_count: 1 }],
        );
        assert.deepEqual(
          database.query(
            "SELECT status,scheduled_cancellation_count FROM commerce_offering_retirements",
          ),
          [{ status: "waiting_for_period_end", scheduled_cancellation_count: 1 }],
        );
        assert.deepEqual(
          database.query(
            "SELECT status,active_subscription_count,latest_paid_through_at_ms FROM commerce_seller_offboarding",
          ),
          [{ status: "waiting", active_subscription_count: 1, latest_paid_through_at_ms: 2000 }],
        );
      } finally {
        database.close();
      }
    });
  }

  test(`${stage} workflow progress propagates exhausted D1 retries and recovers on a later sweep`, async () => {
    const database = await createTestDatabase();
    try {
      seedRetirement(database);
      let failProgress = true;
      let failures = 0;
      let providerCalls = 0;
      let reconciliationCalls = 0;
      let nowMs = 100;
      const error = new Error("D1_ERROR: Network connection lost.");
      const batch = database.d1.batch.bind(database.d1);
      database.d1.batch = async <T>(statements: D1PreparedStatement[]) => {
        const atStage = stage === "initial" ? providerCalls === 0 : providerCalls === 1;
        if (failProgress && atStage) {
          failures += 1;
          throw error;
        }
        return batch<T>(statements);
      };
      const run = () =>
        processCommerceFinancialProviderActions({
          database: database.d1,
          now: () => nowMs,
          provider: {
            async cancelAtPeriodEnd() {
              providerCalls += 1;
            },
            async cancelImmediately() {
              throw new Error("unexpected_immediate_cancellation");
            },
          },
          async requestReconciliation() {
            reconciliationCalls += 1;
          },
        });

      await assert.rejects(run(), (caught) => caught === error);
      assert.equal(failures, 3);
      assert.equal(providerCalls, stage === "initial" ? 0 : 1);
      assert.equal(reconciliationCalls, providerCalls);
      assert.deepEqual(
        database.query("SELECT status,attempt_count FROM commerce_financial_provider_actions"),
        [
          {
            status: stage === "initial" ? "pending" : "completed",
            attempt_count: stage === "initial" ? 0 : 1,
          },
        ],
      );

      failProgress = false;
      nowMs += 300_000;
      assert.equal(await run(), stage === "initial" ? 1 : 0);
      assert.equal(providerCalls, 1);
      assert.equal(reconciliationCalls, 1);
      assert.deepEqual(
        database.query("SELECT status,attempt_count FROM commerce_financial_provider_actions"),
        [{ status: "completed", attempt_count: 1 }],
      );
      assert.equal(
        database.query<{ status: string }>("SELECT status FROM commerce_offering_retirements")[0]
          ?.status,
        "waiting_for_period_end",
      );
    } finally {
      database.close();
    }
  });
}

for (const error of [
  new Error("D1_ERROR: no such table: commerce_offering_retirements"),
  new Error("Network connection lost."),
  "D1_ERROR: Network connection lost.",
]) {
  test(`workflow progress does not retry ${String(error)}`, async () => {
    const database = await createTestDatabase();
    try {
      let batchCalls = 0;
      database.d1.batch = async () => {
        batchCalls += 1;
        throw error;
      };
      await assert.rejects(
        processCommerceFinancialProviderActions({
          database: database.d1,
          provider: {
            async cancelAtPeriodEnd() {
              assert.fail("unexpected_provider_call");
            },
            async cancelImmediately() {
              assert.fail("unexpected_provider_call");
            },
          },
          async requestReconciliation() {
            assert.fail("unexpected_reconciliation_call");
          },
        }),
        (caught) => caught === error,
      );
      assert.equal(batchCalls, 1);
    } finally {
      database.close();
    }
  });
}

test("provider actions persist their provider stage and resume at reconciliation", async () => {
  const database = await createTestDatabase();
  try {
    seedRetirement(database);
    let providerCalls = 0;
    const providerKeys: string[] = [];
    let reconciliationCalls = 0;
    const run = () =>
      processCommerceFinancialProviderActions({
        database: database.d1,
        now: () => 100,
        createLeaseToken: () => `lease-${reconciliationCalls}`,
        provider: {
          async cancelAtPeriodEnd(input) {
            providerCalls += 1;
            providerKeys.push(input.idempotencyKey);
          },
          async cancelImmediately() {
            throw new Error("unexpected_immediate_cancellation");
          },
        },
        async requestReconciliation() {
          reconciliationCalls += 1;
          if (reconciliationCalls === 1) throw new Error("reconciliation_unavailable");
        },
      });

    assert.equal(await run(), 0);
    assert.deepEqual(
      database.query<{
        status: string;
        provider_completed_at_ms: number | null;
        last_error_code: string | null;
      }>(
        "SELECT status,provider_completed_at_ms,last_error_code FROM commerce_financial_provider_actions",
      )[0],
      {
        status: "failed",
        provider_completed_at_ms: 100,
        last_error_code: "reconciliation_unavailable",
      },
    );

    database.execRaw("UPDATE commerce_financial_provider_actions SET available_at_ms=100");
    assert.equal(await run(), 1);
    assert.equal(providerCalls, 1, "a durable provider success must not be repeated");
    assert.deepEqual(providerKeys, ["commerce:subscription.cancel_at_period_end:sub-1"]);
    assert.equal(reconciliationCalls, 2);
    assert.equal(
      database.query<{ status: string }>(
        "SELECT status FROM commerce_financial_provider_actions",
      )[0]?.status,
      "completed",
    );
    assert.equal(
      database.query<{ status: string }>("SELECT status FROM commerce_offering_retirements")[0]
        ?.status,
      "waiting_for_period_end",
    );

    database.execRaw(`
      UPDATE commerce_offering_retirements SET status='complete',completed_at_ms=100;
      UPDATE commerce_offering_lifecycles SET state='archived',archived_at_ms=100;
      INSERT INTO commerce_subscriptions(id,connected_account_id,customer_id,buyer_id,offering_id,price_id,stripe_subscription_id,status,cancel_at_period_end,current_period_end_ms,created_at_ms,updated_at_ms)
        VALUES ('sub-late','acct-1','customer-late','buyer-late','off-1','price-1','sub_stripe_late','active',0,3000,2,2);
    `);
    assert.equal(await run(), 1);
    assert.equal(providerCalls, 2);
    assert.equal(
      database.query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM commerce_financial_provider_actions WHERE subscription_id='sub-late'",
      )[0]?.count,
      1,
    );
    assert.equal(
      database.query<{ status: string }>("SELECT status FROM commerce_offering_retirements")[0]
        ?.status,
      "waiting_for_period_end",
    );
  } finally {
    database.close();
  }
});

test("provider actions reject stage writes after their lease expires", async () => {
  const database = await createTestDatabase();
  try {
    seedRetirement(database);
    let nowMs = 100;
    let reconciliationCalls = 0;

    assert.equal(
      await processCommerceFinancialProviderActions({
        database: database.d1,
        now: () => nowMs,
        createLeaseToken: () => "expired-lease",
        provider: {
          async cancelAtPeriodEnd() {
            nowMs = 60_101;
          },
          async cancelImmediately() {
            throw new Error("unexpected_immediate_cancellation");
          },
        },
        async requestReconciliation() {
          reconciliationCalls += 1;
        },
      }),
      0,
    );
    assert.deepEqual(
      database.query<{
        status: string;
        provider_completed_at_ms: number | null;
      }>("SELECT status,provider_completed_at_ms FROM commerce_financial_provider_actions")[0],
      { status: "processing", provider_completed_at_ms: null },
    );
    assert.equal(reconciliationCalls, 0);
  } finally {
    database.close();
  }
});

test("provider actions quarantine after bounded retries and open an incident", async () => {
  const database = await createTestDatabase();
  try {
    seedRetirement(database);
    let nowMs = 100;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await processCommerceFinancialProviderActions({
        database: database.d1,
        now: () => nowMs,
        createLeaseToken: () => `lease-${attempt}`,
        provider: {
          async cancelAtPeriodEnd() {
            throw new Error("stripe_unavailable");
          },
          async cancelImmediately() {
            throw new Error("unexpected_immediate_cancellation");
          },
        },
        async requestReconciliation() {},
      });
      nowMs += 3_600_000;
    }

    assert.deepEqual(
      database.query<{ status: string; attempt_count: number }>(
        "SELECT status,attempt_count FROM commerce_financial_provider_actions",
      )[0],
      { status: "quarantined", attempt_count: 5 },
    );
    assert.equal(
      database.query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM commerce_incidents WHERE summary_code='commerce_provider_action_quarantined'",
      )[0]?.count,
      1,
    );
  } finally {
    database.close();
  }
});

test("parent financial actions quarantine after bounded retries and cannot be reclaimed", async () => {
  const database = await createTestDatabase();
  try {
    const store = new SqliteCommerceFinancialOperationsStore(database.d1);
    const action: CommerceFinancialAction = {
      id: "refund-1",
      connectedAccountId: "acct-1",
      guildId: "guild-1",
      actionType: "subscription.refund",
      entityType: "payment",
      entityId: "payment-1",
      actorUserId: "seller-1",
      reasonCode: "buyer_request",
      amountMinor: 500,
      currency: "AUD",
      status: "processing",
      providerResultId: null,
      accessAction: "retain",
      attemptCount: 0,
      lastErrorCode: null,
      leaseToken: null,
      claimedAtMs: null,
      leaseExpiresAtMs: null,
      availableAtMs: 0,
      providerCompletedAtMs: null,
      reconciliationRequestedAtMs: null,
      quarantinedAtMs: null,
      createdAtMs: 1,
      updatedAtMs: 1,
      completedAtMs: null,
    };
    let nowMs = 100;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const leaseToken = `parent-lease-${attempt}`;
      assert.equal(
        await store.claimAction(action, { leaseToken, nowMs, leaseMs: 60_000 }),
        "claimed",
      );
      assert.equal(
        await store.failAction(action.id, leaseToken, "stripe_unavailable", nowMs),
        true,
      );
      nowMs += 3_600_000;
    }

    assert.equal((await store.readAction(action.id))?.quarantinedAtMs, nowMs - 3_600_000);
    assert.equal((await store.listRecoverableActions(nowMs)).length, 0);
    assert.equal(
      await store.claimAction(action, { leaseToken: "late-lease", nowMs, leaseMs: 60_000 }),
      "quarantined",
    );
    assert.equal(
      database.query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM commerce_incidents WHERE summary_code='commerce_financial_action_quarantined'",
      )[0]?.count,
      1,
    );
  } finally {
    database.close();
  }
});

test("expired parent leases cannot mutate seller state", async () => {
  const database = await createTestDatabase();
  try {
    database.execRaw(`
      INSERT INTO commerce_connected_accounts(id,guild_id,stripe_account_id,status,charges_enabled,payouts_enabled,details_submitted,created_at_ms,updated_at_ms)
        VALUES ('acct-1','guild-1','acct_stripe','active',1,1,1,1,1);
      INSERT INTO commerce_offering_lifecycles(offering_id,connected_account_id,guild_id,state,included_benefits_json,support_contact,role_manageable,created_at_ms,updated_at_ms)
        VALUES ('off-1','acct-1','guild-1','published','["Access"]','seller@example.test',1,1,1);
    `);
    const store = new SqliteCommerceFinancialOperationsStore(database.d1);
    const action = parentSellerAction();
    assert.equal(
      await store.claimAction(action, { leaseToken: "expired", nowMs: 100, leaseMs: 100 }),
      "claimed",
    );
    await store.stopNewSales("acct-1", "guild-1", {
      actionId: action.id,
      leaseToken: "expired",
      nowMs: 201,
    });
    assert.equal(
      database.query<{ state: string }>(
        "SELECT state FROM commerce_offering_lifecycles WHERE offering_id='off-1'",
      )[0]?.state,
      "published",
    );

    assert.equal(
      await store.claimAction(action, { leaseToken: "current", nowMs: 201, leaseMs: 100 }),
      "claimed",
    );
    await store.stopNewSales("acct-1", "guild-1", {
      actionId: action.id,
      leaseToken: "current",
      nowMs: 201,
    });
    assert.equal(
      database.query<{ state: string }>(
        "SELECT state FROM commerce_offering_lifecycles WHERE offering_id='off-1'",
      )[0]?.state,
      "unpublished",
    );
    await store.enqueueSubscriptionCancellations({
      parentActionId: action.id,
      workflowType: "seller_offboarding",
      workflowId: "acct-1",
      connectedAccountId: "acct-1",
      guildId: "guild-1",
      subscriptions: [
        {
          id: "sub-1",
          stripeSubscriptionId: "sub_stripe_1",
          buyerId: "buyer-1",
          offeringId: "off-1",
          status: "active",
          cancelAtPeriodEnd: false,
          currentPeriodEndMs: 2_000,
        },
      ],
      reasonCode: "seller_requested",
      nowMs: 201,
      leaseToken: "current",
    });
    await store.saveOffboarding(
      {
        connectedAccountId: "acct-1",
        guildId: "guild-1",
        status: "waiting",
        reasonCode: "seller_requested",
        actorUserId: "seller-1",
        activeSubscriptionCount: 1,
        latestPaidThroughAtMs: 2_000,
        startedAtMs: 201,
        completedAtMs: null,
        updatedAtMs: 201,
      },
      { actionId: action.id, leaseToken: "current", nowMs: 201 },
    );
    await store.enqueueRefundCancellation({
      parentActionId: action.id,
      leaseToken: "current",
      connectedAccountId: "acct-1",
      guildId: "guild-1",
      subscription: {
        id: "sub-refund",
        stripeSubscriptionId: "sub_stripe_refund",
        buyerId: "buyer-refund",
        offeringId: "off-1",
        status: "active",
        cancelAtPeriodEnd: false,
        currentPeriodEndMs: 2_000,
      },
      mode: "immediate",
      reasonCode: "buyer_request",
      nowMs: 201,
    });
    await store.recordDeauthorization({
      connectedAccountId: "acct-1",
      guildId: "guild-1",
      buyerIds: [],
      operationId: action.id,
      nowMs: 201,
      leaseToken: "current",
    });
    assert.equal(
      database.query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM commerce_financial_provider_actions WHERE operation_key IN ('commerce:seller_offboarding:acct-1:sub-1','commerce:refund-cancellation:offboard-1:sub-refund')",
      )[0]?.count,
      2,
    );
    database.execRaw(`
      INSERT INTO commerce_subscriptions(id,connected_account_id,customer_id,buyer_id,offering_id,price_id,stripe_subscription_id,status,cancel_at_period_end,created_at_ms,updated_at_ms)
        VALUES ('sub-active','acct-1','customer-active','buyer-active','off-1','price-1','sub_stripe_active','active',0,1,1);
    `);
    assert.equal(
      await store.archiveSeller("acct-1", {
        actionId: action.id,
        leaseToken: "current",
        nowMs: 201,
      }),
      false,
    );
    database.execRaw("UPDATE commerce_subscriptions SET status='ended' WHERE id='sub-active'");
    assert.equal(
      await store.archiveSeller("acct-1", {
        actionId: action.id,
        leaseToken: "current",
        nowMs: 201,
      }),
      true,
    );
  } finally {
    database.close();
  }
});

test("scheduled sweeps replenish late offboarding and renewal-shutdown subscriptions", async () => {
  const database = await createTestDatabase();
  try {
    database.execRaw(`
      INSERT INTO commerce_connected_accounts(id,guild_id,stripe_account_id,status,charges_enabled,payouts_enabled,details_submitted,created_at_ms,updated_at_ms)
        VALUES ('acct-1','guild-1','acct_stripe','active',1,1,1,1,1);
      INSERT INTO commerce_financial_actions(id,connected_account_id,guild_id,action_type,entity_type,entity_id,actor_user_id,reason_code,status,attempt_count,available_at_ms,created_at_ms,updated_at_ms,completed_at_ms)
        VALUES ('offboard-1','acct-1','guild-1','seller.offboarding_started','seller','acct-1','seller-1','seller_requested','completed',1,1,1,1,1);
      INSERT INTO commerce_seller_offboarding(connected_account_id,guild_id,status,reason_code,actor_user_id,active_subscription_count,started_at_ms,updated_at_ms)
        VALUES ('acct-1','guild-1','waiting','seller_requested','seller-1',1,1,1);
      INSERT INTO commerce_subscriptions(id,connected_account_id,customer_id,buyer_id,offering_id,price_id,stripe_subscription_id,status,cancel_at_period_end,current_period_end_ms,created_at_ms,updated_at_ms)
        VALUES ('sub-1','acct-1','customer-1','buyer-1','off-1','price-1','sub_stripe_1','active',0,2000,1,1);
    `);
    const run = () =>
      processCommerceFinancialProviderActions({
        database: database.d1,
        now: () => 100,
        provider: {
          async cancelAtPeriodEnd() {},
          async cancelImmediately() {},
        },
        async requestReconciliation() {},
      });
    await run();
    database.execRaw(`
      INSERT INTO commerce_subscriptions(id,connected_account_id,customer_id,buyer_id,offering_id,price_id,stripe_subscription_id,status,cancel_at_period_end,current_period_end_ms,created_at_ms,updated_at_ms)
        VALUES ('sub-2','acct-1','customer-2','buyer-2','off-1','price-1','sub_stripe_2','active',0,3000,2,2);
    `);
    await run();
    assert.equal(
      database.query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM commerce_financial_provider_actions WHERE workflow_type='seller_offboarding'",
      )[0]?.count,
      2,
    );

    database.execRaw(`
      INSERT INTO commerce_operational_controls(id,scope_type,scope_id,control_type,enabled,reason_code,actor_user_id,created_at_ms,updated_at_ms)
        VALUES ('control-1','guild','guild-1','renewal_shutdown',1,'risk_review','seller-1',1,1);
      INSERT INTO commerce_subscriptions(id,connected_account_id,customer_id,buyer_id,offering_id,price_id,stripe_subscription_id,status,cancel_at_period_end,current_period_end_ms,created_at_ms,updated_at_ms)
        VALUES ('sub-3','acct-1','customer-3','buyer-3','off-1','price-1','sub_stripe_3','active',0,4000,3,3);
    `);
    await run();
    assert.equal(
      database.query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM commerce_financial_provider_actions WHERE workflow_type='renewal_shutdown'",
      )[0]?.count,
      3,
    );
  } finally {
    database.close();
  }
});

function seedRetirement(database: Awaited<ReturnType<typeof createTestDatabase>>): void {
  database.execRaw(`
    INSERT INTO commerce_connected_accounts(id,guild_id,stripe_account_id,status,charges_enabled,payouts_enabled,details_submitted,created_at_ms,updated_at_ms)
      VALUES ('acct-1','guild-1','acct_stripe','active',1,1,1,1,1);
    INSERT INTO commerce_offerings(id,connected_account_id,guild_id,discord_role_id,name,purchase_type,status,created_at_ms,updated_at_ms)
      VALUES ('off-1','acct-1','guild-1','role-1','Gold','subscription','draft',1,1);
    INSERT INTO commerce_offering_lifecycles(offering_id,connected_account_id,guild_id,state,included_benefits_json,support_contact,role_manageable,retire_at_ms,created_at_ms,updated_at_ms)
      VALUES ('off-1','acct-1','guild-1','retiring','["Access"]','seller@example.test',1,2,1,1);
    INSERT INTO commerce_offering_retirements(id,connected_account_id,guild_id,offering_id,requested_by_user_id,reason_code,status,active_subscription_count,scheduled_cancellation_count,failed_cancellation_count,created_at_ms,updated_at_ms)
      VALUES ('retire-1','acct-1','guild-1','off-1','seller-1','seller_requested','scheduling_cancellations',1,0,0,1,1);
    INSERT INTO commerce_subscriptions(id,connected_account_id,customer_id,buyer_id,offering_id,price_id,stripe_subscription_id,status,cancel_at_period_end,current_period_end_ms,created_at_ms,updated_at_ms)
      VALUES ('sub-1','acct-1','customer-1','buyer-1','off-1','price-1','sub_stripe_1','active',0,2000,1,1);
  `);
}

function parentSellerAction(): CommerceFinancialAction {
  return {
    id: "offboard-1",
    connectedAccountId: "acct-1",
    guildId: "guild-1",
    actionType: "seller.offboarding_started",
    entityType: "seller",
    entityId: "acct-1",
    actorUserId: "seller-1",
    reasonCode: "seller_requested",
    amountMinor: null,
    currency: null,
    status: "processing",
    providerResultId: null,
    accessAction: "remove_at_period_end",
    attemptCount: 0,
    lastErrorCode: null,
    leaseToken: null,
    claimedAtMs: null,
    leaseExpiresAtMs: null,
    availableAtMs: 0,
    providerCompletedAtMs: null,
    reconciliationRequestedAtMs: null,
    quarantinedAtMs: null,
    createdAtMs: 1,
    updatedAtMs: 1,
    completedAtMs: null,
  };
}
