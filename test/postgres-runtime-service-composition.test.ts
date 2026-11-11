import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createRuntimeApp } from "../src/runtime/app";
import { __testing as runtimeTesting } from "../src/node/postgres-runtime";
import { composeApplicationServices } from "../src/runtime/service-composition";
import {
  createPostgresDatabaseCapabilityFromEnvironment,
  type PostgresDatabaseCapability,
} from "../src/runtime/postgres/postgres-capability";
import { createPostgresJobQueue } from "../src/runtime/postgres/postgres-job-queue";
import type { PostgresJobHandlerContext } from "../src/runtime/postgres/postgres-job-worker";
import { initializePostgresSchema } from "../src/runtime/postgres/postgres-schema";
import { maintainServerLevels } from "../src/runtime/server-level-queue-consumer";
import { createWebhookCredentialKeyRing } from "../src/security/webhook-credentials";
import { WebhookCredentialService } from "../src/security/webhook-credentials/store";
import { createPostgresWebhookCredentialStore } from "../src/security/webhook-credentials/postgres-store";
import type { ConfiguredGameServer, ServerLevelProviderEvent } from "../src/server-levels/model";
import type { WebhookProxyConfig } from "../src/types";
import { InMemoryObjectStore } from "./support/in-memory-object-store";
import type { QueueDeliveryOutcome } from "../src/runtime/queue-delivery";

const postgresUrl = process.env.TEST_POSTGRES_URL;

function handlerContext(
  queueName: PostgresJobHandlerContext["queueName"],
  jobId: string,
): PostgresJobHandlerContext {
  return {
    jobId,
    queueName,
    attempts: 1,
    maxAttempts: 3,
    signal: new AbortController().signal,
  };
}

async function resetAndMigrate(database: PostgresDatabaseCapability): Promise<void> {
  await database.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await initializePostgresSchema(database);
}

function assertSafeTestDatabase(value: string): void {
  const url = new URL(value);
  const databaseName = url.pathname.slice(1);
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (!local || !databaseName.endsWith("_test")) {
    throw new Error("PostgreSQL integration tests require a local database ending in _test.");
  }
}

