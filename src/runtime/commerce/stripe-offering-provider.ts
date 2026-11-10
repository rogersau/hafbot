import type { CommerceOfferingProvider } from "../../commerce/offering-service";
import type { CommerceRecurringInterval } from "../../commerce/types";
import { isRecord } from "../../unknown-parse";
import type { StripeConnectClient } from "./stripe-connect-client";

/** Stripe Product/Price operations for a connected seller. */
export class StripeCommerceOfferingProvider implements CommerceOfferingProvider {
  constructor(private readonly stripe: Pick<StripeConnectClient, "requestForConnectedAccount">) {}

  async createProduct(input: {
    connectedAccountId: string;
    name: string;
    description: string | null;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<{ id: string; createdAtMs: number | null }> {
    const body = new URLSearchParams({ name: input.name });
    if (input.description) body.set("description", input.description);
    setMetadata(body, input.metadata);
    const value = await this.stripe.requestForConnectedAccount(
      input.connectedAccountId,
      "/v1/products",
      {
        method: "POST",
        body,
        idempotencyKey: input.idempotencyKey,
      },
    );
    return parseResource(value, "prod_");
  }

  async createPrice(input: {
    connectedAccountId: string;
    productId: string;
    currency: "AUD" | "USD";
    unitAmountMinor: number;
    recurringInterval: CommerceRecurringInterval;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<{ id: string; createdAtMs: number | null }> {
    if (!/^prod_[A-Za-z0-9]+$/.test(input.productId))
      throw new Error("Stripe Product ID is required.");
    const body = new URLSearchParams({
      product: input.productId,
      currency: input.currency.toLowerCase(),
      unit_amount: String(input.unitAmountMinor),
      "recurring[interval]": input.recurringInterval,
    });
    setMetadata(body, input.metadata);
    const value = await this.stripe.requestForConnectedAccount(
      input.connectedAccountId,
      "/v1/prices",
      {
        method: "POST",
        body,
        idempotencyKey: input.idempotencyKey,
      },
    );
    return parseResource(value, "price_");
  }

  async retirePrice(input: {
    connectedAccountId: string;
    priceId: string;
    idempotencyKey: string;
  }): Promise<void> {
    if (!/^price_[A-Za-z0-9]+$/.test(input.priceId))
      throw new Error("Stripe Price ID is required.");
    await this.stripe.requestForConnectedAccount(
      input.connectedAccountId,
      `/v1/prices/${encodeURIComponent(input.priceId)}`,
      {
        method: "POST",
        body: new URLSearchParams({ active: "false" }),
        idempotencyKey: input.idempotencyKey,
      },
    );
  }
}

function setMetadata(body: URLSearchParams, metadata: Record<string, string>): void {
  for (const [key, value] of Object.entries(metadata)) {
    if (!/^haf_[a-z0-9_]+$/.test(key) || !/^[A-Za-z0-9:_-]{1,100}$/.test(value)) {
      throw new Error("commerce_provider_metadata_invalid");
    }
    body.set(`metadata[${key}]`, value);
  }
}

function parseResource(
  value: unknown,
  prefix: "prod_" | "price_",
): { id: string; createdAtMs: number | null } {
  if (!isRecord(value)) throw new Error("commerce_provider_response_invalid");
  const row = value;
  if (typeof row.id !== "string" || !row.id.startsWith(prefix)) {
    throw new Error("commerce_provider_response_invalid");
  }
  return {
    id: row.id,
    createdAtMs:
      typeof row.created === "number" && Number.isFinite(row.created) ? row.created * 1_000 : null,
  };
}
