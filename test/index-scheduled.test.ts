/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import worker from "../src/index";
import type { Env } from "../src/env";
import { isRecord } from "../src/unknown-parse";
import { createTestDatabase } from "./support/sqlite-d1-database";

test("scheduled bootstrap records accepted identities and version only after start completes", async () => {
  let finishStart!: () => void;
  const started = new Promise<void>((resolve) => {
    finishStart = resolve;
  });
  const fixture = await scheduledFixture({ beforeStart: () => started });
  try {
    const completion = fixture.run();
    await fixture.startRequested;
    assert.deepEqual(fixture.info, []);
    finishStart();
    await completion;

    assert.deepEqual(fixture.info, [
      {
        event: "haf.metric",
        metric: "scheduled_operation",
        operation: "gateway_bootstrap",
        outcome: "completed",
        identityCount: 1,
        environment: "production",
        workerVersion: "scheduled-worker-version",
      },
    ]);
    assert.deepEqual(fixture.gatewayActions, ["/start"]);
    assert.equal(fixture.bucketLists(), 1);
    assert.deepEqual(fixture.bootstrapFailures(), []);
  } finally {
    finishStart();
    fixture.close();
  }
});

test("failed scheduled bootstrap reports failure and continues maintenance without success evidence", async () => {
  const fixture = await scheduledFixture({ startStatus: 503 });
  try {
    await fixture.run();
    assert.deepEqual(fixture.info, []);
    assert.equal(fixture.bootstrapFailures().length, 1);
    assert.equal(fixture.bucketLists(), 1);
  } finally {
    fixture.close();
  }
});

test("disabled Gateway does not emit successful start evidence", async () => {
  const fixture = await scheduledFixture({ enabled: false });
  try {
    await fixture.run();
    assert.deepEqual(fixture.info, []);
    assert.deepEqual(fixture.gatewayActions, []);
    assert.equal(fixture.bucketLists(), 1);
  } finally {
    fixture.close();
  }
});

test("scheduled sweeps record empty attendance and financial database recovery without provider calls", async () => {
  const fixture = await scheduledFixture({ failAttendanceOnce: true });
  try {
    await fixture.run();
    assert.equal(
      fixture.completedTasks.filter((event) => event.operation === "Attendance observation").length,
      0,
    );
    assert.equal(
      fixture.completedTasks.filter(
        (event) => event.operation === "Commerce financial action sweep",
      ).length,
      1,
    );
    assert.equal(fixture.taskFailures().length, 1);

    await fixture.run();
    assert.equal(
      fixture.completedTasks.filter((event) => event.operation === "Attendance observation").length,
      1,
    );
    assert.equal(
      fixture.completedTasks.filter(
        (event) => event.operation === "Commerce financial action sweep",
      ).length,
      2,
    );
    assert.equal(fixture.taskFailures().length, 1);
    assert.equal(fixture.providerCalls(), 0);
    assert.ok(
      fixture.completedTasks.every(
        (event) =>
          event.outcome === "completed" && event.workerVersion === "scheduled-worker-version",
      ),
    );
  } finally {
    fixture.close();
  }
});

test("bootstrap telemetry failure does not report a Gateway failure or interrupt maintenance", async () => {
  const fixture = await scheduledFixture({ loggerFails: true });
  try {
    await fixture.run();
    assert.deepEqual(fixture.gatewayActions, ["/start"]);
    assert.deepEqual(fixture.bootstrapFailures(), []);
    assert.equal(fixture.bucketLists(), 1);
  } finally {
    fixture.close();
  }
});

test("maintenance stops Gateway without emitting successful bootstrap evidence", async () => {
  const fixture = await scheduledFixture({ maintenance: true });
  try {
    await fixture.run();
    assert.deepEqual(fixture.info, []);
    assert.deepEqual(fixture.gatewayActions, ["/stop"]);
    assert.equal(fixture.bucketLists(), 0);
  } finally {
    fixture.close();
  }
});

