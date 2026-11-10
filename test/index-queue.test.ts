import type { QueueProducer, QueueBatch } from "../src/runtime/queue-types";
/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import worker from "../src/index";
import { isRecord } from "../src/unknown-parse";
import { createLegacyCommunityStoreDatabase } from "./helpers/legacy-community-store-d1";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("worker queue dispatches gateway event queue batches", async () => {
  const fetchCalls: Array<{ input: string; method: string | undefined; body: string | undefined }> =
    [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    fetchCalls.push({
      input: String(input),
      method: init?.method,
      body: typeof init?.body === "string" ? init.body : undefined,
    });

    return Response.json({ id: "message-1", channel_id: "global-admin-log-channel", content: "" });
  };

  try {
    await worker.queue(
      createMessageBatch("haf-bot-gateway-events", [
        { type: "GUILD_CREATE", data: { id: "guild-1", name: "Guild One" } },
      ]),
      createQueueEnv({ GLOBAL_ADMIN_LOG_CHANNEL_ID: "global-admin-log-channel" }),
      {} as ExecutionContext,
    );

    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0]?.body ?? "", /"title":"🟢 Bot Installed"/);
    assert.match(fetchCalls[0]?.body ?? "", /"value":"Guild One"/);
    assert.match(fetchCalls[0]?.body ?? "", /"value":"guild-1"/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker queue auto-leaves when a suspended guild installs the bot", async () => {
  const database = new SqliteD1Database();
  await database.exec(`
    INSERT INTO guild_service_suspensions
      (guild_id, reason, created_at_ms, created_by_user_id)
    VALUES ('guild-1', 'internal evidence', 1, 'admin');
  `);
  const fetchCalls: Array<{ input: string; method: string; authorization: string | null }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    fetchCalls.push({
      input: String(input),
      method: init?.method ?? "GET",
      authorization: new Headers(init?.headers).get("Authorization"),
    });
    return new Response(null, { status: 204 });
  };

  try {
    await worker.queue(
      createMessageBatch("haf-bot-gateway-events", [
        { type: "GUILD_CREATE", data: { id: "guild-1", name: "Blocked Guild" } },
      ]),
      createQueueEnv({ HAF_DB: database as unknown as D1Database }),
      {} as ExecutionContext,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(fetchCalls, [
    {
      input: "https://discord.com/api/v10/users/@me/guilds/guild-1",
      method: "DELETE",
      authorization: "Bot bot-token",
    },
  ]);
  assert.equal(
    await database
      .prepare("SELECT guild_id FROM known_guilds WHERE guild_id = ?")
      .bind("guild-1")
      .first(),
    null,
  );
});

test("worker queue keeps non-gateway batches on the R2 quota consumer path", async () => {
  const r2Writes: unknown[] = [];

  await worker.queue(
    createMessageBatch("haf-bot-r2-quota", [
      {
        event: "object-create",
        eventTime: "2026-05-25T12:34:56.789Z",
        object: { key: "guild-1/transcript.html", size: 42 },
      },
    ]),
    createQueueEnv({ HAF_DB: createR2CaptureD1Database(r2Writes) }),
    {} as ExecutionContext,
  );

  assert.deepEqual(r2Writes, [
    {
      guildId: "guild-1",
      key: "guild-1/transcript.html",
      sizeBytes: 42,
    },
  ]);
});

test("worker maintenance mode leaves Queue consumers available for an ordered drain", async () => {
  const r2Writes: unknown[] = [];

  await worker.queue(
    createMessageBatch("haf-bot-r2-quota", [
      {
        event: "object-create",
        eventTime: "2026-05-25T12:34:56.789Z",
        object: { key: "guild-maintenance/transcript.html", size: 7 },
      },
    ]),
    createQueueEnv({
      HAF_MAINTENANCE_MODE: "true",
      HAF_DB: createR2CaptureD1Database(r2Writes),
    }),
    {} as ExecutionContext,
  );

  assert.equal(r2Writes.length, 1);
});

test("worker queue reports an unknown consumer and rethrows the original error", async () => {
  const errors: unknown[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => errors.push(args[0]);
  try {
    await assert.rejects(
      () =>
        worker.queue(
          createMessageBatch("haf-bot-unknown", [{ guildId: "guild-1" }]),
          createQueueEnv(),
          {} as ExecutionContext,
        ),
      (error: unknown) =>
        error instanceof Error &&
        error.message === "No Queue consumer is configured for haf-bot-unknown.",
    );
  } finally {
    console.error = originalError;
  }
  const payload = errors.find(isRecord) as
    | { code?: string; severity?: string; environment?: string }
    | undefined;
  assert.equal(payload?.code, "queue.unknown_consumer");
  assert.equal(payload?.severity, "critical");
  assert.equal(payload?.environment, "production");
});

test("worker queue reports its deployed version inside a Sentry invocation boundary", async () => {
  const waitUntil: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;
  let sentryRequests = 0;
  let sentryEnvelope = "";
  globalThis.fetch = async (_input, init) => {
    sentryRequests += 1;
    sentryEnvelope += await new Response(init?.body).text();
    return new Response(null, { status: 200 });
  };
  const context = {
    waitUntil(promise: Promise<unknown>) {
      waitUntil.push(promise);
    },
    passThroughOnException() {},
    props: {},
  } as ExecutionContext;
  try {
    await assert.rejects(() =>
      worker.queue(
        createMessageBatch("haf-bot-unknown", [{ guildId: "guild-1" }]),
        createQueueEnv({
          SENTRY_DSN: "https://public@example.test/1",
          WORKER_VERSION: { id: "worker-version-test" },
        }),
        context,
      ),
    );
    await Promise.allSettled(waitUntil);
    assert.ok(waitUntil.length >= 1);
    assert.equal(sentryRequests, 1);
    assert.match(sentryEnvelope, /"release":"worker-version-test"/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker queue runs compensating ticket recovery for suspended guilds", async () => {
  const database = new SqliteD1Database();
  await database.exec(`
    INSERT INTO guild_service_suspensions
      (guild_id, reason, created_at_ms, created_by_user_id)
    VALUES ('guild-1', 'billing', 1, 'admin');
    INSERT INTO ticket_template_replies
      (interaction_id, guild_id, ticket_channel_id, template_id, template_internal_name,
       staff_user_id, bot_message_id, status, created_at_ms)
    VALUES ('interaction-1', 'guild-1', 'ticket-channel', 'template-1', 'Greeting',
            'staff', NULL, 'pending', 1);
  `);

  await worker.queue(
    createMessageBatch("haf-bot-ticket-recovery", [
      {
        kind: "template-reply-completion",
        recovery: {
          interactionId: "interaction-1",
          botMessageId: "message-1",
          ticket: { guildId: "guild-1" },
          template: { id: "template-1" },
        },
      },
    ]),
    createQueueEnv({ HAF_DB: database as unknown as D1Database }),
    {} as ExecutionContext,
  );

  const row = await database
    .prepare("SELECT status, bot_message_id FROM ticket_template_replies WHERE interaction_id = ?")
    .bind("interaction-1")
    .first<{ status: string; bot_message_id: string | null }>();
  assert.deepEqual(row, { status: "sent", bot_message_id: "message-1" });
});

function createMessageBatch(queue: string, bodies: unknown[]): QueueBatch<unknown> {
  return {
    queue,
    messages: bodies.map((body, index) => ({
      id: `message-${index + 1}`,
      body,
      attempts: 1,
      timestamp: new Date(),
      ack() {},
      retry() {},
    })),
    ackAll() {},
    retryAll() {},
  } as QueueBatch<unknown>;
}

function createQueueEnv(options?: {
  GLOBAL_ADMIN_LOG_CHANNEL_ID?: string;
  HAF_DB?: D1Database;
  HAF_MAINTENANCE_MODE?: string;
  SENTRY_DSN?: string;
  WORKER_VERSION?: { id: string };
}) {
  return {
    DISCORD_BOT_TOKEN: "bot-token",
    BOT_USER_ID: "bot-user-id",
    DISCORD_PUBLIC_KEY: "a".repeat(64),
    COMPONENT_ID_SIGNING_SECRET: "component-id-signing-secret-for-production-tests",
    GLOBAL_ADMIN_LOG_CHANNEL_ID: options?.GLOBAL_ADMIN_LOG_CHANNEL_ID,
    HAF_MAINTENANCE_MODE: options?.HAF_MAINTENANCE_MODE,
    SENTRY_DSN: options?.SENTRY_DSN,
    WORKER_VERSION: options?.WORKER_VERSION,
    HAF_DB: options?.HAF_DB ?? createLegacyCommunityStoreDatabase(),
    GATEWAY_SESSION_DO: {
      idFromName() {
        return "gateway-session-id" as never;
      },
      get() {
        return { fetch: async () => Response.json({ status: "idle" }) };
      },
    } as never,
    R2_QUOTA_QUEUE: {} as QueueProducer<unknown>,
    GATEWAY_EVENT_QUEUE: {} as QueueProducer<unknown>,
    TICKET_TRANSCRIPTS_BUCKET: {} as R2Bucket,
    DISCORD_CACHE_KV: {
      get: async () => null,
      put: async () => undefined,
      delete: async () => undefined,
      list: async () => ({ keys: [], list_complete: true, cursor: undefined }),
    } as unknown as KVNamespace,
  } as never;
}

function createR2CaptureD1Database(writes: unknown[]): D1Database {
  const database = new SqliteD1Database();
  const originalPrepare = database.prepare.bind(database);
  database.prepare = (query: string) => {
    const statement = originalPrepare(query);
    const originalBind = statement.bind.bind(statement);
    statement.bind = (...args: unknown[]) => {
      const bound = originalBind(...args);
      const originalRun = bound.run.bind(bound);
      bound.run = async () => {
        if (query.includes("guild_r2_objects")) {
          writes.push({ guildId: args[0], key: args[1], sizeBytes: args[2] });
        }
        return originalRun();
      };
      return bound;
    };
    return statement;
  };
  return database as unknown as D1Database;
}
