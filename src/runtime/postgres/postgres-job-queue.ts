import { randomUUID } from "node:crypto";

import type { QueueDeliveryOutcome } from "../queue-delivery";
import type {
  PostgresDatabaseCapability,
  PostgresExecutor,
  PostgresValue,
} from "./postgres-capability";

export const PORTABLE_QUEUE_NAMES = [
  "r2-quota",
  "gateway-events",
  "webhook-proxy-deliveries",
  "steam-ban-lookups",
  "billing-sync",
  "billing-delivery",
  "commerce-sync",
  "commerce-roles",
  "commerce-game-access",
  "ticket-recovery",
  "server-levels",
] as const;

export type PortableQueueName = (typeof PORTABLE_QUEUE_NAMES)[number];
export type PostgresJobState = "queued" | "running" | "completed" | "terminal";

export interface EnqueuePostgresJobInput {
  queueName: PortableQueueName;
  payload: unknown;
  dedupeKey?: string;
  id?: string;
  maxAttempts?: number;
  availableAt?: Date;
}

export interface EnqueuePostgresJobResult {
  id: string;
  inserted: boolean;
}

export interface ClaimedPostgresJob {
  id: string;
  queueName: PortableQueueName;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  leaseToken: string;
  leaseExpiresAt: Date;
  createdAt: Date;
}

export interface PostgresJobMetadata {
  id: string;
  queueName: PortableQueueName;
  dedupeKey: string | null;
  state: PostgresJobState;
  attempts: number;
  maxAttempts: number;
  availableAt: Date;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  terminalReasonCode: string | null;
}

export interface PostgresJobStats {
  queueName: PortableQueueName;
  queued: number;
  running: number;
  completed: number;
  terminal: number;
  oldestAvailableAt: Date | null;
}

export interface ClaimPostgresJobsInput {
  ownerId: string;
  queueNames: readonly PortableQueueName[];
  limit?: number;
  leaseMs?: number;
  now?: Date;
}

export interface PostgresJobQueue {
  enqueue(
    input: EnqueuePostgresJobInput,
    executor?: PostgresExecutor,
  ): Promise<EnqueuePostgresJobResult>;
  claim(input: ClaimPostgresJobsInput): Promise<ClaimedPostgresJob[]>;
  extendLease(jobId: string, leaseToken: string, leaseMs: number, now?: Date): Promise<boolean>;
  settle(
    job: Pick<ClaimedPostgresJob, "id" | "leaseToken">,
    outcome: QueueDeliveryOutcome,
    now?: Date,
  ): Promise<PostgresJobState | null>;
  inspect(jobId: string): Promise<PostgresJobMetadata | null>;
  stats(): Promise<PostgresJobStats[]>;
  retryOne(jobId: string, now?: Date): Promise<boolean>;
  discardOne(jobId: string, reasonCode: string, now?: Date): Promise<boolean>;
  purgeFinishedBefore(cutoff: Date): Promise<number>;
}

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_LEASE_MS = 30_000;
const MAX_BATCH_SIZE = 100;
const MAX_LEASE_MS = 15 * 60_000;

