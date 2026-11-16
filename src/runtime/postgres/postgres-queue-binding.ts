import type { QueueProducer } from "../queue-types";
import type { PostgresDatabaseCapability } from "./postgres-capability";
import type { PortableQueueName, PostgresJobQueue } from "./postgres-job-queue";

const MAX_BATCH_SIZE = 100;
const MAX_DELAY_SECONDS = 86_400;

/** Durable producer backed by the PostgreSQL jobs table. */
export function createPostgresQueueBinding<Body>(input: {
  database: PostgresDatabaseCapability;
  jobs: PostgresJobQueue;
  queueName: PortableQueueName;
}): QueueProducer<Body> {
  return {
    async send(body, options) {
      await input.jobs.enqueue({
        queueName: input.queueName,
        payload: body,
        availableAt: availableAt(options?.delaySeconds),
      });
    },

    async sendBatch(messages, options) {
      const requests = [...messages];
      if (requests.length === 0 || requests.length > MAX_BATCH_SIZE) {
        throw new Error(`PostgreSQL Queue batches must contain 1 to ${MAX_BATCH_SIZE} messages.`);
      }
      await input.database.transaction(async (transaction) => {
        for (const request of requests) {
          await input.jobs.enqueue(
            {
              queueName: input.queueName,
              payload: request.body,
              availableAt: availableAt(request.delaySeconds ?? options?.delaySeconds),
            },
            transaction,
          );
        }
      });
    },
  };
}

function availableAt(delaySeconds: number | undefined): Date {
  if (delaySeconds === undefined) return new Date();
  if (!Number.isSafeInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > MAX_DELAY_SECONDS) {
    throw new Error(`Queue delaySeconds must be between 0 and ${MAX_DELAY_SECONDS}.`);
  }
  return new Date(Date.now() + delaySeconds * 1_000);
}
