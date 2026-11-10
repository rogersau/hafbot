import type {
  CommerceConnectedAccount,
  CommerceCurrency,
  CommercePayment,
  CommerceSubscription,
} from "./types";
import type { CommerceSupportPayment } from "./support-payments";
import { readFinancialActionWorkflow } from "./financial-action-workflow";

export type CommerceFinancialActionType =
  | "subscription.refund"
  | "subscription.cancel_immediately"
  | "subscription.cancel_at_period_end"
  | "support.refund"
  | "seller.offboarding_started"
  | "seller.disconnected"
  | "seller.deauthorized"
  | "seller.renewal_shutdown";

export interface CommerceFinancialAction {
  id: string;
  connectedAccountId: string;
  guildId: string;
  actionType: CommerceFinancialActionType;
  entityType: "payment" | "subscription" | "seller";
  entityId: string;
  actorUserId: string;
  reasonCode: string;
  amountMinor: number | null;
  currency: CommerceCurrency | null;
  status: "processing" | "completed" | "failed";
  providerResultId: string | null;
  accessAction: "retain" | "remove_immediately" | "remove_at_period_end" | "none" | null;
  attemptCount: number;
  lastErrorCode: string | null;
  leaseToken: string | null;
  claimedAtMs: number | null;
  leaseExpiresAtMs: number | null;
  availableAtMs: number;
  providerCompletedAtMs: number | null;
  reconciliationRequestedAtMs: number | null;
  quarantinedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
  completedAtMs: number | null;
}

export interface CommerceScopedSubscription {
  subscription: CommerceSubscription;
  account: CommerceConnectedAccount;
  guildId: string;
}

export interface CommerceScopedPayment {
  payment: CommercePayment;
  subscription: CommerceSubscription | null;
  account: CommerceConnectedAccount;
  guildId: string;
}

export interface CommerceScopedSupportPayment {
  payment: CommerceSupportPayment;
  account: CommerceConnectedAccount;
  guildId: string;
}

export interface CommerceOffboardingSubscription {
  id: string;
  stripeSubscriptionId: string;
  buyerId: string;
  offeringId: string;
  status: CommerceSubscription["status"];
  cancelAtPeriodEnd: boolean;
  currentPeriodEndMs: number | null;
}

export interface CommerceSellerOffboarding {
  connectedAccountId: string;
  guildId: string;
  status: "canceling" | "waiting" | "ready" | "completed" | "unexpected_deauthorization";
  reasonCode: string;
  actorUserId: string | null;
  activeSubscriptionCount: number;
  latestPaidThroughAtMs: number | null;
  startedAtMs: number;
  completedAtMs: number | null;
  updatedAtMs: number;
}

export interface CommerceFinancialOperationsStore {
  readPayment(paymentId: string): Promise<CommerceScopedPayment | null>;
  readSupportPayment(paymentId: string): Promise<CommerceScopedSupportPayment | null>;
  readSubscription(subscriptionId: string): Promise<CommerceScopedSubscription | null>;
  readSeller(guildId: string): Promise<{
    account: CommerceConnectedAccount;
  } | null>;
  listActiveSubscriptions(connectedAccountId: string): Promise<CommerceOffboardingSubscription[]>;
  readAction(actionId: string): Promise<CommerceFinancialAction | null>;
  listRecoverableActions(nowMs: number, limit?: number): Promise<CommerceFinancialAction[]>;
  claimAction(
    action: CommerceFinancialAction,
    claim: { leaseToken: string; nowMs: number; leaseMs: number },
  ): Promise<"claimed" | "completed" | "processing" | "quarantined">;
  failAction(
    actionId: string,
    leaseToken: string,
    errorCode: string,
    nowMs: number,
  ): Promise<boolean>;
  markProviderCompleted(
    actionId: string,
    leaseToken: string,
    providerResultId: string | null,
    nowMs: number,
  ): Promise<boolean>;
  markReconciliationRequested(
    actionId: string,
    leaseToken: string,
    nowMs: number,
  ): Promise<boolean>;
  completeAction(action: CommerceFinancialAction, leaseToken: string): Promise<boolean>;
  enqueueSubscriptionCancellations(input: {
    parentActionId: string;
    workflowType: "seller_offboarding" | "renewal_shutdown";
    workflowId: string;
    connectedAccountId: string;
    guildId: string;
    subscriptions: CommerceOffboardingSubscription[];
    reasonCode: string;
    nowMs: number;
    leaseToken: string;
  }): Promise<void>;
  enqueueRefundCancellation(input: {
    parentActionId: string;
    leaseToken: string;
    connectedAccountId: string;
    guildId: string;
    subscription: CommerceOffboardingSubscription;
    mode: "immediate" | "period_end";
    reasonCode: string;
    nowMs: number;
  }): Promise<void>;
  stopNewSales(
    connectedAccountId: string,
    guildId: string,
    lease: CommerceFinancialActionLease,
  ): Promise<void>;
  saveSellerLifecycle(
    connectedAccountId: string,
    state: "offboarding" | "disconnected",
    lease: CommerceFinancialActionLease,
  ): Promise<void>;
  saveOffboarding(
    value: CommerceSellerOffboarding,
    lease: CommerceFinancialActionLease,
  ): Promise<void>;
  readOffboarding(connectedAccountId: string): Promise<CommerceSellerOffboarding | null>;
  archiveSeller(connectedAccountId: string, lease: CommerceFinancialActionLease): Promise<boolean>;
  recordDeauthorization(input: {
    connectedAccountId: string;
    guildId: string;
    buyerIds: string[];
    operationId: string;
    nowMs: number;
    leaseToken: string;
  }): Promise<void>;
}

