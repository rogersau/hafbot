import type { CommerceFinancialOperationsProvider } from "../../commerce/financial-operations";
import { isRecord } from "../../unknown-parse";
import type { StripeConnectClient } from "./stripe-connect-client";

export class StripeCommerceFinancialOperationsProvider implements CommerceFinancialOperationsProvider {
  constructor(
    private readonly stripe: Pick<
      StripeConnectClient,
      "requestForConnectedAccount" | "deleteConnectedAccount"
    >,
  ) {}

  async refund(input: Parameters<CommerceFinancialOperationsProvider["refund"]>[0]) {
    const response = await this.stripe.requestForConnectedAccount(
      accountId(input.connectedAccountId),
      "/v1/refunds",
      {
        method: "POST",
        body: new URLSearchParams({
          payment_intent: providerId(input.stripePaymentIntentId, "pi_"),
          amount: positiveMinor(input.amountMinor),
          refund_application_fee: "true",
        }),
        idempotencyKey: input.idempotencyKey,
      },
    );
    return { id: responseId(response, "re_") };
  }

  async cancelImmediately(
    input: Parameters<CommerceFinancialOperationsProvider["cancelImmediately"]>[0],
  ): Promise<void> {
    await this.stripe.requestForConnectedAccount(
      accountId(input.connectedAccountId),
      `/v1/subscriptions/${encodeURIComponent(providerId(input.stripeSubscriptionId, "sub_"))}`,
      { method: "DELETE", idempotencyKey: input.idempotencyKey },
    );
  }

  async cancelAtPeriodEnd(
    input: Parameters<CommerceFinancialOperationsProvider["cancelAtPeriodEnd"]>[0],
  ): Promise<void> {
    await this.stripe.requestForConnectedAccount(
      accountId(input.connectedAccountId),
      `/v1/subscriptions/${encodeURIComponent(providerId(input.stripeSubscriptionId, "sub_"))}`,
      {
        method: "POST",
        body: new URLSearchParams({ cancel_at_period_end: "true" }),
        idempotencyKey: input.idempotencyKey,
      },
    );
  }

  async disconnect(
    input: Parameters<CommerceFinancialOperationsProvider["disconnect"]>[0],
  ): Promise<void> {
    await this.stripe.deleteConnectedAccount(
      accountId(input.connectedAccountId),
      input.idempotencyKey,
    );
  }
}

function responseId(value: unknown, prefix: string): string {
  if (!isRecord(value) || typeof value.id !== "string") {
    throw new Error("Stripe returned an invalid response.");
  }
  return providerId(value.id, prefix);
}

function accountId(value: string): string {
  return providerId(value, "acct_");
}

function providerId(value: string, prefix: string): string {
  if (!value.startsWith(prefix) || !/^[A-Za-z0-9_]+$/.test(value)) {
    throw new Error("Stripe object scope is invalid.");
  }
  return value;
}

function positiveMinor(value: number): string {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Refund amount is invalid.");
  }
  return String(value);
}
