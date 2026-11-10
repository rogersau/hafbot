/// <reference types="node/assert" />
import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import type { PaidRoleEntitlementState } from "../src/commerce/paid-role-entitlement";
import { CloudflarePaidRoleStore } from "../src/runtime/commerce/cloudflare-paid-role-store";
import { createTestDatabase } from "./support/sqlite-d1-database";

const NOW = 1_800_000_000_000;

test("paid role operation claims are idempotent and release allows retry", async () => {
  const database = await createTestDatabase();
  try {
    const store = new CloudflarePaidRoleStore(database.d1, () => "id-1");
    assert.equal(
      await store.appendOperation({
        operationKey: "op-1",
        entitlementId: "ent-1",
        operationType: "assign",
        createdAtMs: NOW,
      }),
      true,
    );
    assert.equal(
      await store.appendOperation({
        operationKey: "op-1",
        entitlementId: "ent-1",
        operationType: "assign",
        createdAtMs: NOW,
      }),
      false,
    );
    await store.releaseOperation("op-1");
    assert.equal(
      await store.appendOperation({
        operationKey: "op-1",
        entitlementId: "ent-1",
        operationType: "assign",
        createdAtMs: NOW + 1,
      }),
      true,
    );
    await store.commitOperation("op-1", NOW + 2);
    await store.releaseOperation("op-1");
    assert.equal(
      await store.appendOperation({
        operationKey: "op-1",
        entitlementId: "ent-1",
        operationType: "assign",
        createdAtMs: NOW + 60_002,
      }),
      false,
    );
    assert.equal(
      await store.appendOperation({
        operationKey: "op-expired",
        entitlementId: "ent-1",
        operationType: "assign",
        createdAtMs: NOW,
      }),
      true,
    );
    assert.equal(
      await store.appendOperation({
        operationKey: "op-expired",
        entitlementId: "ent-1",
        operationType: "assign",
        createdAtMs: NOW + 60_001,
      }),
      true,
    );
  } finally {
    database.close();
  }
});

test("expired provider-action lease owners cannot overwrite reclaimed work", async () => {
  const database = await createTestDatabase();
  try {
    database.execRaw(`
      INSERT INTO commerce_role_assignments(
        id,entitlement_id,guild_id,discord_user_id,discord_role_id,status,
        provider_cancellation_state,attempt_count,created_at_ms,updated_at_ms
      ) VALUES ('assignment-lease','ent-lease','guild-1','user-1','role-1','assigned','pending',0,${NOW},${NOW});
    `);
    const store = new CloudflarePaidRoleStore(database.d1, () => "action-lease");
    await store.enqueueProviderAction({
      operationKey: "cancel-lease",
      assignmentId: "assignment-lease",
      connectedAccountId: "acct-1",
      subscriptionId: "sub-1",
      actionType: "subscription.cancel_at_period_end",
      reasonCode: "guild_ban",
      nowMs: NOW,
    });
    const original = (await store.listDueProviderActions(NOW))[0];
    assert.ok(original);
    const originalClaim = await store.claimProviderAction(original.id, NOW);
    assert.equal(originalClaim, NOW);

    const reclaimed = (await store.listDueProviderActions(NOW + 60_001))[0];
    assert.ok(reclaimed);
    const reclaimedClaim = await store.claimProviderAction(reclaimed.id, NOW + 60_001);
    assert.equal(reclaimedClaim, NOW + 60_001);
    assert.equal(await store.completeProviderAction(original, originalClaim, NOW + 60_002), false);
    assert.equal(
      database.query<{ state: string }>(
        "SELECT provider_cancellation_state AS state FROM commerce_role_assignments WHERE id='assignment-lease'",
      )[0]?.state,
      "pending",
    );

    assert.equal(await store.completeProviderAction(reclaimed, reclaimedClaim, NOW + 60_003), true);
    await store.failProviderAction(original, originalClaim, "stale_failure", NOW + 60_004);
    assert.deepEqual(
      database.query<{ status: string; state: string }>(
        `SELECT action.status,assignment.provider_cancellation_state AS state
         FROM commerce_paid_role_provider_actions action
         JOIN commerce_role_assignments assignment ON assignment.id=action.assignment_id
         WHERE action.operation_key='cancel-lease'`,
      )[0],
      { status: "completed", state: "scheduled" },
    );
  } finally {
    database.close();
  }
});