export interface CommerceFinancialActionLease {
  actionId: string;
  leaseToken: string;
  nowMs: number;
}

export interface CommerceFinancialOperationsProvider {
  refund(input: {
    connectedAccountId: string;
    stripePaymentIntentId: string;
    amountMinor: number;
    idempotencyKey: string;
  }): Promise<{ id: string }>;
  cancelImmediately(input: {
    connectedAccountId: string;
    stripeSubscriptionId: string;
    idempotencyKey: string;
  }): Promise<void>;
  cancelAtPeriodEnd(input: {
    connectedAccountId: string;
    stripeSubscriptionId: string;
    idempotencyKey: string;
  }): Promise<void>;
  disconnect(input: { connectedAccountId: string; idempotencyKey: string }): Promise<void>;
}

export interface CommerceFinancialOperationsReconciler {
  request(input: { connectedAccountId: string; correlationId: string }): Promise<void>;
}

export class CommerceFinancialOperationsService {
  constructor(
    private readonly store: CommerceFinancialOperationsStore,
    private readonly provider: CommerceFinancialOperationsProvider,
    private readonly reconciler: CommerceFinancialOperationsReconciler,
    private readonly now: () => number = Date.now,
  ) {}

  readActionForGuild(actionId: string, guildId: string): Promise<CommerceFinancialAction | null> {
    return this.store
      .readAction(actionId)
      .then((action) => (action?.guildId === guildId ? action : null));
  }

  async recoverDueActions(limit = 100): Promise<number> {
    const actions = await this.store.listRecoverableActions(this.now(), limit);
    let recovered = 0;
    for (const action of actions) {
      try {
        await this.recover(action);
        recovered += 1;
      } catch {
        // The action records its safe failure and remains available to a later sweep.
      }
    }
    return recovered;
  }

