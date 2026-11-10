import { SafeDiagnosticError } from "../../observability/safe-diagnostic-error";
import type {
  BillingAuditIdentity,
  BillingCatalogEntry,
  BillingLedgerOperation,
  BillingSubscriptionProjection,
  StripeOwnerState,
  StripeSubscriptionState,
} from "./types";

export interface StripeOwnerStateReader {
  readOwnerState(customerId: string): Promise<StripeOwnerState>;
}

export interface BillingSyncStore {
  readCustomerId(ownerId: string): Promise<string | null>;
  bindCustomer(ownerId: string, customerId: string, nowMs: number): Promise<void>;
  readProjection(ownerId: string): Promise<BillingSubscriptionProjection | null>;
  acquireOwnerSync(ownerId: string, nowMs: number, leaseMs: number): Promise<number | null>;
  releaseOwnerSync(ownerId: string, generation: number, nowMs: number): Promise<void>;
  commitOwnerSync(input: {
    ownerId: string;
    generation: number;
    projection: BillingSubscriptionProjection;
    operation: BillingLedgerOperation | null;
  }): Promise<boolean>;
}

export interface SyncBillingOwnerInput {
  ownerId: string;
  customerId?: string;
  source: BillingLedgerOperation["source"];
  correlationId?: string | null;
}

export class BillingOwnerSyncBusyError extends SafeDiagnosticError {
  constructor(readonly projectionObservedAtMs: number | null) {
    super("A Billing sync is already active for this Plan Owner.");
  }
}

// Allow short overlaps; contention without a fresh projection still needs attention.
const MAX_DEFERRED_PROJECTION_AGE_MS = 15 * 60_000;

export async function reconcileAllBillingOwners(options: {
  listOwnerIds(): Promise<string[]>;
  syncOwner(input: SyncBillingOwnerInput): Promise<BillingSubscriptionProjection>;
  now?: () => number;
}): Promise<number> {
  const ownerIds = await options.listOwnerIds();
  const failures: Array<{ ownerId: string; error: Error }> = [];
  let completed = 0;
  for (const ownerId of ownerIds) {
    try {
      await options.syncOwner({ ownerId, source: "scheduled", correlationId: null });
      completed += 1;
    } catch (cause) {
      if (cause instanceof BillingOwnerSyncBusyError && cause.projectionObservedAtMs !== null) {
        const projectionAgeMs = (options.now ?? Date.now)() - cause.projectionObservedAtMs;
        if (projectionAgeMs >= 0 && projectionAgeMs < MAX_DEFERRED_PROJECTION_AGE_MS) {
          // The active sync owns this refresh; the next five-minute sweep retries it.
          try {
            console.info({
              event: "haf.metric",
              metric: "billing_owner_reconciliation",
              outcome: "deferred",
              reason: "owner_sync_busy",
              projectionAgeMs,
            });
          } catch {
            // Telemetry must not turn normal contention into a failed task.
          }
          continue;
        }
      }
      failures.push({
        ownerId,
        error: new SafeDiagnosticError(`Plan Owner ${ownerId} reconciliation failed.`, { cause }),
      });
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.error),
      `Billing reconciliation failed for ${failures.length} Plan Owner(s): ${failures
        .map((failure) => failure.ownerId)
        .join(", ")}`,
    );
  }
  return completed;
}

