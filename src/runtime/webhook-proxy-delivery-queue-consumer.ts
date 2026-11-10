import type { QueueBatch } from "./queue-types";
import type { Env } from "../env";
import {
  WebhookProxyService,
  type WebhookProxyDeliveryEnvelope,
  type WebhookProxyDeliveryResult,
} from "../services/webhook-proxy-service";
import { createCloudflareContext } from "./cloudflare-context";
import { isRecord } from "../unknown-parse";
import { OperationalIncidentService } from "../operations/incidents";
import { GuildServicePolicy } from "./guild-service-policy";
import {
  classifyQueueDeliveryError,
  DEFAULT_QUEUE_MAX_ATTEMPTS,
  deliverQueueBatch,
  queueDeliveryEmitter,
} from "./queue-delivery";

export const WEBHOOK_PROXY_DELIVERY_QUEUE_NAME = "haf-bot-webhook-proxy-deliveries";

export interface WebhookProxyDeliveryQueueLogger {
  error(...args: unknown[]): void;
  info?(...args: unknown[]): void;
}

export async function handleWebhookProxyDeliveryQueueBatch(
  batch: QueueBatch<unknown>,
  env: Env,
  logger: WebhookProxyDeliveryQueueLogger = console,
): Promise<void> {
  const context = createCloudflareContext(env);
  const guildServicePolicy = new GuildServicePolicy(context.stores.guildServiceSuspensions);
  const service = new WebhookProxyService(context.stores.webhookProxy, {
    persistDeliveryLogs: context.webhookProxyLogPersistenceEnabled,
    guildEntitlements: context.stores.guildEntitlements,
    isGuildSuspended: (guildId) => guildServicePolicy.isGuildSuspended(guildId),
    credentialService: context.webhookCredentialService,
    operationalIncidents: new OperationalIncidentService(context.stores.operationalIncidents),
  });

  await deliverWebhookProxyDeliveryQueueBatch(batch, service, logger);
}

export async function deliverWebhookProxyDeliveryQueueBatch(
  batch: QueueBatch<unknown>,
  service: {
    deliverQueuedWebhook(
      delivery: WebhookProxyDeliveryEnvelope,
    ): Promise<WebhookProxyDeliveryResult>;
  },
  logger: WebhookProxyDeliveryQueueLogger = console,
): Promise<void> {
  await deliverQueueBatch(batch, {
    maxAttempts: DEFAULT_QUEUE_MAX_ATTEMPTS,
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

  if (message.version === 2) {
    const destinations = message.destinations.flatMap((destination) => {
      if (!isRecord(destination)) return [];
      const destinationId = asString(destination.destinationId);
      const credentialId = asString(destination.credentialId);
      return destinationId && credentialId ? [{ destinationId, credentialId }] : [];
    });
    if (destinations.length === 0) return null;
    return {
      version: 2,
      config: { guildId, publicId },
      destinations,
      body,
      contentType,
    };
  }

  const destinations = message.destinations.flatMap((destination) => {
    if (!isRecord(destination)) return [];
    const id = asString(destination.id);
    const label = asString(destination.label);
    const url = asString(destination.url);
    return id && label && url ? [{ id, label, url }] : [];
  });
  if (destinations.length === 0) return null;
  return {
    version: 1,
    config: { guildId, publicId },
    destinations,
    body,
    contentType,
  };
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