  async refundSubscription(input: {
    guildId: string;
    paymentId: string;
    amountMinor: number;
    cancellation: "default" | "none" | "immediate" | "period_end";
    actorUserId: string;
    reasonCode: string;
    actionId: string;
  }): Promise<{ refundId: string | null; accessAction: CommerceFinancialAction["accessAction"] }> {
    const scoped = await this.store.readPayment(input.paymentId);
    if (!scoped || scoped.guildId !== input.guildId || !scoped.subscription) {
      throw new Error("commerce_payment_not_found");
    }
    assertReason(input.reasonCode);
    const payment = scoped.payment;
    const subscription = scoped.subscription;
    const refundable = payment.amountReceivedMinor - payment.amountRefundedMinor;
    if (
      payment.status !== "succeeded" ||
      !Number.isSafeInteger(input.amountMinor) ||
      input.amountMinor < 1 ||
      input.amountMinor > refundable
    ) {
      throw new Error("commerce_refund_invalid");
    }
    const fullRefund = input.amountMinor === refundable;
    const cancellation =
      input.cancellation === "default" ? (fullRefund ? "immediate" : "none") : input.cancellation;
    const accessAction =
      cancellation === "immediate"
        ? "remove_immediately"
        : cancellation === "period_end"
          ? "remove_at_period_end"
          : "retain";
    const action = this.action({
      input,
      accountId: scoped.account.id,
      actionType: "subscription.refund",
      entityType: "payment",
      entityId: payment.id,
      amountMinor: input.amountMinor,
      currency: payment.currency,
      accessAction,
    });
    const claim = await this.claim(action);
    if (claim === "completed") return { refundId: null, accessAction };
    if (claim === "processing") throw new Error("commerce_financial_action_in_progress");
    try {
      const refundId = await this.providerStage(action, claim, async () => {
        const refund = await this.provider.refund({
          connectedAccountId: scoped.account.stripeAccountId,
          stripePaymentIntentId: payment.stripePaymentIntentId,
          amountMinor: input.amountMinor,
          idempotencyKey: `commerce:refund:${action.id}`,
        });
        return refund.id;
      });
      if (cancellation !== "none") {
        await this.store.enqueueRefundCancellation({
          parentActionId: action.id,
          leaseToken: claim,
          connectedAccountId: scoped.account.id,
          guildId: input.guildId,
          subscription: offboardingSubscription(subscription),
          mode: cancellation,
          reasonCode: input.reasonCode,
          nowMs: this.now(),
        });
      }
      await this.reconciliationStage(action, claim, scoped.account.id);
      await this.completeAction(
        {
          ...action,
          status: "completed",
          providerResultId: refundId,
          providerCompletedAtMs: this.now(),
          reconciliationRequestedAtMs: this.now(),
          completedAtMs: this.now(),
          updatedAtMs: this.now(),
        },
        claim,
      );
      return { refundId, accessAction };
    } catch (error) {
      await this.store.failAction(action.id, claim, safeErrorCode(error), this.now());
      throw error;
    }
  }

  async refundSupport(input: {
    guildId: string;
    paymentId: string;
    amountMinor: number;
    actorUserId: string;
    reasonCode: string;
    actionId: string;
  }): Promise<{ refundId: string | null }> {
    const scoped = await this.store.readSupportPayment(input.paymentId);
    if (!scoped || scoped.guildId !== input.guildId) {
      throw new Error("commerce_support_payment_not_found");
    }
    assertReason(input.reasonCode);
    const refundable = scoped.payment.amountReceivedMinor - scoped.payment.amountRefundedMinor;
    if (
      scoped.payment.status !== "succeeded" ||
      !Number.isSafeInteger(input.amountMinor) ||
      input.amountMinor < 1 ||
      input.amountMinor > refundable
    ) {
      throw new Error("commerce_support_refund_invalid");
    }
    const action = this.action({
      input,
      accountId: scoped.account.id,
      actionType: "support.refund",
      entityType: "payment",
      entityId: scoped.payment.id,
      amountMinor: input.amountMinor,
      currency: scoped.payment.currency,
      accessAction: "none",
    });
    const claim = await this.claim(action);
    if (claim === "completed") return { refundId: null };
    if (claim === "processing") throw new Error("commerce_financial_action_in_progress");
    try {
      const refundId = await this.providerStage(action, claim, async () => {
        const refund = await this.provider.refund({
          connectedAccountId: scoped.account.stripeAccountId,
          stripePaymentIntentId: scoped.payment.stripePaymentIntentId,
          amountMinor: input.amountMinor,
          idempotencyKey: `commerce:support-refund:${action.id}`,
        });
        return refund.id;
      });
      await this.reconciliationStage(action, claim, scoped.account.id);
      await this.completeAction(
        {
          ...action,
          status: "completed",
          providerResultId: refundId,
          providerCompletedAtMs: this.now(),
          reconciliationRequestedAtMs: this.now(),
          completedAtMs: this.now(),
          updatedAtMs: this.now(),
        },
        claim,
      );
      return { refundId };
    } catch (error) {
      await this.store.failAction(action.id, claim, safeErrorCode(error), this.now());
      throw error;
    }
  }

  async readOffboardingForGuild(guildId: string): Promise<CommerceSellerOffboarding | null> {
    const seller = await this.store.readSeller(guildId);
    return seller ? this.store.readOffboarding(seller.account.id) : null;
  }

