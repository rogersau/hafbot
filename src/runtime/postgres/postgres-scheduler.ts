import { randomUUID } from "node:crypto";

import type { ManagedNodeComponent } from "../../node/host";
import type { PostgresDatabaseCapability } from "./postgres-capability";
import {
  createPostgresLeaseStore,
  type PostgresLease,
  type PostgresLeaseStore,
} from "./postgres-lease-store";

export interface PostgresScheduledTaskContext {
  fencingGeneration: number;
  signal: AbortSignal;
}

export interface PostgresScheduledTask {
  name: string;
  intervalMs: number;
  run(context: PostgresScheduledTaskContext): Promise<void>;
}

export interface PostgresSchedulerOptions {
  database: PostgresDatabaseCapability;
  tasks: readonly PostgresScheduledTask[];
  ownerId?: string;
  leaseName?: string;
  leaseMs?: number;
  pollIntervalMs?: number;
  now?: () => Date;
  leases?: PostgresLeaseStore;
  onError?: (error: unknown, context: { taskName?: string }) => void;
}

export interface PostgresSchedulerStatus {
  state: "created" | "running" | "stopping" | "stopped";
  ownerId: string;
  leaseGeneration: number | null;
  leaseExpiresAt: string | null;
  activeTask: string | null;
  completedRuns: number;
  failedRuns: number;
}

export function createPostgresScheduler(
  options: PostgresSchedulerOptions,
): ManagedNodeComponent & { status(): PostgresSchedulerStatus } {
  if (options.tasks.length === 0)
    throw new Error("At least one PostgreSQL scheduled task is required.");
  const names = new Set<string>();
  for (const task of options.tasks) {
    assertName(task.name);
    if (names.has(task.name)) throw new Error(`Duplicate PostgreSQL scheduled task: ${task.name}.`);
    names.add(task.name);
    readDuration(task.intervalMs, "task interval", 24 * 60 * 60_000);
  }
  const ownerId = options.ownerId ?? `scheduler-${randomUUID()}`;
  const leaseName = options.leaseName ?? "haf-scheduler";
  const leaseMs = readDuration(options.leaseMs ?? 60_000, "scheduler lease", 15 * 60_000);
  const pollIntervalMs = readDuration(
    options.pollIntervalMs ?? 5_000,
    "scheduler poll interval",
    60_000,
  );
  if (pollIntervalMs > Math.floor(leaseMs / 2)) {
    throw new Error("scheduler poll interval must be no more than half of scheduler lease.");
  }
  const now = options.now ?? (() => new Date());
  const leases = options.leases ?? createPostgresLeaseStore(options.database);
  let state: PostgresSchedulerStatus["state"] = "created";
  let lease: PostgresLease | null = null;
  let loopPromise: Promise<void> | undefined;
  let sleepAbort: AbortController | undefined;
  let activeTask: string | null = null;
  let completedRuns = 0;
  let failedRuns = 0;

  return {
    async start() {
      if (state !== "created") throw new Error(`Cannot start PostgreSQL scheduler from ${state}.`);
      state = "running";
      loopPromise = runLoop();
    },

    async stop() {
      if (state === "stopped") return;
      state = "stopping";
      sleepAbort?.abort();
      await loopPromise;
      if (lease) await leases.release(lease).catch((error) => options.onError?.(error, {}));
      lease = null;
      state = "stopped";
    },

    isReady() {
      return state === "running";
    },

    status() {
      return {
        state,
        ownerId,
        leaseGeneration: lease?.fencingGeneration ?? null,
        leaseExpiresAt: lease?.leaseExpiresAt.toISOString() ?? null,
        activeTask,
        completedRuns,
        failedRuns,
      };
    },
  };

  async function runLoop(): Promise<void> {
    while (state === "running") {
      try {
        if (!lease || lease.leaseExpiresAt.getTime() <= now().getTime()) {
          lease = await leases.acquire(leaseName, ownerId, leaseMs, now());
        } else if (lease.leaseExpiresAt.getTime() - now().getTime() <= leaseMs / 2) {
          lease = await leases.renew(lease, leaseMs, now());
        }
        if (lease) {
          for (const task of options.tasks) {
            if (state !== "running" || !lease) break;
            if (!(await markTaskStarted(options.database, task, lease, now()))) continue;
            await runTask(task);
          }
        }
      } catch (error) {
        lease = null;
        options.onError?.(error, {});
      }
      if (state === "running") await sleep(pollIntervalMs);
    }
  }

  async function runTask(task: PostgresScheduledTask): Promise<void> {
    if (!lease) return;
    const startedLease = lease;
    activeTask = task.name;
    const controller = new AbortController();
    let renewing = false;
    const heartbeat = setInterval(
      () => {
        if (renewing || !lease) return;
        renewing = true;
        void leases
          .renew(lease, leaseMs, now())
          .then((renewed) => {
            lease = renewed;
            if (!renewed) controller.abort(new Error("PostgreSQL scheduler lease was lost."));
          })
          .catch((error) => {
            lease = null;
            controller.abort(error);
            options.onError?.(error, { taskName: task.name });
          })
          .finally(() => {
            renewing = false;
          });
      },
      Math.max(100, Math.floor(leaseMs / 3)),
    );
    heartbeat.unref?.();

    let outcome = "completed";
    try {
      await task.run({
        fencingGeneration: startedLease.fencingGeneration,
        signal: controller.signal,
      });
      completedRuns += 1;
    } catch (error) {
      outcome = "failed";
      failedRuns += 1;
      options.onError?.(error, { taskName: task.name });
    } finally {
      clearInterval(heartbeat);
      activeTask = null;
    }

    await markTaskCompleted(
      options.database,
      task.name,
      startedLease.fencingGeneration,
      outcome,
      now(),
    );
  }

  async function sleep(milliseconds: number): Promise<void> {
    sleepAbort = new AbortController();
    try {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, milliseconds);
        timer.unref?.();
        sleepAbort!.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    } finally {
      sleepAbort = undefined;
    }
  }
}

