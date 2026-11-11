import type {
  CommerceOffering,
  CommerceOfferingLifecycle,
  CommercePrice,
  CommerceRecurringInterval,
} from "./types";

export type { CommerceOfferingLifecycle } from "./types";

export type CommerceOfferingRetirementStatus =
  | "requested"
  | "stopping_sales"
  | "scheduling_cancellations"
  | "waiting_for_period_end"
  | "complete"
  | "failed";

export interface CommerceOfferingRetirementProgress {
  status: CommerceOfferingRetirementStatus;
  activeSubscriptionCount: number;
  scheduledCancellationCount: number;
  failedCancellationCount: number;
  latestPeriodEndMs: number | null;
  completedAtMs: number | null;
}

export interface CommerceOfferingPublishContext {
  premiumActive: boolean;
  sellerEligible: boolean;
  termsAccepted: boolean;
  roleManageable: boolean;
}

export interface CommerceOfferingStore {
  createOffering(offering: CommerceOffering): Promise<void>;
  readOffering(offeringId: string): Promise<CommerceOffering | null>;
  listOfferings(connectedAccountId: string): Promise<CommerceOffering[]>;
  createPrice(price: CommercePrice): Promise<boolean>;
  listPrices(offeringId: string): Promise<CommercePrice[]>;
  readPublishContext(
    connectedAccountId: string,
    guildId: string,
    offeringId: string,
  ): Promise<CommerceOfferingPublishContext>;
  /** Published subscriptions retain their publication slot while a role repair is pending. */
  countPublishedSubscriptions(guildId: string): Promise<number>;
  hasPublishedRoleMapping(
    guildId: string,
    discordRoleId: string,
    excludingOfferingId: string,
  ): Promise<boolean>;
  beginRoleReplacement(input: {
    offering: CommerceOffering;
    replacementRoleId: string;
    nowMs: number;
  }): Promise<"updated" | "replacement_pending">;
  beginRetirement(input: {
    offering: CommerceOffering;
    actorUserId: string;
    reasonCode: string;
    actionId: string;
    retireAtMs: number;
    nowMs: number;
  }): Promise<void>;
  archiveOffering(offeringId: string, nowMs: number): Promise<boolean>;
  readDashboard(connectedAccountId: string): Promise<CommerceOfferingDashboard>;
}

