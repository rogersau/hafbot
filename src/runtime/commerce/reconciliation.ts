import type {
  CommerceBuyer,
  CommerceConnectedAccount,
  CommerceCustomer,
  CommerceDispute,
  CommerceEntitlement,
  CommercePayment,
  CommerceRefund,
  CommerceRoleAssignment,
  CommerceSubscription,
} from "../../commerce";
import type {
  CommerceSupportDispute,
  CommerceSupportPayment,
  CommerceSupportRefund,
} from "../../commerce/support-payments";

export type CommerceReconciliationSource =
  | "webhook"
  | "checkout"
  | "scheduled"
  | "support"
  | "admin";

export interface CommerceReconciliationMessage {
  connectedAccountId: string;
  eventId: string;
  resourceType: "seller";
  resourceId: string;
  generation: number;
}

export interface CommerceReconciliationTrigger {
  eventType: string;
  objectId: string | null;
  source: CommerceReconciliationSource;
}

export interface CommerceSellerSnapshot {
  expiredCheckoutIds?: string[];
  connectedAccount: CommerceConnectedAccount;
  buyers: CommerceBuyer[];
  customers: CommerceCustomer[];
  subscriptions: CommerceSubscription[];
  payments: CommercePayment[];
  refunds: CommerceRefund[];
  disputes: CommerceDispute[];
  entitlements: CommerceEntitlement[];
  roleAssignments: CommerceRoleAssignment[];
  supportPayments?: CommerceSupportPayment[];
  supportRefunds?: CommerceSupportRefund[];
  supportDisputes?: CommerceSupportDispute[];
  observedAtMs: number;
}

export interface CommerceSnapshotProvider {
  readSellerSnapshot(input: {
    connectedAccountId: string;
    trigger: CommerceReconciliationTrigger;
  }): Promise<CommerceSellerSnapshot>;
}

export type CommerceTerminalEventHandler = (input: {
  message: CommerceReconciliationMessage;
  trigger: CommerceReconciliationTrigger;
  actionId: string;
}) => Promise<CommerceSellerSnapshot>;

export interface CommerceReconciliationStore {
  claim(input: {
    message: CommerceReconciliationMessage;
    leaseToken: string;
    nowMs: number;
    leaseMs: number;
  }): Promise<"claimed" | "stale" | "leased" | "complete" | "missing">;
  readTrigger(
    message: CommerceReconciliationMessage,
  ): Promise<CommerceReconciliationTrigger | null>;
  commit(input: {
    message: CommerceReconciliationMessage;
    leaseToken: string;
    snapshot: CommerceSellerSnapshot;
    nowMs: number;
  }): Promise<boolean>;
  fail(input: {
    message: CommerceReconciliationMessage;
    leaseToken: string;
    reasonCode: string;
    nowMs: number;
  }): Promise<void>;
  quarantine(input: {
    message: CommerceReconciliationMessage;
    leaseToken: string | null;
    reasonCode: string;
    nowMs: number;
  }): Promise<void>;
  listPendingOutbox(limit?: number): Promise<CommerceReconciliationMessage[]>;
  markOutboxSent(message: CommerceReconciliationMessage, sentAtMs: number): Promise<void>;
  requestRefresh(input: {
    connectedAccountId: string;
    source: Exclude<CommerceReconciliationSource, "webhook">;
    correlationId: string;
    requestedAtMs: number;
  }): Promise<{
    accepted: boolean;
    outboxPending: boolean;
    message: CommerceReconciliationMessage;
  }>;
  listScheduledSellerAccounts(limit?: number): Promise<string[]>;
}

export interface CommerceReconciliationQueue {
  send(message: CommerceReconciliationMessage): Promise<unknown>;
}

export class CommerceProjectionQuarantineError extends Error {
  constructor(public readonly reasonCode: string) {
    super(reasonCode);
    this.name = "CommerceProjectionQuarantineError";
  }
}

