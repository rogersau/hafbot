import type { QueueJobMetadata } from "../../src/runtime/queue-types";

import type { Env } from "./test-env";

import { createSqliteContext } from "./sqlite/runtime/sqlite-context";

import { deliverTicketRecovery } from "../../src/runtime/ticket-recovery-queue-consumer";

export async function handleTicketRecovery(payload: unknown, metadata: QueueJobMetadata, env: Env) {
  // One composed context graph; the direct delivery consumes its selected
  // Ticket lifecycle and panel services rather than rebuilding a factory.
  const context = createSqliteContext(env);
  return deliverTicketRecovery(
    payload,
    metadata,
    context.services.ticketLifecycle,
    context.services.ticketPanelService,
    env.DISCORD_BOT_TOKEN,
  );
}
export * from "../../src/runtime/ticket-recovery-queue-consumer";
