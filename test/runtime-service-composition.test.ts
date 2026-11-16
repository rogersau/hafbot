/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import {
  WebhookCredentialService,
  type StoredWebhookCredential,
  type WebhookCredentialStore,
} from "../src/security/webhook-credentials/store";
import { createWebhookCredentialKeyRing } from "../src/security/webhook-credentials";
import { ALL_FEATURES_ENABLED } from "../src/runtime/features";
import type { WebhookProxyConfig, ManagedMessageDraft } from "../src/types";
import type { GatewayController } from "../src/runtime/contracts";
import { createTestRuntimeApp, type TestRuntimeAppOptions } from "./support/create-runtime-app";
import {
  createProductionRuntimeStores,
  withStoreOverrides,
  type ProductionRuntimeStoresFixture,
} from "./support/production-runtime-stores";
import { WaitUntilRecorder } from "./support/wait-until-recorder";

function createTestWebhookCredentialService(): WebhookCredentialService {
  const credentials = new Map<string, StoredWebhookCredential>();
  const store: WebhookCredentialStore = {
    async readById(credentialId) {
      return credentials.get(credentialId) ?? null;
    },
    async readByOwner(owner) {
      return (
        [...credentials.values()].find(
          (credential) => JSON.stringify(credential.owner) === JSON.stringify(owner),
        ) ?? null
      );
    },
    async upsert(credential) {
      credentials.set(credential.credentialId, credential);
    },
    async delete(credentialId) {
      credentials.delete(credentialId);
    },
  };
  return new WebhookCredentialService(
    store,
    createWebhookCredentialKeyRing({ keyV1: Buffer.alloc(32, 7).toString("base64") }),
  );
}

function webhookProxyConfig(credentialId: string): WebhookProxyConfig {
  return {
    guildId: "guild-1",
    publicId: "public_webhook_1234",
    name: "Alerts",
    enabled: true,
    banLookupEnabled: false,
    banLookupCredentialId: null,
    banLookupAppIds: [],
    destinations: [{ id: "main", label: "Main", credentialId }],
    defaultDestinationIds: ["main"],
    routingRules: [],
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function testOptions(
  fixture: ProductionRuntimeStoresFixture,
  overrides: Partial<TestRuntimeAppOptions> = {},
): TestRuntimeAppOptions {
  return {
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: fixture.stores,
    gateway: {} as GatewayController,
    ...overrides,
  };
}

test("composed services are reused across repeated HTTP dispatches instead of being rebuilt", async () => {
  const fixture = createProductionRuntimeStores();
  await fixture.database.d1
    .prepare("INSERT INTO guild_entitlements (guild_id, plan, updated_at_ms) VALUES (?, ?, ?)")
    .bind("guild-1", "premium", 1)
    .run();
  const credentials = createTestWebhookCredentialService();
  const credential = await credentials.replace(
    {
      kind: "proxy_destination",
      guildId: "guild-1",
      publicId: "public_webhook_1234",
      destinationId: "main",
    },
    "https://discord.com/api/webhooks/900001/main",
  );
  const config = webhookProxyConfig(credential.credentialId);
  let configReads = 0;
  const stores = {
    ...fixture.stores,
    webhookProxy: withStoreOverrides(fixture.stores.webhookProxy, {
      async readWebhookProxyConfig(publicId: string) {
        configReads += 1;
        return publicId === config.publicId ? config : null;
      },
    }),
  };
  const originalFetch = globalThis.fetch;
  const forwards: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    forwards.push(String(input));
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  try {
    const app = createTestRuntimeApp(
      testOptions({ ...fixture, stores }, { webhookCredentialService: credentials }),
    );

    for (let dispatch = 0; dispatch < 2; dispatch += 1) {
      const response = await app.fetch(
        new Request(`https://runtime.example/webhooks/${config.publicId}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: `dispatch ${dispatch}` }),
        }),
      );
      assert.equal(response.status, 204);
    }
    // Two dispatches shared one composed WebhookProxyService: its config cache
    // served the second dispatch, so the store was read exactly once.
    assert.equal(configReads, 1);
    assert.equal(forwards.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    fixture.close();
  }
});

test("composed services deliver shared background work through the host lifecycle", async () => {
  const fixture = createProductionRuntimeStores();
  await fixture.database.d1
    .prepare("INSERT INTO guild_entitlements (guild_id, plan, updated_at_ms) VALUES (?, ?, ?)")
    .bind("guild-1", "premium", 1)
    .run();
  const credentials = createTestWebhookCredentialService();
  const credential = await credentials.replace(
    {
      kind: "proxy_destination",
      guildId: "guild-1",
      publicId: "public_webhook_1234",
      destinationId: "main",
    },
    "https://discord.com/api/webhooks/900001/main",
  );
  const config = webhookProxyConfig(credential.credentialId);
  const stores = {
    ...fixture.stores,
    webhookProxy: withStoreOverrides(fixture.stores.webhookProxy, {
      async readWebhookProxyConfig(publicId: string) {
        return publicId === config.publicId ? config : null;
      },
    }),
  };
  const waitUntil = new WaitUntilRecorder();
  const originalFetch = globalThis.fetch;
  const forwards: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    forwards.push(String(input));
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  try {
    const app = createTestRuntimeApp(
      testOptions(
        { ...fixture, stores },
        {
          webhookCredentialService: credentials,
          waitUntil: (promise: Promise<unknown>) => waitUntil.waitUntil(promise),
        },
      ),
    );
    const response = await app.fetch(
      new Request(`https://runtime.example/webhooks/${config.publicId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "background delivery" }),
      }),
    );

    assert.equal(response.status, 204);
    assert.equal(waitUntil.pendingCount, 1, "the composed service reports delivery to waitUntil");
    await waitUntil.flush();
    assert.deepEqual(forwards, ["https://discord.com/api/webhooks/900001/main"]);
  } finally {
    globalThis.fetch = originalFetch;
    fixture.close();
  }
});

test("test-only service overrides replace composed services before app creation", async () => {
  const fixture = createProductionRuntimeStores();
  const hideCalls: string[] = [];
  const app = createTestRuntimeApp(
    testOptions(fixture, {
      services: {
        evidenceVaultService: {
          hideEvidence: async (interaction: { guild_id?: string }) => {
            hideCalls.push(interaction.guild_id ?? "");
            return {
              ok: true,
              record: {} as never,
              message: "Evidence hidden in the Evidence Vault.",
            };
          },
        } as never,
      },
    }),
  );

  const hideResponse = await app.fetch(
    new Request("https://runtime.example/interactions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-ed25519": "ignored-for-test",
        "x-signature-timestamp": String(Math.floor(Date.now() / 1000)),
      },
      body: JSON.stringify({
        type: 2,
        guild_id: "guild-1",
        channel_id: "source",
        member: { permissions: "0", roles: ["staff"], user: { id: "hider" } },
        data: {
          name: "Hide Evidence",
          type: 3,
          target_id: "message-1",
          resolved: {
            messages: {
              "message-1": { id: "message-1", channel_id: "source", content: "proof" },
            },
          },
        },
      }),
    }),
  );
  assert.equal(hideCalls.length, 1);
  assert.equal(hideResponse.status, 200);

  // A non-overridden composed service still serves dispatch from the fixture stores.
  const blocklistResponse = await app.fetch(
    new Request("https://runtime.example/interactions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-ed25519": "ignored-for-test",
        "x-signature-timestamp": String(Math.floor(Date.now() / 1000)),
      },
      body: JSON.stringify({
        type: 2,
        guild_id: "guild-1",
        member: { permissions: "8" },
        data: { name: "blocklist", options: [{ type: 1, name: "list" }] },
      }),
    }),
  );
  assert.equal(blocklistResponse.status, 200);
  const body = (await blocklistResponse.json()) as { data: { content: string } };
  assert.match(body.data.content, /No emojis are blocked/);
  fixture.close();
});