test(
  "Node composition feeds HTTP, direct queue delivery and scheduled maintenance from one graph",
  { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
  async () => {
    assert.ok(postgresUrl);
    assertSafeTestDatabase(postgresUrl);
    const database = createPostgresDatabaseCapabilityFromEnvironment({
      DATABASE_URL: postgresUrl,
      NODE_ENV: "test",
      PG_POOL_MAX: "8",
    });
    const originalFetch = globalThis.fetch;
    const forwardCalls: string[] = [];
    // The composed services capture fetch at construction; install the fake
    // before composition so delivery targets the recording boundary.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      forwardCalls.push(String(input));
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    try {
      await resetAndMigrate(database);
      const jobs = createPostgresJobQueue(database);
      const environment = {
        NODE_ENV: "test",
        STAGING_MODE: "true",
        DISCORD_PUBLIC_KEY: "a".repeat(64),
        DISCORD_BOT_TOKEN: "composition-test-token",
        BOT_USER_ID: "123456789012345678",
        // Fictional test key ring so webhook credentials persist and resolve.
        WEBHOOK_CREDENTIAL_KEY_V1: Buffer.alloc(32, 7).toString("base64"),
      };
      const queues = runtimeTesting.createQueueBindings(database, jobs);
      const env = runtimeTesting.createNodeEnvironment(environment, queues);
      const composition = runtimeTesting.createNodeContext({
        environment,
        env,
        database,
        objects: new InMemoryObjectStore(),
      });
      // Composition mirrors the Node runtime root: one graph from the selected
      // context, Gateway controller and host lifecycle.
      const waitUntil = (promise: Promise<unknown>) => void promise.catch(() => undefined);
      const services = composeApplicationServices({
        ...composition.app,
        gateway: { start: async () => {}, status: async () => ({}) },
        waitUntil,
      });
      assert.ok(services.serverLevelProcessor);

      // Persist the destination credential through the same key ring the
      // composed WebhookCredentialService uses, then seed the proxy config.
      const credentials = new WebhookCredentialService(
        createPostgresWebhookCredentialStore(database),
        createWebhookCredentialKeyRing({ keyV1: environment.WEBHOOK_CREDENTIAL_KEY_V1 }),
      );
      const credential = await credentials.replace(
        {
          kind: "proxy_destination",
          guildId: "guild-1",
          publicId: "public_webhook_composition",
          destinationId: "main",
        },
        "https://discord.com/api/webhooks/900001/main",
      );
      const config: WebhookProxyConfig = {
        guildId: "guild-1",
        publicId: "public_webhook_composition",
        name: "Alerts",
        enabled: true,
        banLookupEnabled: false,
        banLookupCredentialId: null,
        banLookupAppIds: [],
        destinations: [{ id: "main", label: "Main", credentialId: credential.credentialId }],
        defaultDestinationIds: ["main"],
        routingRules: [],
        createdAtMs: 1,
        updatedAtMs: 1,
      };
      await composition.app.stores.webhookProxy.upsertWebhookProxyConfig(config);
      await database.execute(
        "INSERT INTO guild_entitlements (guild_id, plan, updated_at_ms) VALUES ('guild-1', 'premium', 1)",
      );

      // HTTP dispatch consumes the composed graph through the runtime app.
      const runtimeApp = createRuntimeApp({
        ...composition.app,
        services,
        gateway: { start: async () => {}, status: async () => ({}) },
        environment: "staging",
        waitUntil,
      });
      const health = await runtimeApp.fetch(new Request("https://runtime.example/health"));
      assert.equal(health.status, 200);

      const ingress = await runtimeApp.fetch(
        new Request("https://runtime.example/webhooks/public_webhook_composition", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: "composition delivery" }),
        }),
      );
      assert.equal(ingress.status, 204);
      assert.equal(forwardCalls.length, 0, "ingress hands delivery to the native queue");

      const now = new Date();
      const [claimed] = await jobs.claim({
        ownerId: "composition-test-worker",
        queueNames: ["webhook-proxy-deliveries"],
        limit: 1,
        now,
      });
      assert.ok(claimed, "the composed HTTP graph enqueued the delivery job");
      const handlers = runtimeTesting.createJobHandlers({
        env,
        context: composition.app,
        services,
        selected: composition.selected,
        gatewayDependencies: runtimeTesting.createGatewayDependencies({
          context: composition.app,
          database,
          paidRoles: composition.selected.paidRoles,
        }),
        database,
        guildObjects: composition.guildObjects,
      });
      const deliveryHandler = handlers["webhook-proxy-deliveries"];
      assert.ok(deliveryHandler);
      const outcome: QueueDeliveryOutcome = await deliveryHandler(
        claimed.payload,
        handlerContext("webhook-proxy-deliveries", claimed.id),
      );
      assert.deepEqual(outcome, { status: "complete" });
      assert.deepEqual(forwardCalls, ["https://discord.com/api/webhooks/900001/main"]);
      const settled = await jobs.settle(claimed, outcome, new Date(Date.now() + 1));
      assert.equal(settled, "completed");

      // Scheduled maintenance consumes the SAME composition-selected processor
      // through the maintenance seam against the shared store.
      const serverLevels = composition.app.stores.serverLevels;
      await serverLevels.upsertConfig({
        guildId: "guild-1",
        enabled: true,
        announcementChannelId: null,
        removedAtMs: null,
        updatedAtMs: 1,
      });
      const configuredServer: ConfiguredGameServer = {
        id: "server-1",
        guildId: "guild-1",
        displayName: "Main",
        providerServerId: "127.0.0.1:27015",
        maxSlots: 4,
        endpointId: "endpoint-1",
        webhookCredentialId: "credential-1",
        webhookVerifiedAtMs: 1,
        subscribedEvents: ["user.join"],
        capacityProposal: null,
        lastRosterReconciledAtMs: null,
        lastCapacityCheckedAtMs: null,
        createdAtMs: 1,
        updatedAtMs: 1,
      };
      await serverLevels.createConfiguredGameServer(configuredServer);
      const providerEvent: ServerLevelProviderEvent = {
        inboxId: "inbox-1",
        deliveryId: "delivery-1",
        configuredGameServerId: "server-1",
        guildId: "guild-1",
        eventType: "player.join",
        occurredAtMs: 1_000,
        steamId64: "76561198000000001",
        population: 1,
        queueSize: 0,
        receivedAtMs: 1_000,
      };
      const accepted = await serverLevels.acceptProviderEvent(providerEvent);
      assert.equal(accepted.accepted, true);

      const levelQueue = queues["server-levels"];
      await levelQueue.send({ inboxId: "inbox-1", guildId: "guild-1" });
      const [levelJob] = await jobs.claim({
        ownerId: "composition-test-worker",
        queueNames: ["server-levels"],
        limit: 1,
        now: new Date(),
      });
      assert.ok(levelJob, "the ingress outbox published a Server Levels job");
      const levelHandler = handlers["server-levels"];
      assert.ok(levelHandler);
      const levelOutcome = await levelHandler(
        levelJob.payload,
        handlerContext("server-levels", levelJob.id),
      );
      assert.deepEqual(levelOutcome, { status: "complete" });
      const maintenance = await maintainServerLevels(env, composition.app, {
        processor: services.serverLevelProcessor!,
      });
      assert.equal(maintenance.servers, 1);
      assert.ok(await serverLevels.readProviderEvent("inbox-1"));
    } finally {
      globalThis.fetch = originalFetch;
      await database.close();
    }
  },
);

