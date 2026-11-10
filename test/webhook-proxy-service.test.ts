/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import {
  evaluateWebhookProxyPayload,
  selectDestinations,
  WebhookProxyNotFoundError,
  WebhookProxyService,
} from "../src/services/webhook-proxy-service";
import type { WebhookProxyConfig } from "../src/types";
import type { WebhookProxyStore } from "../src/runtime/contracts";
import { afterStoreSeed, createProductionRuntimeStores } from "./support/production-runtime-stores";

const baseConfig: WebhookProxyConfig = {
  guildId: "guild-1",
  publicId: "public_webhook_1234",
  name: "Server alerts",
  enabled: true,
  banLookupEnabled: false,
  banLookupNotificationUrl: null,
  banLookupAppIds: [],
  destinations: [
    { id: "main", label: "Main", url: "https://discord.com/api/webhooks/1/main" },
    { id: "errors", label: "Errors", url: "https://discord.com/api/webhooks/2/errors" },
  ],
  defaultDestinationIds: ["main"],
  routingRules: [
    {
      id: "errors",
      label: "Errors",
      pattern: "error|failed",
      flags: "i",
      destinationIds: ["errors"],
    },
  ],
  createdAtMs: 1,
  updatedAtMs: 1,
};

function createStore(
  config: WebhookProxyConfig | null,
  overrides: Partial<WebhookProxyStore> = {},
): WebhookProxyStore {
  const fixture = createProductionRuntimeStores();
  const rawStore = fixture.stores.webhookProxy;
  const ready = config ? rawStore.upsertWebhookProxyConfig(config) : Promise.resolve();
  const store = afterStoreSeed(rawStore, ready);
  return Object.assign(store, overrides);
}

test("selectDestinations uses defaults when no regex rule matches", () => {
  assert.deepEqual(
    selectDestinations(baseConfig, JSON.stringify({ content: "hello" })).map(
      (destination) => destination.id,
    ),
    ["main"],
  );
});

test("selectDestinations uses regex-routed destinations when a rule matches", () => {
  assert.deepEqual(
    selectDestinations(baseConfig, JSON.stringify({ content: "ERROR: bad things" })).map(
      (destination) => destination.id,
    ),
    ["errors"],
  );
});

test("evaluateWebhookProxyPayload mirrors replacements, all rule matches, destinations, and Steam extraction", () => {
  const config: WebhookProxyConfig = {
    ...baseConfig,
    banLookupEnabled: true,
    contentReplacements: [
      { id: "rename", label: "Rename", pattern: "ERROR", flags: "g", replacement: "ALERT" },
    ],
    routingRules: [
      {
        id: "alert",
        label: "Alerts",
        pattern: "ALERT",
        flags: "i",
        destinationIds: ["errors"],
      },
      {
        id: "steam",
        label: "Steam IDs",
        pattern: "76561198000000000",
        flags: "",
        destinationIds: ["errors", "main"],
      },
    ],
  };

  const result = evaluateWebhookProxyPayload(
    config,
    JSON.stringify({ content: "ERROR 76561198000000000" }),
    "application/json",
  );

  assert.equal(result.transformedBody, '{"content":"ALERT 76561198000000000"}');
  assert.deepEqual(
    result.matchedRules.map((rule) => rule.label),
    ["Alerts", "Steam IDs"],
  );
  assert.deepEqual(
    result.destinations.map((destination) => destination.id),
    ["errors", "main"],
  );
  assert.equal(result.usedDefaultDestinations, false);
  assert.deepEqual(result.steamIds, ["76561198000000000"]);
});

test("evaluateWebhookProxyPayload reports fallback destinations when no rule matches", () => {
  const result = evaluateWebhookProxyPayload(baseConfig, "plain text", "text/plain");
  assert.equal(result.usedDefaultDestinations, true);
  assert.deepEqual(result.matchedRules, []);
  assert.deepEqual(
    result.destinations.map((destination) => destination.id),
    ["main"],
  );
});

test("evaluateWebhookProxyPayload rejects invalid JSON even without content replacements", () => {
  const config = { ...baseConfig, contentReplacements: [] };
  assert.throws(
    () => evaluateWebhookProxyPayload(config, "{broken", "application/json"),
    SyntaxError,
  );
});