test("paid role state and commerce role assignments persist without claiming manual roles", async () => {
  const database = await createTestDatabase();
  try {
    const store = new CloudflarePaidRoleStore(database.d1);
    const state = roleState();
    await store.saveState(state);
    assert.deepEqual(await store.readState(state.entitlementId), state);
    database.execRaw(`
      INSERT INTO commerce_buyers(id,discord_user_id,created_at_ms,updated_at_ms) VALUES ('buyer-1','user-1',${NOW},${NOW});
      INSERT INTO commerce_offerings(id,connected_account_id,guild_id,discord_role_id,name,purchase_type,status,created_at_ms,updated_at_ms) VALUES ('offering-1','seller-1','guild-1','role-1','Monthly','subscription','active',${NOW},${NOW});
      INSERT INTO commerce_entitlements(id,connected_account_id,buyer_id,offering_id,source_type,source_id,status,effective_at_ms,created_at_ms,updated_at_ms) VALUES ('ent-1','seller-1','buyer-1','offering-1','subscription','stripe-sub-1','active',${NOW},${NOW},${NOW});
      INSERT INTO commerce_subscriptions(id,connected_account_id,customer_id,buyer_id,offering_id,price_id,stripe_subscription_id,status,created_at_ms,updated_at_ms) VALUES ('sub-1','seller-1','customer-1','buyer-1','offering-1','price-1','stripe-sub-1','active',${NOW},${NOW});
    `);
    const rebuilt = await store.buildEntitlementState("ent-1");
    assert.equal(rebuilt?.connectedAccountId, "seller-1");
    assert.equal(rebuilt?.subscriptionStatus, "active");
    assert.equal(
      await store.readManagedAssignment({
        entitlementId: state.entitlementId,
        guildId: state.guildId,
        discordUserId: state.discordUserId,
        discordRoleId: state.discordRoleId,
      }),
      null,
    );
    await store.saveManagedAssignment({
      id: "assignment-1",
      entitlementId: state.entitlementId,
      guildId: state.guildId,
      discordUserId: state.discordUserId,
      discordRoleId: state.discordRoleId,
      state: "managed",
      withheldReason: null,
      providerCancellationState: "none",
      attemptCount: 1,
      lastErrorCode: null,
      assignedAtMs: NOW,
      removedAtMs: null,
      updatedAtMs: NOW,
    });
    assert.equal(
      (
        await store.listManagedAssignments({
          guildId: state.guildId,
          discordRoleId: state.discordRoleId,
        })
      ).length,
      1,
    );
    assert.equal(
      await store.readManagedAssignment({
        entitlementId: "another-entitlement",
        guildId: state.guildId,
        discordUserId: state.discordUserId,
        discordRoleId: state.discordRoleId,
      }),
      null,
    );
  } finally {
    database.close();
  }
});

test("rebuild uses the provider grace anchor instead of reconciliation timestamps", async () => {
  const database = await createTestDatabase();
  try {
    const store = new CloudflarePaidRoleStore(database.d1);
    const graceStartedAtMs = NOW - 3 * 24 * 60 * 60 * 1_000;
    database.execRaw(`
      INSERT INTO commerce_buyers(id,discord_user_id,created_at_ms,updated_at_ms) VALUES ('buyer-grace','user-grace',${NOW},${NOW});
      INSERT INTO commerce_offerings(id,connected_account_id,guild_id,discord_role_id,name,purchase_type,status,created_at_ms,updated_at_ms) VALUES ('offering-grace','seller-grace','guild-grace','role-grace','Monthly','subscription','active',${NOW},${NOW});
      INSERT INTO commerce_entitlements(id,connected_account_id,buyer_id,offering_id,source_type,source_id,status,effective_at_ms,created_at_ms,updated_at_ms) VALUES ('ent-grace','seller-grace','buyer-grace','offering-grace','subscription','stripe-sub-grace','active',${NOW},${NOW},${NOW});
      INSERT INTO commerce_subscriptions(
        id,connected_account_id,customer_id,buyer_id,offering_id,price_id,stripe_subscription_id,status,
        latest_invoice_id,latest_invoice_status,latest_payment_intent_id,latest_payment_status,
        grace_started_at_ms,grace_ends_at_ms,created_at_ms,updated_at_ms
      ) VALUES (
        'sub-grace','seller-grace','customer-grace','buyer-grace','offering-grace','price-grace','stripe-sub-grace','past_due',
        'invoice-grace','open','payment-grace','failed',${graceStartedAtMs},${graceStartedAtMs + 7 * 24 * 60 * 60 * 1_000},${NOW},${NOW}
      );
      INSERT INTO commerce_payments(
        id,connected_account_id,customer_id,buyer_id,offering_id,price_id,stripe_payment_intent_id,
        currency,amount_minor,amount_received_minor,amount_refunded_minor,status,created_at_ms,updated_at_ms
      ) VALUES ('payment-local','seller-grace','customer-grace','buyer-grace','offering-grace','price-grace','payment-grace','AUD',500,0,0,'failed',${NOW},${NOW});
    `);
    const rebuilt = await store.buildEntitlementState("ent-grace");
    assert.equal(rebuilt?.failedPaymentAtMs, graceStartedAtMs);
    assert.equal(rebuilt?.paymentStatus, "failed");
  } finally {
    database.close();
  }
});

