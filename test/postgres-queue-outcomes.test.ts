import assert from "node:assert/strict";
import test from "node:test";

import {
  createPostgresDatabaseCapabilityFromEnvironment,
  type PostgresDatabaseCapability,
} from "../src/runtime/postgres/postgres-capability";
import { createPostgresJobQueue } from "../src/runtime/postgres/postgres-job-queue";
import {
  createPostgresJobWorker,
  type PostgresJobHandler,
} from "../src/runtime/postgres/postgres-job-worker";
import { initializePostgresSchema } from "../src/runtime/postgres/postgres-schema";
import { deliverBillingSync } from "../src/runtime/billing/postgres-runtime";
import type { BillingSyncQueueMessage } from "../src/runtime/billing/webhook";

const postgresUrl = process.env.TEST_POSTGRES_URL;
const postgresOnly = { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" };

test(
  "PostgreSQL native job worker persists retry delay and exact exhaustion reason across restart",
  postgresOnly,
  async () => {
    assert.ok(postgresUrl);
    assertSafeTestDatabase(postgresUrl);
    const database = createTestDatabase(postgresUrl);
    try {
      await initializeFreshTestSchema(database);
      const queue = createPostgresJobQueue(database);
      const startedAt = new Date("2026-11-05T00:00:00.000Z");
      const completeJob = await queue.enqueue({
        id: "complete-job",
        queueName: "gateway-events",
        payload: { kind: "complete" },
        maxAttempts: 2,
        availableAt: startedAt,
      });
      const retryJob = await queue.enqueue({
        id: "retry-job",
        queueName: "billing-sync",
        payload: { kind: "retry" },
        maxAttempts: 2,
        availableAt: startedAt,
      });
      const attemptsByJob = new Map<string, number[]>();
      const maxAttemptsByJob = new Map<string, number>();
      const firstWorker = createPostgresJobWorker({
        queue,
        ownerId: "native-outcomes-first",
        leaseMs: 500,
        pollIntervalMs: 10,
        now: () => startedAt,
        handlers: {
          "gateway-events": async (_payload, context) => {
            recordContext(context, attemptsByJob, maxAttemptsByJob);
            return { status: "complete" };
          },
          "billing-sync": async (_payload, context) => {
            recordContext(context, attemptsByJob, maxAttemptsByJob);
            return {
              status: "retry",
              reasonCode: "provider_rate_limited",
              delaySeconds: 37,
            };
          },
        },
      });
      await firstWorker.start();
      try {
        await waitFor(
          async () =>
            (await queue.inspect(completeJob.id))?.state === "completed" &&
            (await queue.inspect(retryJob.id))?.attempts === 1 &&
            (await queue.inspect(retryJob.id))?.state === "queued",
        );
      } finally {
        await firstWorker.stop();
      }

      const complete = await queue.inspect(completeJob.id);
      const delayed = await queue.inspect(retryJob.id);
      assert.deepEqual(
        {
          state: complete?.state,
          attempts: complete?.attempts,
          terminal: complete?.terminalReasonCode,
        },
        { state: "completed", attempts: 1, terminal: null },
      );
      assert.deepEqual(
        {
          state: delayed?.state,
          attempts: delayed?.attempts,
          maxAttempts: delayed?.maxAttempts,
          terminal: delayed?.terminalReasonCode,
          delayMs: delayed!.availableAt.getTime() - startedAt.getTime(),
        },
        {
          state: "queued",
          attempts: 1,
          maxAttempts: 2,
          terminal: null,
          delayMs: 37_000,
        },
      );
      assert.deepEqual(attemptsByJob.get(retryJob.id), [1]);
      assert.equal(maxAttemptsByJob.get(retryJob.id), 2);
      assert.equal(firstWorker.status().retried, 1);
      assert.equal(firstWorker.status().terminal, 0);

      const restartedAt = new Date(delayed!.availableAt);
      const secondWorker = createPostgresJobWorker({
        queue,
        ownerId: "native-outcomes-restart",
        leaseMs: 500,
        pollIntervalMs: 10,
        now: () => restartedAt,
        handlers: {
          "billing-sync": async (_payload, context) => {
            recordContext(context, attemptsByJob, maxAttemptsByJob);
            return {
              status: "retry",
              reasonCode: "provider_rate_limited",
              delaySeconds: 0,
            };
          },
        },
      });
      await secondWorker.start();
      try {
        await waitFor(async () => (await queue.inspect(retryJob.id))?.state === "terminal");
      } finally {
        await secondWorker.stop();
      }

      const exhausted = await queue.inspect(retryJob.id);
      assert.deepEqual(
        {
          state: exhausted?.state,
          attempts: exhausted?.attempts,
          maxAttempts: exhausted?.maxAttempts,
          terminal: exhausted?.terminalReasonCode,
        },
        {
          state: "terminal",
          attempts: 2,
          maxAttempts: 2,
          terminal: "provider_rate_limited",
        },
      );
      assert.deepEqual(attemptsByJob.get(retryJob.id), [1, 2]);
      assert.equal(maxAttemptsByJob.get(retryJob.id), 2);
      assert.equal(secondWorker.status().retried, 0);
      assert.equal(secondWorker.status().terminal, 1);
    } finally {
      await database.close();
    }
  },
);

test(
  "PostgreSQL native job worker never fabricates completion for missing or invalid outcomes",
  postgresOnly,
  async () => {
    assert.ok(postgresUrl);
    assertSafeTestDatabase(postgresUrl);
    const database = createTestDatabase(postgresUrl);
    try {
      await initializeFreshTestSchema(database);
      const queue = createPostgresJobQueue(database);
      await queue.enqueue({
        id: "missing-outcome",
        queueName: "ticket-recovery",
        payload: { kind: "missing" },
        maxAttempts: 1,
      });
      await queue.enqueue({
        id: "invalid-outcome",
        queueName: "ticket-recovery",
        payload: { kind: "invalid" },
        maxAttempts: 1,
      });
      const errors: unknown[] = [];
      const worker = createPostgresJobWorker({
        queue,
        ownerId: "native-invalid-outcome",
        leaseMs: 500,
        pollIntervalMs: 10,
        onError(error) {
          errors.push(error);
        },
        handlers: {
          "ticket-recovery": (async (payload: unknown) =>
            (payload as { kind: string }).kind === "missing"
              ? undefined
              : { status: "retry" }) as unknown as PostgresJobHandler,
        },
      });
      await worker.start();
      try {
        await waitFor(async () => {
          const missing = await queue.inspect("missing-outcome");
          const invalid = await queue.inspect("invalid-outcome");
          return missing?.state === "terminal" && invalid?.state === "terminal";
        });
      } finally {
        await worker.stop();
      }

      assert.deepEqual(
        (await queue.inspect("missing-outcome"))?.terminalReasonCode,
        "missing_delivery_outcome",
      );
      assert.deepEqual(
        (await queue.inspect("invalid-outcome"))?.terminalReasonCode,
        "missing_delivery_outcome",
      );
      assert.equal((await queue.inspect("missing-outcome"))?.attempts, 1);
      assert.equal((await queue.inspect("invalid-outcome"))?.attempts, 1);
      assert.equal(worker.status().processed, 2);
      assert.equal(worker.status().terminal, 2);
      assert.equal(worker.status().retried, 0);
      assert.equal(errors.length, 2);
    } finally {
      await database.close();
    }
  },
);

test(
  "PostgreSQL job worker fences a stale lease after takeover without reporting completion",
  postgresOnly,
  async () => {
    assert.ok(postgresUrl);
    assertSafeTestDatabase(postgresUrl);
    const database = createTestDatabase(postgresUrl);
    try {
      await initializeFreshTestSchema(database);
      const queue = createPostgresJobQueue(database);
      const job = await queue.enqueue({
        id: "fenced-job",
        queueName: "ticket-recovery",
        payload: { kind: "fenced" },
        maxAttempts: 3,
      });
      const entered = deferred();
      const release = deferred();
      const worker = createPostgresJobWorker({
        queue,
        ownerId: "native-fenced",
        leaseMs: 60_000,
        pollIntervalMs: 10,
        handlers: {
          "ticket-recovery": async () => {
            entered.resolve();
            await release.promise;
            return { status: "complete" };
          },
        },
      });
      await worker.start();
      try {
        await entered.promise;
        const expired = await database.execute(
          "UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1 AND state = 'running'",
          [job.id],
        );
        assert.equal(expired, 1);
        const [rival] = await queue.claim({
          ownerId: "native-rival",
          queueNames: ["ticket-recovery"],
          limit: 1,
          leaseMs: 60_000,
        });
        assert.ok(rival);
        assert.equal(rival.id, job.id);
        assert.equal(rival.attempts, 2);

        release.resolve();
        await waitFor(() => worker.status().lostLeases === 1);
        assert.equal(worker.status().processed, 0);
        assert.equal(worker.status().terminal, 0);
        assert.equal(worker.status().retried, 0);
        assert.equal(await queue.settle(rival, { status: "complete" }), "completed");
      } finally {
        await worker.stop();
      }

      const settled = await queue.inspect(job.id);
      assert.deepEqual(
        {
          state: settled?.state,
          attempts: settled?.attempts,
          terminal: settled?.terminalReasonCode,
        },
        { state: "completed", attempts: 2, terminal: null },
      );
    } finally {
      await database.close();
    }
  },
);

test(
  "PostgreSQL native worker reuses one injected billing processing port across jobs",
  postgresOnly,
  async () => {
    assert.ok(postgresUrl);
    assertSafeTestDatabase(postgresUrl);
    const database = createTestDatabase(postgresUrl);
    try {
      await initializeFreshTestSchema(database);
      const queue = createPostgresJobQueue(database);
      await queue.enqueue({
        id: "billing-job-1",
        queueName: "billing-sync",
        payload: { eventId: "evt_1", customerId: "cus_1" },
        maxAttempts: 2,
      });
      await queue.enqueue({
        id: "billing-job-2",
        queueName: "billing-sync",
        payload: { eventId: "evt_2", customerId: "cus_2" },
        maxAttempts: 2,
      });
      const processed: Array<{ eventId: string; customerId: string; attempts: number }> = [];
      const processing = {
        async processMessage(message: BillingSyncQueueMessage, attempts: number) {
          processed.push({
            eventId: message.eventId,
            customerId: message.customerId,
            attempts,
          });
          return "processed" as const;
        },
      };
      const handler: PostgresJobHandler = (payload, metadata) =>
        deliverBillingSync(payload, metadata, processing);
      const worker = createPostgresJobWorker({
        queue,
        ownerId: "native-billing-reuse",
        leaseMs: 500,
        pollIntervalMs: 10,
        handlers: { "billing-sync": handler },
      });
      await worker.start();
      try {
        await waitFor(async () => {
          const first = await queue.inspect("billing-job-1");
          const second = await queue.inspect("billing-job-2");
          return first?.state === "completed" && second?.state === "completed";
        });
      } finally {
        await worker.stop();
      }

      assert.deepEqual(
        processed.sort((left, right) => left.eventId.localeCompare(right.eventId)),
        [
          { eventId: "evt_1", customerId: "cus_1", attempts: 1 },
          { eventId: "evt_2", customerId: "cus_2", attempts: 1 },
        ],
      );
      assert.equal(worker.status().processed, 2);
      assert.equal(worker.status().retried, 0);
      assert.equal(worker.status().terminal, 0);
    } finally {
      await database.close();
    }
  },
);

function recordContext(
  context: { jobId: string; attempts: number; maxAttempts: number },
  attemptsByJob: Map<string, number[]>,
  maxAttemptsByJob: Map<string, number>,
): void {
  attemptsByJob.set(context.jobId, [...(attemptsByJob.get(context.jobId) ?? []), context.attempts]);
  // Record the native attempt limit from the job row rather than a copied consumer limit.
  maxAttemptsByJob.set(context.jobId, context.maxAttempts);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createTestDatabase(url: string): PostgresDatabaseCapability {
  return createPostgresDatabaseCapabilityFromEnvironment({
    DATABASE_URL: url,
    NODE_ENV: "test",
    PG_POOL_MAX: "6",
  });
}

async function initializeFreshTestSchema(database: PostgresDatabaseCapability): Promise<void> {
  await database.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await initializePostgresSchema(database);
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for PostgreSQL test condition.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function assertSafeTestDatabase(value: string): void {
  const url = new URL(value);
  const databaseName = url.pathname.slice(1);
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (!local || !databaseName.endsWith("_test")) {
    throw new Error("PostgreSQL integration tests require a local database ending in _test.");
  }
}
