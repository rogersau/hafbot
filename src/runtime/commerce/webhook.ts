import { isRecord } from "../../unknown-parse";

/** The initial Connect event surface. Other verified events are acknowledged and ignored. */
export const SUPPORTED_COMMERCE_STRIPE_EVENT_TYPES = new Set([
  "account.application.deauthorized",
  "account.closed",
  "account.external_account.created",
  "account.external_account.deleted",
  "account.external_account.updated",
  "account.updated",
  "capability.updated",
  "charge.dispute.closed",
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.failed",
  "charge.refunded",
  "charge.succeeded",
  "charge.updated",
  "checkout.session.async_payment_failed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.completed",
  "checkout.session.expired",
  "customer.subscription.created",
  "customer.subscription.deleted",
  "customer.subscription.updated",
  "invoice.finalization_failed",
  "invoice.marked_uncollectible",
  "invoice.paid",
  "invoice.payment_action_required",
  "invoice.payment_failed",
  "invoice.upcoming",
  "invoice.voided",
  "payment_intent.canceled",
  "payment_intent.payment_failed",
  "payment_intent.processing",
  "payment_intent.succeeded",
  "person.created",
  "person.deleted",
  "person.updated",
  "refund.created",
  "refund.failed",
  "refund.updated",
]);

export interface CommerceWebhookMetadata {
  eventId: string;
  eventType: string;
  objectId: string | null;
  connectedAccountId: string;
  providerCreatedAtMs: number;
  payloadHash: string;
  apiVersion: string | null;
}

export interface CommerceWebhookStore {
  accept(
    event: CommerceWebhookMetadata,
  ): Promise<{ accepted: boolean; outboxPending: boolean; generation: number }>;
  markOutboxSent(eventId: string, connectedAccountId: string, sentAtMs: number): Promise<void>;
}

export interface CommerceSyncQueueMessage {
  eventId: string;
  connectedAccountId: string;
  resourceType: "seller";
  resourceId: string;
  generation: number;
}

export interface CommerceSyncQueueSender {
  send(message: CommerceSyncQueueMessage): Promise<unknown>;
}

/** Alias retained for callers that describe the handler as a Connect webhook. */
export const createCommerceConnectWebhookHandler = createCommerceStripeWebhookHandler;

export function createCommerceStripeWebhookHandler(options: {
  secret: string;
  store: CommerceWebhookStore;
  queue: CommerceSyncQueueSender;
  now?: () => number;
  toleranceSeconds?: number;
}) {
  const now = options.now ?? Date.now;
  return async (request: Request): Promise<Response | null> => {
    if (new URL(request.url).pathname !== "/api/commerce/stripe-webhook") return null;
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const rawBody = await request.text();
    const signature = request.headers.get("stripe-signature");
    if (
      !signature ||
      !(await verifyStripeSignature({
        rawBody,
        signature,
        secret: options.secret,
        nowMs: now(),
        toleranceSeconds: options.toleranceSeconds,
      }))
    ) {
      return Response.json({ error: "Invalid Stripe signature" }, { status: 400 });
    }

    const parsed = await parseCommerceWebhook(rawBody);
    if (parsed === null) return Response.json({ error: "Malformed Stripe event" }, { status: 400 });
    if (!SUPPORTED_COMMERCE_STRIPE_EVENT_TYPES.has(parsed.eventType)) {
      return Response.json({ received: true, ignored: true }, { status: 200 });
    }

    const accepted = await options.store.accept(parsed);
    if (accepted.outboxPending) {
      try {
        await options.queue.send({
          eventId: parsed.eventId,
          connectedAccountId: parsed.connectedAccountId,
          resourceType: "seller",
          resourceId: parsed.connectedAccountId,
          generation: accepted.generation,
        });
        await options.store.markOutboxSent(parsed.eventId, parsed.connectedAccountId, now());
      } catch {
        // The durable outbox repair sweep owns retries for this gap. Stripe still receives 200.
      }
    }
    return Response.json({ received: true, duplicate: !accepted.accepted }, { status: 200 });
  };
}

export async function verifyStripeSignature(input: {
  rawBody: string;
  signature: string;
  secret: string;
  nowMs: number;
  toleranceSeconds?: number;
}): Promise<boolean> {
  const parts = input.signature.split(",").map((part) => part.trim().split("=", 2));
  const timestampText = parts.find(([key]) => key === "t")?.[1];
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value ?? "");
  const timestamp = Number(timestampText);
  const tolerance = input.toleranceSeconds ?? 300;
  if (
    !Number.isInteger(timestamp) ||
    Math.abs(Math.floor(input.nowMs / 1_000) - timestamp) > tolerance
  ) {
    return false;
  }
  const expected = await hmacHex(input.secret, `${timestamp}.${input.rawBody}`);
  return signatures.some((candidate) => constantTimeEqualHex(candidate, expected));
}

async function parseCommerceWebhook(rawBody: string): Promise<CommerceWebhookMetadata | null> {
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!isRecord(value) || !isRecord(value.data) || !isRecord(value.data.object)) return null;

  const eventId = asString(value.id);
  const eventType = asString(value.type);
  const connectedAccountId = asString(value.account);
  const providerCreatedAtSeconds = value.created;
  const objectId = asString(value.data.object.id);
  if (
    !eventId ||
    !eventType ||
    !connectedAccountId?.match(/^acct_[A-Za-z0-9]+$/) ||
    typeof providerCreatedAtSeconds !== "number" ||
    !Number.isSafeInteger(providerCreatedAtSeconds) ||
    providerCreatedAtSeconds < 0
  ) {
    return null;
  }

  return {
    eventId,
    eventType,
    objectId,
    connectedAccountId,
    providerCreatedAtMs: providerCreatedAtSeconds * 1_000,
    payloadHash: await sha256Hex(rawBody),
    apiVersion: asString(value.api_version),
  };
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToHex(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
}

async function sha256Hex(value: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function constantTimeEqualHex(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function bytesToHex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
