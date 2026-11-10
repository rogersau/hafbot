import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import {
  createPostgresDatabaseCapabilityFromEnvironment,
  type PostgresDatabaseCapability,
} from "../src/runtime/postgres/postgres-capability";
import {
  applyPostgresMigrations,
  readPostgresMigrations,
} from "../src/runtime/postgres/postgres-migrations";
import { createPostgresWebhookIngressGuard } from "../src/runtime/postgres/postgres-webhook-ingress-guard";

const postgresUrl = process.env.TEST_POSTGRES_URL;

test(
  "PostgreSQL webhook guard preserves atomic concurrency, rate, and duplicate limits",
  { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
  async () => {
    assert.ok(postgresUrl);
    assertSafeTestDatabase(postgresUrl);
    const database = createTestDatabase(postgresUrl);
    try {
      await resetAndMigrate(database);
      let leaseId = 0;
      const guard = createPostgresWebhookIngressGuard(database, {
        randomId: () => `guard-lease-${++leaseId}`,
      });
      const scope = guard.getByName("source:v1:webhook-proxy:public-1");
      const nowMs = Date.parse("2026-08-20T00:00:00.000Z");
      const policy = {
        requestsPerMinute: 600,
        burst: 10,
        concurrency: 2,
        leaseTimeoutMs: 1_000,
        duplicateWindowMs: 60_000,
      };
      const [first, second] = await Promise.all([
        scope.reserve({ nowMs, policy }),
        scope.reserve({ nowMs, policy }),
      ]);
      assert.equal(first.ok, true);
      assert.equal(second.ok, true);
      const concurrencyLimited = await scope.reserve({ nowMs, policy });
      assert.deepEqual(concurrencyLimited, {
        ok: false,
        reason: "concurrency_limited",
        retryAfterSeconds: 1,
      });
      assert.ok(first.ok && second.ok);
      assert.deepEqual(
        await scope.registerBody({
          leaseId: first.leaseId,
          sha256: "body-sha",
          nowMs,
          duplicateWindowMs: 60_000,
        }),
        { ok: true },
      );
      await scope.complete({ leaseId: first.leaseId, outcome: "accepted", nowMs });
      const third = await scope.reserve({ nowMs, policy });
      assert.ok(third.ok);
      assert.deepEqual(
        await scope.registerBody({
          leaseId: third.leaseId,
          sha256: "body-sha",
          nowMs,
          duplicateWindowMs: 60_000,
        }),
        { ok: false, reason: "duplicate" },
      );
      await scope.complete({
        leaseId: third.leaseId,
        outcome: "retryable_failure",
        nowMs,
        sha256: "body-sha",
        retryable: true,
      });
      const fourth = await scope.reserve({ nowMs, policy });
      assert.ok(fourth.ok);
      assert.deepEqual(
        await scope.registerBody({
          leaseId: fourth.leaseId,
          sha256: "body-sha",
          nowMs,
          duplicateWindowMs: 60_000,
        }),
        { ok: true },
      );
      await scope.complete({ leaseId: second.leaseId, outcome: "accepted", nowMs });
      await scope.complete({ leaseId: fourth.leaseId, outcome: "accepted", nowMs });

      const rateScope = guard.getByName("global:v2:ban-case");
      const ratePolicy = { ...policy, requestsPerMinute: 60, burst: 1, concurrency: 10 };
      assert.equal((await rateScope.reserve({ nowMs, policy: ratePolicy })).ok, true);
      const rateLimited = await rateScope.reserve({ nowMs, policy: ratePolicy });
      assert.equal(rateLimited.ok, false);
      assert.equal(rateLimited.ok ? null : rateLimited.reason, "rate_limited");
      assert.equal(
        (
          await rateScope.reserve({
            nowMs: nowMs + 1_000,
            policy: ratePolicy,
          })
        ).ok,
        true,
      );

      const singleScope = guard.getByName("invalid-source:v1:ban-case:global");
      const singlePolicy = { ...policy, concurrency: 1 };
      const concurrent = await Promise.all([
        singleScope.reserve({ nowMs, policy: singlePolicy }),
        singleScope.reserve({ nowMs, policy: singlePolicy }),
      ]);
      assert.equal(concurrent.filter((result) => result.ok).length, 1);
      assert.equal(
        concurrent.filter((result) => !result.ok && result.reason === "concurrency_limited").length,
        1,
      );

      const snapshot = await scope.snapshot(nowMs);
      assert.equal(snapshot.activeLeases, 0);
      assert.equal(snapshot.outcomes.reserved, 4);
      assert.equal(snapshot.outcomes.accepted, 3);
      assert.equal(snapshot.outcomes.duplicate, 1);
      assert.equal(snapshot.outcomes.concurrency_limited, 1);
      assert.equal(await guard.pruneExpired(nowMs + 86_400_001), 12);
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
  await applyPostgresMigrations(
    database,
    await readPostgresMigrations(resolve("migrations/postgres")),
  );
}

function assertSafeTestDatabase(value: string): void {
  const url = new URL(value);
  const databaseName = url.pathname.slice(1);
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (!local || !databaseName.endsWith("_test")) {
    throw new Error("PostgreSQL integration tests require a local database ending in _test.");
  }
}
