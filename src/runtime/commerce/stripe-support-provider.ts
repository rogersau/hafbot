import type { CommerceSupportProvider } from "../../commerce/support-payments";
import { isRecord } from "../../unknown-parse";
import type { StripeConnectClient } from "./stripe-connect-client";

export class StripeCommerceSupportProvider implements CommerceSupportProvider {
  constructor(private readonly stripe: Pick<StripeConnectClient, "requestForConnectedAccount">) {}

  async createCustomer(input: {
    connectedAccountId: string;
    buyerId: string;
    discordUserId: string;
    idempotencyKey: string;
  }): Promise<{ id: string }> {
    const response = await this.stripe.requestForConnectedAccount(
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
    return { id: providerId(response, "cus_") };
  }

  async createSupportCheckout(
    input: Parameters<CommerceSupportProvider["createSupportCheckout"]>[0],
  ) {
    const metadata = {
      haf_checkout_kind: "support",
      haf_buyer_id: opaque(input.buyerId),
      haf_guild_id: opaque(input.guildId),
      haf_checkout_attempt_id: opaque(input.checkoutAttemptId),
      haf_application_fee_minor: String(input.applicationFeeMinor),
    };
    const body = new URLSearchParams({
      mode: "payment",
      customer: providerOpaque(input.customerId, "cus_"),
      "line_items[0][price_data][currency]": input.currency.toLowerCase(),
      "line_items[0][price_data][unit_amount]": String(input.amountMinor),
      "line_items[0][price_data][product_data][name]": "Support this server",
      "line_items[0][quantity]": "1",
      "payment_intent_data[application_fee_amount]": String(input.applicationFeeMinor),
      success_url: safeHttpsUrl(input.successUrl),
      cancel_url: safeHttpsUrl(input.cancelUrl),
      expires_at: String(Math.floor(input.expiresAtMs / 1_000)),
      client_reference_id: metadata.haf_checkout_attempt_id,
      "payment_method_types[0]": "card",
      "payment_method_types[1]": "link",
    });
    for (const [key, value] of Object.entries(metadata)) {
      body.set(`metadata[${key}]`, value);
      body.set(`payment_intent_data[metadata][${key}]`, value);
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

  async createRefund(input: Parameters<CommerceSupportProvider["createRefund"]>[0]) {
    const response = await this.stripe.requestForConnectedAccount(
      input.connectedAccountId,
      "/v1/refunds",
      {
        method: "POST",
        body: new URLSearchParams({
          payment_intent: providerOpaque(input.stripePaymentIntentId, "pi_"),
          amount: String(input.amountMinor),
          refund_application_fee: "true",
        }),
        idempotencyKey: input.idempotencyKey,
      },
    );
    return { id: providerId(response, "re_") };
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
