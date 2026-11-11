import { gatewayEnvelope } from "./support/gateway-envelope";
import { __testing as runtimeTesting } from "../src/node/postgres-runtime";
import { InMemoryObjectStore } from "./support/in-memory-object-store";
import assert from "node:assert/strict";
import test from "node:test";

import type { Env } from "./support/test-env";
import { createPostgresGuildAuditLogStore } from "../src/runtime/postgres/postgres-guild-audit-log-store";
import { createPostgresBlocklistStore } from "../src/runtime/postgres/postgres-blocklist-store";
import {
  createPostgresDatabaseCapabilityFromEnvironment,
  type PostgresDatabaseCapability,
} from "../src/runtime/postgres/postgres-capability";
import { createPostgresJobQueue } from "../src/runtime/postgres/postgres-job-queue";
import { initializePostgresSchema } from "../src/runtime/postgres/postgres-schema";
import { createPostgresReactionLimitStore } from "../src/runtime/postgres/postgres-reaction-limit-store";
import { deliverGatewayEventQueueBatch } from "../src/runtime/gateway-event-queue-consumer";
import { deriveGatewayEventKey } from "../src/runtime/gateway-event-idempotency";
import { createPostgresGatewayEventOperationStore } from "../src/runtime/postgres/postgres-gateway-event-operation-store";
import type { QueueDeliveryOutcome } from "../src/runtime/queue-delivery";

