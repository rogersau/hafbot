/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { createWebhookCredentialKeyRing } from "../src/security/webhook-credentials";
import { ServerLevelCredentialService } from "../src/server-levels/credentials";
import { createSqliteServerLevelCredentialStore } from "./support/sqlite/runtime/sqlite-server-level-credential-store";
import { createSqliteServerLevelStore } from "./support/sqlite/runtime/sqlite-server-level-store";
import { handleServerLevelIngress } from "../src/server-levels/ingress";
import type { ServerLevelOperationalEvent } from "../src/server-levels/telemetry";
import { RecordingQueue } from "./support/adapters/recording-queue";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("CFTools ingress authenticates exact bounded facts and acknowledges only after durable acceptance", async () => {
  const database = new SqliteD1Database();
  const store = createSqliteServerLevelStore(database.d1);
  const credentials = new ServerLevelCredentialService(
    createSqliteServerLevelCredentialStore(database.d1),
    createWebhookCredentialKeyRing({ keyV1: bytes(7) }),
  );
  const queue = new RecordingQueue<{ inboxId: string; guildId: string }>();
  const telemetry: ServerLevelOperationalEvent[] = [];
  try {
    await store.upsertConfig({
      guildId: "guild-1",
      enabled: true,
      announcementChannelId: null,
      removedAtMs: null,
      updatedAtMs: 1,
    });
    const rotated = await credentials.rotateWebhookSecret({
      guildId: "guild-1",
      configuredGameServerId: "server-1",
      nowMs: 1,
    });
    await store.createConfiguredGameServer({
      id: "server-1",
      guildId: "guild-1",
      displayName: "DayZ",
      providerServerId: "cftools-1",
      maxSlots: 60,
      endpointId: "endpoint-1",
      webhookCredentialId: rotated.credentialId,
      webhookVerifiedAtMs: null,
      subscribedEvents: ["user.join", "user.leave", "server.restart", "server.shutdown"],
      capacityProposal: null,
      lastRosterReconciledAtMs: null,
      lastCapacityCheckedAtMs: null,
      createdAtMs: 1,
      updatedAtMs: 1,
    });

    const verification = await handleServerLevelIngress(verificationRequest(), "endpoint-1", {
      store,
      credentials,
      queue,
      now: () => 1_050,
      createId: () => "verification",
      emitTelemetry: (event) => telemetry.push(event),
    });
    assert.equal(verification.status, 204);
    assert.equal(
      (await store.readConfiguredGameServer("guild-1", "server-1"))?.webhookVerifiedAtMs,
      null,
    );

    const request = ingressRequest(rotated.secret);
    const first = await handleServerLevelIngress(request, "endpoint-1", {
      store,
      credentials,
      queue,
      now: () => 1_100,
      createId: () => "inbox-1",
      emitTelemetry: (event) => telemetry.push(event),
    });
    assert.equal(first.status, 204);
    assert.deepEqual(queue.messages, [{ inboxId: "inbox-1", guildId: "guild-1" }]);
    assert.equal((await store.listPendingIngressOutbox(10)).length, 0);
    assert.equal(
      (await store.readConfiguredGameServer("guild-1", "server-1"))?.webhookVerifiedAtMs,
      1_100,
    );

    const duplicate = await handleServerLevelIngress(ingressRequest(rotated.secret), "endpoint-1", {
      store,
      credentials,
      queue,
      now: () => 1_200,
      createId: () => "inbox-duplicate",
      emitTelemetry: (event) => telemetry.push(event),
    });
    assert.equal(duplicate.status, 204);
    assert.equal(queue.messages.length, 1);

    const conflictingReplay = await handleServerLevelIngress(
      ingressRequest(rotated.secret, { population: 2 }),
      "endpoint-1",
      {
        store,
        credentials,
        queue,
        now: () => 1_300,
        createId: () => "inbox-conflicting-replay",
        emitTelemetry: (event) => telemetry.push(event),
      },
    );
    assert.equal(conflictingReplay.status, 409);
    assert.equal(queue.messages.length, 1);
    assert.deepEqual(
      telemetry.map((event) => `${event.category}:${event.outcome}`),
      ["ingress:verification", "ingress:accepted", "ingress:duplicate", "ingress:rejected"],
    );
    const serializedTelemetry = JSON.stringify(telemetry);
    assert.doesNotMatch(serializedTelemetry, /guild-1|server-1|76561198000000001/);
    assert.equal(serializedTelemetry.includes(rotated.secret), false);
  } finally {
    database.close();
  }
});