test("WebhookProxyService keeps retained webhook configs dormant for Free Guilds", async () => {
  let forwarded = false;
  const service = new WebhookProxyService(createStore(baseConfig), {
    guildEntitlements: {
      readGuildEntitlement: async (guildId) => ({ guildId, tier: "free", updatedAtMs: 0 }),
    },
    fetch: (async () => {
      forwarded = true;
      return new Response("ok");
    }) as typeof fetch,
  });

  await assert.rejects(
    service.handleInboundWebhook(baseConfig.publicId, "{}", "application/json"),
    WebhookProxyNotFoundError,
  );
  assert.equal(await service.hasInboundWebhookSource(baseConfig.publicId), false);
  assert.equal(forwarded, false);
});

test("WebhookProxyService suppresses inbound and already-queued delivery for a suspended paid Guild", async () => {
  let forwarded = false;
  const service = new WebhookProxyService(createStore(baseConfig), {
    guildEntitlements: {
      readGuildEntitlement: async (guildId) => ({ guildId, tier: "premium", updatedAtMs: 0 }),
    },
    isGuildSuspended: async () => true,
    fetch: (async () => {
      forwarded = true;
      return new Response("ok");
    }) as typeof fetch,
  });

  await assert.rejects(
    service.handleInboundWebhook(baseConfig.publicId, "{}", "application/json"),
    WebhookProxyNotFoundError,
  );
  assert.equal(await service.hasInboundWebhookSource(baseConfig.publicId), false);
  await service.deliverQueuedWebhook({
    config: { guildId: baseConfig.guildId, publicId: baseConfig.publicId },
    destinations: baseConfig.destinations,
    body: "{}",
    contentType: "application/json",
  });
  assert.equal(forwarded, false);
});

test("WebhookProxyService drops queued deliveries after a Guild downgrades", async () => {
  let forwarded = false;
  const service = new WebhookProxyService(createStore(baseConfig), {
    guildEntitlements: {
      readGuildEntitlement: async (guildId) => ({ guildId, tier: "free", updatedAtMs: 0 }),
    },
    fetch: (async () => {
      forwarded = true;
      return new Response("ok");
    }) as typeof fetch,
  });

  await service.deliverQueuedWebhook({
    config: { guildId: baseConfig.guildId, publicId: baseConfig.publicId },
    destinations: baseConfig.destinations,
    body: "{}",
    contentType: "application/json",
  });

  assert.equal(forwarded, false);
});

test("WebhookProxyService forwards payloads and logs successful attempts", async () => {
  const calls: Array<{ input: string; body: string | undefined }> = [];
  const store = createStore(baseConfig);
  const service = new WebhookProxyService(store, {
    fetch: (async (input, init) => {
      calls.push({ input: String(input), body: init?.body as string | undefined });
      return new Response("ok", { status: 200 });
    }) as typeof fetch,
    sleep: async () => {},
  });

  const result = await service.handleInboundWebhook(
    baseConfig.publicId,
    JSON.stringify({ content: "hello" }),
    "application/json",
  );

  assert.deepEqual(result, { publicId: baseConfig.publicId, acceptedDestinations: 1 });
  assert.deepEqual(calls, [
    {
      input: "https://discord.com/api/webhooks/1/main",
      body: JSON.stringify({ content: "hello" }),
    },
  ]);
  const logs = await store.listWebhookProxyForwardLogs("guild-1", baseConfig.publicId);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.ok, true);
  assert.equal(logs[0]?.status, 200);
});

test("WebhookProxyService queues payload delivery when a delivery queue is configured", async () => {
  const deliveries: unknown[] = [];
  const service = new WebhookProxyService(createStore(baseConfig), {
    fetch: (async () => {
      throw new Error("delivery should be queued");
    }) as typeof fetch,
    deliveryQueue: {
      async send(message) {
        deliveries.push(message);
      },
    },
  });

  const result = await service.handleInboundWebhook(
    baseConfig.publicId,
    JSON.stringify({ content: "hello" }),
    "application/json",
  );

  assert.deepEqual(result, { publicId: baseConfig.publicId, acceptedDestinations: 1 });
  assert.deepEqual(deliveries, [
    {
      config: { guildId: baseConfig.guildId, publicId: baseConfig.publicId },
      destinations: [baseConfig.destinations[0]],
      body: JSON.stringify({ content: "hello" }),
      contentType: "application/json",
    },
  ]);
});

