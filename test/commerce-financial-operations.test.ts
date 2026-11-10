/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import {
  CommerceFinancialOperationsService,
  type CommerceFinancialAction,
  type CommerceFinancialOperationsProvider,
  type CommerceFinancialOperationsStore,
  type CommerceSellerOffboarding,
} from "../src/commerce/financial-operations";
import type {
  CommerceConnectedAccount,
  CommercePayment,
  CommerceSubscription,
} from "../src/commerce/types";
import { StripeCommerceFinancialOperationsProvider } from "../src/runtime/commerce/stripe-financial-operations-provider";

test("full subscription refund defaults to fee reversal and immediate access removal", async () => {
  const store = new MemoryStore();
  const provider = new MemoryProvider();
  const reconciled: string[] = [];
  const service = new CommerceFinancialOperationsService(
    store,
    provider,
    {
      async request(input) {
        reconciled.push(input.correlationId);
      },
    },
    () => 1_700_000_000_000,
  );

  const result = await service.refundSubscription({
    guildId: "guild-1",
    paymentId: "payment-1",
    amountMinor: 1_000,
    cancellation: "default",
    actorUserId: "operator-1",
    reasonCode: "buyer_request",
    actionId: "action-1",
  });

  assert.deepEqual(result, { refundId: "re_1", accessAction: "remove_immediately" });
  assert.deepEqual(provider.refunds, [
    {
      connectedAccountId: "acct_seller",
      stripePaymentIntentId: "pi_payment",
      amountMinor: 1_000,
      idempotencyKey: "commerce:refund:action-1",
    },
  ]);
  assert.equal(provider.immediateCancellations.length, 0);
  assert.equal(provider.periodCancellations.length, 0);
  assert.deepEqual(store.cancellationActions, [
    {
      actionType: "subscription.cancel_immediately",
      operationKey: "commerce:refund-cancellation:action-1:subscription-1",
      subscriptionId: "subscription-1",
    },
  ]);
  assert.equal(store.actions.get("action-1")?.status, "completed");
  assert.equal(store.actions.get("action-1")?.actorUserId, "operator-1");
  assert.deepEqual(reconciled, ["action-1"]);

  await service.refundSubscription({
    guildId: "guild-1",
    paymentId: "payment-1",
    amountMinor: 1_000,
    cancellation: "default",
    actorUserId: "operator-1",
    reasonCode: "buyer_request",
    actionId: "action-1",
  });
  assert.equal(provider.refunds.length, 1, "completed action must be idempotent");
});

test("partial refund retains subscription access unless cancellation is explicit", async () => {
  const store = new MemoryStore();
  const provider = new MemoryProvider();
  const service = new CommerceFinancialOperationsService(store, provider, noReconcile);
  const result = await service.refundSubscription({
    guildId: "guild-1",
    paymentId: "payment-1",
    amountMinor: 400,
    cancellation: "default",
    actorUserId: "operator-1",
    reasonCode: "partial_goodwill",
    actionId: "action-partial",
  });
  assert.equal(result.accessAction, "retain");
  assert.equal(provider.immediateCancellations.length, 0);
  assert.equal(provider.periodCancellations.length, 0);
});

test("an idempotency key cannot be reused for a different immutable request", async () => {
  const store = new MemoryStore();
  const service = new CommerceFinancialOperationsService(store, new MemoryProvider(), noReconcile);
  await service.refundSubscription({
    guildId: "guild-1",
    paymentId: "payment-1",
    amountMinor: 400,
    cancellation: "none",
    actorUserId: "operator-1",
    reasonCode: "partial_goodwill",
    actionId: "immutable-action",
  });

  await assert.rejects(
    () =>
      service.refundSubscription({
        guildId: "guild-1",
        paymentId: "payment-1",
        amountMinor: 500,
        cancellation: "none",
        actorUserId: "operator-1",
        reasonCode: "partial_goodwill",
        actionId: "immutable-action",
      }),
    /commerce_financial_action_mismatch/,
  );
});

