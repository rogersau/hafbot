/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createAdminApiHandler } from "./helpers/admin-api";
import { PlayerCountService } from "../src/services/player-count-service";
import { createPlayerCountStatusProviderResolver } from "../src/services/player-count-status-provider";
import { createSteamWebPlayerCountStatusProvider } from "../src/services/steam-web-player-count-status-provider";
import { postPlayerCountAuditEvent } from "../src/services/guild-audit-log-service";
import type { PlayerCountServer } from "../src/types/player-count";
import type { RuntimeStores } from "../src/runtime/app-types";
import {
  afterStoreSeed,
  createProductionRuntimeStores,
  withStoreOverrides,
} from "./support/production-runtime-stores";
import { createPermissiveGuildResourceValidator } from "./helpers/guild-resource-validator";

test("POST /admin/api/player-count/test returns a snapshot without workspaceId", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        response: {
          servers: [
            {
              gameport: 27015,
              players: 7,
              max_players: 50,
              gametype: "lqs1",
              name: "Live",
              map: "Procedural",
            },
          ],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  try {
    const handler = createAdminApiHandler({
      stores: createStoresWithServer(),
      discordBotToken: "token",
      services: createServicesWithServer(),
    });

    const response = await handler(
      new Request("https://example.com/admin/api/player-count/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          guildId: "guild-1",
          serverId: "server-1",
        }),
      }),
      new URL("https://example.com/admin/api/player-count/test"),
    );

    assert.ok(response);
    assert.equal(response!.status, 200);
    const body = (await response!.json()) as {
      ok: boolean;
      snapshot?: { count: number; maxSlots: number; queue: number | null };
    };
    assert.deepEqual(body, {
      ok: true,
      snapshot: { count: 7, maxSlots: 50, queue: 1 },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /admin/api/player-count/test returns the error on a failed reachability check", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("boom", { status: 500 });

  try {
    const handler = createAdminApiHandler({
      stores: createStoresWithServer(),
      discordBotToken: "token",
      services: createServicesWithServer(),
    });

    const response = await handler(
      new Request("https://example.com/admin/api/player-count/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          guildId: "guild-1",
          serverId: "server-1",
        }),
      }),
      new URL("https://example.com/admin/api/player-count/test"),
    );

    assert.ok(response);
    assert.equal(response!.status, 200);
    const body = (await response!.json()) as { ok: boolean; error?: string };
    assert.equal(body.ok, false);
    assert.ok((body.error ?? "").length > 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /admin/api/player-count/test returns 404 for an unknown server", async () => {
  const handler = createAdminApiHandler({
    stores: createStoresWithServer(),
    discordBotToken: "token",
    services: createServicesWithServer(),
  });

  const response = await handler(
    new Request("https://example.com/admin/api/player-count/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ guildId: "guild-1", serverId: "missing" }),
    }),
    new URL("https://example.com/admin/api/player-count/test"),
  );

  assert.ok(response);
  assert.equal(response!.status, 404);
  const body = (await response!.json()) as { code: string; error?: string };
  assert.equal(body.code, "resource_not_found");
  assert.equal(body.error, "Server not found");
});

test("POST /admin/api/player-count/server returns JSON 500 when the store throws", async () => {
  const handler = createAdminApiHandler({
    stores: createStores(),
    guildResources: createPermissiveGuildResourceValidator(),
    discordBotToken: "token",
  });

  const response = await handler(
    new Request("https://example.com/admin/api/player-count/server", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        guildId: "guild-1",
        name: "Main",
        provider: "steam-web",
        providerServerId: "",
        channelId: "channel-1",
        refreshIntervalMinutes: 10,
        steamHost: "127.0.0.1",
        steamPort: 27015,
      }),
    }),
    new URL("https://example.com/admin/api/player-count/server"),
  );

  assert.ok(response);
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("content-type"), "application/json");
  const body = (await response.json()) as { error: string; code: string };
  assert.equal(body.error, "Something went wrong.");
  assert.equal(body.code, "internal_error");
});

