import assert from "node:assert/strict";
import test from "node:test";

import {
  createPostgresDatabaseCapabilityFromEnvironment,
  type PostgresDatabaseCapability,
} from "../src/runtime/postgres/postgres-capability";
import { createPostgresJobQueue } from "../src/runtime/postgres/postgres-job-queue";
import { createPostgresJobWorker } from "../src/runtime/postgres/postgres-job-worker";
import { createPostgresLeaseStore } from "../src/runtime/postgres/postgres-lease-store";
import { initializePostgresSchema } from "../src/runtime/postgres/postgres-schema";
import { createPostgresScheduler } from "../src/runtime/postgres/postgres-scheduler";
import { createPostgresQueueBinding } from "../src/runtime/postgres/postgres-queue-binding";

const postgresUrl = process.env.TEST_POSTGRES_URL;

test("PostgreSQL background loops reject lease timing that cannot renew safely", () => {
  assert.throws(
    () =>
      createPostgresScheduler({
        database: {} as never,
        tasks: [{ name: "probe", intervalMs: 1_000, async run() {} }],
        leaseMs: 1_000,
        pollIntervalMs: 501,
      }),
    /no more than half of scheduler lease/,
  );
  assert.throws(
    () =>
      createPostgresJobWorker({
        queue: {} as never,
        handlers: { "gateway-events": async () => undefined },
        leaseMs: 299,
      }),
    /at least 300 milliseconds/,
  );
});