  async cancelSubscription(input: {
    guildId: string;
    subscriptionId: string;
    mode: "immediate" | "period_end";
    actorUserId: string;
    reasonCode: string;
    actionId: string;
  }): Promise<void> {
    const scoped = await this.store.readSubscription(input.subscriptionId);
    if (!scoped || scoped.guildId !== input.guildId) {
      throw new Error("commerce_subscription_not_found");
    }
    assertReason(input.reasonCode);
    const action = this.action({
      input,
      accountId: scoped.account.id,
      actionType:
        input.mode === "immediate"
          ? "subscription.cancel_immediately"
          : "subscription.cancel_at_period_end",
      entityType: "subscription",
      entityId: scoped.subscription.id,
      amountMinor: null,
      currency: null,
      accessAction: input.mode === "immediate" ? "remove_immediately" : "remove_at_period_end",
    });
    const claim = await this.claim(action);
    if (claim === "completed") return;
    if (claim === "processing") throw new Error("commerce_financial_action_in_progress");
    try {
      await this.providerStage(action, claim, async () => {
        const operation =
          input.mode === "immediate"
            ? this.provider.cancelImmediately.bind(this.provider)
            : this.provider.cancelAtPeriodEnd.bind(this.provider);
        await operation({
          connectedAccountId: scoped.account.stripeAccountId,
          stripeSubscriptionId: scoped.subscription.stripeSubscriptionId,
          idempotencyKey: `commerce:subscription-${input.mode}:${action.id}`,
        });
        return null;
      });
      await this.reconciliationStage(action, claim, scoped.account.id);
      await this.completeAction(
        {
          ...action,
          status: "completed",
          providerCompletedAtMs: this.now(),
          reconciliationRequestedAtMs: this.now(),
          completedAtMs: this.now(),
          updatedAtMs: this.now(),
        },
        claim,
      );
    } catch (error) {
      await this.store.failAction(action.id, claim, safeErrorCode(error), this.now());
      throw error;
    }
  }

  async beginOffboarding(input: {
    guildId: string;
    actorUserId: string;
    reasonCode: string;
    actionId: string;
  }): Promise<{ subscriptions: CommerceOffboardingSubscription[] }> {
    assertReason(input.reasonCode);
    const seller = await this.store.readSeller(input.guildId);
    if (!seller) throw new Error("commerce_seller_not_connected");
    const action = this.action({
      input,
      accountId: seller.account.id,
      actionType: "seller.offboarding_started",
      entityType: "seller",
      entityId: seller.account.id,
      amountMinor: null,
      currency: null,
      accessAction: "remove_at_period_end",
    });
    const claim = await this.claim(action);
    if (claim === "processing") throw new Error("commerce_financial_action_in_progress");
    const subscriptions = await this.store.listActiveSubscriptions(seller.account.id);
    if (claim === "completed") return { subscriptions };
    try {
      await this.store.stopNewSales(seller.account.id, input.guildId, this.lease(action.id, claim));
      await this.store.saveSellerLifecycle(
        seller.account.id,
        "offboarding",
        this.lease(action.id, claim),
      );
      await this.store.enqueueSubscriptionCancellations({
        parentActionId: action.id,
        workflowType: "seller_offboarding",
        workflowId: seller.account.id,
        connectedAccountId: seller.account.id,
        guildId: input.guildId,
        subscriptions,
        reasonCode: input.reasonCode,
        nowMs: this.now(),
        leaseToken: claim,
      });
      const latestPaidThroughAtMs = maximum(
        subscriptions.map((subscription) => subscription.currentPeriodEndMs),
      );
      const nowMs = this.now();
      await this.store.saveOffboarding(
        {
          connectedAccountId: seller.account.id,
          guildId: input.guildId,
          status: subscriptions.length === 0 ? "ready" : "waiting",
          reasonCode: input.reasonCode,
          actorUserId: input.actorUserId,
          activeSubscriptionCount: subscriptions.length,
          latestPaidThroughAtMs,
          startedAtMs: nowMs,
          completedAtMs: null,
          updatedAtMs: nowMs,
        },
        this.lease(action.id, claim),
      );
      await this.completeAction(
        {
          ...action,
          accessAction: subscriptions.length === 0 ? "none" : "remove_at_period_end",
          status: "completed",
          completedAtMs: this.now(),
          updatedAtMs: this.now(),
        },
        claim,
      );
      return { subscriptions };
    } catch (error) {
      await this.store.failAction(action.id, claim, safeErrorCode(error), this.now());
      throw error;
    }
  }

