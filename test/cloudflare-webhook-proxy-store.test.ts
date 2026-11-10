/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createCloudflareWebhookProxyStore } from "../src/runtime/cloudflare-webhook-proxy-store";
import type { WebhookProxyConfig, WebhookProxyForwardLog } from "../src/types";
import { SqliteD1Database } from "./support/sqlite-d1-database";

const baseConfig: WebhookProxyConfig = {
  guildId: "guild-1",
  publicId: "public_webhook_1234",
  name: "Alerts",
  enabled: true,
  banLookupEnabled: false,
  banLookupNotificationUrl: null,
  banLookupAppIds: [],
  destinations: [{ id: "main", label: "Main", url: "https://discord.com/api/webhooks/1/main" }],
  defaultDestinationIds: ["main"],
  routingRules: [],
  contentReplacements: [],
  createdAtMs: 100,
  updatedAtMs: 200,
};

test("createCloudflareWebhookProxyStore reuses the store without runtime DDL", async () => {
  const database = new SqliteD1Database();
  const firstStore = createCloudflareWebhookProxyStore(database as unknown as D1Database);
  const secondStore = createCloudflareWebhookProxyStore(database as unknown as D1Database);

  await firstStore.listWebhookProxyConfigs("guild-1");
  await firstStore.readWebhookProxyConfig("missing");

  assert.strictEqual(firstStore, secondStore);
  assert.equal(database.execCalls, 0);
});

test("createCloudflareWebhookProxyStore stores and reads webhook configs", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareWebhookProxyStore(database as unknown as D1Database);
  const newerConfig: WebhookProxyConfig = {
    ...baseConfig,
    publicId: "public_webhook_5678",
    name: "Deployments",
    updatedAtMs: 300,
  };

  await store.upsertWebhookProxyConfig(baseConfig);
  await store.upsertWebhookProxyConfig(newerConfig);

  assert.deepEqual(await store.readWebhookProxyConfig(baseConfig.publicId), baseConfig);
  assert.deepEqual(await store.listWebhookProxyConfigs(baseConfig.guildId), [
    newerConfig,
    baseConfig,
  ]);

  await store.deleteWebhookProxyConfig({
    guildId: baseConfig.guildId,
    publicId: baseConfig.publicId,
  });

  assert.equal(await store.readWebhookProxyConfig(baseConfig.publicId), null);
});

test("createCloudflareWebhookProxyStore updates webhook configs on upsert conflict", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareWebhookProxyStore(database as unknown as D1Database);
  const updatedConfig: WebhookProxyConfig = {
    ...baseConfig,
    name: "Alerts v2",
    enabled: false,
    destinations: [
      { id: "secondary", label: "Secondary", url: "https://discord.com/api/webhooks/1/secondary" },
    ],
    defaultDestinationIds: ["secondary"],
    routingRules: [
      {
        id: "critical",
        label: "Critical",
        pattern: "critical",
        flags: "i",
        destinationIds: ["secondary"],
      },
    ],
    contentReplacements: [
      {
        id: "ticket-link",
        label: "Ticket link",
        pattern: "TICKET-(\\d+)",
        flags: "g",
        replacement: "https://example.com/tickets/$1",
      },
    ],
    createdAtMs: 999,
    updatedAtMs: 400,
  };

  await store.upsertWebhookProxyConfig(baseConfig);
  await store.upsertWebhookProxyConfig(updatedConfig);

  assert.deepEqual(await store.readWebhookProxyConfig(baseConfig.publicId), {
    ...updatedConfig,
    createdAtMs: baseConfig.createdAtMs,
  });
});

test("createCloudflareWebhookProxyStore stores and reads content replacements", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareWebhookProxyStore(database as unknown as D1Database);
  const config: WebhookProxyConfig = {
    ...baseConfig,
    contentReplacements: [
      {
        id: "cftools-profile",
        label: "CFTools profile",
        pattern: "\\b(7656119\\d{10})\\b",
        flags: "g",
        replacement: "[$1](https://app.cftools.cloud/profile/$1)",
      },
    ],
  };

  await store.upsertWebhookProxyConfig(config);

  assert.deepEqual(await store.readWebhookProxyConfig(config.publicId), config);
});

test("createCloudflareWebhookProxyStore stores and reads Steam ban lookup settings", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareWebhookProxyStore(database as unknown as D1Database);
  const config: WebhookProxyConfig = {
    ...baseConfig,
    banLookupEnabled: true,
    banLookupNotificationUrl: "https://example.com/ban-reports",
    banLookupAppIds: [221100, 730],
  };

  await store.upsertWebhookProxyConfig(config);

  assert.deepEqual(await store.readWebhookProxyConfig(config.publicId), config);
});

test("createCloudflareWebhookProxyStore caps stored delivery logs per guild", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareWebhookProxyStore(database as unknown as D1Database);
  const olderSameGuildLog: WebhookProxyForwardLog = {
    guildId: "guild-1",
    id: "old-same-guild",
    publicId: "public_old_same_guild",
    destinationId: "main",
    destinationUrl: "https://discord.com/api/webhooks/1/main",
    status: 200,
    ok: true,
    attempt: 1,
    error: null,
    timestampMs: -1,
  };
  const olderOtherGuildLog: WebhookProxyForwardLog = {
    ...olderSameGuildLog,
    guildId: "guild-2",
    id: "old-other-guild",
    publicId: "public_old_other_guild",
  };

  await store.createWebhookProxyForwardLog(olderSameGuildLog);
  await store.createWebhookProxyForwardLog(olderOtherGuildLog);

  for (let index = 0; index < 1002; index += 1) {
    await store.createWebhookProxyForwardLog({
      guildId: "guild-1",
      id: `log-${index}`,
      publicId: baseConfig.publicId,
      destinationId: "main",
      destinationUrl: "https://discord.com/api/webhooks/1/main",
      status: 200,
      ok: true,
      attempt: 1,
      error: null,
      timestampMs: index,
    });
  }

  const logs = await store.listWebhookProxyForwardLogs("guild-1", baseConfig.publicId, 200);

  assert.equal(logs.length, 100);
  assert.deepEqual(
    logs.slice(0, 3).map((log) => log.id),
    ["log-1001", "log-1000", "log-999"],
  );
  assert.deepEqual(await store.listWebhookProxyForwardLogs("guild-1", "public_old_same_guild"), []);
  assert.deepEqual(await store.listWebhookProxyForwardLogs("guild-2", "public_old_other_guild"), [
    olderOtherGuildLog,
  ]);
});
