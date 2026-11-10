import { isRecord } from "../../unknown-parse";

const SUPPORTED_STRIPE_EVENT_TYPES = new Set([
  "charge.dispute.closed",
  "charge.dispute.created",
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.deleted",
  "customer.subscription.updated",
  "invoice.finalization_failed",
  "invoice.paid",
  "invoice.payment_action_required",
  "invoice.payment_failed",
  "subscription_schedule.canceled",
  "subscription_schedule.completed",
  "subscription_schedule.released",
  "subscription_schedule.updated",
]);

export interface VerifiedBillingWebhook {
  eventId: string;
  eventType: string;
  objectId: string | null;
  customerId: string;
  createdAtMs: number;
  payloadHash: string;
}

export interface BillingWebhookStore {
  accept(event: VerifiedBillingWebhook): Promise<{ accepted: boolean; outboxPending: boolean }>;
  markOutboxSent(eventId: string, sentAtMs: number): Promise<void>;
}

export interface BillingSyncQueueSender {
  send(message: BillingSyncQueueMessage): Promise<unknown>;
}

export interface BillingSyncQueueMessage {
  eventId: string;
  customerId: string;
}

export interface StripeWebhookCustomerResolver {
  resolveChargeCustomer(chargeId: string): Promise<string>;
}

export function createStripeWebhookHandler(options: {
  secret: string;
  store: BillingWebhookStore;
  queue: BillingSyncQueueSender;
  customerResolver?: StripeWebhookCustomerResolver;
  now?: () => number;
  toleranceSeconds?: number;
}) {
  const now = options.now ?? Date.now;
  return async (request: Request): Promise<Response | null> => {
    if (new URL(request.url).pathname !== "/api/billing/stripe-webhook") return null;
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
    const eventType = readStripeEventType(rawBody);
    if (!eventType) return Response.json({ error: "Malformed Stripe event" }, { status: 400 });
    if (hasConnectedAccountContext(rawBody)) {
      return Response.json(
        { error: "Connected-account events must use the Commerce webhook" },
        { status: 400 },
      );
    }
    if (!SUPPORTED_STRIPE_EVENT_TYPES.has(eventType)) {
      return Response.json({ received: true, ignored: true }, { status: 200 });
    }
    const event = await parseVerifiedStripeEvent(rawBody, options.customerResolver);
    if (!event) return Response.json({ error: "Unsupported Stripe event" }, { status: 400 });
    const accepted = await options.store.accept(event);
    if (accepted.outboxPending) {
      try {
        await options.queue.send({ eventId: event.eventId, customerId: event.customerId });
        await options.store.markOutboxSent(event.eventId, now());
      } catch {
        // The durable outbox sweep repairs this gap.
      }
    }
    return Response.json({ received: true, duplicate: !accepted.accepted }, { status: 200 });
  };
}

function hasConnectedAccountContext(rawBody: string): boolean {
  try {
    const value: unknown = JSON.parse(rawBody);
    return isRecord(value) && typeof value.account === "string" && value.account.length > 0;
  } catch {
    return false;
  }
}

function readStripeEventType(rawBody: string): string | null {
  try {
    const value: unknown = JSON.parse(rawBody);
    return isRecord(value) ? asString(value.type) : null;
  } catch {
    return null;
  }
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

async function parseVerifiedStripeEvent(
  rawBody: string,
  customerResolver?: StripeWebhookCustomerResolver,
): Promise<VerifiedBillingWebhook | null> {
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!isRecord(value) || !isRecord(value.data) || !isRecord(value.data.object)) return null;
  const object = value.data.object;
  const eventId = asString(value.id);
  const eventType = asString(value.type);
  let customer = isRecord(object.customer)
    ? asString(object.customer.id)
    : asString(object.customer);
  const objectId = asString(object.id);
  if (!customer && customerResolver && isChargeRelatedEvent(eventType)) {
    const chargeId = isRecord(object.charge) ? asString(object.charge.id) : asString(object.charge);
    if (chargeId) customer = await customerResolver.resolveChargeCustomer(chargeId);
  }
  if (!eventId || !eventType || !customer) return null;
  return {
    eventId,
    eventType,
    objectId,
    customerId: customer,
    createdAtMs: typeof value.created === "number" ? value.created * 1_000 : 0,
    payloadHash: await sha256Hex(rawBody),
  };
}

function isChargeRelatedEvent(eventType: string | null): boolean {
  return (
    eventType?.startsWith("charge.dispute.") === true || eventType?.startsWith("refund.") === true
  );
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
