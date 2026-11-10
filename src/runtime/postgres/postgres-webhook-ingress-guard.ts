import { randomUUID } from "node:crypto";

import type {
  GuardPolicyInput,
  GuardReserveResult,
  GuardSnapshot,
  WebhookIngressGuardNamespace,
  WebhookIngressGuardScope,
} from "../contracts/webhook-ingress-guard";
import type { PostgresDatabaseCapability, PostgresExecutor } from "./postgres-capability";
import { readPostgresSafeInteger } from "./postgres-values";

export interface PostgresWebhookIngressGuardMaintenance {
  pruneExpired(nowMs?: number, batchSize?: number): Promise<number>;
}

export function createPostgresWebhookIngressGuard(
  database: PostgresDatabaseCapability,
  options: { randomId?: () => string } = {},
): WebhookIngressGuardNamespace & PostgresWebhookIngressGuardMaintenance {
  const randomId = options.randomId ?? randomUUID;
  return {
    getByName(name) {
      assertScopeKey(name);
      return createScope(database, name, randomId);
    },

    async pruneExpired(nowMs = Date.now(), batchSize = 1_000) {
      const now = readDate(nowMs, "nowMs");
      const limit = readBoundedInteger(batchSize, "batchSize", 1, 10_000);
      return database.transaction(async (transaction) => {
        let removed = 0;
        removed += await deleteBounded(
          transaction,
          "webhook_guard_leases",
          "expires_at",
          now,
          limit,
        );
        removed += await deleteBounded(
          transaction,
          "webhook_guard_duplicates",
          "expires_at",
          now,
          limit,
        );
        removed += await deleteBounded(
          transaction,
          "webhook_guard_counters",
          "bucket_at",
          new Date(now.getTime() - 86_400_000),
          limit,
        );
        return removed;
      });
    },
  };
}

