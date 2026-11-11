import type { QueueJobMetadata } from "../../src/runtime/queue-types";

import type { Env } from "./test-env";

import { createSqliteContext } from "./sqlite/runtime/sqlite-context";

import { createServiceFactory } from "../../src/runtime/service-factory";
import { deliverTicketRecovery } from "../../src/runtime/ticket-recovery-queue-consumer";
export async function handleTicketRecovery(payload: unknown, metadata: QueueJobMetadata, env: Env) {
  const context = createSqliteContext(env);
  const services = createServiceFactory({
    stores: context.stores,
    discordBotToken: env.DISCORD_BOT_TOKEN,
  });
  return deliverTicketRecovery(
    payload,
    metadata,
    services.ticketLifecycle,
    services.ticketPanelService,
    env.DISCORD_BOT_TOKEN,
  );
}
export * from "../../src/runtime/ticket-recovery-queue-consumer";
