import type { QueueJobMetadata } from "../../src/runtime/queue-types";
import type { Env } from "./test-env";

import { createSqliteContext } from "./sqlite/runtime/sqlite-context";

import { deliverR2Quota, type R2QuotaQueueLogger } from "../../src/runtime/r2-quota-queue-consumer";
export async function handleR2Quota(
  payload: unknown,
  metadata: QueueJobMetadata,
  env: Env,
  logger: R2QuotaQueueLogger = console,
) {
  const context = createSqliteContext(env);
  return deliverR2Quota(payload, metadata, context.stores.guildR2Objects, logger);
}
export * from "../../src/runtime/r2-quota-queue-consumer";