async function markTaskStarted(
  database: PostgresDatabaseCapability,
  task: PostgresScheduledTask,
  lease: PostgresLease,
  now: Date,
): Promise<boolean> {
  const rows = await database.query<{ name: string }>(
    `INSERT INTO scheduler_task_state (
       name, last_started_at, last_outcome, last_lease_generation, updated_at
     )
     SELECT $1, $2, 'running', $3, $2
      WHERE EXISTS (
        SELECT 1 FROM scheduler_leases
         WHERE name = $4 AND owner_id = $5 AND lease_token = $6
           AND fencing_generation = $3 AND lease_expires_at > $2
      )
     ON CONFLICT (name) DO UPDATE
       SET last_started_at = EXCLUDED.last_started_at,
           last_outcome = EXCLUDED.last_outcome,
           last_lease_generation = EXCLUDED.last_lease_generation,
           updated_at = EXCLUDED.updated_at
     WHERE scheduler_task_state.last_started_at IS NULL
        OR scheduler_task_state.last_started_at <= $2 - ($7 * INTERVAL '1 millisecond')
     RETURNING name`,
    [
      task.name,
      now,
      lease.fencingGeneration,
      lease.name,
      lease.ownerId,
      lease.leaseToken,
      task.intervalMs,
    ],
  );
  return rows.length === 1;
}

async function markTaskCompleted(
  database: PostgresDatabaseCapability,
  name: string,
  generation: number,
  outcome: string,
  now: Date,
): Promise<void> {
  await database.execute(
    `UPDATE scheduler_task_state
        SET last_completed_at = $1, last_outcome = $2, updated_at = $1
      WHERE name = $3 AND last_lease_generation = $4`,
    [now, outcome, name, generation],
  );
}

function readDuration(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > maximum) {
    throw new Error(`${name} must be between 100 and ${maximum} milliseconds.`);
  }
  return value;
}

function assertName(value: string): void {
  if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(value)) {
    throw new Error(`Invalid PostgreSQL scheduled task name: ${value}.`);
  }
}