export async function processCommerceReconciliationMessage(options: {
  message: CommerceReconciliationMessage;
  attempts: number;
  store: CommerceReconciliationStore;
  provider: CommerceSnapshotProvider;
  maxAttempts?: number;
  leaseMs?: number;
  now?: () => number;
  createLeaseToken?: () => string;
  terminalEventHandler?: CommerceTerminalEventHandler;
  afterCommit?: (snapshot: CommerceSellerSnapshot) => Promise<void>;
}): Promise<"processed" | "stale" | "leased" | "complete" | "retry" | "quarantined"> {
  const now = options.now ?? Date.now;
  const leaseToken = options.createLeaseToken?.() ?? crypto.randomUUID();
  const claim = await options.store.claim({
    message: options.message,
    leaseToken,
    nowMs: now(),
    leaseMs: options.leaseMs ?? 60_000,
  });
  if (claim !== "claimed") return claim === "missing" ? "retry" : claim;

  const trigger = await options.store.readTrigger(options.message);
  if (!trigger) {
    await options.store.quarantine({
      message: options.message,
      leaseToken,
      reasonCode: "reconciliation_trigger_missing",
      nowMs: now(),
    });
    return "quarantined";
  }

  try {
    const snapshot = isCommerceTerminalEvent(trigger.eventType)
      ? await options.terminalEventHandler?.({
          message: options.message,
          trigger,
          actionId: terminalEventActionId(options.message),
        })
      : await options.provider.readSellerSnapshot({
          connectedAccountId: options.message.connectedAccountId,
          trigger,
        });
    if (!snapshot) throw new CommerceProjectionQuarantineError("terminal_event_handler_missing");
    validateSnapshot(options.message.connectedAccountId, snapshot);
    const committed = await options.store.commit({
      message: options.message,
      leaseToken,
      snapshot,
      nowMs: now(),
    });
    if (!committed) return "stale";
    await options.afterCommit?.(snapshot);
    return "processed";
  } catch (error) {
    if (error instanceof CommerceProjectionQuarantineError) {
      await options.store.quarantine({
        message: options.message,
        leaseToken,
        reasonCode: error.reasonCode,
        nowMs: now(),
      });
      return "quarantined";
    }
    const maxAttempts = options.maxAttempts ?? 5;
    if (options.attempts >= maxAttempts) {
      await options.store.quarantine({
        message: options.message,
        leaseToken,
        reasonCode: "provider_refresh_exhausted",
        nowMs: now(),
      });
      return "quarantined";
    }
    await options.store.fail({
      message: options.message,
      leaseToken,
      reasonCode: "provider_refresh_failed",
      nowMs: now(),
    });
    return "retry";
  }
}

function isCommerceTerminalEvent(eventType: string): boolean {
  return eventType === "account.application.deauthorized" || eventType === "account.closed";
}

function terminalEventActionId(message: CommerceReconciliationMessage): string {
  return `commerce:stripe-terminal:${message.connectedAccountId}:${message.eventId}`;
}

export async function sweepCommerceSyncOutbox(options: {
  store: CommerceReconciliationStore;
  queue: CommerceReconciliationQueue;
  now?: () => number;
}): Promise<number> {
  const now = options.now ?? Date.now;
  const pending = await options.store.listPendingOutbox();
  for (const message of pending) {
    await options.queue.send(message);
    await options.store.markOutboxSent(message, now());
  }
  return pending.length;
}

export async function requestCommerceRefresh(options: {
  connectedAccountId: string;
  source: Exclude<CommerceReconciliationSource, "webhook">;
  correlationId: string;
  store: CommerceReconciliationStore;
  queue: CommerceReconciliationQueue;
  now?: () => number;
}): Promise<CommerceReconciliationMessage> {
  const now = options.now ?? Date.now;
  const request = await options.store.requestRefresh({
    connectedAccountId: options.connectedAccountId,
    source: options.source,
    correlationId: options.correlationId,
    requestedAtMs: now(),
  });
  if (request.outboxPending) {
    try {
      await options.queue.send(request.message);
      await options.store.markOutboxSent(request.message, now());
    } catch {
      // The scheduled outbox sweep closes the commit-success/Queue-send gap.
    }
  }
  return request.message;
}

export async function scheduleCommerceReconciliation(options: {
  store: CommerceReconciliationStore;
  queue: CommerceReconciliationQueue;
  scheduleId: string;
  limit?: number;
  now?: () => number;
}): Promise<number> {
  const accountIds = await options.store.listScheduledSellerAccounts(options.limit);
  for (const connectedAccountId of accountIds) {
    await requestCommerceRefresh({
      connectedAccountId,
      source: "scheduled",
      correlationId: `${options.scheduleId}:${connectedAccountId}`,
      store: options.store,
      queue: options.queue,
      now: options.now,
    });
  }
  return accountIds.length;
}

function validateSnapshot(connectedAccountId: string, snapshot: CommerceSellerSnapshot): void {
  if (
    snapshot.connectedAccount.id !== connectedAccountId ||
    snapshot.connectedAccount.stripeAccountId !== connectedAccountId
  ) {
    throw new CommerceProjectionQuarantineError("connected_account_scope_mismatch");
  }
  const sellerRows = [
    ...snapshot.customers,
    ...snapshot.subscriptions,
    ...snapshot.payments,
    ...snapshot.refunds,
    ...snapshot.disputes,
    ...snapshot.entitlements,
    ...(snapshot.supportPayments ?? []),
    ...(snapshot.supportRefunds ?? []),
  ];
  if (sellerRows.some((row) => row.connectedAccountId !== connectedAccountId)) {
    throw new CommerceProjectionQuarantineError("seller_scoped_object_mismatch");
  }
  if (
    snapshot.roleAssignments.some(
      (assignment) => assignment.guildId !== snapshot.connectedAccount.guildId,
    )
  ) {
    throw new CommerceProjectionQuarantineError("role_assignment_guild_mismatch");
  }
}