test("WebhookProxyService enqueues Steam ban lookups from enabled webhook proxy payloads", async () => {
  const lookups: unknown[] = [];
  const config: WebhookProxyConfig = {
    ...baseConfig,
    banLookupEnabled: true,
    banLookupNotificationUrl: "https://example.com/ban-reports",
    banLookupAppIds: [221100],
  };
  const service = new WebhookProxyService(createStore(config), {
    fetch: (async () => new Response("ok", { status: 200 })) as typeof fetch,
    steamBanLookupQueue: {
      async send(message) {
        lookups.push(message);
      },
    },
  });

  const result = await service.handleInboundWebhook(
    baseConfig.publicId,
    JSON.stringify({ content: "Player https://steamcommunity.com/profiles/76561198000000001" }),
    "application/json",
  );

  assert.deepEqual(result, { publicId: baseConfig.publicId, acceptedDestinations: 1 });
  assert.deepEqual(lookups, [
    {
      guildId: baseConfig.guildId,
      steamIds: ["76561198000000001"],
      notificationUrl: "https://example.com/ban-reports",
      banLookupAppIds: [221100],
    },
  ]);
});

test("WebhookProxyService delivers queued webhook payloads with retry logging", async () => {
  const fetchCalls: string[] = [];
  const store = createStore(null);
  const service = new WebhookProxyService(store, {
    fetch: (async (input) => {
      fetchCalls.push(String(input));
      return new Response("ok", { status: 200 });
    }) as typeof fetch,
  });

  await service.deliverQueuedWebhook({
    config: { guildId: baseConfig.guildId, publicId: baseConfig.publicId },
    destinations: [baseConfig.destinations[0]!],
    body: "{}",
    contentType: "application/json",
  });

  assert.deepEqual(fetchCalls, ["https://discord.com/api/webhooks/1/main"]);
  const logs = await store.listWebhookProxyForwardLogs(baseConfig.guildId, baseConfig.publicId);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.guildId, baseConfig.guildId);
  assert.equal(logs[0]?.publicId, baseConfig.publicId);
  assert.equal(logs[0]?.ok, true);
});

test("WebhookProxyService redacts destination secrets and provider bodies from forward logs", async () => {
  const store = createStore(null);
  const service = new WebhookProxyService(store, {
    maxAttempts: 1,
    fetch: async () => new Response("echoed-message-secret", { status: 400 }),
  });

  const outcome = await service.deliverQueuedWebhook({
    config: { guildId: "guild-1", publicId: "public-1" },
    destinations: [
      {
        id: "main",
        label: "Main",
        url: "https://discord.com/api/webhooks/123/super-secret-token",
      },
    ],
    body: "message-secret",
    contentType: "application/json",
  });

  assert.deepEqual(outcome, { status: "terminal", reasonCode: "provider_rejected" });
  const logs = await store.listWebhookProxyForwardLogs("guild-1", "public-1");
  assert.equal(logs[0]?.destinationUrl, undefined);
  assert.equal(logs[0]?.error, "HTTP 400");
  assert.doesNotMatch(
    JSON.stringify(logs),
    /super-secret-token|echoed-message-secret|message-secret/,
  );
});

test("WebhookProxyService retries Discord rate limits with retry-after", async () => {
  const sleeps: number[] = [];
  const statuses = [429, 200];
  const store = createStore(baseConfig);
  const service = new WebhookProxyService(store, {
    fetch: (async () => {
      const status = statuses.shift() ?? 204;
      return new Response("", {
        status,
        headers: status === 429 ? { "retry-after": "0.1" } : undefined,
      });
    }) as typeof fetch,
    sleep: async (delayMs) => {
      sleeps.push(delayMs);
    },
  });

  await service.handleInboundWebhook(baseConfig.publicId, "{}", "application/json");

  const logs = await store.listWebhookProxyForwardLogs("guild-1", baseConfig.publicId);
  assert.deepEqual(
    logs.map((log) => log.status).sort((a, b) => (a ?? 0) - (b ?? 0)),
    [200, 429],
  );
  assert.deepEqual(sleeps, [350]);
});

test("WebhookProxyService skips delivery log persistence when disabled", async () => {
  const store = createStore(baseConfig);
  const service = new WebhookProxyService(store, {
    fetch: (async () => new Response("ok", { status: 200 })) as typeof fetch,
    sleep: async () => {},
    persistDeliveryLogs: false,
  });

  const result = await service.handleInboundWebhook(
    baseConfig.publicId,
    JSON.stringify({ content: "hello" }),
    "application/json",
  );

  assert.deepEqual(result, { publicId: baseConfig.publicId, acceptedDestinations: 1 });
  assert.deepEqual(await store.listWebhookProxyForwardLogs("guild-1", baseConfig.publicId), []);
});