const postgresUrl = process.env.TEST_POSTGRES_URL;
const postgresOnly = { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" };

test(
  "PostgreSQL Gateway Reaction Limits count each event and breach once",
  postgresOnly,
  async (t) => {
    const database = await createTestDatabase();
    const reactions = createPostgresReactionLimitStore(database);
    const receipts = createPostgresGatewayEventOperationStore(database);
    const queue = createPostgresJobQueue(database);
    const env = createEnv();
    let now = new Date("2026-11-05T00:00:00.000Z");
    t.mock.method(Date, "now", () => now.getTime());
    t.mock.timers.enable({ apis: ["setInterval"] });
    t.mock.method(console, "log", () => {});
    t.mock.method(console, "error", () => {});
    t.mock.method(console, "warn", () => {});
    let deleteAttempts = 0;
    let deletes = 0;
    t.mock.method(
      globalThis,
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        assert.match(String(input), /^https:\/\/discord\.com\/api\//);
        assert.equal(init?.method, "DELETE");
        deleteAttempts += 1;
        // Blocklist has completed and the counters have committed before this failure.
        if (deleteAttempts === 2) return Response.json({ retry_after: 180 }, { status: 429 });
        if (deleteAttempts === 3) {
          // A heartbeat may renew the receipt while the failed provider request is in flight.
          now = new Date(now.getTime() + 40_000);
          t.mock.timers.tick(40_000);
          return Response.json({ retry_after: 2 }, { status: 429 });
        }
        deletes += 1;
        return new Response(null, { status: 204 });
      },
    );
    try {
      await reactions.upsertReactionLimitConfig({
        guildId: "guild-test",
        limitsEnabled: true,
        maxReactionsPerMessage: null,
        maxReactionsPerUserPerMessage: 0,
        breachThreshold: null,
        breachRoleId: null,
        breachRoleDurationMs: null,
        breachDmText: null,
        channelMode: "exclude",
        channelIds: [],
      });
      await database.execute(
        "INSERT INTO guild_entitlements (guild_id, plan, updated_at_ms) VALUES ($1, 'premium', 0)",
        ["guild-test"],
      );
      const blocklist = createPostgresBlocklistStore(database, "bot-test");
      await blocklist.applyGuildEmojiMutation({
        guildId: "guild-test",
        emoji: "🚫",
        action: "add",
      });
      for (const sequence of [1, 2]) {
        const payload = gatewayEnvelope({
          type: "MESSAGE_REACTION_ADD",
          sequence,
          data: {
            guild_id: "guild-test",
            channel_id: "channel-test",
            message_id: "message-test",
            user_id: "user-test",
            emoji: { id: null, name: "🚫", animated: false },
          },
        });
        // A v2 sequence identifies distinct events with the same reaction payload.
        const envelope = { ...payload, version: 2, sessionId: "session-test" };
        const body = { ...envelope, eventKey: deriveGatewayEventKey(envelope) };
        const job = await queue.enqueue({
          queueName: "gateway-events",
          payload: body,
          availableAt: now,
        });
        const reasons: string[] = [];
        for (let attempt = 1; attempt <= 4; attempt += 1) {
          const result = await deliverNext(queue, env, now, database);
          reasons.push(...result.reasons);
          const metadata = await queue.inspect(job.id);
          assert.ok(metadata);
          if (metadata.state !== "queued") break;
          const removing = await receipts.read(body.eventKey, "reaction-add:reaction-limit:remove");
          assert.ok(metadata.availableAt.getTime() >= removing!.leaseExpiresAtMs!);
          if (attempt === 1) assert.equal(metadata.availableAt.getTime() - now.getTime(), 180_000);
          now = metadata.availableAt;
        }
        assert.equal((await queue.inspect(job.id))?.state, "completed", reasons.join(","));
        assert.equal((await queue.inspect(job.id))?.attempts, sequence === 1 ? 3 : 1);
        assert.equal(
          (await receipts.read(body.eventKey, "reaction-add:blocklist"))?.state,
          "completed",
        );
        const counters = await receipts.read(body.eventKey, "reaction-add:reaction-limit:counters");
        assert.equal(counters?.state, "completed");
        assert.equal(counters?.attempts, 1);
        assert.deepEqual(JSON.parse(counters!.outcomeJson!), {
          totalReactions: sequence,
          userReactions: sequence,
        });
        // Duplicate delivery retains all completed mutations and Discord effects.
        await queue.enqueue({ queueName: "gateway-events", payload: body, availableAt: now });
        assert.equal((await deliverNext(queue, env, now, database)).state, "completed");
      }
      assert.deepEqual(await reactions.readBreachCounters("guild-test"), [
        { guildId: "guild-test", userId: "user-test", breachCount: 2 },
      ]);
      assert.equal(deletes, 4);
      assert.equal(deleteAttempts, 6);
    } finally {
      await database.close();
    }
  },
);

test(
  "PostgreSQL Gateway retries rate-limited member audits after the operation lease",
  postgresOnly,
  async (t) => {
    const database = await createTestDatabase();
    const queue = createPostgresJobQueue(database);
    const env = createEnv();
    let now = new Date("2026-11-05T00:00:00.000Z");
    t.mock.method(Date, "now", () => now.getTime());
    t.mock.method(console, "error", () => {});
    t.mock.method(console, "warn", () => {});
    const posts: Array<{ nonce: string; enforce_nonce: boolean }> = [];
    t.mock.method(
      globalThis,
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        assert.equal(String(input), "https://discord.com/api/v10/channels/audit-test/messages");
        assert.equal(init?.method, "POST");
        posts.push(JSON.parse(String(init?.body)));
        if (posts.length <= 2) return Response.json({ retry_after: 2 }, { status: 429 });
        return Response.json({ id: "audit-message-test" });
      },
    );
    try {
      await createPostgresGuildAuditLogStore(database).upsertConfig({
        guildId: "guild-test",
        auditChannelId: "audit-test",
        groupChannelIds: {},
        eventStates: {
          groups: {},
          overrides: { "member.role-assign": true, "member.role-remove": true },
        },
        updatedAtMs: now.getTime(),
      });
      const body = gatewayEnvelope({
        type: "GUILD_MEMBER_UPDATE",
        previousRoleIds: ["role-old"],
        data: {
          guild_id: "guild-test",
          user: { id: "user-test", username: "Test" },
          roles: ["role-new"],
        },
      });
      const eventKey = deriveGatewayEventKey(body);
      const job = await queue.enqueue({
        queueName: "gateway-events",
        payload: body,
        availableAt: now,
      });
      const reasons: string[] = [];
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        const result = await deliverNext(queue, env, now, database);
        reasons.push(...result.reasons);
        const metadata = await queue.inspect(job.id);
        assert.ok(metadata);
        if (metadata.state !== "queued") break;
        now = metadata.availableAt;
      }
      assert.equal((await queue.inspect(job.id))?.state, "completed", reasons.join(","));
      assert.equal((await queue.inspect(job.id))?.attempts, 3);
      assert.deepEqual(reasons, ["provider_rate_limited", "provider_rate_limited"]);
      const receipt = await createPostgresGatewayEventOperationStore(database).read(
        eventKey,
        "member-update:audit-role-assign",
      );
      assert.equal(receipt?.state, "completed");
      assert.equal(receipt?.attempts, 3);
      assert.equal(posts.length, 4);
      assert.equal(new Set(posts.slice(0, 3).map((post) => post.nonce)).size, 1);
      assert.ok(posts.every((post) => post.enforce_nonce));
      await queue.enqueue({ queueName: "gateway-events", payload: body, availableAt: now });
      assert.equal((await deliverNext(queue, env, now, database)).state, "completed");
      assert.equal(posts.length, 4);
    } finally {
      await database.close();
    }
  },
);