export function createBillingOwnerSync(options: {
  stripe: StripeOwnerStateReader;
  store: BillingSyncStore;
  catalog: ReadonlyMap<string, BillingCatalogEntry>;
  now?: () => number;
  leaseMs?: number;
  createId?: () => string;
  resolveOwnerIdentity?(ownerId: string): Promise<BillingAuditIdentity | null>;
  billingUrl?: string;
}) {
  const now = options.now ?? Date.now;
  const leaseMs = options.leaseMs ?? 60_000;
  const createId = options.createId ?? (() => crypto.randomUUID());

  return async (input: SyncBillingOwnerInput): Promise<BillingSubscriptionProjection> => {
    const startedAtMs = now();
    const boundCustomerId = await options.store.readCustomerId(input.ownerId);
    const customerId = input.customerId ?? boundCustomerId;
    if (!customerId) throw new SafeDiagnosticError("Plan Owner has no Stripe Customer binding.");
    if (boundCustomerId && boundCustomerId !== customerId) {
      throw new SafeDiagnosticError("Plan Owner is already bound to a different Stripe Customer.");
    }
    if (!boundCustomerId) {
      await options.store.bindCustomer(input.ownerId, customerId, startedAtMs);
    }

    const generation = await options.store.acquireOwnerSync(input.ownerId, startedAtMs, leaseMs);
    if (generation === null) {
      const previous = await options.store.readProjection(input.ownerId);
      throw new BillingOwnerSyncBusyError(previous?.observedAtMs ?? null);
    }

    try {
      const previous = await options.store.readProjection(input.ownerId);
      const observed = await options.stripe.readOwnerState(customerId);
      if (observed.customer.id !== customerId) {
        throw new SafeDiagnosticError("Stripe returned state for a different Customer.");
      }
      const projection = projectOwnerState(input.ownerId, observed, options.catalog, previous);
      const changed = lifecycleChanged(previous, projection);
      const ownerIdentity = changed
        ? ((await options.resolveOwnerIdentity?.(input.ownerId)) ?? null)
        : null;
      const committed = await options.store.commitOwnerSync({
        ownerId: input.ownerId,
        generation,
        projection,
        operation: changed
          ? {
              id: createId(),
              ownerId: input.ownerId,
              kind: lifecycleKind(previous, projection),
              source: input.source,
              correlationId: input.correlationId ?? null,
              summaryJson: JSON.stringify(
                ownerEventSummary(previous, projection, ownerIdentity, options.billingUrl),
              ),
              createdAtMs: now(),
            }
          : null,
      });
      if (!committed)
        throw new SafeDiagnosticError("Billing sync result was stale and was not committed.");
      return projection;
    } catch (cause) {
      try {
        await options.store.releaseOwnerSync(input.ownerId, generation, now());
      } catch (releaseCause) {
        throw new AggregateError(
          [cause, releaseCause],
          "Billing sync failed and its lease could not be released.",
        );
      }
      throw cause;
    }
  };
}

function lifecycleChanged(
  previous: BillingSubscriptionProjection | null,
  next: BillingSubscriptionProjection,
): boolean {
  if (!previous) return next.status !== "missing";
  return lifecycleFingerprint(previous) !== lifecycleFingerprint(next);
}

function lifecycleFingerprint(value: BillingSubscriptionProjection): string {
  return JSON.stringify({
    subscriptionId: value.subscriptionId,
    priceId: value.priceId,
    plan: value.plan,
    frequency: value.frequency,
    status: value.status,
    currentPeriodEndMs: value.currentPeriodEndMs,
    cancelAtPeriodEnd: value.cancelAtPeriodEnd,
    cancelledAtMs: value.cancelledAtMs,
    scheduleId: value.scheduleId,
    quarantineReason: value.quarantineReason,
    pricingCohort: value.pricingCohort,
    founderAwardedAtMs: value.founderAwardedAtMs,
  });
}

function lifecycleKind(
  previous: BillingSubscriptionProjection | null,
  next: BillingSubscriptionProjection,
): string {
  if (!previous?.subscriptionId && next.subscriptionId) return "subscription_started";
  if (next.status === "past_due" || next.status === "unpaid") return "payment_recovery_required";
  if (previous?.status !== "active" && next.status === "active") return "subscription_recovered";
  if (next.status === "cancelled") return "subscription_cancelled";
  if (next.quarantineReason) return "subscription_quarantined";
  if (previous?.plan !== next.plan || previous?.frequency !== next.frequency)
    return "subscription_plan_changed";
  if (previous?.currentPeriodEndMs !== next.currentPeriodEndMs) return "subscription_renewed";
  return "subscription_changed";
}

function ownerEventSummary(
  previous: BillingSubscriptionProjection | null,
  projection: BillingSubscriptionProjection,
  owner: BillingAuditIdentity | null,
  billingUrl?: string,
) {
  const requiresPayment = projection.status === "past_due" || projection.status === "unpaid";
  return {
    summary: lifecycleKind(previous, projection).replaceAll("_", " "),
    resultingAccess: projection.plan,
    effectiveAtMs:
      projection.cancelAtPeriodEnd && !previous?.cancelAtPeriodEnd
        ? (projection.currentPeriodEndMs ?? projection.observedAtMs)
        : projection.observedAtMs,
    requiredAction: requiresPayment ? "Update payment details" : null,
    billingPath: billingUrl ?? "/admin/billing",
    notifyOwner: true,
    eventType: "subscription",
    plan: projection.plan,
    owner,
    subscriptionStatus: projection.status,
  };
}

