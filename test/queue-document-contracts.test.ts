import assert from "node:assert/strict";
import test from "node:test";
import { deliverGatewayEventQueueBatch } from "../src/runtime/gateway-event-queue-consumer";
import { deliverWebhookProxyDeliveryQueueBatch } from "../src/runtime/webhook-proxy-delivery-queue-consumer";
import { deliverSteamBanLookupQueueBatch } from "../src/runtime/steam-ban-lookup-queue-consumer";
import type { QueueBatch } from "../src/runtime/queue-types";
import type { Env } from "../src/env";
import type { GatewayEventDependencies } from "../src/runtime/gateway-events/capabilities";

function batch(body: unknown) {
  const actions: string[] = [];
  const message = {
    id: "synthetic",
    timestamp: new Date(0),
    body,
    attempts: 1,
    ack() {
      actions.push("ack");
    },
    retry() {
      actions.push("retry");
    },
  };
  const value: QueueBatch<unknown> = {
    queue: "contract-test",
    messages: [message],
    ackAll: message.ack,
    retryAll: message.retry,
  };
  return { value, actions };
}
const logger = { error() {}, info() {} };

test("Gateway rejects unversioned and retired envelopes before dispatch", async () => {
  for (const version of [undefined, 1]) {
    const item = batch({ version, type: "MESSAGE_CREATE", data: {} });
    await deliverGatewayEventQueueBatch(
      item.value,
      {} as Env,
      logger,
      {} as GatewayEventDependencies,
    );
    assert.deepEqual(item.actions, ["ack"]);
  }
});

test("Webhook delivery accepts no plaintext destination queue format", async () => {
  let deliveries = 0;
  for (const version of [undefined, 1, 2]) {
    const item = batch({
      version,
      config: { guildId: "guild", publicId: "proxy" },
      destinations: [{ id: "main", label: "Main", url: "https://example.invalid/private-token" }],
      body: "hello",
      contentType: "text/plain",
    });
    await deliverWebhookProxyDeliveryQueueBatch(
      item.value,
      {
        async deliverQueuedWebhook() {
          deliveries++;
          return { status: "complete" };
        },
      },
      logger,
    );
    assert.deepEqual(item.actions, ["ack"]);
  }
  assert.equal(deliveries, 0);
});

test("Steam lookup accepts no plaintext notification queue format", async () => {
  let lookups = 0;
  for (const version of [undefined, 1, 2]) {
    const item = batch({
      version,
      guildId: "guild",
      steamIds: ["76561198000000001"],
      notificationUrl: "https://example.invalid/private-token",
      banLookupAppIds: [],
    });
    await deliverSteamBanLookupQueueBatch(
      item.value,
      {
        async processBatch() {
          lookups++;
          return { status: "complete" };
        },
      },
      logger,
    );
    assert.deepEqual(item.actions, ["ack"]);
  }
  assert.equal(lookups, 0);
});