async function deliverNext(
  queue: ReturnType<typeof createPostgresJobQueue>,
  env: Env,
  now: Date,
  database: PostgresDatabaseCapability,
) {
  const [job] = await queue.claim({
    ownerId: "test-worker",
    queueNames: ["gateway-events"],
    limit: 1,
    now,
  });
  assert.ok(job);
  const result: { outcome?: QueueDeliveryOutcome } = {};
  const reasons: string[] = [];
  const message = {
    id: job.id,
    timestamp: now,
    body: job.payload,
    attempts: job.attempts,
    ack() {
      result.outcome = { status: "complete" };
    },
    retry(options?: QueueRetryOptions) {
      result.outcome = { status: "retry", reasonCode: "consumer_requested_retry", ...options };
    },
  };
  await deliverGatewayEventQueueBatch(
    {
      queue: "haf-bot-gateway-events",
      messages: [message],
      ackAll: () => message.ack(),
      retryAll: (options) => message.retry(options),
    },
    env,
    {
      error() {},
      info(name, value) {
        const event = value as { reasonCode?: string };
        if (name === "queue_delivery" && event.reasonCode) reasons.push(event.reasonCode);
      },
    },
    runtimeTesting.createGatewayDependencies(
      runtimeTesting.createNodeContext({
        environment: { NODE_ENV: "test", STAGING_MODE: "true" },
        env: { ...env, STAGING_MODE: "true" },
        database,
        objects: new InMemoryObjectStore(),
      }).app,
      env,
      database,
    ),
  );
  assert.ok(result.outcome);
  return {
    state: await queue.settle(job, result.outcome, new Date(Date.now())),
    reasons,
    jobId: job.id,
  };
}

function createEnv(): Env {
  return {
    DISCORD_PUBLIC_KEY: "a".repeat(64),
    BOT_USER_ID: "bot-test",
    DISCORD_BOT_TOKEN: "fake-token",
  } as Env;
}

async function createTestDatabase(): Promise<PostgresDatabaseCapability> {
  assert.ok(postgresUrl);
  const url = new URL(postgresUrl);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname.endsWith("_test"));
  const database = createPostgresDatabaseCapabilityFromEnvironment({
    DATABASE_URL: postgresUrl,
    NODE_ENV: "test",
    PG_POOL_MAX: "6",
  });
  await database.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await initializePostgresSchema(database);
  return database;
}
