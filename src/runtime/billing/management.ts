import type { BillingCatalogEntry, BillingSubscriptionProjection } from "./types";

export interface BillingManagementProvider {
  createPortal(input: {
    customerId: string;
    returnUrl: string;
    idempotencyKey: string;
  }): Promise<{ url: string }>;
  updatePrice(input: {
    subscriptionId: string;
    priceId: string;
    idempotencyKey: string;
    proration: "always_invoice";
    pendingIfIncomplete: true;
  }): Promise<void>;
  schedulePrice(input: {
    subscriptionId: string;
    currentPriceId: string;
    nextPriceId: string;
    currentPeriodEndMs: number;
    idempotencyKey: string;
  }): Promise<void>;
  setCancelAtPeriodEnd(input: {
    subscriptionId: string;
    cancelAtPeriodEnd: boolean;
    idempotencyKey: string;
  }): Promise<void>;
}

export interface BillingManagementStore {
  readProjection(ownerId: string): Promise<BillingSubscriptionProjection | null>;
  countAssignments(ownerId: string): Promise<number>;
  hasWhiteLabelObligation(ownerId: string): Promise<boolean>;
}

export function createBillingManagementService(options: {
  provider: BillingManagementProvider;
  store: BillingManagementStore;
  catalog: ReadonlyMap<string, BillingCatalogEntry>;
  publicBaseUrl: string;
  syncOwner(input: {
    ownerId: string;
    source: "operator";
    correlationId: string;
  }): Promise<BillingSubscriptionProjection>;
}) {
  async function current(ownerId: string, allowGrace = false) {
    const projection = await options.store.readProjection(ownerId);
    if (!projection?.subscriptionId || !projection.priceId)
      throw new ManagementError("usable_subscription_required", 409);
    if (projection.quarantineReason) throw new ManagementError("billing_quarantined", 409);
    if (!allowGrace && (projection.status === "past_due" || projection.status === "unpaid"))
      throw new ManagementError("billing_in_grace", 409);
    return projection;
  }
  return {
    async createPortal(ownerId: string, intentId: string) {
      const projection = await current(ownerId, true);
      return options.provider.createPortal({
        customerId: projection.customerId,
        returnUrl: `${options.publicBaseUrl}/admin/billing`,
        idempotencyKey: key("portal", ownerId, intentId),
      });
    },
    async changePrice(ownerId: string, targetPriceId: string, intentId: string) {
      const projection = await current(ownerId);
      const source = options.catalog.get(projection.priceId!);
      const target = options.catalog.get(targetPriceId);
      if (!source || !target || target.legacy) {
        throw new ManagementError("unsupported_price", 400);
      }
      if (source.plan === "premium_plus" && target.plan === "premium") {
        if (
          (await options.store.countAssignments(ownerId)) > 1 ||
          (await options.store.hasWhiteLabelObligation(ownerId))
        ) {
          throw new ManagementError("downgrade_obligations_unresolved", 409);
        }
        if (!projection.currentPeriodEndMs) throw new ManagementError("renewal_date_missing", 409);
        const portal = await options.provider.createPortal({
          customerId: projection.customerId,
          returnUrl: `${options.publicBaseUrl}/admin/billing?change=scheduled`,
          idempotencyKey: key("change-portal", ownerId, intentId),
        });
        await options.provider.schedulePrice({
          subscriptionId: projection.subscriptionId!,
          currentPriceId: source.priceId,
          nextPriceId: target.priceId,
          currentPeriodEndMs: projection.currentPeriodEndMs,
          idempotencyKey: key("schedule-price", ownerId, intentId),
        });
        await options.syncOwner({
          ownerId,
          source: "operator",
          correlationId: intentId,
        });
        return {
          effective: "renewal" as const,
          effectiveAtMs: projection.currentPeriodEndMs,
          url: portal.url,
        };
      }
      const portal = await options.provider.createPortal({
        customerId: projection.customerId,
        returnUrl: `${options.publicBaseUrl}/admin/billing?change=complete`,
        idempotencyKey: key("change-portal", ownerId, intentId),
      });
      await options.provider.updatePrice({
        subscriptionId: projection.subscriptionId!,
        priceId: target.priceId,
        idempotencyKey: key("update-price", ownerId, intentId),
        proration: "always_invoice",
        pendingIfIncomplete: true,
      });
      await options.syncOwner({
        ownerId,
        source: "operator",
        correlationId: intentId,
      });
      return {
        effective: "immediate" as const,
        chargeImpact: "prorated" as const,
        url: portal.url,
      };
    },
    async setCancellation(ownerId: string, cancelAtPeriodEnd: boolean, intentId: string) {
      const projection = await current(ownerId, true);
      await options.provider.setCancelAtPeriodEnd({
        subscriptionId: projection.subscriptionId!,
        cancelAtPeriodEnd,
        idempotencyKey: key(cancelAtPeriodEnd ? "cancel" : "reverse-cancel", ownerId, intentId),
      });
      return options.syncOwner({
        ownerId,
        source: "operator",
        correlationId: intentId,
      });
    },
  };
}

function key(kind: string, ownerId: string, intentId: string): string {
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(intentId)) throw new ManagementError("invalid_intent", 400);
  return `${kind}:${ownerId}:${intentId}`;
}

export class ManagementError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
