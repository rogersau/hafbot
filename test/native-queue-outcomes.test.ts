import assert from "node:assert/strict";
import test from "node:test";

import {
  createPostgresJobWorker,
  type PostgresJobHandler,
} from "../src/runtime/postgres/postgres-job-worker";
import type {
  ClaimedPostgresJob,
  PostgresJobQueue,
} from "../src/runtime/postgres/postgres-job-queue";
import type { QueueDeliveryOutcome } from "../src/runtime/queue-delivery";

interface SettledJob {
  jobId: string;
  outcome: QueueDeliveryOutcome;
}

test("Native job worker never fabricates completion for missing or invalid outcomes", async () => {
  const native = createFakeNativeQueue([
    claimedJob({
      id: "missing-outcome",
      queueName: "ticket-recovery",
      payload: { kind: "missing" },
      maxAttempts: 1,
    }),
    claimedJob({
      id: "invalid-outcome",
      queueName: "ticket-recovery",
      payload: { kind: "invalid" },
      maxAttempts: 1,
    }),
  ]);
  const errors: unknown[] = [];
  const worker = createPostgresJobWorker({
    queue: native.queue,
    ownerId: "native-invalid-outcome",
    leaseMs: 500,
    pollIntervalMs: 1_000,
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
    await waitFor(() => native.settled.length === 2);
  } finally {
    await worker.stop();
  }

  assert.deepEqual(
    native.settled.map(({ jobId, outcome }) => ({ jobId, outcome })),
    [
      {
        jobId: "missing-outcome",
        outcome: { status: "terminal", reasonCode: "missing_delivery_outcome" },
      },
      {
        jobId: "invalid-outcome",
        outcome: { status: "terminal", reasonCode: "missing_delivery_outcome" },
      },
    ],
  );
  assert.equal(errors.length, 2);
  assert.equal(worker.status().processed, 2);
  assert.equal(worker.status().terminal, 2);
  assert.equal(worker.status().retried, 0);
});

function claimedJob(overrides: Partial<ClaimedPostgresJob> = {}): ClaimedPostgresJob {
  const id = overrides.id ?? "job-1";
  return {
    id,
    queueName: "billing-sync",
    payload: { kind: "work" },
    attempts: 1,
    maxAttempts: 4,
    leaseToken: `lease-${id}`,
    leaseExpiresAt: new Date(0),
    createdAt: new Date(0),
    ...overrides,
  };
}

function createFakeNativeQueue(jobs: ClaimedPostgresJob[]): {
  queue: PostgresJobQueue;
  settled: SettledJob[];
} {
  const remaining = [...jobs];
  const settled: SettledJob[] = [];
  const queue = {
    async claim() {
      return remaining.splice(0);
    },
    async extendLease() {
      return true;
    },
    async settle(
      job: Pick<ClaimedPostgresJob, "id" | "leaseToken">,
      outcome: QueueDeliveryOutcome,
    ) {
      settled.push({ jobId: job.id, outcome });
      if (outcome.status === "complete") return "completed";
      if (outcome.status === "terminal") return "terminal";
      return "queued";
    },
  } as unknown as PostgresJobQueue;
  return { queue, settled };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for native job settlement.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
