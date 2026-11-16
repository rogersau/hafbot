import { SafeDiagnosticError } from "../../observability/safe-diagnostic-error";
import { isRecord } from "../../unknown-parse";
import type { StripeOwnerState, StripeSubscriptionState } from "./types";
import type { StripeOwnerStateReader } from "./owner-sync";
import type { BillingCheckoutProvider } from "./checkout";
import type { BillingManagementProvider } from "./management";
import type { BillingAdverseProvider, StripeDisputeState } from "./adverse";
import type { StripeDisplayPrice } from "./landing-catalog";
import type { StripeWebhookCustomerResolver } from "./webhook";

export class StripeHttpClient
  implements
    StripeOwnerStateReader,
    BillingCheckoutProvider,
    BillingManagementProvider,
    BillingAdverseProvider,
    StripeWebhookCustomerResolver
{
  constructor(
    private readonly secretKey: string,
    private readonly apiVersion: string,
    private readonly portalConfigurationId: string,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  async readPrice(priceId: string): Promise<StripeDisplayPrice> {
    const value = await this.get(`/v1/prices/${encodeURIComponent(priceId)}`);
    if (!isRecord(value)) throw new SafeDiagnosticError("Stripe returned an invalid Price.");
    const productId = objectOrId(value.product);
    const recurring = isRecord(value.recurring) ? value.recurring : null;
    const interval = recurring?.interval;
    if (
      value.id !== priceId ||
      typeof productId !== "string" ||
      typeof value.active !== "boolean" ||
      typeof value.unit_amount !== "number" ||
      typeof value.currency !== "string" ||
      (interval !== "month" && interval !== "year")
    ) {
      throw new SafeDiagnosticError("Stripe Price is incomplete.");
    }
    return {
      id: priceId,
      productId,
      active: value.active,
      unitAmount: value.unit_amount,
      currency: value.currency,
      interval,
    };
  }

  async readOwnerState(customerId: string): Promise<StripeOwnerState> {
    const [customer, subscriptions] = await Promise.all([
      this.get(`/v1/customers/${encodeURIComponent(customerId)}`),
      this.get(`/v1/subscriptions?customer=${encodeURIComponent(customerId)}&status=all&limit=10`),
    ]);
    if (!isRecord(customer) || customer.deleted === true || customer.id !== customerId) {
      throw new SafeDiagnosticError("Stripe Customer was not found.");
    }
    if (!isRecord(subscriptions) || !Array.isArray(subscriptions.data)) {
      throw new SafeDiagnosticError("Stripe returned an invalid Subscription list.");
    }
    return {
      customer: { id: customerId, email: asNullableString(customer.email) },
      subscriptions: subscriptions.data.map((value) => parseSubscription(value, customerId)),
      observedAtMs: Date.now(),
    };
  }

  async createCustomer(input: {
    ownerId: string;
    email: string | null;
    idempotencyKey: string;
  }): Promise<string> {
    const body = new URLSearchParams({ "metadata[haf_owner_id]": input.ownerId });
    if (input.email) body.set("email", input.email);
    const customer = await this.post("/v1/customers", body, input.idempotencyKey);
    if (!isRecord(customer) || typeof customer.id !== "string") {
      throw new SafeDiagnosticError("Stripe returned an invalid Customer.");
    }
    return customer.id;
  }

  async createCheckout(input: {
    customerId: string;
    priceId: string;
    ownerId: string;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
  }): Promise<{ id: string; url: string }> {
    const checkout = await this.post(
      "/v1/checkout/sessions",
      new URLSearchParams({
        mode: "subscription",
        customer: input.customerId,
        client_reference_id: input.ownerId,
        "line_items[0][price]": input.priceId,
        "line_items[0][quantity]": "1",
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        allow_promotion_codes: "true",
        payment_method_collection: "if_required",
        "automatic_tax[enabled]": "false",
        "adaptive_pricing[enabled]": "true",
        "subscription_data[metadata][haf_owner_id]": input.ownerId,
        "payment_method_types[0]": "card",
        "payment_method_types[1]": "link",
      }),
      input.idempotencyKey,
    );
    if (
      !isRecord(checkout) ||
      typeof checkout.id !== "string" ||
      typeof checkout.url !== "string"
    ) {
      throw new SafeDiagnosticError("Stripe returned an invalid Checkout Session.");
    }
    return { id: checkout.id, url: checkout.url };
  }

  async createPortal(input: {
    customerId: string;
    returnUrl: string;
    idempotencyKey: string;
  }): Promise<{ url: string }> {
    const value = await this.post(
      "/v1/billing_portal/sessions",
      new URLSearchParams({
        customer: input.customerId,
        return_url: input.returnUrl,
        configuration: this.portalConfigurationId,
      }),
      input.idempotencyKey,
    );
    if (!isRecord(value) || typeof value.url !== "string")
      throw new SafeDiagnosticError("Stripe returned an invalid Portal Session.");
    return { url: value.url };
  }

  async updatePrice(input: {
    subscriptionId: string;
    priceId: string;
    idempotencyKey: string;
    proration: "always_invoice";
    pendingIfIncomplete: true;
  }): Promise<void> {
    const subscription = await this.get(
      `/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
    );
    const itemId = firstSubscriptionItemId(subscription);
    await this.post(
      `/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
      new URLSearchParams({
        [`items[0][id]`]: itemId,
        [`items[0][price]`]: input.priceId,
        proration_behavior: input.proration,
        payment_behavior: "pending_if_incomplete",
      }),
      input.idempotencyKey,
    );
  }

  async schedulePrice(input: {
    subscriptionId: string;
    currentPriceId: string;
    nextPriceId: string;
    currentPeriodEndMs: number;
    idempotencyKey: string;
  }): Promise<void> {
    const created = await this.post(
      "/v1/subscription_schedules",
      new URLSearchParams({ from_subscription: input.subscriptionId }),
      `${input.idempotencyKey}:create`,
    );
    if (!isRecord(created) || typeof created.id !== "string") {
      throw new SafeDiagnosticError("Stripe returned an invalid Subscription Schedule.");
    }
    const firstPhase =
      Array.isArray(created.phases) && isRecord(created.phases[0]) ? created.phases[0] : null;
    if (!firstPhase || typeof firstPhase.start_date !== "number") {
      throw new SafeDiagnosticError("Stripe Subscription Schedule is missing its current phase.");
    }
    await this.post(
      `/v1/subscription_schedules/${encodeURIComponent(created.id)}`,
      new URLSearchParams({
        "phases[0][start_date]": String(firstPhase.start_date),
        "phases[0][items][0][price]": input.currentPriceId,
        "phases[0][items][0][quantity]": "1",
        "phases[0][end_date]": String(Math.floor(input.currentPeriodEndMs / 1_000)),
        "phases[0][proration_behavior]": "none",
        "phases[1][items][0][price]": input.nextPriceId,
        "phases[1][items][0][quantity]": "1",
        "phases[1][proration_behavior]": "none",
        proration_behavior: "none",
        end_behavior: "release",
      }),
      `${input.idempotencyKey}:update`,
    );
  }

  async setCancelAtPeriodEnd(input: {
    subscriptionId: string;
    cancelAtPeriodEnd: boolean;
    idempotencyKey: string;
  }): Promise<void> {
    await this.post(
      `/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
      new URLSearchParams({ cancel_at_period_end: String(input.cancelAtPeriodEnd) }),
      input.idempotencyKey,
    );
  }

  async readDispute(disputeId: string): Promise<StripeDisputeState> {
    const dispute = await this.get(`/v1/disputes/${encodeURIComponent(disputeId)}`);
    if (
      !isRecord(dispute) ||
      typeof dispute.id !== "string" ||
      typeof dispute.amount !== "number"
    ) {
      throw new SafeDiagnosticError("Stripe returned an invalid dispute.");
    }
    const chargeId = objectOrId(dispute.charge);
    if (!chargeId) throw new SafeDiagnosticError("Stripe dispute has no Charge.");
    const charge = await this.get(`/v1/charges/${encodeURIComponent(chargeId)}`);
    if (!isRecord(charge) || typeof charge.amount !== "number") {
      throw new SafeDiagnosticError("Stripe returned an invalid Charge.");
    }
    const paymentMethod = isRecord(charge.payment_method_details)
      ? charge.payment_method_details.type
      : null;
    if (typeof paymentMethod !== "string")
      throw new SafeDiagnosticError("Stripe Charge payment method is missing.");
    return {
      id: dispute.id,
      status: normalizeDisputeStatus(dispute.status),
      amount: dispute.amount,
      chargeAmount: charge.amount,
      paymentMethodType: paymentMethod,
    };
  }

  async resolveChargeCustomer(chargeId: string): Promise<string> {
    const charge = await this.get(`/v1/charges/${encodeURIComponent(chargeId)}`);
    if (!isRecord(charge) || charge.id !== chargeId) {
      throw new SafeDiagnosticError("Stripe returned an invalid Charge.");
    }
    const customerId = objectOrId(charge.customer);
    if (!customerId) throw new SafeDiagnosticError("Stripe Charge has no Customer.");
    return customerId;
  }

  async cancelImmediately(subscriptionId: string, idempotencyKey: string): Promise<void> {
    await this.post(
      `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
      new URLSearchParams({ cancel_at_period_end: "false", proration_behavior: "none" }),
      idempotencyKey,
      "DELETE",
    );
  }

  private async get(path: string): Promise<unknown> {
    const response = await this.fetchImpl(`https://api.stripe.com${path}`, {
      headers: {
        authorization: `Bearer ${this.secretKey}`,
        "stripe-version": this.apiVersion,
      },
    });
    return readStripeResponse(response);
  }

  private async post(
    path: string,
    body: URLSearchParams,
    idempotencyKey: string,
    method = "POST",
  ): Promise<unknown> {
    const response = await this.fetchImpl(`https://api.stripe.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.secretKey}`,
        "stripe-version": this.apiVersion,
        "content-type": "application/x-www-form-urlencoded",
        "idempotency-key": idempotencyKey,
      },
      body,
    });
    return readStripeResponse(response);
  }
}

