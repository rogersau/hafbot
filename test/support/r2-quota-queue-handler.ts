import type { QueueBatch } from "../../src/runtime/queue-types";
import type { Env } from "./test-env";

import { createSqliteContext } from "./sqlite/runtime/sqlite-context";

import {
  deliverR2QuotaQueueBatch,
  type R2QuotaQueueLogger,
} from "../../src/runtime/r2-quota-queue-consumer";
export async function handleR2QuotaQueueBatch(
  batch: QueueBatch<unknown>,
  env: Env,
  logger: R2QuotaQueueLogger = console,
): Promise<void> {
  const context = createSqliteContext(env);
  await deliverR2QuotaQueueBatch(batch, context.stores.guildR2Objects, logger);
}
export * from "../../src/runtime/r2-quota-queue-consumer";
