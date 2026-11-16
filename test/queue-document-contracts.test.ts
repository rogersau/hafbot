import assert from "node:assert/strict";
import test from "node:test";
import { deliverGatewayEvent } from "../src/runtime/gateway-event-queue-consumer";
import { deliverWebhookProxyDelivery } from "../src/runtime/webhook-proxy-delivery-queue-consumer";
import { deliverSteamBanLookup } from "../src/runtime/steam-ban-lookup-queue-consumer";
import type { Env } from "../src/env";
import type { GatewayEventDependencies } from "../src/runtime/gateway-events/capabilities";
import { queueJobMetadata } from "./support/queue-delivery-fixture";

const logger = { error() {}, info() {} };

test("Gateway rejects unversioned and retired envelopes before dispatch", async () => {
  for (const version of [undefined, 1]) {
    const outcome = await deliverGatewayEvent(
      { version, type: "MESSAGE_CREATE", data: {} },
      queueJobMetadata({ jobId: `gateway-${String(version)}` }),
      {} as Env,
      logger,
      {} as GatewayEventDependencies,
    );
    assert.deepEqual(outcome, {
      status: "terminal",
      reasonCode: "unsupported_gateway_event_version",
    });
  }
});

test("Webhook delivery accepts no plaintext destination queue format", async () => {
  let deliveries = 0;
  for (const version of [undefined, 1, 2]) {
    const outcome = await deliverWebhookProxyDelivery(
      {
        version,
        config: { guildId: "guild", publicId: "proxy" },
        destinations: [{ id: "main", label: "Main", url: "https://example.invalid/private-token" }],
        body: "hello",
        contentType: "text/plain",
      },
      queueJobMetadata({ jobId: `webhook-${String(version)}` }),
      {
        async deliverQueuedWebhook() {
          deliveries++;
          return { status: "complete" };
        },
      },
      logger,
    );
    assert.deepEqual(outcome, { status: "terminal", reasonCode: "invalid_webhook_delivery" });
  }
  assert.equal(deliveries, 0);
});

test("Steam lookup accepts no plaintext notification queue format", async () => {
  let lookups = 0;
  for (const version of [undefined, 1, 2]) {
    const outcome = await deliverSteamBanLookup(
      {
        version,
        guildId: "guild",
        steamIds: ["76561198000000001"],
        notificationUrl: "https://example.invalid/private-token",
        banLookupAppIds: [],
      },
      queueJobMetadata({ jobId: `steam-${String(version)}` }),
      {
        async processBatch() {
          lookups++;
          return { status: "complete" };
        },
      },
      logger,
    );
    assert.deepEqual(outcome, { status: "terminal", reasonCode: "invalid_steam_lookup" });
  }
  assert.equal(lookups, 0);
});