async function readStripeResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new SafeDiagnosticError(`Stripe request failed with HTTP ${response.status}.`);
  }
  try {
    return await response.json();
  } catch {
    // JSON parser errors may include fragments of the provider response body.
    throw new SafeDiagnosticError("Stripe returned an invalid JSON response.");
  }
}

function normalizeDisputeStatus(value: unknown): StripeDisputeState["status"] {
  if (
    value === "needs_response" ||
    value === "under_review" ||
    value === "lost" ||
    value === "won" ||
    value === "warning_closed"
  ) {
    return value;
  }
  return "needs_response";
}

function firstSubscriptionItemId(value: unknown): string {
  if (
    !isRecord(value) ||
    !isRecord(value.items) ||
    !Array.isArray(value.items.data) ||
    !isRecord(value.items.data[0]) ||
    typeof value.items.data[0].id !== "string"
  ) {
    throw new SafeDiagnosticError("Stripe Subscription Item was not found.");
  }
  return value.items.data[0].id;
}

function parseSubscription(value: unknown, customerId: string): StripeSubscriptionState {
  if (!isRecord(value)) {
    throw new SafeDiagnosticError("Stripe returned an invalid Subscription.");
  }
  const items = isRecord(value.items) && Array.isArray(value.items.data) ? value.items.data : null;
  if (!items) throw new SafeDiagnosticError("Stripe returned an invalid Subscription.");
  if (items.length !== 1)
    throw new SafeDiagnosticError("Stripe Subscription must contain exactly one item.");
  const item = items[0];
  const price = isRecord(item) && isRecord(item.price) ? item.price : null;
  const status = normalizeStatus(value.status);
  const id = asString(value.id);
  const priceId = price ? asString(price.id) : null;
  const productId = price
    ? isRecord(price.product)
      ? asString(price.product.id)
      : asString(price.product)
    : null;
  if (!id || !priceId || !productId || !status)
    throw new SafeDiagnosticError("Stripe Subscription is incomplete.");
  return {
    id,
    customerId,
    priceId,
    productId,
    status,
    currentPeriodStartMs: secondsToMs(
      isRecord(item) ? item.current_period_start : value.current_period_start,
    ),
    currentPeriodEndMs: secondsToMs(
      isRecord(item) ? item.current_period_end : value.current_period_end,
    ),
    cancelAtPeriodEnd: value.cancel_at_period_end === true,
    cancelledAtMs: secondsToMs(value.canceled_at),
    latestInvoiceId: objectOrId(value.latest_invoice),
    scheduleId: objectOrId(value.schedule),
  };
}

function normalizeStatus(value: unknown): StripeSubscriptionState["status"] | null {
  if (value === "incomplete" || value === "active" || value === "past_due" || value === "unpaid") {
    return value;
  }
  return value === "canceled" || value === "incomplete_expired" ? "canceled" : null;
}

function objectOrId(value: unknown): string | null {
  return isRecord(value) ? asString(value.id) : asNullableString(value);
}

function secondsToMs(value: unknown): number | null {
  return typeof value === "number" ? value * 1_000 : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : asString(value);
}
