import type { PaidRoleProviderSubscriptionOperations } from "../../commerce/paid-role-entitlement";
import type { StripeConnectClient } from "./stripe-connect-client";

export class StripePaidRoleSubscriptionOperations implements PaidRoleProviderSubscriptionOperations {
  constructor(private readonly stripe: Pick<StripeConnectClient, "requestForConnectedAccount">) {}

  async cancelAtPeriodEnd(input: {
    connectedAccountId: string;
    subscriptionId: string;
    idempotencyKey: string;
  }): Promise<void> {
    if (!/^acct_[A-Za-z0-9]+$/.test(input.connectedAccountId)) {
      throw new Error("Connected Account ID is required.");
    }
    if (!/^sub_[A-Za-z0-9]+$/.test(input.subscriptionId)) {
      throw new Error("Stripe Subscription ID is required.");
    }
    await this.stripe.requestForConnectedAccount(
      input.connectedAccountId,
      `/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
      {
        method: "POST",
        body: new URLSearchParams({ cancel_at_period_end: "true" }),
        idempotencyKey: input.idempotencyKey,
      },
    );
  }

  async cancelImmediately(input: {
    connectedAccountId: string;
    subscriptionId: string;
    idempotencyKey: string;
  }): Promise<void> {
    if (!/^acct_[A-Za-z0-9]+$/.test(input.connectedAccountId)) {
      throw new Error("Connected Account ID is required.");
    }
    if (!/^sub_[A-Za-z0-9]+$/.test(input.subscriptionId)) {
      throw new Error("Stripe Subscription ID is required.");
    }
    await this.stripe.requestForConnectedAccount(
      input.connectedAccountId,
      `/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
      { method: "DELETE", idempotencyKey: input.idempotencyKey },
    );
  }
}
