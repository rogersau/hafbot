import { randomUUID } from "node:crypto";

import type { ManagedNodeComponent } from "../../node/host";
import { classifyQueueDeliveryError, type QueueDeliveryOutcome } from "../queue-delivery";
import type { ClaimedPostgresJob, PortableQueueName, PostgresJobQueue } from "./postgres-job-queue";

export interface PostgresJobHandlerContext {
  jobId: string;
  queueName: PortableQueueName;
  attempts: number;
  maxAttempts: number;
  signal: AbortSignal;
}

export type PostgresJobHandler = (
  payload: unknown,
  context: PostgresJobHandlerContext,
) => Promise<QueueDeliveryOutcome | void>;

export interface PostgresJobWorkerOptions {
  queue: PostgresJobQueue;
  handlers: Partial<Record<PortableQueueName, PostgresJobHandler>>;
  ownerId?: string;
  batchSize?: number;
  leaseMs?: number;
  pollIntervalMs?: number;
  now?: () => Date;
  onError?: (error: unknown, context: { jobId?: string; queueName?: PortableQueueName }) => void;
}

export interface PostgresJobWorkerStatus {
  state: "created" | "running" | "stopping" | "stopped";
  ownerId: string;
  configuredQueues: PortableQueueName[];
  inFlight: number;
  processed: number;
  retried: number;
  terminal: number;
  lostLeases: number;
  lastClaimAt: string | null;
}

export interface PostgresJobWorker extends ManagedNodeComponent {
  status(): PostgresJobWorkerStatus;
}

export function createPostgresJobWorker(options: PostgresJobWorkerOptions): PostgresJobWorker {
  const ownerId = options.ownerId ?? `jobs-${randomUUID()}`;
  const queueNames = Object.keys(options.handlers) as PortableQueueName[];
  if (queueNames.length === 0) throw new Error("At least one PostgreSQL job handler is required.");
  const batchSize = readPositiveInteger(options.batchSize ?? 10, "batchSize", 100);
  const leaseMs = readPositiveInteger(options.leaseMs ?? 30_000, "leaseMs", 15 * 60_000);
  if (leaseMs < 300) throw new Error("leaseMs must be at least 300 milliseconds.");
  const pollIntervalMs = readPositiveInteger(
    options.pollIntervalMs ?? 1_000,
    "pollIntervalMs",
    60_000,
  );
  const now = options.now ?? (() => new Date());
  let state: PostgresJobWorkerStatus["state"] = "created";
  let loopPromise: Promise<void> | undefined;
  let sleepAbort: AbortController | undefined;
  let inFlight = 0;
  let processed = 0;
  let retried = 0;
  let terminal = 0;
  let lostLeases = 0;
  let lastClaimAt: string | null = null;

  return {
    async start() {
      if (state !== "created") throw new Error(`Cannot start PostgreSQL job worker from ${state}.`);
      state = "running";
      loopPromise = runLoop();
    },

    async stop() {
      if (state === "stopped") return;
      state = "stopping";
      sleepAbort?.abort();
      await loopPromise;
      state = "stopped";
    },

    isReady() {
      return state === "running";
    },

    status() {
      return {
        state,
        ownerId,
        configuredQueues: [...queueNames],
        inFlight,
        processed,
        retried,
        terminal,
        lostLeases,
        lastClaimAt,
      };
    },
  };

  async function runLoop(): Promise<void> {
    while (state === "running") {
      try {
        const jobs = await options.queue.claim({
          ownerId,
          queueNames,
          limit: batchSize,
          leaseMs,
          now: now(),
        });
        lastClaimAt = now().toISOString();
        if (jobs.length === 0) {
          await sleep(pollIntervalMs);
          continue;
        }
        await Promise.all(jobs.map(processJob));
      } catch (error) {
        options.onError?.(error, {});
        if (state === "running") await sleep(pollIntervalMs);
      }
    }
  }

  async function processJob(job: ClaimedPostgresJob): Promise<void> {
    const handler = options.handlers[job.queueName];
    if (!handler) {
      await options.queue.settle(
        job,
        { status: "terminal", reasonCode: "missing_queue_handler" },
        now(),
      );
      terminal += 1;
      return;
    }

    inFlight += 1;
    const leaseController = new AbortController();
    let leaseLost = false;
    let extending = false;
    const heartbeat = setInterval(
      () => {
        if (extending || leaseLost) return;
        extending = true;
        void options.queue
          .extendLease(job.id, job.leaseToken, leaseMs, now())
          .then((extended) => {
            if (!extended) {
              leaseLost = true;
              lostLeases += 1;
              leaseController.abort(new Error("PostgreSQL job lease was lost."));
            }
          })
          .catch((error) => {
            leaseLost = true;
            lostLeases += 1;
            leaseController.abort(error);
            options.onError?.(error, { jobId: job.id, queueName: job.queueName });
          })
          .finally(() => {
            extending = false;
          });
      },
      Math.max(100, Math.floor(leaseMs / 3)),
    );
    heartbeat.unref?.();

    try {
      let outcome: QueueDeliveryOutcome;
      try {
        outcome = (await handler(job.payload, {
          jobId: job.id,
          queueName: job.queueName,
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
          signal: leaseController.signal,
        })) ?? { status: "complete" };
      } catch (error) {
        options.onError?.(error, { jobId: job.id, queueName: job.queueName });
        outcome = classifyQueueDeliveryError(error);
      }
      if (leaseLost) return;
      const settled = await options.queue.settle(job, outcome, now());
      if (!settled) {
        leaseLost = true;
        lostLeases += 1;
        return;
      }
      processed += 1;
      if (settled === "queued") retried += 1;
      if (settled === "terminal") terminal += 1;
    } finally {
      clearInterval(heartbeat);
      inFlight -= 1;
    }
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

function readPositiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}
