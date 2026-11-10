import assert from "node:assert/strict";
import test from "node:test";
import { readdir } from "node:fs/promises";

import { createNodeHost } from "../src/node/host";
import { createPostgresNodeRuntime } from "../src/node/postgres-runtime";
import { createPostgresDatabaseCapabilityFromEnvironment } from "../src/runtime/postgres/postgres-capability";
import { PORTABLE_QUEUE_NAMES } from "../src/runtime/postgres/postgres-job-queue";
import { InMemoryObjectStore } from "./support/in-memory-object-store";

const postgresUrl = process.env.TEST_POSTGRES_URL;

test(
  "PostgreSQL Node runtime fails closed on pending migrations and serves the full application",
  { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
  async () => {
    assert.ok(postgresUrl);
    assertSafeTestDatabase(postgresUrl);
    const migrationNames = (await readdir("migrations/postgres"))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    assert.ok(migrationNames.length > 0);
    await resetDatabase(postgresUrl);
    const baseEnvironment = {
      DATABASE_URL: postgresUrl,
      NODE_ENV: "test",
      STAGING_MODE: "true",
      DISCORD_PUBLIC_KEY: "a".repeat(64),
      DISCORD_BOT_TOKEN: "portable-test-token",
      BOT_USER_ID: "123456789012345678",
      HAF_GATEWAY_ENABLED: "false",
      HAF_JOBS_ENABLED: "false",
      HAF_MAINTENANCE_MODE: "true",
    };
    await assert.rejects(
      createPostgresNodeRuntime({
        environment: { ...baseEnvironment, HAF_RUN_MIGRATIONS: "false" },
        lifecycle: { waitUntil() {} },
        objects: new InMemoryObjectStore(),
      }),
      /pending migration/,
    );

    const host = createNodeHost({
      role: "all",
      hostname: "127.0.0.1",
      port: 0,
      statusToken: "portable-status-token",
      maintenanceMode: true,
      staticRoot: "does-not-exist",
      createRuntime: (lifecycle) =>
        createPostgresNodeRuntime({
          environment: {
            ...baseEnvironment,
            HAF_RUN_MIGRATIONS: "true",
            HAF_JOBS_ENABLED: "true",
            HAF_JOB_POLL_MS: "10",
          },
          lifecycle,
          objects: new InMemoryObjectStore(),
        }),
    });
    const address = await host.start();
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const ready = await fetch(`${origin}/health/ready`);
      assert.equal(ready.status, 200);
      assert.deepEqual(await ready.json(), {
        status: "ready",
        role: "all",
        checks: {
          process: true,
          api: true,
          runtime: true,
          gateway: true,
          jobs: true,
          scheduler: true,
        },
      });

      const status = await fetch(`${origin}/internal/status`, {
        headers: { authorization: "Bearer portable-status-token" },
      });
      assert.equal(status.status, 200);
      const statusBody = (await status.json()) as {
        components: {
          jobs: { configuredQueues: string[] };
        };
        runtime: {
          migrationRuntime: string;
          migrations: number;
          migrationNames: string[];
          revision: string;
          objectStore: string;
          httpPersistence: string;
          activation: {
            gateway: boolean;
            jobs: boolean;
            scheduler: boolean;
            maintenance: boolean;
          };
        };
      };
      assert.deepEqual(statusBody.components.jobs.configuredQueues, [...PORTABLE_QUEUE_NAMES]);
      assert.deepEqual(statusBody.runtime, {
        migrationRuntime: "postgres",
        migrations: migrationNames.length,
        migrationNames,
        revision: "portable-node",
        objectStore: "injected",
        httpPersistence: "read-only",
        activation: { gateway: false, jobs: true, scheduler: false, maintenance: true },
        queues: [],
      });

      const application = await fetch(`${origin}/not-a-real-route`);
      assert.equal(application.status, 404);
      assert.equal(await application.text(), "Not found");
      assert.equal(
        (
          await fetch(`${origin}/interactions`, {
            method: "POST",
            body: "blocked",
          })
        ).status,
        503,
      );
    } finally {
      const result = await host.shutdown("test_complete");
      assert.equal(result.backgroundTasksDrained, true);
    }
  },
);

async function resetDatabase(url: string): Promise<void> {
  const database = createPostgresDatabaseCapabilityFromEnvironment({
    DATABASE_URL: url,
    NODE_ENV: "test",
  });
  try {
    await database.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  } finally {
    await database.close();
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