test("POST /admin/api/player-count/delete scopes deletion, cleanup, and audit to the authorized Guild", async () => {
  const fixture = createProductionRuntimeStores();
  const ownServer = createServer({ id: "server-own", guildId: "guild-1", name: "Own" });
  const foreignServer = createServer({
    id: "server-foreign",
    guildId: "guild-2",
    name: "Foreign",
  });
  await fixture.database.d1
    .prepare("INSERT INTO guild_entitlements (guild_id, plan, updated_at_ms) VALUES (?, ?, ?)")
    .bind("guild-1", "premium", 1)
    .run();
  await fixture.stores.playerCount.upsertPlayerCountServer(ownServer);
  await fixture.stores.playerCount.upsertPlayerCountServer(foreignServer);
  await fixture.stores.guildAuditLog.upsertConfig({
    guildId: "guild-1",
    auditChannelId: "audit-channel-1",
    groupChannelIds: {},
    eventStates: { groups: { "player-count": true }, overrides: {} },
    excludedChannelIds: [],
    excludedRoleIds: [],
    updatedAtMs: 1,
  });

  const reported = new Set([
    "player_count:streak_reported:guild-1:server-own",
    "player_count:streak_reported:guild-2:server-foreign",
  ]);
  const clearedStreaks: string[] = [];
  const healthyObservations: Array<{ guildId: string; resourceId: string; condition: string }> = [];
  const guildResources = createPermissiveGuildResourceValidator();
  const playerCountService = new PlayerCountService(fixture.stores.playerCount, {
    discordBotToken: "token",
    async modifyChannel() {},
    resolveStatusProvider: createPlayerCountStatusProviderResolver({}),
    streakReportedStore: {
      async isStreakReported(key) {
        return reported.has(key);
      },
      async markStreakReported(key) {
        reported.add(key);
      },
      async clearStreakReported(key) {
        clearedStreaks.push(key);
        reported.delete(key);
      },
    },
    postPlayerCountAuditEvent: async () => {},
    postPlayerCountDeletionAuditEvent: (input) =>
      postPlayerCountAuditEvent(
        "player-count.server-delete",
        input,
        fixture.stores.guildAuditLog,
        "token",
        guildResources,
      ),
    operationalIncidents: {
      async observeFailure() {
        throw new Error("Unexpected failure observation");
      },
      async observeHealthy(input) {
        healthyObservations.push({
          guildId: input.guildId,
          resourceId: input.key.resourceId,
          condition: input.key.condition,
        });
        return null;
      },
    },
  });
  const handler = createAdminApiHandler({
    stores: fixture.stores,
    discordBotToken: "token",
    services: { playerCountService },
    guildResources,
    readCustomerAdminSession: async () => ({
      user: { id: "account-1", discordUserId: "actor-1", name: "Admin" },
    }),
  });
  const auditBodies: Array<{ embeds: Array<{ title: string; fields: unknown[] }> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    auditBodies.push(JSON.parse(String(init?.body)));
    return Response.json({ id: "audit-message-1" });
  };

  try {
    const foreignResponse = await deleteServer(handler, "guild-1", foreignServer.id);
    assert.equal(foreignResponse.status, 404);
    assert.deepEqual(
      await fixture.stores.playerCount.readPlayerCountServer(foreignServer.id),
      foreignServer,
    );
    assert.deepEqual(clearedStreaks, []);
    assert.deepEqual(healthyObservations, []);
    assert.equal(auditBodies.length, 0);

    const ownResponse = await deleteServer(handler, "guild-1", ownServer.id);
    assert.equal(ownResponse.status, 200);
    assert.equal(await fixture.stores.playerCount.readPlayerCountServer(ownServer.id), null);
    assert.deepEqual(clearedStreaks, ["player_count:streak_reported:guild-1:server-own"]);
    assert.deepEqual(healthyObservations, [
      { guildId: "guild-1", resourceId: "server-own", condition: "offline" },
    ]);
    assert.equal(reported.has("player_count:streak_reported:guild-2:server-foreign"), true);
    assert.equal(auditBodies.length, 1);
    assert.equal(auditBodies[0]?.embeds[0]?.title, "🎮 Player Count Server Deleted");
    assert.ok(JSON.stringify(auditBodies[0]?.embeds[0]?.fields).includes("actor-1"));
  } finally {
    globalThis.fetch = originalFetch;
    fixture.close();
  }
});