test("recovery resumes after the durable provider stage without repeating the refund", async () => {
  const store = new MemoryStore();
  const provider = new MemoryProvider();
  let reconciliationAttempts = 0;
  let nowMs = 1_700_000_000_000;
  const service = new CommerceFinancialOperationsService(
    store,
    provider,
    {
      async request() {
        reconciliationAttempts += 1;
        if (reconciliationAttempts === 1) throw new Error("reconciliation_unavailable");
      },
    },
    () => nowMs,
  );

  await assert.rejects(
    () =>
      service.refundSubscription({
        guildId: "guild-1",
        paymentId: "payment-1",
        amountMinor: 400,
        cancellation: "none",
        actorUserId: "operator-1",
        reasonCode: "partial_goodwill",
        actionId: "recover-refund",
      }),
    /reconciliation_unavailable/,
  );
  assert.equal(store.actions.get("recover-refund")?.providerCompletedAtMs, 1_700_000_000_000);

  nowMs += 60_000;
  assert.equal(await service.recoverDueActions(), 1);
  assert.equal(provider.refunds.length, 1);
  assert.equal(reconciliationAttempts, 2);
  assert.equal(store.actions.get("recover-refund")?.status, "completed");
});

test("offboarding stops new sales, schedules period-end cancellation, and blocks disconnect", async () => {
  const store = new MemoryStore();
  const provider = new MemoryProvider();
  const service = new CommerceFinancialOperationsService(store, provider, noReconcile);
  const result = await service.beginOffboarding({
    guildId: "guild-1",
    actorUserId: "operator-1",
    reasonCode: "seller_requested",
    actionId: "offboard-1",
  });
  assert.equal(result.subscriptions.length, 1);
  assert.equal(store.salesStopped, true);
  assert.equal(store.lifecycle, "offboarding");
  assert.equal(store.offboarding?.latestPaidThroughAtMs, 1_800_000_000_000);
  assert.equal(provider.periodCancellations.length, 0);
  assert.deepEqual(store.cancellationActions, [
    {
      actionType: "subscription.cancel_at_period_end",
      operationKey: "commerce:seller_offboarding:account-1:subscription-1",
      subscriptionId: "subscription-1",
    },
  ]);

  await assert.rejects(
    () =>
      service.completeOffboarding({
        guildId: "guild-1",
        actorUserId: "operator-1",
        reasonCode: "seller_requested",
        actionId: "disconnect-1",
      }),
    /commerce_offboarding_active_subscriptions/,
  );
  store.activeSubscriptions = [];
  await service.completeOffboarding({
    guildId: "guild-1",
    actorUserId: "operator-1",
    reasonCode: "seller_requested",
    actionId: "disconnect-1",
  });
  assert.deepEqual(provider.disconnections, ["acct_seller"]);
  assert.equal(store.archived, true);
  assert.equal(store.offboarding?.status, "completed");
});

test("unexpected deauthorization opens an incident without removing paid-through access", async () => {
  const store = new MemoryStore();
  const provider = new MemoryProvider();
  const service = new CommerceFinancialOperationsService(store, provider, noReconcile);
  await service.handleUnexpectedDeauthorization({
    guildId: "guild-1",
    actionId: "deauth-1",
  });
  assert.equal(store.salesStopped, true);
  assert.equal(store.lifecycle, "disconnected");
  assert.equal(store.deauthorization?.operationId, "deauth-1");
  assert.deepEqual(store.deauthorization?.buyerIds, ["buyer-1"]);
  assert.equal(provider.immediateCancellations.length, 0);
  assert.equal(store.actions.get("deauth-1")?.accessAction, "remove_at_period_end");
});

test("unexpected deauthorization reclaims the same action after a partial failure", async () => {
  const store = new MemoryStore();
  const service = new CommerceFinancialOperationsService(store, new MemoryProvider(), noReconcile);
  store.deauthorizationFailuresRemaining = 1;

  await assert.rejects(
    () =>
      service.handleUnexpectedDeauthorization({
        guildId: "guild-1",
        actionId: "deauth-retry",
      }),
    /deauthorization persistence failed/,
  );
  assert.equal(store.actions.get("deauth-retry")?.status, "failed");

  await service.handleUnexpectedDeauthorization({
    guildId: "guild-1",
    actionId: "deauth-retry",
  });
  assert.equal(store.actions.get("deauth-retry")?.status, "completed");
});