  async shutdownRenewals(input: {
    guildId: string;
    actorUserId: string;
    reasonCode: string;
    actionId: string;
  }): Promise<{ subscriptions: CommerceOffboardingSubscription[] }> {
    assertReason(input.reasonCode);
    const seller = await this.store.readSeller(input.guildId);
    if (!seller) throw new Error("commerce_seller_not_connected");
    const subscriptions = await this.store.listActiveSubscriptions(seller.account.id);
    const action = this.action({
      input,
      accountId: seller.account.id,
      actionType: "seller.renewal_shutdown",
      entityType: "seller",
      entityId: seller.account.id,
      amountMinor: null,
      currency: null,
      accessAction: subscriptions.length === 0 ? "none" : "remove_at_period_end",
    });
    const claim = await this.claim(action);
    if (claim === "completed") return { subscriptions };
    if (claim === "processing") throw new Error("commerce_financial_action_in_progress");
    try {
      await this.store.enqueueSubscriptionCancellations({
        parentActionId: action.id,
        workflowType: "renewal_shutdown",
        workflowId: seller.account.id,
        connectedAccountId: seller.account.id,
        guildId: input.guildId,
        subscriptions,
        reasonCode: input.reasonCode,
        nowMs: this.now(),
        leaseToken: claim,
      });
      await this.completeAction(
        {
          ...action,
          status: "completed",
          completedAtMs: this.now(),
          updatedAtMs: this.now(),
        },
        claim,
      );
      return { subscriptions };
    } catch (error) {
      await this.store.failAction(action.id, claim, safeErrorCode(error), this.now());
      throw error;
    }
  }

  async completeOffboarding(input: {
    guildId: string;
    actorUserId: string;
    reasonCode: string;
    actionId: string;
  }): Promise<void> {
    assertReason(input.reasonCode);
    const seller = await this.store.readSeller(input.guildId);
    if (!seller) throw new Error("commerce_seller_not_connected");
    const active = await this.store.listActiveSubscriptions(seller.account.id);
    if (active.length > 0) throw new Error("commerce_offboarding_active_subscriptions");
    const offboarding = await this.store.readOffboarding(seller.account.id);
    if (!offboarding) throw new Error("commerce_offboarding_not_started");
    const action = this.action({
      input,
      accountId: seller.account.id,
      actionType: "seller.disconnected",
      entityType: "seller",
      entityId: seller.account.id,
      amountMinor: null,
      currency: null,
      accessAction: "none",
    });
    const claim = await this.claim(action);
    if (claim === "completed") return;
    if (claim === "processing") throw new Error("commerce_financial_action_in_progress");
    try {
      await this.providerStage(action, claim, async () => {
        await this.provider.disconnect({
          connectedAccountId: seller.account.stripeAccountId,
          idempotencyKey: `commerce:disconnect:${input.actionId}`,
        });
        return null;
      });
      if (!(await this.store.archiveSeller(seller.account.id, this.lease(action.id, claim)))) {
        throw new Error("commerce_offboarding_active_subscriptions");
      }
      await this.store.saveOffboarding(
        {
          ...offboarding,
          status: "completed",
          activeSubscriptionCount: 0,
          completedAtMs: this.now(),
          updatedAtMs: this.now(),
        },
        this.lease(action.id, claim),
      );
      await this.completeAction(
        {
          ...action,
          status: "completed",
          providerCompletedAtMs: this.now(),
          completedAtMs: this.now(),
          updatedAtMs: this.now(),
        },
        claim,
      );
    } catch (error) {
      await this.store.failAction(action.id, claim, safeErrorCode(error), this.now());
      throw error;
    }
  }