export function createPostgresJobQueue(
  database: PostgresDatabaseCapability,
  options: { randomId?: () => string; random?: () => number } = {},
): PostgresJobQueue {
  const randomId = options.randomId ?? randomUUID;
  const random = options.random ?? Math.random;

  return {
    async enqueue(input, executor = database) {
      assertQueueName(input.queueName);
      const id = input.id ?? randomId();
      const dedupeKey = normalizeOptionalKey(input.dedupeKey, "dedupeKey");
      const maxAttempts = readPositiveInteger(
        input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        "maxAttempts",
      );
      const availableAt = input.availableAt ?? new Date();
      const payloadJson = serializePayload(input.payload);
      const inserted = await executor.query<{ id: string }>(
        `INSERT INTO jobs (
           id, queue_name, dedupe_key, payload_json, available_at, max_attempts
         ) VALUES ($1, $2, $3, $4::jsonb, $5, $6)
         ON CONFLICT (queue_name, dedupe_key) DO NOTHING
         RETURNING id`,
        [id, input.queueName, dedupeKey, payloadJson, availableAt, maxAttempts],
      );
      if (inserted[0]) return { id: inserted[0].id, inserted: true };
      if (dedupeKey === null) {
        throw new Error(`PostgreSQL job id ${id} already exists.`);
      }
      const existing = await executor.query<{ id: string }>(
        "SELECT id FROM jobs WHERE queue_name = $1 AND dedupe_key = $2",
        [input.queueName, dedupeKey],
      );
      if (!existing[0]) throw new Error("Deduplicated PostgreSQL job could not be read.");
      return { id: existing[0].id, inserted: false };
    },

    async claim(input) {
      assertIdentifier(input.ownerId, "ownerId");
      if (input.queueNames.length === 0) return [];
      for (const queueName of input.queueNames) assertQueueName(queueName);
      const queueNames = [...new Set(input.queueNames)];
      const limit = Math.min(MAX_BATCH_SIZE, readPositiveInteger(input.limit ?? 10, "claim limit"));
      const leaseMs = readDuration(input.leaseMs ?? DEFAULT_LEASE_MS, "leaseMs");
      const now = input.now ?? new Date();
      const leaseExpiresAt = new Date(now.getTime() + leaseMs);
      const leaseToken = randomId();

      return database.transaction(async (transaction) => {
        await transaction.execute(
          `UPDATE jobs
             SET state = 'terminal',
                 terminal_reason_code = 'lease_expired_after_max_attempts',
                 lease_owner = NULL,
                 lease_token = NULL,
                 lease_expires_at = NULL,
                 completed_at = $1,
                 updated_at = $1
           WHERE state = 'running'
             AND lease_expires_at <= $1
             AND attempts >= max_attempts`,
          [now],
        );

        const queuePlaceholders = queueNames.map((_, index) => `$${index + 6}`).join(", ");
        const values: PostgresValue[] = [
          now,
          input.ownerId,
          leaseToken,
          leaseExpiresAt,
          limit,
          ...queueNames,
        ];
        const rows = await transaction.query<JobRow>(
          `WITH candidates AS (
             SELECT id
               FROM jobs
              WHERE queue_name IN (${queuePlaceholders})
                AND attempts < max_attempts
                AND (
                  (state = 'queued' AND available_at <= $1)
                  OR
                  (state = 'running' AND lease_expires_at <= $1)
                )
              ORDER BY available_at, created_at, id
              FOR UPDATE SKIP LOCKED
              LIMIT $5
           )
           UPDATE jobs AS job
              SET state = 'running',
                  attempts = job.attempts + 1,
                  lease_owner = $2,
                  lease_token = $3,
                  lease_expires_at = $4,
                  updated_at = $1
             FROM candidates
            WHERE job.id = candidates.id
           RETURNING job.*`,
          values,
        );
        return rows.map(mapClaimedJob);
      });
    },

    async extendLease(jobId, leaseToken, leaseMs, now = new Date()) {
      assertIdentifier(jobId, "jobId");
      assertIdentifier(leaseToken, "leaseToken");
      const expiresAt = new Date(now.getTime() + readDuration(leaseMs, "leaseMs"));
      return (
        (await database.execute(
          `UPDATE jobs
              SET lease_expires_at = $1, updated_at = $2
            WHERE id = $3
              AND state = 'running'
              AND lease_token = $4
              AND lease_expires_at > $2`,
          [expiresAt, now, jobId, leaseToken],
        )) === 1
      );
    },

    async settle(job, outcome, now = new Date()) {
      assertIdentifier(job.id, "jobId");
      assertIdentifier(job.leaseToken, "leaseToken");
      if (outcome.status === "complete") {
        return updateFinishedState(database, job, "completed", null, now);
      }
      if (outcome.status === "terminal") {
        return updateFinishedState(
          database,
          job,
          "terminal",
          normalizeReasonCode(outcome.reasonCode),
          now,
        );
      }

      const reasonCode = normalizeReasonCode(outcome.reasonCode);
      const delayMs =
        outcome.delaySeconds === undefined
          ? exponentialBackoffMs(await readAttempts(database, job), random)
          : Math.min(86_400_000, Math.max(0, Math.floor(outcome.delaySeconds * 1_000)));
      const availableAt = new Date(now.getTime() + delayMs);
      const rows = await database.query<{ state: PostgresJobState }>(
        `UPDATE jobs
            SET state = CASE WHEN attempts >= max_attempts THEN 'terminal' ELSE 'queued' END,
                available_at = CASE
                  WHEN attempts >= max_attempts THEN available_at
                  ELSE $1::timestamptz
                END,
                lease_owner = NULL,
                lease_token = NULL,
                lease_expires_at = NULL,
                completed_at = CASE
                  WHEN attempts >= max_attempts THEN $2::timestamptz
                  ELSE NULL
                END,
                terminal_reason_code = CASE WHEN attempts >= max_attempts THEN $3 ELSE NULL END,
                updated_at = $2
          WHERE id = $4 AND state = 'running' AND lease_token = $5
          RETURNING state`,
        [availableAt, now, reasonCode, job.id, job.leaseToken],
      );
      return rows[0]?.state ?? null;
    },

    async inspect(jobId) {
      assertIdentifier(jobId, "jobId");
      const rows = await database.query<JobRow>("SELECT * FROM jobs WHERE id = $1", [jobId]);
      return rows[0] ? mapJobMetadata(rows[0]) : null;
    },

    async stats() {
      const rows = await database.query<JobStatsRow>(
        `SELECT queue_name,
                COUNT(*) FILTER (WHERE state = 'queued')::INTEGER AS queued,
                COUNT(*) FILTER (WHERE state = 'running')::INTEGER AS running,
                COUNT(*) FILTER (WHERE state = 'completed')::INTEGER AS completed,
                COUNT(*) FILTER (WHERE state = 'terminal')::INTEGER AS terminal,
                MIN(available_at) FILTER (WHERE state = 'queued') AS oldest_available_at
           FROM jobs
          GROUP BY queue_name
          ORDER BY queue_name`,
      );
      return rows.map((row) => ({
        queueName: readQueueName(row.queue_name),
        queued: row.queued,
        running: row.running,
        completed: row.completed,
        terminal: row.terminal,
        oldestAvailableAt: row.oldest_available_at,
      }));
    },

    async retryOne(jobId, now = new Date()) {
      assertIdentifier(jobId, "jobId");
      return (
        (await database.execute(
          `UPDATE jobs
              SET state = 'queued', attempts = 0, available_at = $1,
                  completed_at = NULL, terminal_reason_code = NULL, updated_at = $1
            WHERE id = $2 AND state = 'terminal'`,
          [now, jobId],
        )) === 1
      );
    },

    async discardOne(jobId, reasonCode, now = new Date()) {
      assertIdentifier(jobId, "jobId");
      const reason = normalizeReasonCode(reasonCode);
      return (
        (await database.execute(
          `UPDATE jobs
              SET state = 'terminal', terminal_reason_code = $1, completed_at = $2,
                  lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = $2
            WHERE id = $3
              AND (state = 'queued' OR (state = 'running' AND lease_expires_at <= $2))`,
          [reason, now, jobId],
        )) === 1
      );
    },

    purgeFinishedBefore(cutoff) {
      return database.execute(
        "DELETE FROM jobs WHERE state IN ('completed', 'terminal') AND completed_at < $1",
        [cutoff],
      );
    },
  };
}

