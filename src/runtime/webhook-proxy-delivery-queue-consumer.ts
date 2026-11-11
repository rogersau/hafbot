import type { QueueJobMetadata } from "./queue-types";

import {
  type WebhookProxyDeliveryEnvelope,
  type WebhookProxyDeliveryResult,
} from "../services/webhook-proxy-service";

import { isRecord } from "../unknown-parse";

import {
  classifyQueueDeliveryError,
  deliverQueueJob,
  queueDeliveryEmitter,
  type QueueDeliveryOutcome,
} from "./queue-delivery";

export const WEBHOOK_PROXY_DELIVERY_QUEUE_NAME = "haf-bot-webhook-proxy-deliveries";

export interface WebhookProxyDeliveryQueueLogger {
  error(...args: unknown[]): void;
  info?(...args: unknown[]): void;
}

export async function deliverWebhookProxyDelivery(
  payload: unknown,
  metadata: QueueJobMetadata,
  service: {
    deliverQueuedWebhook(
      delivery: WebhookProxyDeliveryEnvelope,
    ): Promise<WebhookProxyDeliveryResult>;
  },
  logger: WebhookProxyDeliveryQueueLogger = console,
): Promise<QueueDeliveryOutcome> {
  return deliverQueueJob(payload, {
    metadata,
    parse(body) {
      const delivery = parseWebhookProxyDeliveryEnvelope(body);
      return delivery
        ? { ok: true, value: delivery }
        : { ok: false, reasonCode: "invalid_webhook_delivery" };
    },
    async handle(delivery) {
      return service.deliverQueuedWebhook(delivery);
    },
    classifyError: classifyQueueDeliveryError,
    emit: queueDeliveryEmitter(logger),
  });
}

function parseWebhookProxyDeliveryEnvelope(message: unknown): WebhookProxyDeliveryEnvelope | null {
  if (!isRecord(message) || !isRecord(message.config) || !Array.isArray(message.destinations)) {
    return null;
  }

  const guildId = asString(message.config.guildId);
  const publicId = asString(message.config.publicId);
  const body = asString(message.body);
  const contentType = message.contentType === null ? null : asString(message.contentType);
  if (!guildId || !publicId || body === null) return null;
  if (message.contentType !== null && contentType === null) return null;

  if (message.version !== 2) return null;
  const destinations = message.destinations.flatMap((destination) => {
    if (!isRecord(destination)) return [];
    const destinationId = asString(destination.destinationId);
    const credentialId = asString(destination.credentialId);
    return destinationId && credentialId ? [{ destinationId, credentialId }] : [];
  });
  if (!destinations.length || destinations.length !== message.destinations.length) return null;
  return { version: 2, config: { guildId, publicId }, destinations, body, contentType };
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
