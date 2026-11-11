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

test("Native job worker passes claimed metadata and exact direct outcomes to settlement", async () => {
  const job = claimedJob({
    id: "direct-retry",
    queueName: "billing-sync",
    payload: { kind: "retry" },
    attempts: 2,
    maxAttempts: 5,
  });
  const native = createFakeNativeQueue([job]);
  let received: { payload: unknown; context: Parameters<PostgresJobHandler>[1] } | undefined;
  const worker = createPostgresJobWorker({
    queue: native.queue,
    ownerId: "native-direct-outcome",
    leaseMs: 500,
    pollIntervalMs: 1_000,
    handlers: {
      "billing-sync": async (payload, context) => {
        received = { payload, context };
        return {
          status: "retry",
          reasonCode: "provider_rate_limited",
          delaySeconds: 37,
        };
      },
    },
  });

  await worker.start();
  try {
    await waitFor(() => native.settled.length === 1);
  } finally {
    await worker.stop();
  }

  assert.deepEqual(received?.payload, { kind: "retry" });
  assert.equal(received?.context.jobId, "direct-retry");
  assert.equal(received?.context.queueName, "billing-sync");
  assert.equal(received?.context.attempts, 2);
  assert.equal(received?.context.maxAttempts, 5);
  assert.ok(received?.context.signal instanceof AbortSignal);
  assert.equal(received?.context.signal.aborted, false);
  assert.deepEqual(native.settled, [
    {
      jobId: "direct-retry",
      outcome: {
        status: "retry",
        reasonCode: "provider_rate_limited",
        delaySeconds: 37,
      },
    },
  ]);
  const status = worker.status();
  assert.equal(status.state, "stopped");
  assert.equal(status.ownerId, "native-direct-outcome");
  assert.deepEqual(status.configuredQueues, ["billing-sync"]);
  assert.equal(status.inFlight, 0);
  assert.equal(status.processed, 1);
  assert.equal(status.retried, 1);
  assert.equal(status.terminal, 0);
  assert.equal(status.lostLeases, 0);
  assert.ok(status.lastClaimAt);
});

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