test("WebhookProxyService reuses cached webhook configs for repeated requests", async () => {
  let readCount = 0;
  const fetchCalls: string[] = [];
  const service = new WebhookProxyService(
    createStore(baseConfig, {
      async readWebhookProxyConfig() {
        readCount += 1;
        return baseConfig;
      },
    }),
    {
      fetch: (async (input) => {
        fetchCalls.push(String(input));
        return new Response("ok", { status: 200 });
      }) as typeof fetch,
      sleep: async () => {},
    },
  );

  await service.handleInboundWebhook(
    baseConfig.publicId,
    JSON.stringify({ content: "hello" }),
    null,
  );
  await service.handleInboundWebhook(
    baseConfig.publicId,
    JSON.stringify({ content: "hello again" }),
    null,
  );

  assert.equal(readCount, 1);
  assert.deepEqual(fetchCalls, [
    "https://discord.com/api/webhooks/1/main",
    "https://discord.com/api/webhooks/1/main",
  ]);
});

test("WebhookProxyService exposes source existence only after a guarded cache fill", async () => {
  let readCount = 0;
  const service = new WebhookProxyService(
    createStore(baseConfig, {
      async readWebhookProxyConfig() {
        readCount += 1;
        return baseConfig;
      },
    }),
  );

  assert.equal(await service.readCachedInboundWebhookSource(baseConfig.publicId), null);
  assert.equal(await service.hasInboundWebhookSource(baseConfig.publicId), true);
  assert.equal(await service.readCachedInboundWebhookSource(baseConfig.publicId), true);
  assert.equal(readCount, 1);
});

test("WebhookProxyService shares a supplied source cache across request-scoped instances", async () => {
  let readCount = 0;
  const configCache = new Map();
  const store = createStore(baseConfig, {
    async readWebhookProxyConfig() {
      readCount += 1;
      return baseConfig;
    },
  });
  const first = new WebhookProxyService(store, { configCache });
  const second = new WebhookProxyService(store, { configCache });

  assert.equal(await first.hasInboundWebhookSource(baseConfig.publicId), true);
  assert.equal(await second.readCachedInboundWebhookSource(baseConfig.publicId), true);
  assert.equal(readCount, 1);
});

test("WebhookProxyService deduplicates concurrent config loads for the same webhook", async () => {
  let readCount = 0;
  let resolveConfig: ((config: WebhookProxyConfig) => void) | undefined;
  const service = new WebhookProxyService(
    createStore(baseConfig, {
      async readWebhookProxyConfig() {
        readCount += 1;
        return await new Promise<WebhookProxyConfig>((resolve) => {
          resolveConfig = resolve;
        });
      },
    }),
    {
      fetch: (async () => new Response("ok", { status: 200 })) as typeof fetch,
      sleep: async () => {},
    },
  );

  const first = service.handleInboundWebhook(
    baseConfig.publicId,
    JSON.stringify({ content: "first" }),
    null,
  );
  const second = service.handleInboundWebhook(
    baseConfig.publicId,
    JSON.stringify({ content: "second" }),
    null,
  );

  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(readCount, 1);

  resolveConfig?.(baseConfig);

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(firstResult, { publicId: baseConfig.publicId, acceptedDestinations: 1 });
  assert.deepEqual(secondResult, { publicId: baseConfig.publicId, acceptedDestinations: 1 });
});

test("WebhookProxyService invalidates cached webhook configs", async () => {
  let readCount = 0;
  let currentConfig: WebhookProxyConfig = baseConfig;
  const fetchCalls: string[] = [];
  const service = new WebhookProxyService(
    createStore(baseConfig, {
      async readWebhookProxyConfig() {
        readCount += 1;
        return currentConfig;
      },
    }),
    {
      fetch: (async (input) => {
        fetchCalls.push(String(input));
        return new Response("ok", { status: 200 });
      }) as typeof fetch,
      sleep: async () => {},
    },
  );

  await service.handleInboundWebhook(
    baseConfig.publicId,
    JSON.stringify({ content: "hello" }),
    null,
  );

  currentConfig = {
    ...baseConfig,
    destinations: [{ id: "alt", label: "Alt", url: "https://discord.com/api/webhooks/9/alt" }],
    defaultDestinationIds: ["alt"],
    routingRules: [],
    updatedAtMs: 2,
  };
  service.invalidateWebhookProxyConfig(baseConfig.publicId);

  await service.handleInboundWebhook(
    baseConfig.publicId,
    JSON.stringify({ content: "hello" }),
    null,
  );

  assert.equal(readCount, 2);
  assert.deepEqual(fetchCalls, [
    "https://discord.com/api/webhooks/1/main",
    "https://discord.com/api/webhooks/9/alt",
  ]);
});