async function scheduledFixture(
  options: {
    enabled?: boolean;
    maintenance?: boolean;
    startStatus?: number;
    beforeStart?: () => Promise<void>;
    loggerFails?: boolean;
    failAttendanceOnce?: boolean;
  } = {},
) {
  const database = await createTestDatabase();
  let failAttendance = options.failAttendanceOnce;
  const prepare = database.d1.prepare.bind(database.d1);
  database.d1.prepare = (query) => {
    if (
      failAttendance &&
      query.startsWith("SELECT data FROM attendance_observation_runs WHERE active_target")
    ) {
      failAttendance = false;
      throw new Error("Synthetic attendance read outage");
    }
    return prepare(query);
  };
  const info: unknown[] = [];
  const completedTasks: Record<string, unknown>[] = [];
  const errors: unknown[] = [];
  const gatewayActions: string[] = [];
  let markStartRequested!: () => void;
  const startRequested = new Promise<void>((resolve) => {
    markStartRequested = resolve;
  });
  let bucketLists = 0;
  const originalInfo = console.info;
  const originalError = console.error;
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    throw new Error("Unexpected provider call in empty scheduled sweep");
  };
  console.info = (payload: unknown) => {
    if (!isRecord(payload) || payload.metric !== "scheduled_operation") return;
    if (payload.operation !== "gateway_bootstrap") {
      completedTasks.push(payload);
      return;
    }
    if (options.loggerFails) throw new Error("Logger unavailable");
    info.push(payload);
  };
  console.error = (payload) => errors.push(payload);
  const env = {
    DISCORD_BOT_TOKEN: "test-bot-token",
    BOT_USER_ID: "test-bot-user",
    DISCORD_PUBLIC_KEY: "a".repeat(64),
    COMPONENT_ID_SIGNING_SECRET: "component-id-signing-secret-for-production-tests",
    GATEWAY_ENABLED: options.enabled === false ? "false" : "true",
    HAF_MAINTENANCE_MODE: options.maintenance ? "true" : "false",
    HAF_DB: database.d1,
    STRIPE_SECRET_KEY: "sk_live_local_fixture_not_a_real_key",
    STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_local_fixture_not_a_real_key",
    STRIPE_API_VERSION: "2026-09-30.clover",
    COMMERCE_SYNC_QUEUE: { send: async () => undefined } as unknown as Env["COMMERCE_SYNC_QUEUE"],
    WORKER_VERSION: { id: "scheduled-worker-version" },
    GATEWAY_SESSION_DO: {
      idFromName: (name: string) => name,
      get: () => ({
        async fetch(input: RequestInfo | URL) {
          const action = new URL(String(input)).pathname;
          gatewayActions.push(action);
          if (action === "/start") {
            markStartRequested();
            await options.beforeStart?.();
          }
          return Response.json(
            {
              status: "connecting",
              sessionId: "private-session-id",
              resumeGatewayUrl: "wss://private-gateway.example/",
              lastError: "private-diagnostic",
            },
            { status: action === "/start" ? (options.startStatus ?? 200) : 200 },
          );
        },
      }),
    } as unknown as DurableObjectNamespace,
    TICKET_TRANSCRIPTS_BUCKET: {
      async list() {
        bucketLists += 1;
        return { objects: [], truncated: false };
      },
    } as unknown as R2Bucket,
  } as Env;
  return {
    info,
    startRequested,
    completedTasks,
    gatewayActions,
    bucketLists: () => bucketLists,
    bootstrapFailures: () =>
      errors.filter((error) => isRecord(error) && error.code === "scheduled.bootstrap_failed"),
    taskFailures: () =>
      errors.filter((error) => isRecord(error) && error.code === "scheduled.task_failed"),
    providerCalls: () => providerCalls,
    async run() {
      const pending: Promise<unknown>[] = [];
      worker.scheduled({} as ScheduledController, env, {
        waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      } as unknown as ExecutionContext);
      await Promise.all(pending);
    },
    close() {
      console.info = originalInfo;
      console.error = originalError;
      globalThis.fetch = originalFetch;
      database.close();
    },
  };
}
