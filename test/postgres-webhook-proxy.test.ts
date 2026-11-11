import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresWebhookProxyStore } from "../src/runtime/postgres/postgres-webhook-proxy-store";
import { createPostgresWebhookCredentialStore } from "../src/security/webhook-credentials/postgres-store";
import { createWebhookCredentialKeyRing } from "../src/security/webhook-credentials";
import { WebhookCredentialService } from "../src/security/webhook-credentials/store";
import {
  WebhookProxyService,
  type WebhookProxyDeliveryEnvelope,
} from "../src/services/webhook-proxy-service";
import type { WebhookProxyConfig } from "../src/types";
import { withFreshPostgres } from "./support/postgres";

test(
  "native Webhook Proxy persists and queues credential references without plaintext URLs",
  { skip: process.env.TEST_POSTGRES_URL ? false : "TEST_POSTGRES_URL is not configured" },
  async () => {
    await withFreshPostgres(async (database) => {
      const store = createPostgresWebhookProxyStore(database);
      const credentials = new WebhookCredentialService(
        createPostgresWebhookCredentialStore(database),
        createWebhookCredentialKeyRing({ keyV1: Buffer.alloc(32, 7).toString("base64") }),
      );
      const owner = {
        kind: "proxy_destination" as const,
        guildId: "guild",
        publicId: "proxy",
        destinationId: "main",
      };
      const url = "https://discord.com/api/webhooks/123456789012/synthetic_secret";
      const credential = await credentials.replace(owner, url);
      const config: WebhookProxyConfig = {
        guildId: "guild",
        publicId: "proxy",
        name: "Alerts",
        enabled: true,
        banLookupEnabled: false,
        banLookupCredentialId: null,
        banLookupAppIds: [],
        destinations: [{ id: "main", label: "Main", credentialId: credential.credentialId }],
        defaultDestinationIds: ["main"],
        routingRules: [],
        contentReplacements: [],
        createdAtMs: 1,
        updatedAtMs: 1,
      };
      await store.upsertWebhookProxyConfig(config);
      assert.deepEqual(await store.readWebhookProxyConfig("proxy"), config);
      const queued: WebhookProxyDeliveryEnvelope[] = [];
      const service = new WebhookProxyService(store, {
        credentialService: credentials,
        deliveryQueue: {
          async send(message) {
            queued.push(message);
          },
        },
      });
      await service.handleInboundWebhook("proxy", "hello", "text/plain");
      assert.deepEqual(queued, [
        {
          version: 2,
          config: { guildId: "guild", publicId: "proxy" },
          destinations: [{ destinationId: "main", credentialId: credential.credentialId }],
          body: "hello",
          contentType: "text/plain",
        },
      ]);
      const delivered: string[] = [];
      const delivery = new WebhookProxyService(store, {
        credentialService: credentials,
        persistDeliveryLogs: true,
        fetch: async (input) => {
          delivered.push(String(input));
          return new Response(null, { status: 204 });
        },
      });
      assert.deepEqual(await delivery.deliverQueuedWebhook(queued[0]), { status: "complete" });
      assert.deepEqual(delivered, [url]);
      const records = await database.query(
        "SELECT row_to_json(c) AS config FROM webhook_proxy_configs c",
      );
      assert.doesNotMatch(
        JSON.stringify({
          records,
          queued,
          logs: await store.listWebhookProxyForwardLogs("guild", "proxy"),
        }),
        /synthetic_secret|discord\.com\/api\/webhooks|destinationsV2|credentialMigrated/,
      );
    });
  },
);
