import type { QueueBatch } from "../../src/runtime/queue-types";

import type { Env } from "./test-env";

import { createSqliteContext } from "./sqlite/runtime/sqlite-context";

import { createServiceFactory } from "../../src/runtime/service-factory";
import { deliverTicketRecoveryQueueBatch } from "../../src/runtime/ticket-recovery-queue-consumer";
export async function handleTicketRecoveryQueueBatch(
  batch: QueueBatch<unknown>,
  env: Env,
): Promise<void> {
  const context = createSqliteContext(env);
  const services = createServiceFactory({
    stores: context.stores,
    discordBotToken: env.DISCORD_BOT_TOKEN,
  });
  await deliverTicketRecoveryQueueBatch(
    batch,
    services.ticketLifecycle,
    services.ticketPanelService,
    env.DISCORD_BOT_TOKEN,
  );
}
export * from "../../src/runtime/ticket-recovery-queue-consumer";