  async handleUnexpectedDeauthorization(input: {
    guildId: string;
    actionId: string;
  }): Promise<void> {
    const seller = await this.store.readSeller(input.guildId);
    if (!seller) throw new Error("commerce_seller_not_connected");
    const actionInput = {
      guildId: input.guildId,
      actionId: input.actionId,
      actorUserId: "stripe",
      reasonCode: "stripe_deauthorized",
    };
    const action = this.action({
      input: actionInput,
      accountId: seller.account.id,
      actionType: "seller.deauthorized",
      entityType: "seller",
      entityId: seller.account.id,
      amountMinor: null,
      currency: null,
      accessAction: "remove_at_period_end",
    });
    const claim = await this.claim(action);
    if (claim === "completed") return;
    if (claim === "processing") throw new Error("commerce_financial_action_in_progress");
    try {
      const subscriptions = await this.store.listActiveSubscriptions(seller.account.id);
      await this.store.stopNewSales(seller.account.id, input.guildId, this.lease(action.id, claim));
      await this.store.saveSellerLifecycle(
        seller.account.id,
        "disconnected",
        this.lease(action.id, claim),
      );
      const nowMs = this.now();
      await this.store.saveOffboarding(
        {
          connectedAccountId: seller.account.id,
          guildId: input.guildId,
          status: "unexpected_deauthorization",
          reasonCode: "stripe_deauthorized",
          actorUserId: null,
          activeSubscriptionCount: subscriptions.length,
          latestPaidThroughAtMs: maximum(
            subscriptions.map((subscription) => subscription.currentPeriodEndMs),
          ),
          startedAtMs: nowMs,
          completedAtMs: null,
          updatedAtMs: nowMs,
        },
        this.lease(action.id, claim),
      );
      await this.store.recordDeauthorization({
        connectedAccountId: seller.account.id,
        guildId: input.guildId,
        buyerIds: subscriptions.map((subscription) => subscription.buyerId),
        operationId: action.id,
        nowMs,
        leaseToken: claim,
      });
      await this.completeAction(
        {
          ...action,
          status: "completed",
          completedAtMs: this.now(),
          updatedAtMs: this.now(),
        },
        claim,
      );
    } catch (error) {
      await this.store.failAction(action.id, claim, safeErrorCode(error), this.now());
      throw error;
    }
  }

  private action(input: {
    input: { guildId: string; actionId: string; actorUserId: string; reasonCode: string };
    accountId: string;
    actionType: CommerceFinancialActionType;
    entityType: CommerceFinancialAction["entityType"];
    entityId: string;
    amountMinor: number | null;
    currency: CommerceCurrency | null;
    accessAction: CommerceFinancialAction["accessAction"];
  }): CommerceFinancialAction {
    const nowMs = this.now();
    return {
      id: input.input.actionId,
      connectedAccountId: input.accountId,
      guildId: input.input.guildId,
      actionType: input.actionType,
      entityType: input.entityType,
      entityId: input.entityId,
      actorUserId: input.input.actorUserId,
      reasonCode: input.input.reasonCode,
      amountMinor: input.amountMinor,
      currency: input.currency,
      status: "processing",
      providerResultId: null,
      accessAction: input.accessAction,
      attemptCount: 1,
      lastErrorCode: null,
      leaseToken: null,
      claimedAtMs: null,
      leaseExpiresAtMs: null,
      availableAtMs: nowMs,
      providerCompletedAtMs: null,
      reconciliationRequestedAtMs: null,
      quarantinedAtMs: null,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      completedAtMs: null,
    };
  }

  private async reconcile(connectedAccountId: string, correlationId: string): Promise<void> {
    await this.reconciler.request({ connectedAccountId, correlationId });
  }

  private async providerStage(
    action: CommerceFinancialAction,
    leaseToken: string,
    operation: () => Promise<string | null>,
  ): Promise<string | null> {
    const persisted = await this.store.readAction(action.id);
    const workflow = readFinancialActionWorkflow(persisted);
    if (workflow.kind === "quarantined") throw new Error("commerce_financial_action_quarantined");
    if (workflow.kind !== "provider-pending") return workflow.providerResultId;
    const providerResultId = await operation();
    if (
      !(await this.store.markProviderCompleted(action.id, leaseToken, providerResultId, this.now()))
    ) {
      throw new Error("commerce_financial_action_lease_lost");
    }
    return providerResultId;
  }

  private async reconciliationStage(
    action: CommerceFinancialAction,
    leaseToken: string,
    connectedAccountId: string,
  ): Promise<void> {
    const persisted = await this.store.readAction(action.id);
    const workflow = readFinancialActionWorkflow(persisted);
    if (workflow.kind === "quarantined") throw new Error("commerce_financial_action_quarantined");
    if (workflow.kind === "completion-pending" || workflow.kind === "completed") return;
    await this.reconcile(connectedAccountId, action.id);
    if (!(await this.store.markReconciliationRequested(action.id, leaseToken, this.now()))) {
      throw new Error("commerce_financial_action_lease_lost");
    }
  }