test("Player Count admin APIs reject Free guilds", async () => {
  const stores = createStoresWithServer("free");
  const handler = createAdminApiHandler({
    stores,
    discordBotToken: "token",
    services: createServicesWithServer(),
  });

  const response = await handler(
    new Request("https://example.com/admin/api/player-count?guildId=guild-1"),
    new URL("https://example.com/admin/api/player-count?guildId=guild-1"),
  );

  assert.equal(response?.status, 402);
});

function createStores(): RuntimeStores {
  return createStoresFixture({ failUpsert: true }).stores;
}

function createStoresWithServer(tier: "free" | "premium" = "premium"): RuntimeStores {
  return createStoresFixture({ server: createServer(), tier }).stores;
}

function createServicesWithServer() {
  const fixture = createStoresFixture({ server: createServer(), tier: "premium" });
  const service = new PlayerCountService(fixture.stores.playerCount, {
    discordBotToken: "token",
    resolveStatusProvider: createPlayerCountStatusProviderResolver({
      "steam-web": createSteamWebPlayerCountStatusProvider({ apiKey: "steam-key" }),
    }),
    async modifyChannel() {},
    streakReportedStore: {
      isStreakReported: async () => false,
      markStreakReported: async () => {},
      clearStreakReported: async () => {},
    },
    postPlayerCountAuditEvent: async () => {},
    postPlayerCountDeletionAuditEvent: async () => {},
  });
  return { playerCountService: service };
}

function createStoresFixture(options: {
  server?: PlayerCountServer;
  tier?: "free" | "premium";
  failUpsert?: boolean;
}) {
  const fixture = createProductionRuntimeStores();
  const rawPlayerCount = fixture.stores.playerCount;
  const ready = (async () => {
    const tier = options.tier ?? "premium";
    await fixture.database.d1
      .prepare("INSERT INTO guild_entitlements (guild_id, plan, updated_at_ms) VALUES (?, ?, ?)")
      .bind("guild-1", tier, 1)
      .run();
    if (options.server) await rawPlayerCount.upsertPlayerCountServer(options.server);
  })();
  let playerCount = afterStoreSeed(rawPlayerCount, ready);
  if (options.failUpsert) {
    playerCount = withStoreOverrides(playerCount, {
      async upsertPlayerCountServer() {
        throw new Error("D1 insert failed: no such column: refresh_interval_minutes");
      },
    });
  }
  const stores: RuntimeStores = {
    ...fixture.stores,
    playerCount,
    guildEntitlements: afterStoreSeed(fixture.stores.guildEntitlements, ready),
  };
  return { ...fixture, stores };
}

function createServer(overrides: Partial<PlayerCountServer> = {}): PlayerCountServer {
  return {
    id: "server-1",
    guildId: "guild-1",
    name: "Main PvP",
    provider: "steam-web",
    providerServerId: "1.2.3.4:27015",
    channelId: null,
    alertChannelId: null,
    refreshIntervalMinutes: 10,
    displayFormat: "Players {count}/{max}",
    offlineFormat: "Players Offline",
    failureThreshold: 3,
    renameOffsetMinutes: 0,
    lastRenamedAtMs: null,
    lastPlayerCount: 0,
    lastMaxSlots: 0,
    lastQueueSize: 0,
    lastFetchedAtMs: null,
    consecutiveFailureCount: 0,
    lastErrorMessage: null,
    lastErrorAtMs: null,
    steamHost: "1.2.3.4",
    steamPort: 27015,
    createdAtMs: 0,
    updatedAtMs: 0,
    ...overrides,
  };
}

async function deleteServer(
  handler: ReturnType<typeof createAdminApiHandler>,
  guildId: string,
  id: string,
): Promise<Response> {
  const url = new URL("https://example.com/admin/api/player-count/delete");
  const response = await handler(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ guildId, id }),
    }),
    url,
  );
  assert.ok(response);
  return response;
}