test("CFTools ingress rejects bad credentials, mismatched servers, and oversized bodies", async () => {
  const database = new SqliteD1Database();
  const store = createSqliteServerLevelStore(database.d1);
  const credentials = new ServerLevelCredentialService(
    createSqliteServerLevelCredentialStore(database.d1),
    createWebhookCredentialKeyRing({ keyV1: bytes(9) }),
  );
  const telemetry: ServerLevelOperationalEvent[] = [];
  try {
    const rotated = await credentials.rotateWebhookSecret({
      guildId: "guild-1",
      configuredGameServerId: "server-1",
      nowMs: 1,
    });
    await store.createConfiguredGameServer({
      id: "server-1",
      guildId: "guild-1",
      displayName: "DayZ",
      providerServerId: "cftools-1",
      maxSlots: 60,
      endpointId: "endpoint-1",
      webhookCredentialId: rotated.credentialId,
      webhookVerifiedAtMs: 1,
      subscribedEvents: ["user.join", "user.leave", "server.restart", "server.shutdown"],
      capacityProposal: null,
      lastRosterReconciledAtMs: null,
      lastCapacityCheckedAtMs: null,
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    const options = {
      store,
      credentials,
      now: () => 1_100,
      createId: () => "inbox",
      emitTelemetry: (event: ServerLevelOperationalEvent) => telemetry.push(event),
    };

    assert.equal(
      (await handleServerLevelIngress(ingressRequest("wrong-secret"), "endpoint-1", options))
        .status,
      401,
    );
    assert.equal(
      (
        await handleServerLevelIngress(
          ingressRequest(rotated.secret, { providerServerId: "other-server" }),
          "endpoint-1",
          options,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await handleServerLevelIngress(
          new Request("https://hafbot.xyz/webhooks/server-levels/cftools/endpoint-1", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "content-length": "70000",
              "x-hephaistos-shard": "1",
              "x-hephaistos-flavor": "WebHookFlavor.CFTOOLS",
              "x-hephaistos-event": "user.join",
              "x-hephaistos-delivery": "delivery-oversized",
              "x-hephaistos-signature": signature("delivery-oversized", rotated.secret),
            },
            body: "{}",
          }),
          "endpoint-1",
          options,
        )
      ).status,
      413,
    );
    assert.deepEqual(
      telemetry.map((event) => event.outcome),
      ["rejected", "rejected", "rejected"],
    );
    assert.equal(JSON.stringify(telemetry).includes(rotated.secret), false);
  } finally {
    database.close();
  }
});

test("CFTools ingress extracts a numeric SteamID64 from a sanitized native Hephaistos body", async () => {
  const database = new SqliteD1Database();
  const store = createSqliteServerLevelStore(database.d1);
  const credentials = new ServerLevelCredentialService(
    createSqliteServerLevelCredentialStore(database.d1),
    createWebhookCredentialKeyRing({ keyV1: bytes(11) }),
  );
  try {
    const stored = await credentials.storeWebhookSecret({
      guildId: "guild-1",
      configuredGameServerId: "server-1",
      secret: "provider-issued-secret",
      nowMs: 1,
    });
    await store.createConfiguredGameServer({
      id: "server-1",
      guildId: "guild-1",
      displayName: "DayZ",
      providerServerId: "cftools-1",
      maxSlots: 60,
      endpointId: "endpoint-1",
      webhookCredentialId: stored.credentialId,
      webhookVerifiedAtMs: null,
      subscribedEvents: ["user.join", "user.leave", "server.restart", "server.shutdown"],
      capacityProposal: null,
      lastRosterReconciledAtMs: null,
      lastCapacityCheckedAtMs: null,
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    const deliveryId = "native-delivery";
    const response = await handleServerLevelIngress(
      new Request("https://hafbot.xyz/webhooks/server-levels/cftools/endpoint-1", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hephaistos-shard": "1",
          "x-hephaistos-flavor": "WebHookFlavor.CFTOOLS",
          "x-hephaistos-event": "user.join",
          "x-hephaistos-delivery": deliveryId,
          "x-hephaistos-signature": signature(deliveryId, "provider-issued-secret"),
        },
        body: `{"cftools_id":"sanitized","player_steam64":76561198000000001,"population":1,"queue_size":0}`,
      }),
      "endpoint-1",
      { store, credentials, now: () => 5_000, createId: () => "native-inbox" },
    );
    assert.equal(response.status, 204);
    assert.equal((await store.readProviderEvent("native-inbox"))?.steamId64, "76561198000000001");
  } finally {
    database.close();
  }
});

function ingressRequest(
  secret: string,
  overrides: { providerServerId?: string; population?: number } = {},
): Request {
  return new Request("https://hafbot.xyz/webhooks/server-levels/cftools/endpoint-1", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hephaistos-shard": "1",
      "x-hephaistos-flavor": "WebHookFlavor.CFTOOLS",
      "x-hephaistos-event": "user.join",
      "x-hephaistos-delivery": "delivery-1",
      "x-hephaistos-signature": signature("delivery-1", secret),
    },
    body: JSON.stringify({
      version: 1,
      providerServerId: overrides.providerServerId ?? "cftools-1",
      occurredAtMs: 1_000,
      steamId64: "76561198000000001",
      population: overrides.population ?? 1,
      queueSize: 0,
    }),
  });
}

function verificationRequest(): Request {
  return new Request("https://hafbot.xyz/webhooks/server-levels/cftools/endpoint-1", {
    method: "POST",
    headers: {
      "x-hephaistos-shard": "1",
      "x-hephaistos-flavor": "WebHookFlavor.CFTOOLS",
      "x-hephaistos-event": "verification",
      "x-hephaistos-delivery": "verification-1",
    },
  });
}

function signature(deliveryId: string, secret: string): string {
  return createHash("sha256").update(`${deliveryId}${secret}`).digest("hex");
}

function bytes(value: number): string {
  return Buffer.alloc(32, value).toString("base64");
}
