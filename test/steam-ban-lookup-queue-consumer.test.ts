import { testWebhookCredential, testWebhookResolver } from "./support/webhook-credentials";
import type { SteamBanLookupQueueMessage } from "../src/services/webhook-proxy-service";
/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import { deliverSteamBanLookup } from "../src/runtime/steam-ban-lookup-queue-consumer";
import { SteamBanLookupService } from "../src/services/steam-ban-lookup-service";
import { WebhookCredentialService } from "../src/security/webhook-credentials/store";
import { queueJobMetadata } from "./support/queue-delivery-fixture";

test("Steam lookup consumer settles each direct job independently", async () => {
  const complete = await deliverSteamBanLookup(
    lookupMessage("76561198000000001"),
    queueJobMetadata({ jobId: "complete" }),
    {
      async processBatch() {
        return { status: "complete" };
      },
    },
    console,
    testWebhookResolver,
  );
  const retry = await deliverSteamBanLookup(
    lookupMessage("76561198000000002"),
    queueJobMetadata({ jobId: "retry" }),
    {
      async processBatch() {
        throw new Error("Steam unavailable");
      },
    },
    console,
    testWebhookResolver,
  );
  let lookups = 0;
  const malformed = await deliverSteamBanLookup(
    { guildId: "guild-1" },
    queueJobMetadata({ jobId: "malformed" }),
    {
      async processBatch() {
        lookups++;
        return { status: "complete" };
      },
    },
    console,
    testWebhookResolver,
  );

  assert.deepEqual(complete, { status: "complete" });
  assert.deepEqual(retry, { status: "retry", reasonCode: "unexpected_error" });
  assert.deepEqual(malformed, { status: "terminal", reasonCode: "invalid_steam_lookup" });
  assert.equal(lookups, 0);
});

test("Steam lookup consumer retries provider failures from the production service", async () => {
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

  const outcome = await deliverSteamBanLookup(
    lookupMessage("76561198000000001"),
    queueJobMetadata({ jobId: "provider-failure" }),
    service,
    console,
    testWebhookResolver,
  );

  assert.deepEqual(outcome, { status: "retry", reasonCode: "steam_api_network_error" });
});

test("Steam lookup consumer terminally settles a missing API key", async () => {
  const service = new SteamBanLookupService({
    store: {
      async read() {
        return null;
      },
      async write() {},
    },
  });

  const outcome = await deliverSteamBanLookup(
    lookupMessage("76561198000000001"),
    queueJobMetadata({ jobId: "missing-key" }),
    service,
    console,
    testWebhookResolver,
  );

  assert.deepEqual(outcome, { status: "terminal", reasonCode: "missing_steam_api_key" });
});

test("Steam lookup retries credential storage outages but terminates deleted credentials", async () => {
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
  const temporary = await deliverSteamBanLookup(
    body,
    queueJobMetadata({ jobId: "credential-outage" }),
    service,
    console,
    credentials,
  );
  assert.deepEqual(temporary, { status: "retry", reasonCode: "credential_store_unavailable" });

  unavailable = false;
  const deleted = await deliverSteamBanLookup(
    body,
    queueJobMetadata({ jobId: "credential-deleted" }),
    service,
    console,
    credentials,
  );
  assert.deepEqual(deleted, { status: "terminal", reasonCode: "credential_unavailable" });
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