interface JobRow extends Record<string, unknown> {
  id: string;
  queue_name: string;
  dedupe_key: string | null;
  payload_json: unknown;
  state: PostgresJobState;
  available_at: Date;
  attempts: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  terminal_reason_code: string | null;
}

interface JobStatsRow extends Record<string, unknown> {
  queue_name: string;
  queued: number;
  running: number;
  completed: number;
  terminal: number;
  oldest_available_at: Date | null;
}

function mapClaimedJob(row: JobRow): ClaimedPostgresJob {
  if (!row.lease_token || !row.lease_expires_at) {
    throw new Error(`Claimed PostgreSQL job ${row.id} is missing its lease.`);
  }
  return {
    id: row.id,
    queueName: readQueueName(row.queue_name),
    payload: row.payload_json,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
  };
}

function mapJobMetadata(row: JobRow): PostgresJobMetadata {
  return {
    id: row.id,
    queueName: readQueueName(row.queue_name),
    dedupeKey: row.dedupe_key,
    state: row.state,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    terminalReasonCode: row.terminal_reason_code,
  };
}

async function readAttempts(
  database: PostgresDatabaseCapability,
  job: Pick<ClaimedPostgresJob, "id" | "leaseToken">,
): Promise<number> {
  const rows = await database.query<{ attempts: number }>(
    "SELECT attempts FROM jobs WHERE id = $1 AND state = 'running' AND lease_token = $2",
    [job.id, job.leaseToken],
  );
  return rows[0]?.attempts ?? 1;
}

async function updateFinishedState(
  database: PostgresDatabaseCapability,
  job: Pick<ClaimedPostgresJob, "id" | "leaseToken">,
  state: "completed" | "terminal",
  reasonCode: string | null,
  now: Date,
): Promise<PostgresJobState | null> {
  const rows = await database.query<{ state: PostgresJobState }>(
    `UPDATE jobs
        SET state = $1, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
            completed_at = $2, terminal_reason_code = $3, updated_at = $2
      WHERE id = $4 AND state = 'running' AND lease_token = $5
      RETURNING state`,
    [state, now, reasonCode, job.id, job.leaseToken],
  );
  return rows[0]?.state ?? null;
}

function serializePayload(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined)
    throw new Error("PostgreSQL job payload must be JSON serializable.");
  return serialized;
}

function exponentialBackoffMs(attempts: number, random: () => number): number {
  const base = Math.min(300_000, 1_000 * 2 ** Math.min(8, Math.max(0, attempts - 1)));
  const jitter = 0.8 + Math.max(0, Math.min(1, random())) * 0.4;
  return Math.floor(base * jitter);
}

function normalizeOptionalKey(value: string | undefined, name: string): string | null {
  if (value === undefined) return null;
  assertIdentifier(value, name);
  return value;
}

function assertIdentifier(value: string, name: string): void {
  if (!value || value.length > 512 || hasControlCharacter(value)) {
    throw new Error(`${name} must be a non-empty bounded identifier.`);
  }
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => character.codePointAt(0)! < 32);
}

function normalizeReasonCode(value: string): string {
  return /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(value) ? value : "invalid_reason_code";
}

function readPositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be positive.`);
  return value;
}

function readDuration(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > MAX_LEASE_MS) {
    throw new Error(`${name} must be between 100 and ${MAX_LEASE_MS} milliseconds.`);
  }
  return value;
}

function assertQueueName(value: string): asserts value is PortableQueueName {
  if (!(PORTABLE_QUEUE_NAMES as readonly string[]).includes(value)) {
    throw new Error(`Unsupported portable queue name: ${value}.`);
  }
}

function readQueueName(value: string): PortableQueueName {
  assertQueueName(value);
  return value;
}