test("rebuild resolves one-time entitlement payment state without a subscription", async () => {
  const database = await createTestDatabase();
  try {
    const store = new CloudflarePaidRoleStore(database.d1);
    database.execRaw(`
      INSERT INTO commerce_buyers(id,discord_user_id,created_at_ms,updated_at_ms) VALUES ('buyer-once','user-once',${NOW},${NOW});
      INSERT INTO commerce_offerings(id,connected_account_id,guild_id,discord_role_id,name,purchase_type,status,created_at_ms,updated_at_ms) VALUES ('offering-once','seller-once','guild-once','role-once','Lifetime','one_time','active',${NOW},${NOW});
      INSERT INTO commerce_entitlements(id,connected_account_id,buyer_id,offering_id,source_type,source_id,status,effective_at_ms,created_at_ms,updated_at_ms) VALUES ('ent-once','seller-once','buyer-once','offering-once','payment','pi_once','active',${NOW},${NOW},${NOW});
      INSERT INTO commerce_payments(
        id,connected_account_id,customer_id,buyer_id,offering_id,price_id,stripe_payment_intent_id,
        currency,amount_minor,amount_received_minor,amount_refunded_minor,status,created_at_ms,updated_at_ms
      ) VALUES ('payment-once','seller-once','customer-once','buyer-once','offering-once','price-once','pi_once','AUD',500,500,0,'succeeded',${NOW},${NOW});
    `);
    const rebuilt = await store.buildEntitlementState("ent-once");
    assert.equal(rebuilt?.subscriptionStatus, "active");
    assert.equal(rebuilt?.paymentStatus, "succeeded");
    assert.equal(rebuilt?.amountMinor, 500);
  } finally {
    database.close();
  }
});

test("role outbox, repairs, audit, incidents, and notifications are durable", async () => {
  const database = await createTestDatabase();
  try {
    const store = new CloudflarePaidRoleStore(database.d1, () => "generated");
    const message = {
      operationKey: "op-outbox",
      entitlementId: "ent-1",
      guildId: "guild-1",
      discordUserId: "user-1",
      discordRoleId: "role-1",
      action: "assign" as const,
      payloadJson: '{"reason":"active_paid"}',
      availableAtMs: NOW,
      createdAtMs: NOW,
      updatedAtMs: NOW,
    };
    assert.equal(await store.enqueueRoleOperation(message), true);
    assert.equal(await store.enqueueRoleOperation(message), false);
    assert.equal((await store.listRoleOutbox(NOW)).length, 1);
    await store.markRoleOutboxSent("generated", NOW + 1);
    await store.saveRoleRepair({
      id: "repair-1",
      offeringId: "offering-1",
      guildId: "guild-1",
      oldRoleId: "old",
      replacementRoleId: "new",
      startedAtMs: NOW,
      deadlineAtMs: NOW + 1000,
      status: "pending",
      repairedCount: 0,
      lastErrorCode: null,
      createdAtMs: NOW,
      updatedAtMs: NOW,
    });
    assert.equal((await store.listDueRoleRepairs(NOW)).length, 1);
    assert.equal(
      await store.appendAudit({
        id: "audit-1",
        guildId: "guild-1",
        operationKey: "audit-op",
        operationType: "role.assign",
        entityType: "entitlement",
        entityId: "ent-1",
        actorType: "system",
        payloadJson: "{}",
        createdAtMs: NOW,
      }),
      true,
    );
    await store.saveIncident({
      id: "incident-1",
      guildId: "guild-1",
      incidentKey: "role-failure",
      severity: "error",
      status: "open",
      summaryCode: "permission",
      safeArgsJson: "{}",
      occurrenceCount: 1,
      firstSeenAtMs: NOW,
      lastSeenAtMs: NOW,
      createdAtMs: NOW,
      updatedAtMs: NOW,
    });
    assert.equal(
      await store.enqueueNotification({
        id: "notice-1",
        operationId: "audit-1",
        destinationType: "buyer_dm",
        destinationId: "user-1",
        payloadJson: "{}",
        status: "pending",
        attemptCount: 0,
        availableAtMs: NOW,
        lastErrorCode: null,
        deliveredAtMs: null,
        createdAtMs: NOW,
        updatedAtMs: NOW,
      }),
      true,
    );
    assert.equal(
      database.query<{ count: number }>("SELECT COUNT(*) AS count FROM commerce_delivery_outbox")[0]
        ?.count,
      1,
    );
  } finally {
    database.close();
  }
});

function roleState(overrides: Partial<PaidRoleEntitlementState> = {}): PaidRoleEntitlementState {
  return {
    entitlementId: "ent-1",
    connectedAccountId: "seller-1",
    guildId: "guild-1",
    discordUserId: "user-1",
    discordRoleId: "role-1",
    subscriptionId: "sub-1",
    subscriptionStatus: "active",
    cancelAtPeriodEnd: false,
    currentPeriodEndMs: NOW + 30_000,
    paymentStatus: "succeeded",
    amountMinor: 500,
    amountRefundedMinor: 0,
    disputeStatus: null,
    failedPaymentAtMs: null,
    adminAction: null,
    memberState: "present",
    updatedAtMs: NOW,
    ...overrides,
  };
}