export function projectOwnerState(
  ownerId: string,
  state: StripeOwnerState,
  catalog: ReadonlyMap<string, BillingCatalogEntry>,
  previous: BillingSubscriptionProjection | null = null,
): BillingSubscriptionProjection {
  const candidates = state.subscriptions.filter(
    (subscription) => subscription.status !== "canceled",
  );
  if (candidates.length > 1) {
    return quarantinedProjection(ownerId, state, previous, "multiple_non_terminal_subscriptions");
  }
  const subscription = candidates[0] ?? latestCancelled(state.subscriptions);
  if (!subscription) return emptyProjection(ownerId, state, "missing", null);
  const catalogEntry = catalog.get(subscription.priceId);
  if (!catalogEntry || catalogEntry.productId !== subscription.productId) {
    return quarantinedProjection(ownerId, state, previous, "unknown_catalog", subscription);
  }
  if (
    previous?.subscriptionId === subscription.id &&
    previous.pricingCohort &&
    previous.pricingCohort !== catalogEntry.cohort &&
    (catalogEntry.cohort !== "standard" || catalogEntry.legacy === true)
  ) {
    return quarantinedProjection(ownerId, state, previous, "pricing_cohort_mismatch", subscription);
  }
  // Existing founder awards remain historical subscription state. Moving to a
  // current standard offer must not quarantine that same subscription.
  return fromSubscription(
    ownerId,
    state,
    subscription,
    catalogEntry,
    normalizeStatus(subscription.status),
    null,
    previous,
  );
}

function quarantinedProjection(
  ownerId: string,
  state: StripeOwnerState,
  previous: BillingSubscriptionProjection | null,
  reason: string,
  observed?: StripeSubscriptionState,
): BillingSubscriptionProjection {
  if (previous?.subscriptionId && previous.plan !== "free") {
    return {
      ...previous,
      customerId: state.customer.id,
      status: "quarantined",
      observedAtMs: state.observedAtMs,
      quarantineReason: reason,
    };
  }
  return observed
    ? fromSubscription(ownerId, state, observed, null, "quarantined", reason, previous)
    : emptyProjection(ownerId, state, "quarantined", reason);
}

function latestCancelled(
  subscriptions: StripeSubscriptionState[],
): StripeSubscriptionState | undefined {
  return subscriptions
    .filter((subscription) => subscription.status === "canceled")
    .sort((left, right) => (right.cancelledAtMs ?? 0) - (left.cancelledAtMs ?? 0))[0];
}

function emptyProjection(
  ownerId: string,
  state: StripeOwnerState,
  status: BillingSubscriptionProjection["status"],
  quarantineReason: string | null,
): BillingSubscriptionProjection {
  return {
    ownerId,
    customerId: state.customer.id,
    subscriptionId: null,
    priceId: null,
    productId: null,
    plan: "free",
    frequency: null,
    status,
    currentPeriodStartMs: null,
    currentPeriodEndMs: null,
    cancelAtPeriodEnd: false,
    cancelledAtMs: null,
    latestInvoiceId: null,
    scheduleId: null,
    observedAtMs: state.observedAtMs,
    quarantineReason,
    pricingCohort: null,
    founderAwardedAtMs: null,
  };
}

function fromSubscription(
  ownerId: string,
  state: StripeOwnerState,
  subscription: StripeSubscriptionState,
  catalogEntry: BillingCatalogEntry | null,
  status: BillingSubscriptionProjection["status"],
  quarantineReason: string | null,
  previous: BillingSubscriptionProjection | null = null,
): BillingSubscriptionProjection {
  const retainsKnownPlan =
    status !== "incomplete" && status !== "cancelled" && status !== "quarantined";
  const sameSubscription = previous?.subscriptionId === subscription.id;
  const founderAwardedAtMs =
    status === "cancelled"
      ? null
      : sameSubscription && previous?.founderAwardedAtMs
        ? previous.founderAwardedAtMs
        : catalogEntry?.cohort === "founder" &&
            subscription.livemode === true &&
            subscription.latestInvoicePaid === true &&
            subscription.latestInvoiceBillingReason === "subscription_create" &&
            (subscription.latestInvoiceAmountPaid ?? 0) > 0
          ? state.observedAtMs
          : null;
  const pricingCohort =
    status === "cancelled"
      ? null
      : founderAwardedAtMs
        ? "founder"
        : catalogEntry?.cohort === "standard"
          ? "standard"
          : null;
  return {
    ownerId,
    customerId: state.customer.id,
    subscriptionId: subscription.id,
    priceId: subscription.priceId,
    productId: subscription.productId,
    plan: retainsKnownPlan && catalogEntry ? catalogEntry.plan : "free",
    frequency: catalogEntry?.frequency ?? null,
    status,
    currentPeriodStartMs: subscription.currentPeriodStartMs,
    currentPeriodEndMs: subscription.currentPeriodEndMs,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    cancelledAtMs: subscription.cancelledAtMs,
    latestInvoiceId: subscription.latestInvoiceId,
    scheduleId: subscription.scheduleId,
    observedAtMs: state.observedAtMs,
    quarantineReason,
    pricingCohort,
    founderAwardedAtMs,
  };
}

function normalizeStatus(
  status: StripeSubscriptionState["status"],
): BillingSubscriptionProjection["status"] {
  return status === "canceled" ? "cancelled" : status;
}
