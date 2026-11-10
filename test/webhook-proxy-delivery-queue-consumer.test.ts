import type { QueueBatch } from "../src/runtime/queue-types";
/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import { deliverWebhookProxyDeliveryQueueBatch } from "../src/runtime/webhook-proxy-delivery-queue-consumer";
import {
  WebhookProxyService,
  type WebhookProxyDeliveryEnvelope,
} from "../src/services/webhook-proxy-service";
import { DiscordApiError } from "../src/discord/client";
import { WebhookCredentialService } from "../src/security/webhook-credentials/store";

test("webhook delivery consumer acknowledges success and delays only the rate-limited sibling", async () => {
  const complete = fakeMessage("complete", deliveryEnvelope("complete"));
  const retry = fakeMessage("retry", deliveryEnvelope("retry"));
  const malformed = fakeMessage("malformed", { config: null });

  await deliverWebhookProxyDeliveryQueueBatch(fakeBatch([complete, retry, malformed]), {
    async deliverQueuedWebhook(delivery) {
      if (delivery.config.publicId === "retry") {
        throw new DiscordApiError("rate limited", 429, "redacted", { retryAfterMs: 1_200 });
      }
      return { status: "complete" };
    },
  });

  assert.deepEqual(complete.actions, [{ action: "ack" }]);
  assert.deepEqual(retry.actions, [{ action: "retry", delaySeconds: 2 }]);
  assert.deepEqual(malformed.actions, [{ action: "ack" }]);
});

test("webhook delivery consumer retries an exhausted rate limit from the production service", async () => {
  const message = fakeMessage("rate-limited", deliveryEnvelope("rate-limited"));
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
      maxAttempts: 1,
      fetch: async () =>
        new Response("rate limited", { status: 429, headers: { "retry-after": "2" } }),
    },
  );

  await deliverWebhookProxyDeliveryQueueBatch(fakeBatch([message]), service);

  assert.deepEqual(message.actions, [{ action: "retry", delaySeconds: 3 }]);
});

test("webhook delivery retries credential storage outages but acknowledges deleted credentials", async () => {
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
  const temporary = fakeMessage("credential-outage", body);
  await deliverWebhookProxyDeliveryQueueBatch(fakeBatch([temporary]), service);
  assert.deepEqual(temporary.actions, [{ action: "retry", delaySeconds: undefined }]);

  unavailable = false;
  const deleted = fakeMessage("credential-deleted", body);
  await deliverWebhookProxyDeliveryQueueBatch(fakeBatch([deleted]), service);
  assert.deepEqual(deleted.actions, [{ action: "ack" }]);
});

function deliveryEnvelope(publicId: string): WebhookProxyDeliveryEnvelope {
  return {
    config: { guildId: "guild-1", publicId },
    destinations: [{ id: "main", label: "Main", url: "https://example.com/webhook" }],
    body: "{}",
    contentType: "application/json",
  };
}

function fakeMessage(id: string, body: unknown) {
  const actions: Array<{ action: "ack" } | { action: "retry"; delaySeconds?: number }> = [];
  return {
    id,
    body,
    attempts: 1,
    timestamp: new Date(),
    actions,
    ack: () => actions.push({ action: "ack" }),
    retry: (options?: { delaySeconds?: number }) =>
      actions.push({ action: "retry", delaySeconds: options?.delaySeconds }),
  };
}

function fakeBatch(messages: ReturnType<typeof fakeMessage>[]): QueueBatch<unknown> {
  return {
    queue: "haf-bot-webhook-proxy-deliveries",
    messages,
    ackAll() {},
    retryAll() {},
  };
}