function createScope(
  database: PostgresDatabaseCapability,
  scopeKey: string,
  randomId: () => string,
): WebhookIngressGuardScope {
  return {
    async reserve(input): Promise<GuardReserveResult> {
      validatePolicy(input.policy);
      const now = readDate(input.nowMs, "nowMs");
      const leaseId = randomId();
      const expiresAt = new Date(now.getTime() + input.policy.leaseTimeoutMs);
      return database.transaction(async (transaction) => {
        await transaction.execute(
          "DELETE FROM webhook_guard_leases WHERE scope_key = $1 AND expires_at <= $2",
          [scopeKey, now],
        );
        await transaction.execute(
          `INSERT INTO webhook_guard_buckets (scope_key, tokens, updated_at)
           VALUES ($1, $2, $3)
           ON CONFLICT (scope_key) DO NOTHING`,
          [scopeKey, input.policy.burst, now],
        );
        const bucketRows = await transaction.query<BucketRow>(
          `SELECT tokens, updated_at
             FROM webhook_guard_buckets
            WHERE scope_key = $1
            FOR UPDATE`,
          [scopeKey],
        );
        const bucket = bucketRows[0];
        if (!bucket) throw new Error("PostgreSQL webhook guard bucket was not created.");
        const elapsedMs = Math.max(0, now.getTime() - bucket.updated_at.getTime());
        const tokens = Math.min(
          input.policy.burst,
          bucket.tokens + (elapsedMs * input.policy.requestsPerMinute) / 60_000,
        );
        const activeRows = await transaction.query<{ count: number }>(
          `SELECT COUNT(*)::INTEGER AS count
             FROM webhook_guard_leases
            WHERE scope_key = $1`,
          [scopeKey],
        );
        if ((activeRows[0]?.count ?? 0) >= input.policy.concurrency) {
          await updateBucket(transaction, scopeKey, tokens, now);
          await incrementCounter(transaction, scopeKey, now, "concurrency_limited");
          return {
            ok: false,
            reason: "concurrency_limited",
            retryAfterSeconds: 1,
          };
        }
        if (tokens < 1) {
          await updateBucket(transaction, scopeKey, tokens, now);
          await incrementCounter(transaction, scopeKey, now, "rate_limited");
          return {
            ok: false,
            reason: "rate_limited",
            retryAfterSeconds: Math.max(
              1,
              Math.ceil(((1 - tokens) * 60) / input.policy.requestsPerMinute),
            ),
          };
        }
        await updateBucket(transaction, scopeKey, tokens - 1, now);
        await transaction.execute(
          `INSERT INTO webhook_guard_leases (scope_key, lease_id, expires_at)
           VALUES ($1, $2, $3)`,
          [scopeKey, leaseId, expiresAt],
        );
        await incrementCounter(transaction, scopeKey, now, "reserved");
        return { ok: true, leaseId, expiresAtMs: expiresAt.getTime() };
      });
    },

    async registerBody(input) {
      assertIdentifier(input.leaseId, "leaseId", 512);
      assertIdentifier(input.sha256, "sha256", 512);
      const now = readDate(input.nowMs, "nowMs");
      const duplicateWindowMs = readBoundedInteger(
        input.duplicateWindowMs,
        "duplicateWindowMs",
        0,
        24 * 60 * 60_000,
      );
      return database.transaction(async (transaction) => {
        const leases = await transaction.query<{ lease_id: string }>(
          `SELECT lease_id
             FROM webhook_guard_leases
            WHERE scope_key = $1 AND lease_id = $2 AND expires_at > $3
            FOR UPDATE`,
          [scopeKey, input.leaseId, now],
        );
        if (!leases[0]) return { ok: false as const, reason: "lease_expired" as const };
        const expiresAt = new Date(now.getTime() + duplicateWindowMs);
        const inserted = await transaction.query<{ sha256: string }>(
          `INSERT INTO webhook_guard_duplicates (scope_key, sha256, expires_at)
           VALUES ($1, $2, $3)
           ON CONFLICT (scope_key, sha256) DO UPDATE
             SET expires_at = EXCLUDED.expires_at
           WHERE webhook_guard_duplicates.expires_at <= $4
           RETURNING sha256`,
          [scopeKey, input.sha256, expiresAt, now],
        );
        if (!inserted[0]) {
          await incrementCounter(transaction, scopeKey, now, "duplicate");
          return { ok: false as const, reason: "duplicate" as const };
        }
        return { ok: true as const };
      });
    },

    async complete(input) {
      assertIdentifier(input.leaseId, "leaseId", 512);
      const now = readDate(input.nowMs, "nowMs");
      const outcome = normalizeOutcome(input.outcome);
      await database.transaction(async (transaction) => {
        await transaction.execute(
          "DELETE FROM webhook_guard_leases WHERE scope_key = $1 AND lease_id = $2",
          [scopeKey, input.leaseId],
        );
        if (input.retryable && input.sha256) {
          assertIdentifier(input.sha256, "sha256", 512);
          await transaction.execute(
            "DELETE FROM webhook_guard_duplicates WHERE scope_key = $1 AND sha256 = $2",
            [scopeKey, input.sha256],
          );
        }
        await incrementCounter(transaction, scopeKey, now, outcome);
      });
    },

    async snapshot(nowMs = Date.now()): Promise<GuardSnapshot> {
      const now = readDate(nowMs, "nowMs");
      return database.transaction(async (transaction) => {
        await transaction.execute(
          "DELETE FROM webhook_guard_leases WHERE scope_key = $1 AND expires_at <= $2",
          [scopeKey, now],
        );
        const leaseRows = await transaction.query<{ count: number }>(
          "SELECT COUNT(*)::INTEGER AS count FROM webhook_guard_leases WHERE scope_key = $1",
          [scopeKey],
        );
        const bucketRows = await transaction.query<BucketRow>(
          "SELECT tokens, updated_at FROM webhook_guard_buckets WHERE scope_key = $1",
          [scopeKey],
        );
        const counterRows = await transaction.query<{
          outcome: string;
          count: string | number;
        }>(
          `SELECT outcome, SUM(count) AS count
             FROM webhook_guard_counters
            WHERE scope_key = $1 AND bucket_at >= $2
            GROUP BY outcome`,
          [scopeKey, new Date(now.getTime() - 86_400_000)],
        );
        const bucket = bucketRows[0];
        return {
          activeLeases: leaseRows[0]?.count ?? 0,
          tokens: bucket?.tokens ?? null,
          updatedAtMs: bucket?.updated_at.getTime() ?? null,
          outcomes: Object.fromEntries(
            counterRows.map((row) => [
              row.outcome,
              readPostgresSafeInteger(row.count, `webhook counter ${row.outcome}`),
            ]),
          ),
          sampledAtMs: now.getTime(),
        };
      });
    },
  };
}

