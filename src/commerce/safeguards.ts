import type { CommercePurchasePolicy, CommerceStorefront } from "./buyer-checkout";
import type { CommerceSupportPage, CommerceSupportPolicy } from "./support-payments";
import type { CommerceCurrency } from "./types";

export const COMMERCE_PILOT_LIMITS = {
  activeSubscribers: 100,
  activeOfferings: 5,
  monthlyGrossMinor: 500_000,
  supportPaymentMinor: 50_000,
  alertThresholds: [70, 90, 100] as const,
};

export type CommerceControlType =
  | "commerce_kill"
  | "new_checkout"
  | "sales_suspension"
  | "offering_suspension"
  | "renewal_shutdown"
  | "support_shutdown"
  | "webhook_quarantine";

export type CommerceControlScope = "global" | "guild" | "seller" | "offering";

export interface CommerceOperationalControl {
  id: string;
  scopeType: CommerceControlScope;
  scopeId: string;
  controlType: CommerceControlType;
  enabled: boolean;
  reasonCode: string | null;
  actorUserId: string;
  expiresAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CommerceControlEffects {
  newPurchases: boolean;
  existingRenewals: boolean;
  supportPayments: boolean;
  webhookIngestion: boolean;
  customerPortal: false;
  reconciliation: false;
  roleDelivery: false;
  refunds: false;
  sellerDashboard: false;
}

export const COMMERCE_CONTROL_EFFECTS: Record<CommerceControlType, CommerceControlEffects> = {
  commerce_kill: effects({ newPurchases: true, existingRenewals: true, supportPayments: true }),
  new_checkout: effects({ newPurchases: true }),
  sales_suspension: effects({ newPurchases: true, supportPayments: true }),
  offering_suspension: effects({ newPurchases: true }),
  renewal_shutdown: effects({ newPurchases: true, existingRenewals: true }),
  support_shutdown: effects({ supportPayments: true }),
  webhook_quarantine: effects({ webhookIngestion: true }),
};

export interface CommerceSafeguardUsage {
  activeSubscribers: number;
  activeOfferings: number;
  monthlyGrossMinor: Record<CommerceCurrency, number>;
  checkoutCounts: { open: number; succeeded: number; failed: number };
  webhookCounts: { accepted: number; duplicate: number; quarantined: number };
  reconciliation: { staleCount: number; failedCount: number };
  roles: { pending: number; failed: number; deadLetter: number };
  subscriptions: { active: number; pastDue: number; grace: number; disputed: number };
  refunds: { count: number; amountMinor: Record<CommerceCurrency, number> };
  disputes: { open: number; amountMinor: Record<CommerceCurrency, number> };
  feesMinor: Record<CommerceCurrency, number>;
  restrictedSeller: boolean;
  oldestRepairAgeMs: number | null;
}

export interface CommerceSafeguardDashboard {
  connectedAccountId: string;
  guildId: string;
  controls: CommerceOperationalControl[];
  usage: CommerceSafeguardUsage;
  limits: typeof COMMERCE_PILOT_LIMITS;
  blockReasons: string[];
}

export interface CommerceCapacityInput {
  id: string;
  checkoutKind: "subscription" | "support";
  connectedAccountId: string;
  guildId: string;
  offeringId: string | null;
  currency: CommerceCurrency;
  amountMinor: number;
  expiresAtMs: number;
  nowMs: number;
}

export interface CommerceSafeguardStore {
  claimCapacity(input: CommerceCapacityInput): Promise<boolean>;
  releaseCapacity(id: string): Promise<void>;
  refreshLimitAlerts(connectedAccountId: string, guildId: string, nowMs: number): Promise<void>;
  saveControl(control: CommerceOperationalControl): Promise<void>;
  readDashboard(guildId: string, nowMs: number): Promise<CommerceSafeguardDashboard | null>;
}

export class CommerceSafeguardsService implements CommercePurchasePolicy, CommerceSupportPolicy {
  constructor(
    private readonly store: CommerceSafeguardStore,
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {}

  async assertPurchaseAllowed(): Promise<void> {
    // The authoritative decision is the atomic claim immediately before Stripe Checkout creation.
  }

  async isStorefrontPurchaseAllowed(storefront: CommerceStorefront): Promise<boolean> {
    const dashboard = await this.readDashboard(storefront.offering.guildId);
    return !isCommerceNewPurchaseBlocked(dashboard, storefront.offering.id);
  }

  async claimPurchase(input: {
    storefront: CommerceStorefront;
    checkoutAttemptId: string;
    expiresAtMs: number;
  }): Promise<void> {
    await this.claim({
      id: input.checkoutAttemptId,
      checkoutKind: "subscription",
      connectedAccountId: input.storefront.account.id,
      guildId: input.storefront.offering.guildId,
      offeringId: input.storefront.offering.id,
      currency: input.storefront.price.currency,
      amountMinor: input.storefront.price.unitAmountMinor,
      expiresAtMs: input.expiresAtMs,
    });
  }

  async releasePurchase(checkoutAttemptId: string): Promise<void> {
    await this.store.releaseCapacity(checkoutAttemptId);
  }

  async claimSupport(input: {
    page: CommerceSupportPage;
    checkoutAttemptId: string;
    amountMinor: number;
    expiresAtMs: number;
  }): Promise<void> {
    await this.claim({
      id: input.checkoutAttemptId,
      checkoutKind: "support",
      connectedAccountId: input.page.context.account.id,
      guildId: input.page.config.guildId,
      offeringId: null,
      currency: input.page.config.currency,
      amountMinor: input.amountMinor,
      expiresAtMs: input.expiresAtMs,
    });
  }

  async releaseSupport(checkoutAttemptId: string): Promise<void> {
    await this.store.releaseCapacity(checkoutAttemptId);
  }

  readDashboard(guildId: string): Promise<CommerceSafeguardDashboard | null> {
    return this.store.readDashboard(guildId, this.now());
  }

  async setControl(input: {
    scopeType: CommerceControlScope;
    scopeId: string;
    controlType: CommerceControlType;
    enabled: boolean;
    reasonCode: string;
    actorUserId: string;
    expiresAtMs?: number | null;
  }): Promise<CommerceOperationalControl> {
    assertControlScope(input);
    if (!/^[a-z0-9][a-z0-9_-]{2,79}$/.test(input.reasonCode)) {
      throw new Error("commerce_control_reason_invalid");
    }
    const nowMs = this.now();
    if (
      input.expiresAtMs != null &&
      (!Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs <= nowMs)
    ) {
      throw new Error("commerce_control_expiry_invalid");
    }
    const control: CommerceOperationalControl = {
      id: this.createId(),
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      controlType: input.controlType,
      enabled: input.enabled,
      reasonCode: input.reasonCode,
      actorUserId: input.actorUserId,
      expiresAtMs: input.expiresAtMs ?? null,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    await this.store.saveControl(control);
    return control;
  }

  private async claim(input: Omit<CommerceCapacityInput, "nowMs">): Promise<void> {
    const nowMs = this.now();
    const claimed = await this.store.claimCapacity({ ...input, nowMs });
    await this.store.refreshLimitAlerts(input.connectedAccountId, input.guildId, nowMs);
    if (!claimed) throw new Error("commerce_purchase_safeguard_blocked");
  }
}

export function isCommerceNewPurchaseBlocked(
  dashboard: CommerceSafeguardDashboard | null | undefined,
  offeringId: string,
): boolean {
  if (!dashboard) return false;
  if (dashboard.blockReasons.some((reason) => reason.startsWith("limit:"))) return true;
  return dashboard.controls.some((control) => {
    if (!control.enabled || !COMMERCE_CONTROL_EFFECTS[control.controlType].newPurchases)
      return false;
    return control.scopeType !== "offering" || control.scopeId === offeringId;
  });
}

function effects(
  overrides: Partial<
    Pick<
      CommerceControlEffects,
      "newPurchases" | "existingRenewals" | "supportPayments" | "webhookIngestion"
    >
  >,
): CommerceControlEffects {
  return {
    newPurchases: false,
    existingRenewals: false,
    supportPayments: false,
    webhookIngestion: false,
    customerPortal: false,
    reconciliation: false,
    roleDelivery: false,
    refunds: false,
    sellerDashboard: false,
    ...overrides,
  };
}

function assertControlScope(input: {
  scopeType: CommerceControlScope;
  scopeId: string;
  controlType: CommerceControlType;
}): void {
  if (input.scopeType === "global" && input.scopeId !== "commerce") {
    throw new Error("commerce_control_scope_invalid");
  }
  if (input.controlType === "offering_suspension" && input.scopeType !== "offering") {
    throw new Error("commerce_control_scope_invalid");
  }
  if (
    !/^[A-Za-z0-9:_-]{1,100}$/.test(input.scopeId) ||
    (input.scopeType === "offering" && input.controlType !== "offering_suspension")
  ) {
    throw new Error("commerce_control_scope_invalid");
  }
}