export interface CommerceOfferingProvider {
  createProduct(input: {
    connectedAccountId: string;
    name: string;
    description: string | null;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<{ id: string; createdAtMs: number | null }>;
  createPrice(input: {
    connectedAccountId: string;
    productId: string;
    currency: "AUD" | "USD";
    unitAmountMinor: number;
    recurringInterval: CommerceRecurringInterval;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<{ id: string; createdAtMs: number | null }>;
  retirePrice?(input: {
    connectedAccountId: string;
    priceId: string;
    idempotencyKey: string;
  }): Promise<void>;
}

export interface CreateCommerceOfferingInput {
  connectedAccountId: string;
  guildId: string;
  discordRoleId: string;
  name: string;
  description?: string | null;
  includedBenefits: string[];
  supportContact: string;
  currency: "AUD" | "USD";
  unitAmountMinor: number;
  recurringInterval: CommerceRecurringInterval;
  roleManageable: boolean;
  termsVersion?: string | null;
}

export interface RetireCommerceOfferingInput {
  offeringId: string;
  actorUserId: string;
  reasonCode: string;
  actionId: string;
  retireAtMs?: number;
}

export interface CommerceOfferingDashboard {
  seller: {
    connectedAccountId: string;
    status: string | null;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    detailsSubmitted: boolean;
  } | null;
  offerings: Array<{
    offering: CommerceOffering;
    subscribers: {
      active: number;
      canceling: number;
      pastDue: number;
      grace: number;
      disputed: number;
    };
    grossByCurrency: Record<"AUD" | "USD", number>;
    refundsByCurrency: Record<"AUD" | "USD", number>;
    disputesByCurrency: Record<"AUD" | "USD", number>;
    estimatedProceedsByCurrency: Record<"AUD" | "USD", number>;
    activePrices: CommercePrice[];
    upcomingCancellations: number;
    roleFailures: number;
    reconciliationIncidents: number;
    retirement: CommerceOfferingRetirementProgress | null;
  }>;
  /** Estimates only; Stripe Dashboard is authoritative for proceeds/payouts. */
  estimatedProceedsAreNonAuthoritative: true;
}

export class CommerceOfferingService {
  constructor(
    private readonly store: CommerceOfferingStore,
    private readonly provider: CommerceOfferingProvider,
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = () => crypto.randomUUID(),
    private readonly onOfferingChanged?: (guildId: string) => Promise<void>,
    private readonly assertFulfillmentPublication?: (offeringId: string) => Promise<void>,
  ) {}

  async createDraft(input: CreateCommerceOfferingInput): Promise<{
    offering: CommerceOffering;
    price: CommercePrice;
  }> {
    validateInput(input);
    const id = this.createId();
    const now = this.now();
    validateBenefits(input.includedBenefits);
    const supportContact = validateSupportContact(input.supportContact);
    const product = await this.provider.createProduct({
      connectedAccountId: input.connectedAccountId,
      name: input.name.trim(),
      description: normalizeDescription(input.description),
      metadata: metadataFor(input.connectedAccountId, input.guildId, id),
      idempotencyKey: `commerce:offering:${id}:product`,
    });
    const stripePrice = await this.provider.createPrice({
      connectedAccountId: input.connectedAccountId,
      productId: product.id,
      currency: input.currency,
      unitAmountMinor: input.unitAmountMinor,
      recurringInterval: input.recurringInterval,
      metadata: metadataFor(input.connectedAccountId, input.guildId, id),
      idempotencyKey: `commerce:offering:${id}:price:1`,
    });
    const offering: CommerceOffering = {
      id,
      connectedAccountId: input.connectedAccountId,
      guildId: input.guildId,
      discordRoleId: input.discordRoleId,
      name: input.name.trim(),
      description: normalizeDescription(input.description),
      purchaseType: "subscription",
      state: "draft",
      termsVersion: input.termsVersion ?? null,
      includedBenefits: input.includedBenefits,
      supportContact,
      roleManageable: input.roleManageable,
      repairDeadlineAtMs: null,
      repairPreviousState: null,
      retireAtMs: null,
      publishedAtMs: null,
      archivedAtMs: null,
      createdAtMs: now,
      updatedAtMs: now,
    };
    const price: CommercePrice = {
      id: this.createId(),
      connectedAccountId: input.connectedAccountId,
      offeringId: id,
      stripeProductId: product.id,
      stripePriceId: stripePrice.id,
      currency: input.currency,
      unitAmountMinor: input.unitAmountMinor,
      priceType: "recurring",
      recurringInterval: input.recurringInterval,
      status: "active",
      providerCreatedAtMs: stripePrice.createdAtMs,
      retiredAtMs: null,
      createdAtMs: now,
    };
    await this.store.createOffering(offering);
    if (!(await this.store.createPrice(price))) throw new Error("commerce_price_already_exists");
    return { offering, price };
  }

  async updateDraft(input: {
    offeringId: string;
    name?: string;
    description?: string | null;
    discordRoleId?: string;
    roleManageable?: boolean;
    termsVersion?: string | null;
    includedBenefits?: string[];
    supportContact?: string;
  }): Promise<{ offering: CommerceOffering }> {
    const current = await this.requireOffering(input.offeringId);
    if (!["draft", "unpublished", "repair_required"].includes(current.state)) {
      throw new Error("commerce_offering_edit_requires_unpublished");
    }
    if (
      input.discordRoleId !== undefined &&
      input.discordRoleId !== current.discordRoleId &&
      current.state !== "draft"
    ) {
      throw new Error("commerce_offering_role_replacement_required");
    }
    const now = this.now();
    if (input.includedBenefits) validateBenefits(input.includedBenefits);
    if (input.supportContact !== undefined) validateSupportContact(input.supportContact);
    const offering: CommerceOffering = {
      ...current,
      name: input.name === undefined ? current.name : requiredName(input.name),
      description:
        input.description === undefined
          ? current.description
          : normalizeDescription(input.description),
      discordRoleId: input.discordRoleId ?? current.discordRoleId,
      roleManageable: input.roleManageable ?? current.roleManageable,
      termsVersion: input.termsVersion === undefined ? current.termsVersion : input.termsVersion,
      includedBenefits: input.includedBenefits ?? current.includedBenefits,
      supportContact:
        input.supportContact === undefined ? current.supportContact : input.supportContact.trim(),
      updatedAtMs: now,
    };
    await this.store.createOffering(offering);
    if (current.state === "repair_required") {
      await this.onOfferingChanged?.(current.guildId);
    }
    return { offering };
  }

  async publish(offeringId: string): Promise<CommerceOffering> {
    await this.assertFulfillmentPublication?.(offeringId);
    const offering = await this.requireOffering(offeringId);
    if (!["draft", "unpublished"].includes(offering.state)) {
      throw new Error("commerce_offering_publish_invalid_state");
    }
    const context = await this.store.readPublishContext(
      offering.connectedAccountId,
      offering.guildId,
      offering.id,
    );
    if (!context.premiumActive) throw new Error("commerce_offering_premium_required");
    if (!context.sellerEligible) throw new Error("commerce_offering_seller_ineligible");
    if (!context.termsAccepted) throw new Error("commerce_offering_terms_required");
    if (!(context.roleManageable && offering.roleManageable)) {
      throw new Error("commerce_offering_role_unmanageable");
    }
    if (
      await this.store.hasPublishedRoleMapping(
        offering.guildId,
        offering.discordRoleId,
        offering.id,
      )
    ) {
      throw new Error("commerce_offering_role_already_published");
    }
    if ((await this.store.countPublishedSubscriptions(offering.guildId)) >= 5) {
      throw new Error("commerce_offering_subscription_limit");
    }
    const now = this.now();
    const next: CommerceOffering = {
      ...offering,
      state: "published",
      publishedAtMs: offering.publishedAtMs ?? now,
      updatedAtMs: now,
    };
    await this.store.createOffering(next);
    await this.onOfferingChanged?.(offering.guildId);
    return next;
  }

  async unpublish(offeringId: string): Promise<CommerceOffering> {
    return this.transition(offeringId, ["published", "suspended"], "unpublished");
  }

  async retire(input: RetireCommerceOfferingInput): Promise<CommerceOffering>;
  async retire(offeringId: string): Promise<CommerceOffering>;
  async retire(input: RetireCommerceOfferingInput | string): Promise<CommerceOffering> {
    if (typeof input === "string") {
      throw new Error("commerce_offering_retire_context_required");
    }
    validateRetirementActor(input.actorUserId);
    validateRetirementReason(input.reasonCode);
    validateRetirementAction(input.actionId);
    const offering = await this.requireOffering(input.offeringId);
    if (offering.state === "retiring") return offering;
    const retireAtMs = input.retireAtMs ?? this.now();
    if (!Number.isSafeInteger(retireAtMs) || retireAtMs < this.now()) {
      throw new Error("commerce_offering_retire_time_invalid");
    }
    if (!["published", "unpublished", "suspended"].includes(offering.state)) {
      throw new Error("commerce_offering_retire_invalid_state");
    }
    await this.store.beginRetirement({
      offering,
      actorUserId: input.actorUserId,
      reasonCode: input.reasonCode,
      actionId: input.actionId,
      retireAtMs,
      nowMs: this.now(),
    });
    if (offering.state === "published") await this.onOfferingChanged?.(offering.guildId);
    return this.requireOffering(input.offeringId);
  }

  async archive(offeringId: string): Promise<CommerceOffering> {
    const offering = await this.requireOffering(offeringId);
    if (offering.state === "published") throw new Error("commerce_offering_unpublish_first");
    const now = this.now();
    if (!(await this.store.archiveOffering(offeringId, now))) {
      throw new Error("commerce_offering_active_subscriptions");
    }
    return this.requireOffering(offeringId);
  }

  async replacePrice(input: {
    offeringId: string;
    currency: "AUD" | "USD";
    unitAmountMinor: number;
    recurringInterval: CommerceRecurringInterval;
  }): Promise<CommercePrice> {
    if (!Number.isSafeInteger(input.unitAmountMinor) || input.unitAmountMinor < 500) {
      throw new Error("commerce_offering_price_below_minimum");
    }
    const offering = await this.requireOffering(input.offeringId);
    const prices = await this.store.listPrices(input.offeringId);
    const previous = prices.find((price) => price.status === "active");
    if (!previous) throw new Error("commerce_offering_active_price_missing");
    const stripePrice = await this.provider.createPrice({
      connectedAccountId: offering.connectedAccountId,
      productId: previous.stripeProductId,
      currency: input.currency,
      unitAmountMinor: input.unitAmountMinor,
      recurringInterval: input.recurringInterval,
      metadata: metadataFor(offering.connectedAccountId, offering.guildId, offering.id),
      idempotencyKey: `commerce:offering:${offering.id}:price:${prices.length + 1}`,
    });
    const now = this.now();
    const next: CommercePrice = {
      ...previous,
      id: this.createId(),
      stripePriceId: stripePrice.id,
      currency: input.currency,
      unitAmountMinor: input.unitAmountMinor,
      recurringInterval: input.recurringInterval,
      providerCreatedAtMs: stripePrice.createdAtMs,
      retiredAtMs: null,
      createdAtMs: now,
      status: "active",
    };
    // Prices are append-only; retiring the previous row leaves subscribers
    // grandfathered on their original price.
    if (!(await this.store.createPrice(next))) throw new Error("commerce_price_already_exists");
    await this.retireLocalPrice(previous, now);
    if (offering.state === "published") await this.onOfferingChanged?.(offering.guildId);
    return next;
  }

  async replaceRole(input: { offeringId: string; discordRoleId: string }): Promise<{
    offering: CommerceOffering;
    status: "updated" | "replacement_pending";
  }> {
    const offering = await this.requireOffering(input.offeringId);
    if (!["draft", "published", "unpublished", "repair_required"].includes(offering.state)) {
      throw new Error("commerce_offering_role_replacement_invalid_state");
    }
    if (!input.discordRoleId || input.discordRoleId.length > 100) {
      throw new Error("commerce_offering_discord_role_invalid");
    }
    if (input.discordRoleId === offering.discordRoleId) {
      return { offering, status: "updated" };
    }
    if (
      await this.store.hasPublishedRoleMapping(offering.guildId, input.discordRoleId, offering.id)
    ) {
      throw new Error("commerce_offering_role_already_published");
    }
    const nowMs = this.now();
    const status = await this.store.beginRoleReplacement({
      offering,
      replacementRoleId: input.discordRoleId,
      nowMs,
    });
    const next = await this.requireOffering(input.offeringId);
    if (offering.state === "published") await this.onOfferingChanged?.(offering.guildId);
    return { offering: next, status };
  }

  async dashboard(connectedAccountId: string): Promise<CommerceOfferingDashboard> {
    return this.store.readDashboard(connectedAccountId);
  }

  private async retireLocalPrice(previous: CommercePrice, retiredAtMs: number): Promise<void> {
    if (this.provider.retirePrice) {
      await this.provider.retirePrice({
        connectedAccountId: previous.connectedAccountId,
        priceId: previous.stripePriceId,
        idempotencyKey: `commerce:price:${previous.stripePriceId}:retire`,
      });
    }
    // Stores expose immutable price creation but not an update operation by
    // design. The offering store supplies this narrow optional hook.
    const storeWithRetire = this.store as CommerceOfferingStore & {
      retirePrice?: (priceId: string, retiredAtMs: number) => Promise<void>;
    };
    if (storeWithRetire.retirePrice) {
      await storeWithRetire.retirePrice(previous.id, retiredAtMs);
    }
  }

  private async transition(
    offeringId: string,
    allowed: CommerceOfferingLifecycle[],
    state: CommerceOfferingLifecycle,
  ): Promise<CommerceOffering> {
    const offering = await this.requireOffering(offeringId);
    if (!allowed.includes(offering.state))
      throw new Error("commerce_offering_transition_invalid_state");
    const next: CommerceOffering = { ...offering, state, updatedAtMs: this.now() };
    await this.store.createOffering(next);
    await this.onOfferingChanged?.(offering.guildId);
    return next;
  }

  private async requireOffering(id: string): Promise<CommerceOffering> {
    const offering = await this.store.readOffering(id);
    if (!offering) throw new Error("commerce_offering_not_found");
    return offering;
  }
}

function validateInput(input: CreateCommerceOfferingInput): void {
  requiredName(input.name);
  for (const [value, label] of [
    [input.connectedAccountId, "connected account"],
    [input.guildId, "guild"],
    [input.discordRoleId, "Discord role"],
  ] as const) {
    if (!value || value.length > 100)
      throw new Error(`commerce_offering_${label.replaceAll(" ", "_")}_invalid`);
  }
  if (input.currency !== "AUD" && input.currency !== "USD")
    throw new Error("commerce_offering_currency_invalid");
  if (!Number.isSafeInteger(input.unitAmountMinor) || input.unitAmountMinor < 500) {
    throw new Error("commerce_offering_price_below_minimum");
  }
  if (input.recurringInterval !== "month" && input.recurringInterval !== "year") {
    throw new Error("commerce_offering_interval_invalid");
  }
}

function requiredName(name: string): string {
  const value = name.trim();
  if (!value || value.length > 100) throw new Error("commerce_offering_name_invalid");
  return value;
}

function normalizeDescription(description: string | null | undefined): string | null {
  if (description === null || description === undefined) return null;
  const value = description.trim();
  if (value.length > 2_000) throw new Error("commerce_offering_description_invalid");
  return value || null;
}

function validateBenefits(benefits: string[]): void {
  if (!Array.isArray(benefits) || benefits.length === 0 || benefits.length > 20) {
    throw new Error("commerce_offering_benefits_invalid");
  }
  for (const benefit of benefits) {
    if (typeof benefit !== "string" || !benefit.trim() || benefit.trim().length > 300) {
      throw new Error("commerce_offering_benefits_invalid");
    }
  }
}

function validateSupportContact(value: string): string {
  const contact = value.trim();
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact);
  const isHttpsUrl = /^https:\/\/[^\s]+$/i.test(contact);
  if (!contact || contact.length > 320 || (!isEmail && !isHttpsUrl)) {
    throw new Error("commerce_offering_support_contact_invalid");
  }
  return contact;
}

function validateRetirementActor(value: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > 100) {
    throw new Error("commerce_offering_actor_invalid");
  }
}

function validateRetirementReason(value: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{2,79}$/.test(value)) {
    throw new Error("commerce_offering_reason_invalid");
  }
}

function validateRetirementAction(value: string): void {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,99}$/.test(value)) {
    throw new Error("commerce_offering_action_invalid");
  }
}

function metadataFor(
  connectedAccountId: string,
  guildId: string,
  offeringId: string,
): Record<string, string> {
  return {
    haf_connected_account_id: connectedAccountId,
    haf_guild_id: guildId,
    haf_offering_id: offeringId,
  };
}
