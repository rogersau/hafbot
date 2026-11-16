import {
  webhookTargets,
  testWebhookCredential,
  testWebhookResolver,
} from "./support/webhook-credentials";
/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import { deliverWebhookProxyDelivery } from "../src/runtime/webhook-proxy-delivery-queue-consumer";
import {
  WebhookProxyService,
  type WebhookProxyDeliveryEnvelope,
} from "../src/services/webhook-proxy-service";
import { DiscordApiError } from "../src/discord/client";
import { WebhookCredentialService } from "../src/security/webhook-credentials/store";
import { queueJobMetadata } from "./support/queue-delivery-fixture";

test("webhook delivery consumer completes success and delays only the rate-limited sibling", async () => {
  const complete = await deliverWebhookProxyDelivery(
    deliveryEnvelope("complete"),
    queueJobMetadata({ jobId: "complete" }),
    {
      async deliverQueuedWebhook() {
        return { status: "complete" };
      },
    },
  );
  const retry = await deliverWebhookProxyDelivery(
    deliveryEnvelope("retry"),
    queueJobMetadata({ jobId: "retry" }),
    {
      async deliverQueuedWebhook() {
        throw new DiscordApiError("rate limited", 429, "redacted", { retryAfterMs: 1_200 });
      },
    },
  );
  let handled = 0;
  const malformed = await deliverWebhookProxyDelivery(
    { config: null },
    queueJobMetadata({ jobId: "malformed" }),
    {
      async deliverQueuedWebhook() {
        handled++;
        return { status: "complete" };
      },
    },
  );

  assert.deepEqual(complete, { status: "complete" });
  assert.deepEqual(retry, {
    status: "retry",
    reasonCode: "provider_rate_limited",
    delaySeconds: 2,
  });
  assert.deepEqual(malformed, { status: "terminal", reasonCode: "invalid_webhook_delivery" });
  assert.equal(handled, 0);
});

test("webhook delivery consumer preserves an exhausted rate limit from the production service", async () => {
  const service = new WebhookProxyService(
    {
      async readWebhookProxyConfig() {
        return null;
      },
      async listWebhookProxyConfigs() {
        return [];
      },
      async upsertWebhookProxyConfig() {},
      async deleteWebhookProxyConfig() {},
      async createWebhookProxyForwardLog() {},
      async listWebhookProxyForwardLogs() {
        return [];
      },
    },
    {
      credentialService: testWebhookResolver,
      maxAttempts: 1,
      fetch: async () =>
        new Response("rate limited", { status: 429, headers: { "retry-after": "2" } }),
    },
  );

  const outcome = await deliverWebhookProxyDelivery(
    deliveryEnvelope("rate-limited"),
    queueJobMetadata({ jobId: "rate-limited", attempts: 4, maxAttempts: 4 }),
    service,
  );

  assert.deepEqual(outcome, {
    status: "retry",
    reasonCode: "provider_rate_limited",
    delaySeconds: 3,
  });
});

test("webhook delivery retries credential storage outages but terminates deleted credentials", async () => {
  let unavailable = true;
  const credentials = new WebhookCredentialService(
    {
      async readById() {
        if (unavailable) throw new Error("database connection lost");
        return null;
      },
      async readByOwner() {
        return null;
      },
      async upsert() {},
      async delete() {},
    },
    { activeWriteVersion: 1, keys: {} },
  );
  const service = new WebhookProxyService(
    {
      async readWebhookProxyConfig() {
        return null;
      },
      async listWebhookProxyConfigs() {
        return [];
      },
      async upsertWebhookProxyConfig() {},
      async deleteWebhookProxyConfig() {},
      async createWebhookProxyForwardLog() {},
      async listWebhookProxyForwardLogs() {
        return [];
      },
    },
    {
      credentialService: credentials,
      fetch: async () => {
        throw new Error("Unresolved credentials must not reach Discord");
      },
    },
  );
  const body: WebhookProxyDeliveryEnvelope = {
    version: 2,
    config: { guildId: "guild-1", publicId: "source" },
    destinations: [{ destinationId: "main", credentialId: "credential-1" }],
    body: "{}",
    contentType: "application/json",
  };
  const temporary = await deliverWebhookProxyDelivery(
    body,
    queueJobMetadata({ jobId: "credential-outage" }),
    service,
  );
  assert.deepEqual(temporary, { status: "retry", reasonCode: "credential_store_unavailable" });

  unavailable = false;
  const deleted = await deliverWebhookProxyDelivery(
    body,
    queueJobMetadata({ jobId: "credential-deleted" }),
    service,
  );
  assert.deepEqual(deleted, { status: "terminal", reasonCode: "credential_unavailable" });
});

function deliveryEnvelope(publicId: string): WebhookProxyDeliveryEnvelope {
  return {
    version: 2,
    config: { guildId: "guild-1", publicId },
    destinations: webhookTargets([
      {
        id: "main",
        label: "Main",
        credentialId: testWebhookCredential("https://example.com/webhook"),
      },
    ]),
    body: "{}",
    contentType: "application/json",
  };
}