test("renewal shutdown schedules period-end cancellation without offboarding the seller", async () => {
  const store = new MemoryStore();
  const provider = new MemoryProvider();
  const service = new CommerceFinancialOperationsService(store, provider, noReconcile);
  const result = await service.shutdownRenewals({
    guildId: "guild-1",
    actorUserId: "operator-1",
    reasonCode: "risk_review",
    actionId: "renewals-1",
  });
  assert.equal(result.subscriptions.length, 1);
  assert.equal(provider.periodCancellations.length, 0);
  assert.equal(store.cancellationActions.length, 1);
  assert.equal(store.lifecycle, null);
  assert.equal(store.offboarding, null);
  assert.equal(store.actions.get("renewals-1")?.accessAction, "remove_at_period_end");
});

test("Stripe financial provider always reverses the application fee in connected scope", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const provider = new StripeCommerceFinancialOperationsProvider({
    async requestForConnectedAccount(accountId, path, options) {
      calls.push({ accountId, path, options });
      return { id: "re_refund" };
    },
    async deleteConnectedAccount(accountId, idempotencyKey) {
      calls.push({ accountId, idempotencyKey, deleted: true });
    },
  });
  await provider.refund({
    connectedAccountId: "acct_seller",
    stripePaymentIntentId: "pi_payment",
    amountMinor: 500,
    idempotencyKey: "refund-key",
  });
  assert.ok(calls[0]);
  const body = (calls[0].options as { body: URLSearchParams }).body;
  assert.equal(calls[0]?.accountId, "acct_seller");
  assert.equal(body.get("refund_application_fee"), "true");
  assert.equal(body.get("amount"), "500");
  await provider.cancelImmediately({
    connectedAccountId: "acct_seller",
    stripeSubscriptionId: "sub_subscription",
    idempotencyKey: "cancel-key",
  });
  assert.ok(calls[1]);
  assert.equal((calls[1].options as { method: string }).method, "DELETE");
  await provider.disconnect({
    connectedAccountId: "acct_seller",
    idempotencyKey: "disconnect-key",
  });
  assert.equal(calls[2]?.deleted, true);
});

const account: CommerceConnectedAccount = {
  id: "account-1",
  guildId: "guild-1",
  stripeAccountId: "acct_seller",
  status: "active",
  country: "AU",
  defaultCurrency: "AUD",
  chargesEnabled: true,
  payoutsEnabled: true,
  detailsSubmitted: true,
  providerCreatedAtMs: 1,
  archivedAtMs: null,
  createdAtMs: 1,
  updatedAtMs: 1,
};

const subscription: CommerceSubscription = {
  id: "subscription-1",
  connectedAccountId: account.id,
  customerId: "customer-1",
  buyerId: "buyer-1",
  offeringId: "offering-1",
  priceId: "price-1",
  stripeSubscriptionId: "sub_subscription",
  status: "active",
  cancelAtPeriodEnd: false,
  currentPeriodStartMs: 1_700_000_000_000,
  currentPeriodEndMs: 1_800_000_000_000,
  canceledAtMs: null,
  endedAtMs: null,
  providerUpdatedAtMs: 1,
  latestInvoiceId: "in_subscription",
  latestInvoiceStatus: "paid",
  latestPaymentIntentId: "pi_payment",
  latestPaymentStatus: "succeeded",
  graceStartedAtMs: null,
  graceEndsAtMs: null,
  createdAtMs: 1,
  updatedAtMs: 1,
};

const payment: CommercePayment = {
  id: "payment-1",
  connectedAccountId: account.id,
  customerId: "customer-1",
  buyerId: "buyer-1",
  offeringId: "offering-1",
  priceId: "price-1",
  stripePaymentIntentId: "pi_payment",
  stripeChargeId: "ch_payment",
  stripeCheckoutSessionId: "cs_payment",
  stripeInvoiceId: "in_subscription",
  stripeSubscriptionId: "sub_subscription",
  billingPeriodStartMs: 1_700_000_000_000,
  billingPeriodEndMs: 1_800_000_000_000,
  isLatestSubscriptionInvoice: true,
  currency: "AUD",
  amountMinor: 1_000,
  amountReceivedMinor: 1_000,
  amountRefundedMinor: 0,
  applicationFeeMinor: 50,
  stripeFeeMinor: 59,
  stripeFeeTaxMinor: 5,
  status: "succeeded",
  providerCreatedAtMs: 1,
  paidAtMs: 1,
  createdAtMs: 1,
  updatedAtMs: 1,
};