test(
  "PostgreSQL jobs use deduplication, fenced leases, retry limits, and operator controls",
  { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
  async () => {
    assert.ok(postgresUrl);
    assertSafeTestDatabase(postgresUrl);
    const database = createTestDatabase(postgresUrl);
    try {
      await resetAndMigrate(database);
      let id = 0;
      const queue = createPostgresJobQueue(database, {
        randomId: () => `generated-${++id}`,
        random: () => 0.5,
      });
      const now = new Date("2026-08-20T00:00:00.000Z");
      const first = await queue.enqueue({
        queueName: "gateway-events",
        dedupeKey: "event-1",
        payload: { event: 1 },
        availableAt: now,
      });
      const duplicate = await queue.enqueue({
        queueName: "gateway-events",
        dedupeKey: "event-1",
        payload: { event: "ignored" },
        availableAt: now,
      });
      assert.equal(first.inserted, true);
      assert.deepEqual(duplicate, { id: first.id, inserted: false });

      for (let index = 2; index <= 10; index += 1) {
        await queue.enqueue({
          queueName: "gateway-events",
          dedupeKey: `event-${index}`,
          payload: { event: index },
          availableAt: now,
        });
      }
      const [ownerOne, ownerTwo] = await Promise.all([
        queue.claim({ ownerId: "owner-1", queueNames: ["gateway-events"], limit: 10, now }),
        queue.claim({ ownerId: "owner-2", queueNames: ["gateway-events"], limit: 10, now }),
      ]);
      const claimed = [...ownerOne, ...ownerTwo];
      assert.equal(claimed.length, 10);
      assert.equal(new Set(claimed.map((job) => job.id)).size, 10);
      assert.equal(
        await queue.settle(
          { id: claimed[0]!.id, leaseToken: "stale-token" },
          { status: "complete" },
          now,
        ),
        null,
      );
      await Promise.all(claimed.map((job) => queue.settle(job, { status: "complete" }, now)));

      await queue.enqueue({
        id: "retry-job",
        queueName: "billing-sync",
        payload: { eventId: "evt_1" },
        maxAttempts: 2,
        availableAt: now,
      });
      const retryOne = (
        await queue.claim({ ownerId: "retry-owner", queueNames: ["billing-sync"], now })
      )[0]!;
      assert.equal(
        await queue.settle(
          retryOne,
          { status: "retry", reasonCode: "provider_unavailable", delaySeconds: 0 },
          now,
        ),
        "queued",
      );
      const retryTwo = (
        await queue.claim({ ownerId: "retry-owner", queueNames: ["billing-sync"], now })
      )[0]!;
      assert.equal(retryTwo.attempts, 2);
      assert.equal(
        await queue.settle(
          retryTwo,
          { status: "retry", reasonCode: "provider_unavailable", delaySeconds: 0 },
          now,
        ),
        "terminal",
      );
      assert.equal((await queue.inspect("retry-job"))?.terminalReasonCode, "provider_unavailable");
      assert.equal(await queue.retryOne("retry-job", now), true);
      assert.equal((await queue.inspect("retry-job"))?.attempts, 0);
      assert.equal(await queue.discardOne("retry-job", "operator_discarded", now), true);

      await queue.enqueue({
        id: "expired-job",
        queueName: "ticket-recovery",
        payload: { ticketId: "ticket-1" },
        availableAt: now,
      });
      const original = (
        await queue.claim({
          ownerId: "crashed-worker",
          queueNames: ["ticket-recovery"],
          leaseMs: 100,
          now,
        })
      )[0]!;
      const takeoverTime = new Date(now.getTime() + 101);
      const recovered = (
        await queue.claim({
          ownerId: "replacement-worker",
          queueNames: ["ticket-recovery"],
          leaseMs: 100,
          now: takeoverTime,
        })
      )[0]!;
      assert.equal(recovered.id, original.id);
      assert.equal(recovered.attempts, 2);
      assert.equal(await queue.settle(original, { status: "complete" }, takeoverTime), null);
      assert.equal(
        await queue.settle(recovered, { status: "complete" }, takeoverTime),
        "completed",
      );

      const stats = await queue.stats();
      assert.equal(stats.find((entry) => entry.queueName === "gateway-events")?.completed, 10);
      assert.equal(await queue.purgeFinishedBefore(new Date(takeoverTime.getTime() + 1)), 12);
    } finally {
      await database.close();
    }
  },
);

test(
  "PostgreSQL Queue bindings preserve payloads, delays, validation, and atomic batches",
  { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
  async () => {
    assert.ok(postgresUrl);
    assertSafeTestDatabase(postgresUrl);
    const database = createTestDatabase(postgresUrl);
    try {
      await resetAndMigrate(database);
      let id = 0;
      const jobs = createPostgresJobQueue(database, {
        randomId: () => `binding-${++id}`,
      });
      const binding = createPostgresQueueBinding<{ kind: string }>({
        database,
        jobs,
        queueName: "gateway-events",
      });
      const before = Date.now();
      await binding.send({ kind: "single" }, { delaySeconds: 30 });
      await binding.sendBatch(
        [
          { body: { kind: "batch-default" } },
          { body: { kind: "batch-override" }, delaySeconds: 1 },
        ],
        { delaySeconds: 20 },
      );

      const rows = await database.query<{
        id: string;
        payload_json: { kind: string };
        available_at: Date;
      }>("SELECT id, payload_json, available_at FROM jobs ORDER BY id");
      assert.deepEqual(
        rows.map((row) => row.payload_json),
        [{ kind: "single" }, { kind: "batch-default" }, { kind: "batch-override" }],
      );
      assert.ok(rows[0]!.available_at.getTime() >= before + 29_000);
      assert.ok(rows[1]!.available_at.getTime() >= before + 19_000);
      assert.ok(rows[2]!.available_at.getTime() >= before + 900);

      await assert.rejects(binding.sendBatch([]), /must contain 1 to 100/);
      await assert.rejects(
        binding.sendBatch(
          Array.from({ length: 101 }, (_, index) => ({ body: { kind: `too-many-${index}` } })),
        ),
        /must contain 1 to 100/,
      );
      await assert.rejects(binding.send({ kind: "invalid" }, { delaySeconds: -1 }), /delaySeconds/);

      const collidingJobs = createPostgresJobQueue(database, { randomId: () => "collision" });
      const collidingBinding = createPostgresQueueBinding({
        database,
        jobs: collidingJobs,
        queueName: "billing-sync",
      });
      await assert.rejects(
        collidingBinding.sendBatch([{ body: 1 }, { body: 2 }]),
        /duplicate key|already exists/i,
      );
      const rolledBack = await database.query<{ count: number }>(
        "SELECT COUNT(*)::INTEGER AS count FROM jobs WHERE id = 'collision'",
      );
      assert.equal(rolledBack[0]?.count, 0, "a failed batch leaves no partial jobs");
    } finally {
      await database.close();
    }
  },
);

test(
  "PostgreSQL lease generations fence stale owners and scheduler tasks",
  { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
  async () => {
    assert.ok(postgresUrl);
    assertSafeTestDatabase(postgresUrl);
    const database = createTestDatabase(postgresUrl);
    try {
      await resetAndMigrate(database);
      let token = 0;
      const leases = createPostgresLeaseStore(database, {
        randomId: () => `lease-${++token}`,
      });
      const now = new Date("2026-08-20T00:00:00.000Z");
      const first = await leases.acquire("gateway:standard", "instance-1", 100, now);
      assert.ok(first);
      assert.equal(first.fencingGeneration, 1);
      assert.equal(
        await leases.acquire("gateway:standard", "instance-2", 100, new Date(now.getTime() + 99)),
        null,
      );
      const second = await leases.acquire(
        "gateway:standard",
        "instance-2",
        100,
        new Date(now.getTime() + 101),
      );
      assert.ok(second);
      assert.equal(second.fencingGeneration, 2);
      assert.equal(await leases.renew(first, 100, new Date(now.getTime() + 102)), null);
      assert.equal(await leases.release(first), false);
      assert.equal(await leases.release(second), true);

      let taskRuns = 0;
      const scheduler = createPostgresScheduler({
        database,
        leases,
        ownerId: "scheduler-test",
        leaseMs: 500,
        pollIntervalMs: 100,
        tasks: [
          {
            name: "five-minute-maintenance",
            intervalMs: 60_000,
            async run({ fencingGeneration, signal }) {
              assert.equal(fencingGeneration > 0, true);
              assert.equal(signal.aborted, false);
              taskRuns += 1;
            },
          },
        ],
      });
      await scheduler.start();
      await waitFor(() => taskRuns === 1);
      await scheduler.stop();
      assert.equal(taskRuns, 1);
      const taskState = await database.query<{
        last_outcome: string;
        last_completed_at: Date | null;
      }>("SELECT last_outcome, last_completed_at FROM scheduler_task_state WHERE name = $1", [
        "five-minute-maintenance",
      ]);
      assert.equal(taskState[0]?.last_outcome, "completed");
      assert.ok(taskState[0]?.last_completed_at instanceof Date);
    } finally {
      await database.close();
    }
  },
);

test(
  "PostgreSQL job worker settles registered handlers",
  { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
  async () => {
    assert.ok(postgresUrl);
    assertSafeTestDatabase(postgresUrl);
    const database = createTestDatabase(postgresUrl);
    try {
      await resetAndMigrate(database);
      const queue = createPostgresJobQueue(database);
      const job = await queue.enqueue({
        queueName: "steam-ban-lookups",
        payload: { steamId: "steam-1" },
      });
      let handled = 0;
      const worker = createPostgresJobWorker({
        queue,
        ownerId: "worker-test",
        leaseMs: 500,
        pollIntervalMs: 10,
        handlers: {
          "steam-ban-lookups": async (payload, context) => {
            assert.deepEqual(payload, { steamId: "steam-1" });
            assert.equal(context.attempts, 1);
            handled += 1;
          },
        },
      });
      await worker.start();
      await waitFor(() => handled === 1);
      await waitFor(async () => (await queue.inspect(job.id))?.state === "completed");
      await worker.stop();
      assert.equal(worker.status().processed, 1);
      assert.equal(worker.status().lostLeases, 0);
    } finally {
      await database.close();
    }
  },
);

function createTestDatabase(url: string): PostgresDatabaseCapability {
  return createPostgresDatabaseCapabilityFromEnvironment({
    DATABASE_URL: url,
    NODE_ENV: "test",
    PG_POOL_MAX: "6",
  });
}

async function resetAndMigrate(database: PostgresDatabaseCapability): Promise<void> {
  await database.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await initializePostgresSchema(database);
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
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