test(
  "maintenance HTTP composes a separate read-only graph that cannot write",
  { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
  async () => {
    assert.ok(postgresUrl);
    assertSafeTestDatabase(postgresUrl);
    const writableDatabase = createPostgresDatabaseCapabilityFromEnvironment({
      DATABASE_URL: postgresUrl,
      NODE_ENV: "test",
      PG_POOL_MAX: "8",
    });
    try {
      await resetAndMigrate(writableDatabase);
      const readOnlyDatabase = createPostgresDatabaseCapabilityFromEnvironment(
        { DATABASE_URL: postgresUrl, NODE_ENV: "test", PG_POOL_MAX: "4" },
        { readOnly: true },
      );
      try {
        assert.equal(await readOnlyDatabase.isReady(), true);

        const jobs = createPostgresJobQueue(writableDatabase);
        const environment = {
          NODE_ENV: "test",
          STAGING_MODE: "true",
          DISCORD_PUBLIC_KEY: "a".repeat(64),
          DISCORD_BOT_TOKEN: "composition-test-token",
          BOT_USER_ID: "123456789012345678",
        };
        const queues = runtimeTesting.createQueueBindings(writableDatabase, jobs);
        const env = runtimeTesting.createNodeEnvironment(environment, queues);
        const writable = runtimeTesting.createNodeContext({
          environment,
          env,
          database: writableDatabase,
          objects: new InMemoryObjectStore(),
        });
        const readOnly = runtimeTesting.createNodeContext({
          environment,
          env,
          database: readOnlyDatabase,
          objects: new InMemoryObjectStore(),
        });
        const writableServices = composeApplicationServices({
          ...writable.app,
          gateway: { start: async () => {}, status: async () => ({}) },
        });
        const readOnlyServices = composeApplicationServices({
          ...readOnly.app,
          gateway: { start: async () => {}, status: async () => ({}) },
        });

        // Maintenance composes its own read-only graph; it never receives the
        // writable composition's services or stores.
        assert.notEqual(writableServices, readOnlyServices);
        assert.notEqual(writable.app.stores.blocklist, readOnly.app.stores.blocklist);

        // The writable graph persists service suspensions.
        await writable.app.stores.guildServiceSuspensions.suspendGuild({
          guildId: "guild-writable",
          reason: "private",
          actorUserId: "admin",
          occurredAtMs: 1,
        });
        assert.ok(
          await writable.app.stores.guildServiceSuspensions.readActiveSuspension("guild-writable"),
        );

        // The read-only HTTP graph refuses the same write and its rejected
        // write never persisted through the shared store.
        await assert.rejects(() =>
          readOnly.app.stores.guildServiceSuspensions.suspendGuild({
            guildId: "guild-readonly",
            reason: "private",
            actorUserId: "admin",
            occurredAtMs: 1,
          }),
        );
        assert.equal(
          await writable.app.stores.guildServiceSuspensions.readActiveSuspension("guild-readonly"),
          null,
          "the read-only graph never wrote through the writable store",
        );
      } finally {
        await readOnlyDatabase.close();
      }
    } finally {
      await writableDatabase.close();
    }
  },
);