  private async claim(
    action: CommerceFinancialAction,
  ): Promise<"completed" | "processing" | string> {
    const leaseToken = crypto.randomUUID();
    const claim = await this.store.claimAction(action, {
      leaseToken,
      nowMs: this.now(),
      leaseMs: 60_000,
    });
    const persisted = await this.store.readAction(action.id);
    if (!persisted || !sameImmutableAction(persisted, action)) {
      throw new Error("commerce_financial_action_mismatch");
    }
    if (claim === "quarantined") throw new Error("commerce_financial_action_quarantined");
    return claim === "claimed" ? leaseToken : claim;
  }

  private async completeAction(action: CommerceFinancialAction, leaseToken: string): Promise<void> {
    if (!(await this.store.completeAction(action, leaseToken))) {
      throw new Error("commerce_financial_action_lease_lost");
    }
  }

  private lease(actionId: string, leaseToken: string): CommerceFinancialActionLease {
    return { actionId, leaseToken, nowMs: this.now() };
  }

  private async recover(action: CommerceFinancialAction): Promise<void> {
    const common = {
      guildId: action.guildId,
      actorUserId: action.actorUserId,
      reasonCode: action.reasonCode,
      actionId: action.id,
    };
    if (action.actionType === "subscription.refund") {
      await this.refundSubscription({
        ...common,
        paymentId: action.entityId,
        amountMinor: action.amountMinor ?? 0,
        cancellation:
          action.accessAction === "remove_immediately"
            ? "immediate"
            : action.accessAction === "remove_at_period_end"
              ? "period_end"
              : "none",
      });
    } else if (action.actionType === "support.refund") {
      await this.refundSupport({
        ...common,
        paymentId: action.entityId,
        amountMinor: action.amountMinor ?? 0,
      });
    } else if (
      action.actionType === "subscription.cancel_immediately" ||
      action.actionType === "subscription.cancel_at_period_end"
    ) {
      await this.cancelSubscription({
        ...common,
        subscriptionId: action.entityId,
        mode: action.actionType === "subscription.cancel_immediately" ? "immediate" : "period_end",
      });
    } else if (action.actionType === "seller.offboarding_started") {
      await this.beginOffboarding(common);
    } else if (action.actionType === "seller.renewal_shutdown") {
      await this.shutdownRenewals(common);
    } else if (action.actionType === "seller.disconnected") {
      await this.completeOffboarding(common);
    } else if (action.actionType === "seller.deauthorized") {
      await this.handleUnexpectedDeauthorization({ guildId: action.guildId, actionId: action.id });
    }
  }
}

function assertReason(value: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{2,79}$/.test(value)) {
    throw new Error("commerce_financial_reason_invalid");
  }
}

function safeErrorCode(error: unknown): string {
  const value = error instanceof Error ? error.message : "provider_failure";
  return /^[a-z0-9][a-z0-9_:-]{0,99}$/.test(value) ? value : "provider_failure";
}

function maximum(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : Math.max(...present);
}

function sameImmutableAction(
  existing: CommerceFinancialAction,
  requested: CommerceFinancialAction,
): boolean {
  return (
    existing.connectedAccountId === requested.connectedAccountId &&
    existing.guildId === requested.guildId &&
    existing.actionType === requested.actionType &&
    existing.entityType === requested.entityType &&
    existing.entityId === requested.entityId &&
    existing.actorUserId === requested.actorUserId &&
    existing.reasonCode === requested.reasonCode &&
    existing.amountMinor === requested.amountMinor &&
    existing.currency === requested.currency &&
    existing.accessAction === requested.accessAction
  );
}

function offboardingSubscription(
  subscription: CommerceSubscription,
): CommerceOffboardingSubscription {
  return {
    id: subscription.id,
    stripeSubscriptionId: subscription.stripeSubscriptionId,
    buyerId: subscription.buyerId,
    offeringId: subscription.offeringId,
    status: subscription.status,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    currentPeriodEndMs: subscription.currentPeriodEndMs,
  };
}
