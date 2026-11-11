import type { Env } from "./test-env";
import type { QueueJobMetadata } from "../../src/runtime/queue-types";
import type { GatewayEventDependencies } from "../../src/runtime/gateway-events/capabilities";
import * as consumer from "../../src/runtime/gateway-event-queue-consumer";
import { sqliteGatewayDependencies } from "./sqlite-gateway-dependencies";
export type {
  GatewayEventEnvelope,
  GatewayEventQueueLogger,
} from "../../src/runtime/gateway-event-queue-consumer";
export const GATEWAY_EVENT_QUEUE_NAME = consumer.GATEWAY_EVENT_QUEUE_NAME;
export async function deliverGatewayEvent(
  payload: unknown,
  metadata: QueueJobMetadata,
  env: Env,
  logger: consumer.GatewayEventQueueLogger = console,
  overrides: Partial<GatewayEventDependencies> = {},
) {
  return consumer.deliverGatewayEvent(payload, metadata, env, logger, {
    ...sqliteGatewayDependencies(env),
    ...overrides,
  });
}
export async function processGatewayEventQueueMessages(
  messages: unknown[],
  env: Env,
  logger: consumer.GatewayEventQueueLogger = console,
  overrides: Partial<GatewayEventDependencies> = {},
) {
  return consumer.processGatewayEventQueueMessages(messages, env, logger, {
    ...sqliteGatewayDependencies(env),
    ...overrides,
  });
}
