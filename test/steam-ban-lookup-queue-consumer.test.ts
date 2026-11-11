import { testWebhookCredential, testWebhookResolver } from "./support/webhook-credentials";
import type { SteamBanLookupQueueMessage } from "../src/services/webhook-proxy-service";
import type { QueueBatch } from "../src/runtime/queue-types";
/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import { deliverSteamBanLookupQueueBatch } from "../src/runtime/steam-ban-lookup-queue-consumer";
import { SteamBanLookupService } from "../src/services/steam-ban-lookup-service";
import { WebhookCredentialService } from "../src/security/webhook-credentials/store";

test("Steam lookup consumer settles each queued lookup independently", async () => {
  const complete = fakeMessage("complete", lookupMessage("76561198000000001"));
  const retry = fakeMessage("retry", lookupMessage("76561198000000002"));
  const malformed = fakeMessage("malformed", { guildId: "guild-1" });

  await deliverSteamBanLookupQueueBatch(
    fakeBatch([complete, retry, malformed]),
    {
      async processBatch(messages) {
        if (messages[0]?.steamIds[0] === "76561198000000002") {
          throw new Error("Steam unavailable");
        }
        return { status: "complete" };
      },
    },
    console,
    testWebhookResolver,
  );

  assert.deepEqual(complete.actions, ["ack"]);
  assert.deepEqual(retry.actions, ["retry"]);
  assert.deepEqual(malformed.actions, ["ack"]);
});

test("Steam lookup consumer retries provider failures from the production service", async () => {
  const message = fakeMessage("provider-failure", lookupMessage("76561198000000001"));
  const service = new SteamBanLookupService({
    steamWebApiKey: "super-secret-key",
    store: {
      async read() {
        return null;
      },
      async write() {},
    },
    fetch: async (input) => {
      throw new Error(`request failed: ${String(input)}`);
    },
    logger: { error() {} },
  });

  await deliverSteamBanLookupQueueBatch(
    fakeBatch([message]),
    service,
    console,
    testWebhookResolver,
  );

  assert.deepEqual(message.actions, ["retry"]);
});

test("Steam lookup consumer terminally acknowledges a missing API key", async () => {
  const message = fakeMessage("missing-key", lookupMessage("76561198000000001"));
  const service = new SteamBanLookupService({
    store: {
      async read() {
        return null;
      },
      async write() {},
    },
  });

  await deliverSteamBanLookupQueueBatch(
    fakeBatch([message]),
    service,
    console,
    testWebhookResolver,
  );

  assert.deepEqual(message.actions, ["ack"]);
});

test("Steam lookup retries credential storage outages but acknowledges deleted credentials", async () => {
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
  const body = {
    version: 2,
    guildId: "guild-1",
    publicId: "lookup-source",
    notificationCredentialId: "credential-1",
    steamIds: ["76561198000000001"],
    banLookupAppIds: [221100],
  };
  const service = {
    async processBatch(): Promise<never> {
      throw new Error("Unresolved credentials must not reach the lookup service");
    },
  };
  const temporary = fakeMessage("credential-outage", body);
  await deliverSteamBanLookupQueueBatch(fakeBatch([temporary]), service, console, credentials);
  assert.deepEqual(temporary.actions, ["retry"]);

  unavailable = false;
  const deleted = fakeMessage("credential-deleted", body);
  await deliverSteamBanLookupQueueBatch(fakeBatch([deleted]), service, console, credentials);
  assert.deepEqual(deleted.actions, ["ack"]);
});

function lookupMessage(steamId: string): SteamBanLookupQueueMessage {
  return {
    guildId: "guild-1",
    steamIds: [steamId],
    version: 2,
    publicId: "lookup-source",
    notificationCredentialId: testWebhookCredential("https://example.com/ban-reports"),
    banLookupAppIds: [221100],
  };
}

function fakeMessage(id: string, body: unknown) {
  const actions: string[] = [];
  return {
    id,
    body,
    attempts: 1,
    timestamp: new Date(),
    actions,
    ack: () => actions.push("ack"),
    retry: () => actions.push("retry"),
  };
}

function fakeBatch(messages: ReturnType<typeof fakeMessage>[]): QueueBatch<unknown> {
  return {
    queue: "haf-bot-steam-ban-lookups",
    messages,
    ackAll() {},
    retryAll() {},
  };
}