test("scheduled maintenance claims due drafts through the composed suspension-aware stores", async () => {
  const fixture = createProductionRuntimeStores();
  await fixture.database.d1
    .prepare("INSERT INTO guild_entitlements (guild_id, plan, updated_at_ms) VALUES (?, ?, ?)")
    .bind("guild-1", "premium", 1)
    .run();
  const draft = (guildId: string, id: string): ManagedMessageDraft => ({
    id,
    guildId,
    internalName: `launch-${id}`,
    channelId: "channel-1",
    embeds: [{ description: "Launch announcement", fields: [] }],
    announcement: { roleIds: [], everyone: false, here: false, notifyOnCreate: false },
    status: "scheduled",
    scheduledAtMs: 1_000,
    failureReason: null,
    attemptCount: 0,
    createdAtMs: 0,
    updatedAtMs: 0,
  });
  await fixture.stores.managedMessages.upsertDraft(draft("guild-1", "draft-1"));
  await fixture.stores.guildServiceSuspensions!.suspendGuild({
    guildId: "guild-1",
    reason: "private",
    actorUserId: "admin",
    occurredAtMs: 0,
  });
  const originalFetch = globalThis.fetch;
  const posts: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST" && url.endsWith("/channels/channel-1/messages")) {
      posts.push(url);
      return Response.json({ id: "message-1" });
    }
    if (url.endsWith("/roles")) return Response.json([]);
    if (url.includes("/channels")) {
      return Response.json([
        {
          id: "channel-1",
          guild_id: "guild-1",
          name: "announcements",
          type: 0,
          parent_id: null,
          position: 0,
        },
      ]);
    }
    return Response.json({ id: "message-1", name: "x" });
  }) as typeof fetch;

  try {
    const app = createTestRuntimeApp(
      testOptions(fixture, {
        features: { ...ALL_FEATURES_ENABLED, playerCount: false, lfg: false, events: false },
      }),
    );

    await app.refreshPlayerCount();
    const suspended = await fixture.stores.managedMessages.readDraftById("guild-1", "draft-1");
    assert.equal(suspended?.status, "scheduled", "suspended Guild drafts are never claimed");
    assert.deepEqual(posts, []);

    await fixture.stores.guildServiceSuspensions!.restoreGuild({
      guildId: "guild-1",
      actorUserId: "admin",
      occurredAtMs: 2_000,
    });
    // The suspended scan already consumed draft-1's claim lease, so a restored
    // draft demonstrates that the same composed graph publishes due work.
    await fixture.stores.managedMessages.upsertDraft(draft("guild-1", "draft-2"));
    await app.refreshPlayerCount();
    const published = await fixture.stores.managedMessages.readById("guild-1", "draft-2");
    assert.equal(published?.status, "published");
    assert.equal(published?.messageId, "message-1");
    assert.equal(posts.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    fixture.close();
  }
});
