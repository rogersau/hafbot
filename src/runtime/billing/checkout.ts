import type { BillingCatalogEntry, BillingSubscriptionProjection } from "./types";

export interface BillingCheckoutProvider {
  createCustomer(input: {
    ownerId: string;
    email: string | null;
    idempotencyKey: string;
  }): Promise<string>;
  createCheckout(input: {
    customerId: string;
    priceId: string;
    ownerId: string;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
  }): Promise<{ id: string; url: string }>;
}

export interface BillingCheckoutStore {
  readCustomerId(ownerId: string): Promise<string | null>;
  bindCustomer(ownerId: string, customerId: string, nowMs: number): Promise<void>;
  readProjection(ownerId: string): Promise<BillingSubscriptionProjection | null>;
  countFounderPlaces(): Promise<number>;
}

export interface BillingCheckoutService {
  listCatalog(ownerId?: string): Promise<BillingCatalogEntry[]>;
  readSummary(ownerId: string): Promise<BillingSubscriptionProjection | null>;
  startCheckout(input: {
    ownerId: string;
    email: string | null;
    priceId: string;
    intentId: string;
  }): Promise<{ checkoutSessionId: string; url: string }>;
  requestSync(ownerId: string, correlationId: string): Promise<BillingSubscriptionProjection>;
}

export function createBillingCheckoutService(options: {
  provider: BillingCheckoutProvider;
  store: BillingCheckoutStore;
  catalog: ReadonlyMap<string, BillingCatalogEntry>;
  publicBaseUrl: string;
  syncOwner(input: {
    ownerId: string;
    source: "checkout";
    correlationId: string;
  }): Promise<BillingSubscriptionProjection>;
  now?: () => number;
}): BillingCheckoutService {
  const now = options.now ?? Date.now;
  return {
    listCatalog: async () => [...options.catalog.values()].filter((entry) => entry.legacy !== true),
    readSummary: (ownerId) => options.store.readProjection(ownerId),
    async startCheckout(input) {
      const catalogEntry = options.catalog.get(input.priceId);
      if (!catalogEntry || catalogEntry.legacy) {
        throw new BillingCheckoutError("unsupported_price", 400);
      }
      if (!/^[A-Za-z0-9_-]{8,100}$/.test(input.intentId)) {
        throw new BillingCheckoutError("invalid_intent", 400);
      }
      const current = await options.store.readProjection(input.ownerId);
      if (current?.quarantineReason) throw new BillingCheckoutError("billing_quarantined", 409);
      if (
        current?.subscriptionId &&
        current.status !== "missing" &&
        current.status !== "cancelled"
      ) {
        throw new BillingCheckoutError("subscription_already_exists", 409);
      }
      let customerId = await options.store.readCustomerId(input.ownerId);
      if (!customerId) {
        customerId = await options.provider.createCustomer({
          ownerId: input.ownerId,
          email: input.email,
          idempotencyKey: `customer:${input.ownerId}`,
        });
        await options.store.bindCustomer(input.ownerId, customerId, now());
      }
      const session = await options.provider.createCheckout({
        customerId,
        priceId: catalogEntry.priceId,
        ownerId: input.ownerId,
        successUrl: `${options.publicBaseUrl}/admin/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${options.publicBaseUrl}/admin/billing?checkout=cancelled`,
        idempotencyKey: `checkout:${input.ownerId}:${input.intentId}`,
      });
      return { checkoutSessionId: session.id, url: session.url };
    },
    requestSync: (ownerId, correlationId) =>
      options.syncOwner({ ownerId, source: "checkout", correlationId }),
  };
}

export class BillingCheckoutError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
