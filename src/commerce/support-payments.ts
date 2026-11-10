import {
  transitionCheckout,
  checkoutFailureRecovery,
  type CheckoutWorkflow,
} from "./checkout-workflow";
import type {
  CommerceBuyer,
  CommerceConnectedAccount,
  CommerceCurrency,
  CommerceCustomer,
  CommercePaymentStatus,
  CommerceSellerProfile,
} from "./types";

const CHECKOUT_TTL_MS = 31 * 60 * 1_000;
const MINIMUM_MINOR = 200;
const MAXIMUM_MINOR = 50_000;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1_000;
const RATE_LIMIT_ATTEMPTS = 5;

export interface CommerceSupportConfig {
  connectedAccountId: string;
  guildId: string;
  enabled: boolean;
  explanation: string;
  currency: CommerceCurrency;
  suggestedAmountsMinor: number[];
  supportContact: string;
  termsVersion: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CommerceSupportContext {
  account: CommerceConnectedAccount;
  seller: CommerceSellerProfile;
  termsAccepted: boolean;
  premiumActive: boolean;
  suspended: boolean;
}

export interface CommerceSupportPage {
  config: CommerceSupportConfig;
  context: CommerceSupportContext;
}

export interface CommerceSupportCheckoutAttempt {
  id: string;
  connectedAccountId: string;
  guildId: string;
  buyerId: string;
  currency: CommerceCurrency;
  amountMinor: number;
  applicationFeeMinor: number;
  stripeCheckoutSessionId: string | null;
  status: "creating" | "open" | "returned" | "expired" | "failed";
  expiresAtMs: number;
  returnedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CommerceSupportPayment {
  id: string;
  connectedAccountId: string;
  guildId: string;
  customerId: string;
  buyerId: string;
  checkoutAttemptId: string;
  stripePaymentIntentId: string;
  stripeChargeId: string | null;
  stripeCheckoutSessionId: string | null;
  currency: CommerceCurrency;
  amountMinor: number;
  amountReceivedMinor: number;
  amountRefundedMinor: number;
  applicationFeeMinor: number;
  stripeFeeMinor: number | null;
  stripeFeeTaxMinor: number | null;
  status: CommercePaymentStatus;
  providerCreatedAtMs: number | null;
  paidAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CommerceSupportRefund {
  id: string;
  connectedAccountId: string;
  supportPaymentId: string;
  stripeRefundId: string;
  currency: CommerceCurrency;
  amountMinor: number;
  applicationFeeRefundedMinor: number | null;
  status: "pending" | "succeeded" | "failed" | "canceled";
  reason: string | null;
  providerCreatedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CommerceSupportDispute {
  id: string;
  connectedAccountId: string;
  supportPaymentId: string;
  stripeDisputeId: string;
  currency: CommerceCurrency;
  amountMinor: number;
  status:
    | "warning_needs_response"
    | "warning_under_review"
    | "warning_closed"
    | "needs_response"
    | "under_review"
    | "won"
    | "lost";
  reason: string | null;
  providerCreatedAtMs: number | null;
  closedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CommerceSupportReport {
  currency: CommerceCurrency;
  paymentCount: number;
  grossMinor: number;
  hafFeeMinor: number;
  stripeFeeMinor: number | null;
  refundedMinor: number;
  disputedMinor: number;
  openDisputeCount: number;
  netBeforeStripeFeesMinor: number;
}

export interface CommerceSupportStore {
  readConfigByGuild(guildId: string): Promise<CommerceSupportConfig | null>;
  readContextByGuild(
    guildId: string,
    termsVersion?: string,
  ): Promise<CommerceSupportContext | null>;
  saveConfig(config: CommerceSupportConfig): Promise<void>;
  getOrCreateBuyer(discordUserId: string, nowMs: number): Promise<CommerceBuyer>;
  readCustomer(connectedAccountId: string, buyerId: string): Promise<CommerceCustomer | null>;
  saveCustomer(customer: CommerceCustomer): Promise<void>;
  claimRateLimit(input: {
    buyerId: string;
    guildId: string;
    nowMs: number;
    windowMs: number;
    maximumAttempts: number;
  }): Promise<boolean>;
  reserveCheckout(attempt: CommerceSupportCheckoutAttempt): Promise<boolean>;
  attachCheckoutSession(attemptId: string, sessionId: string, nowMs: number): Promise<void>;
  failCheckout(attemptId: string, nowMs: number): Promise<void>;
  markCheckoutReturned(input: {
    attemptId: string;
    guildId: string;
    buyerId: string;
    nowMs: number;
  }): Promise<CommerceSupportCheckoutAttempt | null>;
  readPaymentStatus(input: {
    checkoutAttemptId: string;
    buyerId: string;
  }): Promise<CommerceSupportPayment | null>;
  readPayment(paymentId: string): Promise<CommerceSupportPayment | null>;
  readReport(connectedAccountId: string): Promise<CommerceSupportReport[]>;
}

export interface CommerceSupportProvider {
  createCustomer(input: {
    connectedAccountId: string;
    buyerId: string;
    discordUserId: string;
    idempotencyKey: string;
  }): Promise<{ id: string }>;
  createSupportCheckout(input: {
    connectedAccountId: string;
    customerId: string;
    buyerId: string;
    guildId: string;
    checkoutAttemptId: string;
    currency: CommerceCurrency;
    amountMinor: number;
    applicationFeeMinor: number;
    successUrl: string;
    cancelUrl: string;
    expiresAtMs: number;
    idempotencyKey: string;
  }): Promise<{ id: string; url: string }>;
  createRefund(input: {
    connectedAccountId: string;
    stripePaymentIntentId: string;
    amountMinor: number;
    idempotencyKey: string;
  }): Promise<{ id: string }>;
}

export interface CommerceSupportReconciler {
  request(input: { connectedAccountId: string; correlationId: string }): Promise<void>;
}

export interface CommerceSupportPolicy {
  claimSupport?(input: {
    page: CommerceSupportPage;
    checkoutAttemptId: string;
    amountMinor: number;
    expiresAtMs: number;
  }): Promise<void>;
  releaseSupport?(checkoutAttemptId: string): Promise<void>;
}

export class CommerceSupportService {
  constructor(
    private readonly store: CommerceSupportStore,
    private readonly provider: CommerceSupportProvider,
    private readonly reconciler: CommerceSupportReconciler,
    private readonly currentTermsVersion: string,
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = () => crypto.randomUUID(),
    private readonly policy: CommerceSupportPolicy = {},
  ) {}

  async page(guildId: string): Promise<CommerceSupportPage> {
    const config = await this.store.readConfigByGuild(guildId);
    const context = await this.store.readContextByGuild(guildId, config?.termsVersion);
    if (!config || !context || config.connectedAccountId !== context.account.id) {
      throw new Error("commerce_support_not_found");
    }
    return { config, context };
  }

  async saveConfig(input: {
    guildId: string;
    enabled: boolean;
    explanation: string;
    currency: CommerceCurrency;
    suggestedAmountsMinor: number[];
    supportContact: string;
  }): Promise<CommerceSupportConfig> {
    const context = await this.store.readContextByGuild(input.guildId, this.currentTermsVersion);
    if (!context) throw new Error("commerce_support_seller_not_found");
    const existing = await this.store.readConfigByGuild(input.guildId);
    const nowMs = this.now();
    const config: CommerceSupportConfig = {
      connectedAccountId: context.account.id,
      guildId: input.guildId,
      enabled: input.enabled,
      explanation: normalizeExplanation(input.explanation),
      currency: input.currency,
      suggestedAmountsMinor: normalizeSuggestedAmounts(input.suggestedAmountsMinor),
      supportContact: normalizeContact(input.supportContact),
      termsVersion: this.currentTermsVersion,
      createdAtMs: existing?.createdAtMs ?? nowMs,
      updatedAtMs: nowMs,
    };
    if (config.enabled) assertSupportAvailable({ config, context }, this.currentTermsVersion);
    await this.store.saveConfig(config);
    return config;
  }

  async startCheckout(input: {
    guildId: string;
    discordUserId: string;
    checkoutAttemptId: string;
    amountMinor: number;
    successUrl: string;
    cancelUrl: string;
    preflight: {
      memberPresent: boolean;
      memberIsBot: boolean;
      memberBanned: boolean;
    };
  }): Promise<{ checkoutSessionId: string; url: string }> {
    const nowMs = this.now();
    const page = await this.page(input.guildId);
    assertSupportAvailable(page, this.currentTermsVersion);
    assertMember(input.preflight);
    const amountMinor = validSupportAmount(input.amountMinor);
    const applicationFeeMinor = exactFivePercentFee(amountMinor);
    const buyer = await this.store.getOrCreateBuyer(input.discordUserId, nowMs);
    if (
      !(await this.store.claimRateLimit({
        buyerId: buyer.id,
        guildId: input.guildId,
        nowMs,
        windowMs: RATE_LIMIT_WINDOW_MS,
        maximumAttempts: RATE_LIMIT_ATTEMPTS,
      }))
    ) {
      throw new Error("commerce_support_rate_limited");
    }
    const attempt: CommerceSupportCheckoutAttempt = {
      id: input.checkoutAttemptId,
      connectedAccountId: page.context.account.id,
      guildId: input.guildId,
      buyerId: buyer.id,
      currency: page.config.currency,
      amountMinor,
      applicationFeeMinor,
      stripeCheckoutSessionId: null,
      status: "creating",
      expiresAtMs: nowMs + CHECKOUT_TTL_MS,
      returnedAtMs: null,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    if (!(await this.store.reserveCheckout(attempt))) {
      throw new Error("commerce_support_checkout_already_open");
    }
    let workflow: CheckoutWorkflow = { kind: "preparing", capacity: "unclaimed" };
    try {
      let customer = await this.store.readCustomer(page.context.account.id, buyer.id);
      if (!customer) {
        const providerCustomer = await this.provider.createCustomer({
          connectedAccountId: page.context.account.stripeAccountId,
          buyerId: buyer.id,
          discordUserId: buyer.discordUserId,
          idempotencyKey: `commerce:customer:${page.context.account.id}:${buyer.id}`,
        });
        customer = {
          id: this.createId(),
          connectedAccountId: page.context.account.id,
          buyerId: buyer.id,
          stripeCustomerId: providerCustomer.id,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
        };
        await this.store.saveCustomer(customer);
        customer = (await this.store.readCustomer(page.context.account.id, buyer.id)) ?? customer;
      }
      await this.policy.claimSupport?.({
        page,
        checkoutAttemptId: attempt.id,
        amountMinor,
        expiresAtMs: attempt.expiresAtMs,
      });
      if (this.policy.claimSupport)
        workflow = transitionCheckout(workflow, { type: "capacity-claimed" });
      workflow = transitionCheckout(workflow, { type: "provider-invoked" });
      const session = await this.provider.createSupportCheckout({
        connectedAccountId: page.context.account.stripeAccountId,
        customerId: customer.stripeCustomerId,
        buyerId: buyer.id,
        guildId: input.guildId,
        checkoutAttemptId: attempt.id,
        currency: page.config.currency,
        amountMinor,
        applicationFeeMinor,
        successUrl: input.successUrl,
        cancelUrl: input.cancelUrl,
        expiresAtMs: attempt.expiresAtMs,
        idempotencyKey: `commerce:support-checkout:${attempt.id}`,
      });
      workflow = transitionCheckout(workflow, { type: "provider-created", sessionId: session.id });
      await this.store.attachCheckoutSession(attempt.id, session.id, this.now());
      workflow = transitionCheckout(workflow, { type: "session-attached" });
      return { checkoutSessionId: session.id, url: session.url };
    } catch (error) {
      if (checkoutFailureRecovery(workflow).releaseCapacity) {
        await this.policy.releaseSupport?.(attempt.id);
      }
      await this.store.failCheckout(attempt.id, this.now());
      throw error;
    }
  }

  async handleBrowserReturn(input: {
    guildId: string;
    discordUserId: string;
    checkoutAttemptId: string;
  }): Promise<CommerceSupportPayment | null> {
    const page = await this.page(input.guildId);
    const buyer = await this.store.getOrCreateBuyer(input.discordUserId, this.now());
    const attempt = await this.store.markCheckoutReturned({
      attemptId: input.checkoutAttemptId,
      guildId: input.guildId,
      buyerId: buyer.id,
      nowMs: this.now(),
    });
    if (!attempt || attempt.connectedAccountId !== page.context.account.id) {
      throw new Error("commerce_support_return_scope_mismatch");
    }
    await this.reconciler.request({
      connectedAccountId: page.context.account.id,
      correlationId: attempt.id,
    });
    return this.store.readPaymentStatus({
      checkoutAttemptId: attempt.id,
      buyerId: buyer.id,
    });
  }

  readReport(connectedAccountId: string): Promise<CommerceSupportReport[]> {
    return this.store.readReport(connectedAccountId);
  }

  async refund(input: {
    connectedAccountId: string;
    paymentId: string;
    amountMinor: number;
    intentId: string;
  }): Promise<{ refundId: string }> {
    const payment = await this.store.readPayment(input.paymentId);
    if (!payment || payment.connectedAccountId !== input.connectedAccountId) {
      throw new Error("commerce_support_payment_not_found");
    }
    const refundable = payment.amountReceivedMinor - payment.amountRefundedMinor;
    if (
      payment.status !== "succeeded" ||
      !Number.isSafeInteger(input.amountMinor) ||
      input.amountMinor < 1 ||
      input.amountMinor > refundable
    ) {
      throw new Error("commerce_support_refund_invalid");
    }
    const refund = await this.provider.createRefund({
      connectedAccountId: payment.connectedAccountId,
      stripePaymentIntentId: payment.stripePaymentIntentId,
      amountMinor: input.amountMinor,
      idempotencyKey: `commerce:support-refund:${payment.id}:${input.intentId}`,
    });
    await this.reconciler.request({
      connectedAccountId: payment.connectedAccountId,
      correlationId: refund.id,
    });
    return { refundId: refund.id };
  }
}

export function exactFivePercentFee(amountMinor: number): number {
  validSupportAmount(amountMinor);
  if (amountMinor % 20 !== 0) throw new Error("commerce_support_amount_rounding");
  return amountMinor / 20;
}

export function validSupportAmount(amountMinor: number): number {
  if (
    !Number.isSafeInteger(amountMinor) ||
    amountMinor < MINIMUM_MINOR ||
    amountMinor > MAXIMUM_MINOR
  ) {
    throw new Error("commerce_support_amount_invalid");
  }
  return amountMinor;
}

function normalizeSuggestedAmounts(values: number[]): number[] {
  if (values.length < 1 || values.length > 3) {
    throw new Error("commerce_support_suggestions_invalid");
  }
  const normalized = [...new Set(values.map((value) => validSupportAmount(value)))];
  for (const value of normalized) exactFivePercentFee(value);
  if (normalized.length !== values.length) throw new Error("commerce_support_suggestions_invalid");
  return normalized.sort((a, b) => a - b);
}

function normalizeExplanation(value: string): string {
  const explanation = value.trim().replace(/\s+/g, " ");
  if (explanation.length < 10 || explanation.length > 500) {
    throw new Error("commerce_support_explanation_invalid");
  }
  const prohibited =
    /\b(charit(?:y|able)|donat(?:e|ion)|tax[- ]?deductible|fundrais(?:e|er|ing)|crowdfund(?:ing)?|political|raffle|prize|investment|financial return|profit share|project delivery|funding target)\b/i;
  if (prohibited.test(explanation)) throw new Error("commerce_support_prohibited_wording");
  return explanation;
}

function normalizeContact(value: string): string {
  const contact = value.trim();
  if (contact.length < 3 || contact.length > 200) {
    throw new Error("commerce_support_contact_invalid");
  }
  return contact;
}

function assertSupportAvailable(page: CommerceSupportPage, currentTermsVersion: string): void {
  const { account, seller } = page.context;
  if (!page.config.enabled) throw new Error("commerce_support_disabled");
  if (
    account.status !== "active" ||
    !account.chargesEnabled ||
    !account.payoutsEnabled ||
    !account.detailsSubmitted ||
    seller.lifecycleState !== "active" ||
    seller.approvalState !== "approved" ||
    !page.context.premiumActive ||
    page.context.suspended ||
    !page.context.termsAccepted ||
    page.config.termsVersion !== currentTermsVersion
  ) {
    throw new Error("commerce_support_seller_unavailable");
  }
}

function assertMember(input: {
  memberPresent: boolean;
  memberIsBot: boolean;
  memberBanned: boolean;
}): void {
  if (!input.memberPresent) throw new Error("commerce_support_member_required");
  if (input.memberIsBot) throw new Error("commerce_support_bot_forbidden");
  if (input.memberBanned) throw new Error("commerce_support_banned");
}