interface BucketRow extends Record<string, unknown> {
  tokens: number;
  updated_at: Date;
}

async function updateBucket(
  transaction: PostgresExecutor,
  scopeKey: string,
  tokens: number,
  now: Date,
): Promise<void> {
  await transaction.execute(
    "UPDATE webhook_guard_buckets SET tokens = $1, updated_at = $2 WHERE scope_key = $3",
    [tokens, now, scopeKey],
  );
}

async function incrementCounter(
  transaction: PostgresExecutor,
  scopeKey: string,
  now: Date,
  outcome: string,
): Promise<void> {
  const bucketAt = new Date(Math.floor(now.getTime() / 300_000) * 300_000);
  await transaction.execute(
    `INSERT INTO webhook_guard_counters (scope_key, bucket_at, outcome, count)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (scope_key, bucket_at, outcome) DO UPDATE
       SET count = webhook_guard_counters.count + 1`,
    [scopeKey, bucketAt, normalizeOutcome(outcome)],
  );
}

async function deleteBounded(
  transaction: PostgresExecutor,
  table: string,
  timestampColumn: string,
  cutoff: Date,
  limit: number,
): Promise<number> {
  const allowed = new Set([
    "webhook_guard_leases.expires_at",
    "webhook_guard_duplicates.expires_at",
    "webhook_guard_counters.bucket_at",
  ]);
  if (!allowed.has(`${table}.${timestampColumn}`))
    throw new Error("Invalid guard maintenance table.");
  return transaction.execute(
    `DELETE FROM ${table}
      WHERE ctid IN (
        SELECT ctid FROM ${table}
         WHERE ${timestampColumn} <= $1
         ORDER BY ${timestampColumn}
         LIMIT $2
      )`,
    [cutoff, limit],
  );
}

function validatePolicy(policy: GuardPolicyInput): void {
  readBoundedInteger(policy.requestsPerMinute, "requestsPerMinute", 1, 1_000_000);
  readBoundedInteger(policy.burst, "burst", 1, 1_000_000);
  readBoundedInteger(policy.concurrency, "concurrency", 1, 100_000);
  readBoundedInteger(policy.leaseTimeoutMs, "leaseTimeoutMs", 100, 15 * 60_000);
  readBoundedInteger(policy.duplicateWindowMs, "duplicateWindowMs", 0, 24 * 60 * 60_000);
}

function readBoundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function readDate(value: number, name: string): Date {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a timestamp.`);
  return new Date(value);
}

function assertScopeKey(value: string): void {
  assertIdentifier(value, "webhook guard scope", 512);
}

function assertIdentifier(value: string, name: string, maximum: number): void {
  if (!value || value.length > maximum || [...value].some((entry) => entry.codePointAt(0)! < 32)) {
    throw new Error(`${name} must be a non-empty bounded identifier.`);
  }
}

function normalizeOutcome(value: string): string {
  return /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(value) ? value : "invalid_outcome";
}
