/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />
import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { createCloudflareServerLevelCredentialStore } from "../src/runtime/cloudflare-server-level-credential-store";
import { createWebhookCredentialKeyRing } from "../src/security/webhook-credentials";
import { ServerLevelCredentialService } from "../src/server-levels/credentials";
import { CftoolsDataApiClient } from "../src/server-levels/data-api";
import type { ConfiguredGameServer } from "../src/server-levels/model";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("CFTools Data API reconciliation uses only allowlisted reads and reuses encrypted auth", async () => {
  const database = new SqliteD1Database();
  const credentials = new ServerLevelCredentialService(
    createCloudflareServerLevelCredentialStore(database.d1),
    createWebhookCredentialKeyRing({ keyV1: Buffer.alloc(32, 5).toString("base64") }),
  );
  const requests: Array<{ url: string; method: string; headers: Headers; body: string | null }> =
    [];
  let now = 1_000;
  try {
    await credentials.storeDataApiCredentials({
      guildId: "guild-1",
      configuredGameServerId: "server-1",
      applicationId: "haf-test-app",
      secret: "provider-secret",
      nowMs: now,
      createId: () => "data-api-credential",
    });
    const client = new CftoolsDataApiClient({
      credentials,
      now: () => now,
      fetch: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const headers = new Headers(init?.headers);
        requests.push({
          url,
          method,
          headers,
          body: typeof init?.body === "string" ? init.body : null,
        });
        if (url.endsWith("/v1/auth/register")) {
          return Response.json({ token: "access-token" });
        }
        assert.equal(headers.get("authorization"), "Bearer access-token");
        if (url.endsWith("/info")) {
          return Response.json({
            server: { gameserver: { game: 1 }, gameserver_id: "public-server-1" },
          });
        }
        if (url.endsWith("/GSM/list")) {
          return Response.json({
            sessions: [
              { gamedata: { steam64: "76561198000000002", private: "discard-me" } },
              { gamedata: { steam64: "76561198000000001" } },
            ],
          });
        }
        if (url.endsWith("/v1/gameserver/public-server-1")) {
          return Response.json({ dayz: { status: { players: 2, queue: { size: 0 }, slots: 1 } } });
        }
        return new Response("not found", { status: 404 });
      },
    });

    assert.deepEqual(await client.observeCurrentRoster(server()), {
      steamIds: ["76561198000000001", "76561198000000002"],
      population: 2,
      queueSize: 0,
      maxSlots: 1,
      observedAtMs: 1_000,
    });
    now = 2_000;
    await client.observeCurrentRoster(server());

    assert.deepEqual(
      requests.map(({ url, method }) => `${method} ${new URL(url).pathname}`),
      [
        "POST /v1/auth/register",
        "GET /v1/server/cftools-server-1/info",
        "GET /v1/server/cftools-server-1/GSM/list",
        "GET /v1/gameserver/public-server-1",
        "GET /v1/server/cftools-server-1/info",
        "GET /v1/server/cftools-server-1/GSM/list",
        "GET /v1/gameserver/public-server-1",
      ],
    );
    assert.equal(
      requests.every(({ headers }) => headers.get("user-agent") === "haf-test-app"),
      true,
    );
    assert.deepEqual(JSON.parse(requests[0]!.body ?? "null"), {
      application_id: "haf-test-app",
      secret: "provider-secret",
    });
    const stored = database.query<{ ciphertext: string }>(
      "SELECT ciphertext FROM server_level_credentials WHERE purpose = 'data_api'",
    );
    assert.equal(stored.length, 1);
    assert.doesNotMatch(stored[0]!.ciphertext, /provider-secret|access-token|haf-test-app/);
  } finally {
    database.close();
  }
});

test("CFTools Data API rejects a roster that disagrees with public population", async () => {
  const database = new SqliteD1Database();
  const credentials = new ServerLevelCredentialService(
    createCloudflareServerLevelCredentialStore(database.d1),
    createWebhookCredentialKeyRing({ keyV1: Buffer.alloc(32, 6).toString("base64") }),
  );
  try {
    await credentials.storeDataApiCredentials({
      guildId: "guild-1",
      configuredGameServerId: "server-1",
      applicationId: "haf-test-app",
      secret: "provider-secret",
      accessToken: "cached-token",
      accessTokenExpiresAtMs: 100_000,
      nowMs: 1,
    });
    const client = new CftoolsDataApiClient({
      credentials,
      now: () => 1_000,
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith("/info")) {
          return Response.json({
            server: { gameserver: { game: 1 }, gameserver_id: "public-server-1" },
          });
        }
        if (url.endsWith("/GSM/list")) return Response.json({ sessions: [] });
        return Response.json({ dayz: { status: { players: 1, queue: { size: 0 }, slots: 60 } } });
      },
    });
    await assert.rejects(client.observeCurrentRoster(server()), /trusted snapshot/);
  } finally {
    database.close();
  }
});

function server(): ConfiguredGameServer {
  return {
    id: "server-1",
    guildId: "guild-1",
    displayName: "DayZ",
    providerServerId: "cftools-server-1",
    maxSlots: 60,
    endpointId: "endpoint-1",
    webhookCredentialId: "webhook-credential",
    webhookVerifiedAtMs: 1,
    subscribedEvents: ["user.join", "user.leave", "server.restart", "server.shutdown"],
    capacityProposal: null,
    lastRosterReconciledAtMs: null,
    lastCapacityCheckedAtMs: null,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}
