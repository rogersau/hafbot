import type { CommerceBuyerCheckoutProvider } from "../../commerce/buyer-checkout";
import { isRecord } from "../../unknown-parse";
import type { StripeConnectClient } from "./stripe-connect-client";

export class StripeCommerceBuyerProvider implements CommerceBuyerCheckoutProvider {
  constructor(private readonly stripe: Pick<StripeConnectClient, "requestForConnectedAccount">) {}

  async createCustomer(input: {
    connectedAccountId: string;
    buyerId: string;
    discordUserId: string;
    idempotencyKey: string;
  }): Promise<{ id: string }> {
    const value = await this.stripe.requestForConnectedAccount(
      input.connectedAccountId,
      "/v1/customers",
      {
        method: "POST",
        body: new URLSearchParams({
          "metadata[haf_buyer_id]": opaque(input.buyerId),
          "metadata[haf_discord_user_id]": opaque(input.discordUserId),
        }),
        idempotencyKey: input.idempotencyKey,
      },
    );
    return { id: providerId(value, "cus_") };
  }

  async createSubscriptionCheckout(input: {
    connectedAccountId: string;
    customerId: string;
    priceId: string;
    buyerId: string;
    guildId: string;
    offeringId: string;
    checkoutAttemptId: string;
    successUrl: string;
    cancelUrl: string;
    expiresAtMs: number;
    applicationFeePercent: number;
    idempotencyKey: string;
  }): Promise<{ id: string; url: string }> {
    safeHttpsUrl(input.successUrl);
    safeHttpsUrl(input.cancelUrl);
    const metadata = {
      haf_buyer_id: opaque(input.buyerId),
      haf_guild_id: opaque(input.guildId),
      haf_offering_id: opaque(input.offeringId),
      haf_checkout_attempt_id: opaque(input.checkoutAttemptId),
    };
    const body = new URLSearchParams({
      mode: "subscription",
      customer: providerOpaque(input.customerId, "cus_"),
      "line_items[0][price]": providerOpaque(input.priceId, "price_"),
      "line_items[0][quantity]": "1",
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      expires_at: String(Math.floor(input.expiresAtMs / 1_000)),
      client_reference_id: metadata.haf_checkout_attempt_id,
      "subscription_data[application_fee_percent]": String(input.applicationFeePercent),
      "payment_method_types[0]": "card",
      "payment_method_types[1]": "link",
    });
    for (const [key, value] of Object.entries(metadata)) {
      body.set(`metadata[${key}]`, value);
      body.set(`subscription_data[metadata][${key}]`, value);
    }
    const response = await this.stripe.requestForConnectedAccount(
      input.connectedAccountId,
      "/v1/checkout/sessions",
      { method: "POST", body, idempotencyKey: input.idempotencyKey },
    );
    if (!isRecord(response) || typeof response.url !== "string") {
      throw new Error("Stripe Checkout returned an invalid response.");
    }
    return { id: providerId(response, "cs_"), url: safeHttpsUrl(response.url) };
  }

  async retrieveSubscriptionCheckout(input: {
    connectedAccountId: string;
    checkoutSessionId: string;
  }): Promise<{ id: string; url: string }> {
    const checkoutSessionId = providerOpaque(input.checkoutSessionId, "cs_");
    const response = await this.stripe.requestForConnectedAccount(
      input.connectedAccountId,
      `/v1/checkout/sessions/${checkoutSessionId}`,
    );
    if (!isRecord(response) || response.status !== "open" || typeof response.url !== "string") {
      throw new Error("Stripe Checkout session is no longer open.");
    }
    return { id: providerId(response, "cs_"), url: safeHttpsUrl(response.url) };
  }

  async expireSubscriptionCheckout(input: {
    connectedAccountId: string;
    checkoutSessionId: string;
    idempotencyKey: string;
  }): Promise<void> {
    const checkoutSessionId = providerOpaque(input.checkoutSessionId, "cs_");
    const response = await this.stripe.requestForConnectedAccount(
      input.connectedAccountId,
      `/v1/checkout/sessions/${checkoutSessionId}/expire`,
      { method: "POST", idempotencyKey: input.idempotencyKey },
    );
    if (!isRecord(response) || response.status !== "expired") {
      throw new Error("Stripe Checkout session expiration failed.");
    }
    if (providerId(response, "cs_") !== checkoutSessionId) {
      throw new Error("Stripe Checkout session expiration failed.");
    }
  }

  async createCustomerPortal(input: {
    connectedAccountId: string;
    customerId: string;
    returnUrl: string;
    idempotencyKey: string;
  }): Promise<{ url: string }> {
    const response = await this.stripe.requestForConnectedAccount(
      input.connectedAccountId,
      "/v1/billing_portal/sessions",
      {
        method: "POST",
        body: new URLSearchParams({
          customer: providerOpaque(input.customerId, "cus_"),
          return_url: safeHttpsUrl(input.returnUrl),
        }),
        idempotencyKey: input.idempotencyKey,
      },
    );
    if (!isRecord(response) || typeof response.url !== "string") {
      throw new Error("Stripe customer portal returned an invalid response.");
    }
    return { url: safeHttpsUrl(response.url) };
  }
}

function providerId(value: unknown, prefix: string): string {
  if (!isRecord(value) || typeof value.id !== "string") {
    throw new Error("Stripe returned an invalid response.");
  }
  return providerOpaque(value.id, prefix);
}

function providerOpaque(value: string, prefix: string): string {
  if (!value.startsWith(prefix) || !/^[A-Za-z0-9_]+$/.test(value)) {
    throw new Error("Stripe object scope is invalid.");
  }
  return value;
}

function opaque(value: string): string {
  if (!/^[A-Za-z0-9:_-]{1,100}$/.test(value)) {
    throw new Error("Commerce metadata must contain opaque identifiers only.");
  }
  return value;
}

function safeHttpsUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new Error("Commerce return URL must use HTTPS.");
  }
  url.username = "";
  url.password = "";
  return url.toString();
}