class MemoryStore implements CommerceFinancialOperationsStore {
  actions = new Map<string, CommerceFinancialAction>();
  salesStopped = false;
  lifecycle: string | null = null;
  offboarding: CommerceSellerOffboarding | null = null;
  archived = false;
  deauthorization: {
    buyerIds: string[];
    operationId: string;
  } | null = null;
  deauthorizationFailuresRemaining = 0;
  cancellationActions: Array<{
    actionType: "subscription.cancel_at_period_end" | "subscription.cancel_immediately";
    operationKey: string;
    subscriptionId: string;
  }> = [];
  activeSubscriptions = [
    {
      id: subscription.id,
      stripeSubscriptionId: subscription.stripeSubscriptionId,
      buyerId: subscription.buyerId,
      offeringId: subscription.offeringId,
      status: subscription.status,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      currentPeriodEndMs: subscription.currentPeriodEndMs,
    },
  ];

  async readPayment(id: string) {
    return id === payment.id ? { payment, subscription, account, guildId: account.guildId } : null;
  }
  async readSupportPayment() {
    return null;
  }
  async readSubscription(id: string) {
    return id === subscription.id ? { subscription, account, guildId: account.guildId } : null;
  }
  async readSeller(guildId: string) {
    return guildId === account.guildId ? { account } : null;
  }
  async listActiveSubscriptions() {
    return this.activeSubscriptions;
  }
  async readAction(actionId: string) {
    return this.actions.get(actionId) ?? null;
  }
  async listRecoverableActions(nowMs: number, limit = 100) {
    return [...this.actions.values()]
      .filter(
        (action) =>
          action.availableAtMs <= nowMs &&
          action.quarantinedAtMs === null &&
          (action.status === "failed" ||
            (action.status === "processing" &&
              (action.leaseExpiresAtMs === null || action.leaseExpiresAtMs <= nowMs))),
      )
      .slice(0, limit);
  }
  async claimAction(
    action: CommerceFinancialAction,
    claim: { leaseToken: string; nowMs: number; leaseMs: number },
  ) {
    const existing = this.actions.get(action.id);
    if (existing?.status === "completed") return "completed" as const;
    if (existing?.quarantinedAtMs !== null && existing?.quarantinedAtMs !== undefined) {
      return "quarantined" as const;
    }
    if (
      existing?.status === "processing" &&
      existing.leaseExpiresAtMs !== null &&
      existing.leaseExpiresAtMs > claim.nowMs
    ) {
      return "processing" as const;
    }
    this.actions.set(action.id, {
      ...(existing ?? action),
      status: "processing",
      attemptCount: (existing?.attemptCount ?? 0) + 1,
      leaseToken: claim.leaseToken,
      claimedAtMs: claim.nowMs,
      leaseExpiresAtMs: claim.nowMs + claim.leaseMs,
      updatedAtMs: claim.nowMs,
    });
    return "claimed" as const;
  }
  async failAction(actionId: string, leaseToken: string, errorCode: string, nowMs: number) {
    const action = this.actions.get(actionId);
    if (!action || action.leaseToken !== leaseToken) return false;
    this.actions.set(actionId, {
      ...action,
      status: "failed",
      lastErrorCode: errorCode,
      leaseExpiresAtMs: null,
      availableAtMs: nowMs + Math.min(3_600_000, action.attemptCount * 60_000),
      quarantinedAtMs: action.attemptCount >= 5 ? nowMs : null,
      updatedAtMs: nowMs,
    });
    return true;
  }
  async markProviderCompleted(
    actionId: string,
    leaseToken: string,
    providerResultId: string | null,
    nowMs: number,
  ) {
    const action = this.actions.get(actionId);
    if (!action || action.leaseToken !== leaseToken) return false;
    this.actions.set(actionId, {
      ...action,
      providerResultId,
      providerCompletedAtMs: nowMs,
      updatedAtMs: nowMs,
    });
    return true;
  }
  async markReconciliationRequested(actionId: string, leaseToken: string, nowMs: number) {
    const action = this.actions.get(actionId);
    if (!action || action.leaseToken !== leaseToken || action.providerCompletedAtMs === null) {
      return false;
    }
    this.actions.set(actionId, {
      ...action,
      reconciliationRequestedAtMs: nowMs,
      updatedAtMs: nowMs,
    });
    return true;
  }
  async completeAction(action: CommerceFinancialAction, leaseToken: string) {
    const existing = this.actions.get(action.id);
    if (!existing || existing.leaseToken !== leaseToken) return false;
    this.actions.set(action.id, { ...action, leaseToken });
    return true;
  }
  async enqueueSubscriptionCancellations(
    input: Parameters<CommerceFinancialOperationsStore["enqueueSubscriptionCancellations"]>[0],
  ) {
    for (const item of input.subscriptions) {
      const operationKey = `commerce:${input.workflowType}:${input.workflowId}:${item.id}`;
      if (this.cancellationActions.some((action) => action.operationKey === operationKey)) continue;
      this.cancellationActions.push({
        actionType: "subscription.cancel_at_period_end",
        operationKey,
        subscriptionId: item.id,
      });
    }
  }
  async enqueueRefundCancellation(
    input: Parameters<CommerceFinancialOperationsStore["enqueueRefundCancellation"]>[0],
  ) {
    const operationKey = `commerce:refund-cancellation:${input.parentActionId}:${input.subscription.id}`;
    if (this.cancellationActions.some((action) => action.operationKey === operationKey)) return;
    this.cancellationActions.push({
      actionType:
        input.mode === "immediate"
          ? "subscription.cancel_immediately"
          : "subscription.cancel_at_period_end",
      operationKey,
      subscriptionId: input.subscription.id,
    });
  }
  async stopNewSales() {
    this.salesStopped = true;
  }
  async saveSellerLifecycle(_connectedAccountId: string, state: "offboarding" | "disconnected") {
    this.lifecycle = state;
  }
  async saveOffboarding(value: CommerceSellerOffboarding) {
    this.offboarding = value;
  }
  async readOffboarding() {
    return this.offboarding;
  }
  async archiveSeller() {
    if (this.activeSubscriptions.length > 0) return false;
    this.archived = true;
    return true;
  }
  async recordDeauthorization(input: { buyerIds: string[]; operationId: string }) {
    if (this.deauthorizationFailuresRemaining > 0) {
      this.deauthorizationFailuresRemaining -= 1;
      throw new Error("deauthorization persistence failed");
    }
    this.deauthorization = input;
  }
}

class MemoryProvider implements CommerceFinancialOperationsProvider {
  refunds: Array<Parameters<CommerceFinancialOperationsProvider["refund"]>[0]> = [];
  immediateCancellations: Array<
    Parameters<CommerceFinancialOperationsProvider["cancelImmediately"]>[0]
  > = [];
  periodCancellations: Array<
    Parameters<CommerceFinancialOperationsProvider["cancelAtPeriodEnd"]>[0]
  > = [];
  disconnections: string[] = [];
  async refund(input: Parameters<CommerceFinancialOperationsProvider["refund"]>[0]) {
    this.refunds.push(input);
    return { id: "re_1" };
  }
  async cancelImmediately(
    input: Parameters<CommerceFinancialOperationsProvider["cancelImmediately"]>[0],
  ) {
    this.immediateCancellations.push(input);
  }
  async cancelAtPeriodEnd(
    input: Parameters<CommerceFinancialOperationsProvider["cancelAtPeriodEnd"]>[0],
  ) {
    this.periodCancellations.push(input);
  }
  async disconnect(input: Parameters<CommerceFinancialOperationsProvider["disconnect"]>[0]) {
    this.disconnections.push(input.connectedAccountId);
  }
}

const noReconcile = {
  async request() {},
};
