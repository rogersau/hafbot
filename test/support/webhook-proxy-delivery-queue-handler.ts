import type { QueueJobMetadata } from "../../src/runtime/queue-types";
import type { Env } from "./test-env";
import { WebhookProxyService } from "../../src/services/webhook-proxy-service";
import { createSqliteContext } from "./sqlite/runtime/sqlite-context";

import { OperationalIncidentService } from "../../src/operations/incidents";
import { GuildServicePolicy } from "../../src/runtime/guild-service-policy";

import {
  deliverWebhookProxyDelivery,
  type WebhookProxyDeliveryQueueLogger,
} from "../../src/runtime/webhook-proxy-delivery-queue-consumer";
export async function handleWebhookProxyDelivery(
  payload: unknown,
  metadata: QueueJobMetadata,
  env: Env,
  logger: WebhookProxyDeliveryQueueLogger = console,
) {
  const context = createSqliteContext(env);
  const guildServicePolicy = new GuildServicePolicy(context.stores.guildServiceSuspensions);
  const service = new WebhookProxyService(context.stores.webhookProxy, {
    persistDeliveryLogs: context.webhookProxyLogPersistenceEnabled,
    guildEntitlements: context.stores.guildEntitlements,
    isGuildSuspended: (guildId) => guildServicePolicy.isGuildSuspended(guildId),
    credentialService: context.webhookCredentialService,
    operationalIncidents: new OperationalIncidentService(context.stores.operationalIncidents),
  });

  return deliverWebhookProxyDelivery(payload, metadata, service, logger);
}
export * from "../../src/runtime/webhook-proxy-delivery-queue-consumer";
