/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import {
  applyPlayerCountTemplate,
  buildPlayerCountAlertEmbed,
  buildPlayerCountStatusEmbed,
  PlayerCountService,
  type PlayerCountServiceOptions,
} from "../src/services/player-count-service";
import { createPlayerCountStatusProviderResolver } from "../src/services/player-count-status-provider";
import { createSteamWebPlayerCountStatusProvider } from "../src/services/steam-web-player-count-status-provider";
import type { PlayerCountStore } from "../src/runtime/contracts/player-count-store";
import type { PlayerCountServer } from "../src/types/player-count";
import { reportOperationalEvent } from "../src/observability/operational-reporter";
import { GuildResourceValidationError } from "../src/discord/guild-resource-validator";
import {
  createStaticGuildResourceValidator,
  testChannel,
} from "./helpers/guild-resource-validator";
import {
  afterStoreSeed,
  createProductionRuntimeStores,
  withStoreOverrides,
} from "./support/production-runtime-stores";

class FakeStreakStore {
  reported = new Set<string>();
  cleared: string[] = [];
  marked: string[] = [];
  async isStreakReported(key: string) {
    return this.reported.has(key);
  }
  async markStreakReported(key: string) {
    this.marked.push(key);
    this.reported.add(key);
  }
  async clearStreakReported(key: string) {
    this.cleared.push(key);
    this.reported.delete(key);
  }
}

function defaultServiceOptions(
  overrides: Partial<PlayerCountServiceOptions> & { steamWebApiKey?: string } = {},
): PlayerCountServiceOptions {
  const { steamWebApiKey, ...serviceOverrides } = overrides;
  return {
    discordBotToken: "bot-token",
    async modifyChannel() {},
    resolveStatusProvider:
      serviceOverrides.resolveStatusProvider ??
      createPlayerCountStatusProviderResolver(
        steamWebApiKey
          ? { "steam-web": createSteamWebPlayerCountStatusProvider({ apiKey: steamWebApiKey }) }
          : {},
      ),
    streakReportedStore: new FakeStreakStore(),
    postPlayerCountAuditEvent: async () => {},
    postPlayerCountDeletionAuditEvent: async () => {},
    ...serviceOverrides,
  };
}

test("deleteServer leaves the server available when incident cleanup fails", async () => {
  const fixture = createProductionRuntimeStores();
  const server = createServer();
  await fixture.stores.playerCount.upsertPlayerCountServer(server);
  const service = new PlayerCountService(
    fixture.stores.playerCount,
    defaultServiceOptions({
      operationalIncidents: {
        async observeFailure() {
          throw new Error("Unexpected failure observation");
        },
        async observeHealthy() {
          throw new Error("Incident cleanup unavailable");
        },
      },
    }),
  );

  try {
    await assert.rejects(
      service.deleteServer(server.guildId, server.id, "actor-1"),
      /cleanup unavailable/,
    );
    assert.deepEqual(await fixture.stores.playerCount.readPlayerCountServer(server.id), server);
  } finally {
    fixture.close();
  }
});

test("deleteServer audits the actor without making deletion depend on audit delivery", async () => {
  const fixture = createProductionRuntimeStores();
  const server = createServer();
  await fixture.stores.playerCount.upsertPlayerCountServer(server);
  const auditCalls: unknown[] = [];
  const service = new PlayerCountService(
    fixture.stores.playerCount,
    defaultServiceOptions({
      postPlayerCountDeletionAuditEvent: async (input) => {
        auditCalls.push(input);
        throw new Error("Audit delivery unavailable");
      },
    }),
  );

  try {
    assert.deepEqual(await service.deleteServer(server.guildId, server.id, "actor-1"), server);
    assert.equal(await fixture.stores.playerCount.readPlayerCountServer(server.id), null);
    assert.deepEqual(auditCalls, [
      {
        guildId: "guild-1",
        serverId: "server-1",
        serverName: "Main PvP",
        identifier: "123.45.67.89:27015",
        actorUserId: "actor-1",
      },
    ]);
  } finally {
    fixture.close();
  }
});

test("refreshServer does not recreate failure state after the server is deleted", async () => {
  const fixture = createProductionRuntimeStores();
  const server = createServer({ failureThreshold: 1 });
  await fixture.stores.playerCount.upsertPlayerCountServer(server);
  const streakStore = new FakeStreakStore();
  const auditCalls: unknown[] = [];
  const incidentCalls: unknown[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    await fixture.stores.playerCount.deletePlayerCountServer(server.guildId, server.id);
    return new Response("unavailable", { status: 500 });
  };
  const service = new PlayerCountService(
    fixture.stores.playerCount,
    defaultServiceOptions({
      steamWebApiKey: "steam-key",
      streakReportedStore: streakStore,
      postPlayerCountAuditEvent: async (input) => {
        auditCalls.push(input);
      },
      operationalIncidents: {
        async observeFailure(input) {
          incidentCalls.push(input);
          return {} as any;
        },
        async observeHealthy() {
          throw new Error("Unexpected healthy observation");
        },
      },
    }),
  );

  try {
    const result = await service.refreshServer(server.guildId, server.id);
    assert.deepEqual(result, { ok: false, error: "Steam Web API error 500" });
    assert.equal(await fixture.stores.playerCount.readPlayerCountServer(server.id), null);
    assert.deepEqual(streakStore.marked, []);
    assert.deepEqual(auditCalls, []);
    assert.deepEqual(incidentCalls, []);
  } finally {
    globalThis.fetch = originalFetch;
    fixture.close();
  }
});

test("scheduled Player Count work skips Free guilds before external or Discord calls", async () => {
  const server = createServer({ lastFetchedAtMs: null, lastRenamedAtMs: null });
  let fetches = 0;
  let renames = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetches += 1;
    return new Response("unexpected");
  };

  try {
    const service = new PlayerCountService(
      createStore([server], []),
      defaultServiceOptions({
        steamWebApiKey: "steam-key",
        async modifyChannel() {
          renames += 1;
        },
        guildEntitlements: {
          async readGuildEntitlement(guildId) {
            return { guildId, tier: "free", updatedAtMs: Date.now() };
          },
        },
      }),
    );

    await service.refreshAllServers();
    await service.renameDueChannels();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetches, 0);
  assert.equal(renames, 0);
});

test("renameDueChannels renames bound channels every cron tick once five minutes have elapsed", async () => {
  const baseTime = Date.UTC(2026, 0, 1, 12, 0, 0);
  const server = createServer({
    renameOffsetMinutes: 7,
    lastRenamedAtMs: baseTime - 5 * 60 * 1000,
    lastFetchedAtMs: baseTime - 60 * 1000,
  });
  const renamedChannels: Array<{ channelId: string; name: string }> = [];
  const renamedAtUpdates: Array<{ id: string; lastRenamedAtMs: number }> = [];
  const originalDateNow = Date.now;

  Date.now = () => baseTime;

  try {
    const service = new PlayerCountService(
      createStore([server], renamedAtUpdates),
      defaultServiceOptions({
        async modifyChannel(channelId, body) {
          renamedChannels.push({ channelId, name: body.name });
        },
      }),
    );

    await service.renameDueChannels();
  } finally {
    Date.now = originalDateNow;
  }

  assert.deepEqual(renamedChannels, [{ channelId: "voice-1", name: "Players 12/60" }]);
  assert.deepEqual(renamedAtUpdates, [{ id: "server-1", lastRenamedAtMs: baseTime }]);
});

test("Steam channel switches offline at its failure threshold and recovers after a successful poll", async () => {
  const fixture = createProductionRuntimeStores();
  const server = createServer({ consecutiveFailureCount: 1, failureThreshold: 2 });
  await fixture.stores.playerCount.upsertPlayerCountServer(server);
  const channelNames: string[] = [];
  let healthy = false;
  let now = Date.UTC(2026, 9, 8, 12);
  const service = new PlayerCountService(
    fixture.stores.playerCount,
    defaultServiceOptions({
      now: () => now,
      resolveStatusProvider: () => ({
        async query() {
          return healthy
            ? { ok: true, snapshot: { count: 7, maxSlots: 12, queue: 0 } }
            : { ok: false, error: "Server not found in Steam directory" };
        },
      }),
      async modifyChannel(_channelId, body) {
        channelNames.push(body.name);
      },
    }),
  );
  try {
    assert.equal(service.buildChannelName(server), "Players 12/60");
    assert.equal((await service.refreshServer(server.guildId, server.id)).ok, false);
    await service.renameDueChannels();
    assert.deepEqual(channelNames, ["Players Offline"]);
    const failed = await fixture.stores.playerCount.readPlayerCountServer(server.id);
    assert.equal(
      failed?.lastPlayerCount,
      12,
      "The last observation remains available for diagnostics",
    );
    healthy = true;
    now += 5 * 60_000;
    assert.equal((await service.refreshServer(server.guildId, server.id)).ok, true);
    await service.renameDueChannels();
    assert.deepEqual(channelNames, ["Players Offline", "Players 7/12"]);
    assert.equal(
      (await fixture.stores.playerCount.readPlayerCountServer(server.id))?.consecutiveFailureCount,
      0,
    );
  } finally {
    fixture.close();
  }
});

for (const reporterFails of [false, true]) {
  test(`refreshAllServers reports rejected children safely and continues (reporter fails: ${reporterFails})`, async () => {
    const fixture = createProductionRuntimeStores();
    const failed = createServer({ id: "failed", channelId: "voice-failed" });
    const healthy = createServer({ id: "healthy", channelId: "voice-healthy" });
    const unavailable = createServer({ id: "unavailable", channelId: null });
    const logs: unknown[] = [];
    const renames: Array<{ channelId: string; name: string }> = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => logs.push(args);

    try {
      for (const server of [failed, healthy, unavailable]) {
        await fixture.stores.playerCount.upsertPlayerCountServer(server);
      }
      const store = withStoreOverrides(fixture.stores.playerCount, {
        async updatePlayerCountSnapshot(input) {
          if (input.id === failed.id) {
            const cause = new Error("https://provider.invalid/private token=fixture-secret");
            cause.name = "customer-content";
            throw cause;
          }
          return fixture.stores.playerCount.updatePlayerCountSnapshot(input);
        },
      });
      const service = new PlayerCountService(
        store,
        defaultServiceOptions({
          now: () => Date.UTC(2026, 0, 1, 12),
          resolveStatusProvider: () => ({
            async query(server) {
              return server.id === unavailable.id
                ? { ok: false, error: "Provider unavailable" }
                : { ok: true, snapshot: { count: 18, maxSlots: 60, queue: 1 } };
            },
          }),
          ...(reporterFails
            ? {
                reportOperationalEvent: (event) => {
                  reportOperationalEvent(event);
                  throw new Error("Telemetry unavailable");
                },
              }
            : {}),
          async modifyChannel(channelId, body) {
            renames.push({ channelId, name: body.name });
          },
        }),
      );

      await service.refreshAllServers();
      await service.renameDueChannels();

      assert.equal((await store.readPlayerCountServer(healthy.id))?.lastPlayerCount, 18);
      assert.equal((await store.readPlayerCountServer(failed.id))?.lastFetchedAtMs, null);
      assert.equal((await store.readPlayerCountServer(unavailable.id))?.consecutiveFailureCount, 1);
      assert.deepEqual(renames, [
        { channelId: "voice-failed", name: "Players 12/60" },
        { channelId: "voice-healthy", name: "Players 18/60" },
      ]);
      assert.equal(logs.length, 1);
      const [log] = logs[0] as Array<Record<string, unknown>>;
      assert.equal(log?.event, "haf.operational");
      assert.equal(log?.severity, "error");
      assert.equal(log?.code, "player_count.server_refresh_failed");
      assert.equal(log?.guildId, failed.guildId);
      assert.equal(log?.operation, "refresh_player_count");
      assert.deepEqual(log?.context, { serverId: failed.id });
      assert.match(JSON.stringify(log?.cause), /untrusted error details omitted/);
      assert.doesNotMatch(
        JSON.stringify(logs),
        /provider\.invalid|fixture-secret|customer-content|bot-token|123\.45\.67\.89|Main PvP/,
      );
    } finally {
      console.error = originalError;
      fixture.close();
    }
  });
}

test("refreshAllServers refreshes servers once their interval has elapsed", async () => {
  const baseTime = Date.UTC(2026, 0, 1, 12, 0, 0);
  const dueServer = createServer({
    id: "due-server",
    name: "Due",
    refreshIntervalMinutes: 10,
    lastFetchedAtMs: baseTime - 11 * 60 * 1000,
  });
  const notElapsed = createServer({
    id: "not-elapsed",
    name: "Not Elapsed",
    refreshIntervalMinutes: 10,
    lastFetchedAtMs: baseTime - 6 * 60 * 1000,
  });
  const notStaggered = createServer({
    id: "not-staggered",
    name: "Not Staggered",
    refreshIntervalMinutes: 10,
    lastFetchedAtMs: baseTime - 11 * 60 * 1000,
  });

  const snapshotUpdates: Array<{
    id: string;
    lastPlayerCount: number | null;
    lastMaxSlots: number | null;
    lastQueueSize: number | null;
    lastFetchedAtMs: number | null;
  }> = [];
  const originalDateNow = Date.now;
  const originalFetch = globalThis.fetch;

  Date.now = () => baseTime;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        response: {
          servers: [
            {
              gameport: 27015,
              players: 25,
              max_players: 80,
              gametype: "lqs4",
              name: "Due",
              map: "Procedural Map",
            },
          ],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  try {
    const service = new PlayerCountService(
      createStore([dueServer, notElapsed, notStaggered], [], snapshotUpdates),
      defaultServiceOptions({ steamWebApiKey: "steam-key" }),
    );

    await service.refreshAllServers();
  } finally {
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(snapshotUpdates.map((entry) => entry.id).sort(), [
    "due-server",
    "not-staggered",
  ]);
});

test("refreshAllServers emits a player-count audit event when the streak reaches the threshold", async () => {
  const baseTime = Date.UTC(2026, 0, 1, 12, 0, 0);
  const server = createServer({
    id: "server-1",
    guildId: "guild-1",
    name: "Main PvP",
    refreshIntervalMinutes: 10,
    lastFetchedAtMs: baseTime - 11 * 60 * 1000,
    consecutiveFailureCount: 2,
    lastErrorMessage: "Server not found in Steam directory",
    lastErrorAtMs: baseTime - 5 * 60 * 1000,
  });

  const failureUpdates: Array<{
    id: string;
    consecutiveFailureCount: number;
    errorMessage: string;
    errorAtMs: number;
  }> = [];
  const auditCalls: Array<{
    guildId: string;
    serverId: string;
    serverName: string;
    identifier: string;
    errorMessage: string;
    streakCount: number;
  }> = [];
  const streakStore = new FakeStreakStore();
  const originalDateNow = Date.now;
  const originalFetch = globalThis.fetch;

  Date.now = () => baseTime;
  globalThis.fetch = async () => new Response("boom", { status: 500 });

  try {
    const service = new PlayerCountService(
      createStore([server], [], [], failureUpdates),
      defaultServiceOptions({
        steamWebApiKey: "steam-key",
        streakReportedStore: streakStore,
        postPlayerCountAuditEvent: async (input) => {
          auditCalls.push(input);
        },
      }),
    );

    await service.refreshAllServers();
  } finally {
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
  }

  assert.equal(failureUpdates.length, 1);
  assert.equal(failureUpdates[0].consecutiveFailureCount, 3);
  assert.equal(auditCalls.length, 1);
  assert.equal(auditCalls[0].guildId, "guild-1");
  assert.equal(auditCalls[0].serverId, "server-1");
  assert.equal(auditCalls[0].serverName, "Main PvP");
  assert.equal(auditCalls[0].streakCount, 3);
  assert.ok(auditCalls[0].errorMessage.length > 0);
  assert.ok(streakStore.reported.has("player_count:streak_reported:guild-1:server-1"));
});

test("refreshAllServers emits a player-count alert when the streak reaches the configured threshold", async () => {
  const baseTime = Date.UTC(2026, 0, 1, 12, 0, 0);
  const server = createServer({
    id: "server-1",
    guildId: "guild-1",
    name: "Main PvP",
    alertChannelId: "alert-channel-1",
    refreshIntervalMinutes: 10,
    lastFetchedAtMs: baseTime - 11 * 60 * 1000,
    consecutiveFailureCount: 2,
    lastErrorMessage: "Server not found in Steam directory",
    lastErrorAtMs: baseTime - 5 * 60 * 1000,
  });

  const failureUpdates: Array<{
    id: string;
    consecutiveFailureCount: number;
    errorMessage: string;
    errorAtMs: number;
  }> = [];
  const auditCalls: Array<{
    guildId: string;
    serverId: string;
    serverName: string;
    identifier: string;
    errorMessage: string;
    streakCount: number;
  }> = [];
  const fetchCalls: Array<{ input: unknown; init?: RequestInit }> = [];
  const streakStore = new FakeStreakStore();
  const originalDateNow = Date.now;
  const originalFetch = globalThis.fetch;

  Date.now = () => baseTime;
  globalThis.fetch = async (input, init) => {
    fetchCalls.push({ input, init });
    return new Response("boom", { status: 500 });
  };

  try {
    const service = new PlayerCountService(
      createStore([server], [], [], failureUpdates),
      defaultServiceOptions({
        steamWebApiKey: "steam-key",
        streakReportedStore: streakStore,
        postPlayerCountAuditEvent: async (input) => {
          auditCalls.push(input);
        },
      }),
    );

    await service.refreshAllServers();
  } finally {
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
  }

  assert.equal(failureUpdates.length, 1);
  assert.equal(failureUpdates[0].consecutiveFailureCount, 3);
  assert.equal(auditCalls.length, 1);
  assert.equal(auditCalls[0].guildId, "guild-1");
  assert.equal(auditCalls[0].serverId, "server-1");
  assert.equal(auditCalls[0].serverName, "Main PvP");
  assert.equal(auditCalls[0].streakCount, 3);
  assert.ok(auditCalls[0].errorMessage.length > 0);
  assert.ok(streakStore.reported.has("player_count:streak_reported:guild-1:server-1"));
  assert.equal(fetchCalls.length, 2);
  assert.ok(String(fetchCalls[0]?.input).includes("steampowered.com"));
  assert.ok(String(fetchCalls[1]?.input).includes("/channels/alert-channel-1/messages"));
});

test("refreshAllServers uses the configured failure threshold", async () => {
  const baseTime = Date.UTC(2026, 0, 1, 12, 0, 0);
  const server = createServer({
    id: "server-1",
    guildId: "guild-1",
    name: "Main PvP",
    failureThreshold: 5,
    alertChannelId: "alert-channel-1",
    refreshIntervalMinutes: 10,
    lastFetchedAtMs: baseTime - 11 * 60 * 1000,
    consecutiveFailureCount: 4,
  });

  const failureUpdates: Array<{
    id: string;
    consecutiveFailureCount: number;
    errorMessage: string;
    errorAtMs: number;
  }> = [];
  const auditCalls: Array<unknown> = [];
  const fetchCalls: Array<{ input: unknown; init?: RequestInit }> = [];
  const streakStore = new FakeStreakStore();
  const originalDateNow = Date.now;
  const originalFetch = globalThis.fetch;

  Date.now = () => baseTime;
  globalThis.fetch = async (input, init) => {
    fetchCalls.push({ input, init });
    return new Response("boom", { status: 500 });
  };

  try {
    const service = new PlayerCountService(
      createStore([server], [], [], failureUpdates),
      defaultServiceOptions({
        steamWebApiKey: "steam-key",
        streakReportedStore: streakStore,
        postPlayerCountAuditEvent: async (input) => {
          auditCalls.push(input);
        },
      }),
    );

    await service.refreshAllServers();
  } finally {
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
  }

  assert.equal(failureUpdates.length, 1);
  assert.equal(failureUpdates[0].consecutiveFailureCount, 5);
  assert.equal(auditCalls.length, 1);
  assert.equal(fetchCalls.length, 2);
  assert.ok(String(fetchCalls[0]?.input).includes("steampowered.com"));
  assert.ok(String(fetchCalls[1]?.input).includes("/channels/alert-channel-1/messages"));
});

test("refreshAllServers does not post a channel alert when no alert channel is configured", async () => {
  const baseTime = Date.UTC(2026, 0, 1, 12, 0, 0);
  const server = createServer({
    id: "server-1",
    guildId: "guild-1",
    name: "Main PvP",
    alertChannelId: null,
    refreshIntervalMinutes: 10,
    lastFetchedAtMs: baseTime - 11 * 60 * 1000,
    consecutiveFailureCount: 2,
  });

  const failureUpdates: Array<{
    id: string;
    consecutiveFailureCount: number;
    errorMessage: string;
    errorAtMs: number;
  }> = [];
  const auditCalls: Array<unknown> = [];
  const fetchCalls: Array<{ input: unknown; init?: RequestInit }> = [];
  const streakStore = new FakeStreakStore();
  const originalDateNow = Date.now;
  const originalFetch = globalThis.fetch;

  Date.now = () => baseTime;
  globalThis.fetch = async (input, init) => {
    fetchCalls.push({ input, init });
    return new Response("boom", { status: 500 });
  };

  try {
    const service = new PlayerCountService(
      createStore([server], [], [], failureUpdates),
      defaultServiceOptions({
        steamWebApiKey: "steam-key",
        streakReportedStore: streakStore,
        postPlayerCountAuditEvent: async (input) => {
          auditCalls.push(input);
        },
      }),
    );

    await service.refreshAllServers();
  } finally {
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
  }

  assert.equal(auditCalls.length, 1);
  assert.equal(fetchCalls.length, 1);
  assert.ok(String(fetchCalls[0]?.input).includes("steampowered.com"));
});

test("refreshAllServers does not re-emit the alert when the streak is already reported", async () => {
  const baseTime = Date.UTC(2026, 0, 1, 12, 0, 0);
  const server = createServer({
    id: "server-1",
    guildId: "guild-1",
    refreshIntervalMinutes: 10,
    lastFetchedAtMs: baseTime - 11 * 60 * 1000,
    consecutiveFailureCount: 2,
  });

  const failureUpdates: Array<{
    id: string;
    consecutiveFailureCount: number;
    errorMessage: string;
    errorAtMs: number;
  }> = [];
  const auditCalls: Array<unknown> = [];
  const streakStore = new FakeStreakStore();
  streakStore.reported.add("player_count:streak_reported:guild-1:server-1");
  const originalDateNow = Date.now;
  const originalFetch = globalThis.fetch;

  Date.now = () => baseTime;
  globalThis.fetch = async () => new Response("boom", { status: 500 });

  try {
    const service = new PlayerCountService(
      createStore([server], [], [], failureUpdates),
      defaultServiceOptions({
        steamWebApiKey: "steam-key",
        streakReportedStore: streakStore,
        postPlayerCountAuditEvent: async (input) => {
          auditCalls.push(input);
        },
      }),
    );

    await service.refreshAllServers();
  } finally {
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
  }

  assert.equal(failureUpdates.length, 1);
  assert.equal(failureUpdates[0].consecutiveFailureCount, 3);
  assert.equal(auditCalls.length, 0);
});

test("refreshAllServers emits a fresh audit event on a new streak after a successful fetch", async () => {
  const baseTime = Date.UTC(2026, 0, 1, 12, 0, 0);
  const auditCalls: Array<unknown> = [];
  const streakStore = new FakeStreakStore();
  const originalDateNow = Date.now;
  const originalFetch = globalThis.fetch;

  Date.now = () => baseTime;
  globalThis.fetch = async () => new Response("boom", { status: 500 });

  try {
    const firstServer = createServer({
      id: "server-1",
      guildId: "guild-1",
      refreshIntervalMinutes: 10,
      lastFetchedAtMs: baseTime - 11 * 60 * 1000,
      consecutiveFailureCount: 2,
    });
    const firstService = new PlayerCountService(
      createStore([firstServer], []),
      defaultServiceOptions({
        steamWebApiKey: "steam-key",
        streakReportedStore: streakStore,
        postPlayerCountAuditEvent: async (input) => {
          auditCalls.push(input);
        },
      }),
    );

    await firstService.refreshAllServers();
    assert.equal(auditCalls.length, 1);
    assert.ok(streakStore.reported.has("player_count:streak_reported:guild-1:server-1"));

    const secondServer = createServer({
      id: "server-1",
      guildId: "guild-1",
      refreshIntervalMinutes: 10,
      lastFetchedAtMs: baseTime - 11 * 60 * 1000,
      consecutiveFailureCount: 2,
    });
    const secondService = new PlayerCountService(
      createStore([secondServer], []),
      defaultServiceOptions({
        steamWebApiKey: "steam-key",
        streakReportedStore: new FakeStreakStore(),
        postPlayerCountAuditEvent: async (input) => {
          auditCalls.push(input);
        },
      }),
    );

    await secondService.refreshAllServers();
    assert.equal(auditCalls.length, 2);
  } finally {
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
  }
});

test("refreshAllServers keeps the last known good channel name when a fetch fails", async () => {
  const baseTime = Date.UTC(2026, 0, 1, 12, 0, 0);
  const dueServer = createServer({
    id: "server-1",
    guildId: "guild-1",
    refreshIntervalMinutes: 10,
    lastFetchedAtMs: baseTime - 11 * 60 * 1000,
    lastPlayerCount: 12,
    lastMaxSlots: 60,
    lastQueueSize: 0,
    displayFormat: "Players {count}/{max}",
    offlineFormat: "Players Offline",
  });
  const renamedChannels: Array<{ channelId: string; name: string }> = [];
  const originalDateNow = Date.now;
  const originalFetch = globalThis.fetch;

  Date.now = () => baseTime;
  globalThis.fetch = async () => new Response("boom", { status: 500 });

  try {
    const service = new PlayerCountService(
      createStore([dueServer], []),
      defaultServiceOptions({
        steamWebApiKey: "steam-key",
        async modifyChannel(channelId, body) {
          renamedChannels.push({ channelId, name: body.name });
        },
      }),
    );

    await service.refreshAllServers();
    await service.renameDueChannels();
  } finally {
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(renamedChannels, [{ channelId: "voice-1", name: "Players 12/60" }]);
  assert.equal(dueServer.lastPlayerCount, 12);
  assert.equal(dueServer.lastFetchedAtMs, baseTime - 11 * 60 * 1000);
});

test("testServerReachability returns the snapshot on a successful fetch", async () => {
  const server = createServer({
    id: "server-1",
    guildId: "guild-1",
    name: "Main PvP",
    consecutiveFailureCount: 2,
    lastErrorMessage: "previous error",
    lastErrorAtMs: 100,
    lastPlayerCount: 5,
    lastFetchedAtMs: 50,
  });
  const failureUpdates: Array<unknown> = [];
  const snapshotUpdates: Array<unknown> = [];
  const auditCalls: Array<unknown> = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        response: {
          servers: [
            {
              gameport: 27015,
              players: 42,
              max_players: 100,
              gametype: "lqs2",
              name: "Live",
              map: "Procedural Map",
            },
          ],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  try {
    const store = createStoreWithRead(
      [server],
      { ...server },
      {
        failureUpdates,
        snapshotUpdates,
      },
    );
    const service = new PlayerCountService(
      store,
      defaultServiceOptions({
        steamWebApiKey: "steam-key",
        streakReportedStore: new FakeStreakStore(),
        postPlayerCountAuditEvent: async (input) => {
          auditCalls.push(input);
        },
      }),
    );

    const result = await service.testServerReachability("guild-1", "server-1");
    assert.deepEqual(result, {
      ok: true,
      snapshot: { count: 42, maxSlots: 100, queue: 2 },
    });
    assert.equal(snapshotUpdates.length, 0);
    assert.equal(failureUpdates.length, 0);
    assert.equal(auditCalls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("refreshServer resolves the configured status provider and persists its normalized snapshot", async () => {
  const server = createServer();
  const queriedServers: PlayerCountServer[] = [];
  const snapshotUpdates: unknown[] = [];
  const service = new PlayerCountService(
    createStoreWithRead([server], { ...server }, { snapshotUpdates }),
    defaultServiceOptions({
      resolveStatusProvider(provider: string) {
        assert.equal(provider, "steam-web");
        return {
          async query(configuredServer: PlayerCountServer) {
            queriedServers.push(configuredServer);
            return {
              ok: true as const,
              snapshot: {
                count: 42,
                maxSlots: 100,
                queue: 2,
                serverName: "Live",
                map: "Procedural Map",
              },
            };
          },
        };
      },
    }),
  );

  const result = await service.refreshServer(server.guildId, server.id);

  assert.equal(result.ok, true);
  assert.deepEqual(queriedServers, [server]);
  assert.equal(snapshotUpdates.length, 1);
  const lastFetchedAtMs = result.ok ? result.server.lastFetchedAtMs : null;
  assert.deepEqual(snapshotUpdates, [
    {
      guildId: "guild-1",
      id: "server-1",
      expectedUpdatedAtMs: 0,
      lastPlayerCount: 42,
      lastMaxSlots: 100,
      lastQueueSize: 2,
      lastFetchedAtMs,
    },
  ]);
});

test("testServerReachability returns a safe failure when the status provider is unresolved", async () => {
  const server = createServer();
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(
      JSON.stringify({
        response: {
          servers: [
            {
              gameport: 27015,
              players: 42,
              max_players: 100,
              gametype: "",
              name: "Live",
              map: "Procedural Map",
            },
          ],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const service = new PlayerCountService(
      createStoreWithRead([server], { ...server }),
      defaultServiceOptions({
        steamWebApiKey: "steam-key",
        resolveStatusProvider: () => undefined,
      }),
    );

    assert.deepEqual(await service.testServerReachability(server.guildId, server.id), {
      ok: false,
      error: "Player count provider not configured: steam-web",
    });
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("refreshAllServers isolates an unresolved provider and refreshes other due servers", async () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  const unsupportedServer = createServer({
    id: "unsupported-server",
    provider: "toString" as PlayerCountServer["provider"],
    lastFetchedAtMs: now - 11 * 60 * 1000,
  });
  const supportedServer = createServer({
    id: "supported-server",
    lastFetchedAtMs: now - 11 * 60 * 1000,
  });
  const snapshotUpdates: Array<{
    id: string;
    lastPlayerCount: number | null;
    lastMaxSlots: number | null;
    lastQueueSize: number | null;
    lastFetchedAtMs: number | null;
  }> = [];
  const failureUpdates: Array<{
    id: string;
    consecutiveFailureCount: number;
    errorMessage: string;
    errorAtMs: number;
  }> = [];
  const originalDateNow = Date.now;
  Date.now = () => now;

  try {
    const service = new PlayerCountService(
      createStore([unsupportedServer, supportedServer], [], snapshotUpdates, failureUpdates),
      defaultServiceOptions({
        resolveStatusProvider: createPlayerCountStatusProviderResolver({
          "steam-web": {
            async query() {
              return {
                ok: true,
                snapshot: { count: 18, maxSlots: 60, queue: 1 },
              };
            },
          },
        }),
      }),
    );

    await service.refreshAllServers();
  } finally {
    Date.now = originalDateNow;
  }

  assert.deepEqual(snapshotUpdates, [
    {
      guildId: "guild-1",
      id: "supported-server",
      expectedUpdatedAtMs: 0,
      lastPlayerCount: 18,
      lastMaxSlots: 60,
      lastQueueSize: 1,
      lastFetchedAtMs: now,
    },
  ]);
  assert.equal(failureUpdates.length, 1);
  assert.equal(failureUpdates[0].id, "unsupported-server");
  assert.equal(failureUpdates[0].errorMessage, "Player count provider not configured: toString");
});

test("testServerReachability returns the error message on a failed fetch", async () => {
  const server = createServer({ id: "server-1", guildId: "guild-1", name: "Main PvP" });
  const failureUpdates: Array<unknown> = [];
  const snapshotUpdates: Array<unknown> = [];
  const auditCalls: Array<unknown> = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => new Response("boom", { status: 500 });

  try {
    const store = createStoreWithRead(
      [server],
      { ...server },
      {
        failureUpdates,
        snapshotUpdates,
      },
    );
    const service = new PlayerCountService(
      store,
      defaultServiceOptions({
        steamWebApiKey: "steam-key",
        streakReportedStore: new FakeStreakStore(),
        postPlayerCountAuditEvent: async (input) => {
          auditCalls.push(input);
        },
      }),
    );

    const result = await service.testServerReachability("guild-1", "server-1");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.error.length > 0);
    }
    assert.equal(snapshotUpdates.length, 0);
    assert.equal(failureUpdates.length, 0);
    assert.equal(auditCalls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("testServerReachability returns not-found for a server in another guild", async () => {
  const service = new PlayerCountService(
    createStoreWithRead([], null),
    defaultServiceOptions({ steamWebApiKey: "steam-key" }),
  );

  const result = await service.testServerReachability("guild-1", "missing");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, "Server not found");
  }
});

test("testServerReachability returns not-found for a cross-guild server id", async () => {
  const otherGuildServer = createServer({ id: "server-1", guildId: "guild-other" });
  const service = new PlayerCountService(
    createStoreWithRead([otherGuildServer], { ...otherGuildServer }),
    defaultServiceOptions({ steamWebApiKey: "steam-key" }),
  );

  const result = await service.testServerReachability("guild-1", "server-1");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, "Server not found");
  }
});

test("refreshAllServers resets the failure counter on a successful fetch", async () => {
  const baseTime = Date.UTC(2026, 0, 1, 12, 0, 0);
  const serverWithStreak = createServer({
    id: "server-1",
    name: "Recovered",
    refreshIntervalMinutes: 10,
    lastFetchedAtMs: baseTime - 11 * 60 * 1000,
    consecutiveFailureCount: 2,
    lastErrorMessage: "Server 1.2.3.4:27015 not found in Steam directory",
    lastErrorAtMs: baseTime - 5 * 60 * 1000,
  });

  const recoveryStore = createStore([serverWithStreak], []);
  const originalDateNow = Date.now;
  const originalFetch = globalThis.fetch;

  Date.now = () => baseTime;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        response: {
          servers: [
            {
              gameport: 27015,
              players: 25,
              max_players: 80,
              gametype: "",
              name: "Recovered",
              map: "Procedural Map",
            },
          ],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  try {
    const service = new PlayerCountService(
      recoveryStore,
      defaultServiceOptions({ steamWebApiKey: "steam-key" }),
    );

    await service.refreshAllServers();
  } finally {
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
  }

  const recovered = await recoveryStore.readPlayerCountServer("server-1");
  assert.equal(recovered?.consecutiveFailureCount, 0);
  assert.equal(recovered?.lastErrorMessage, null);
  assert.equal(recovered?.lastPlayerCount, 25);
});

test("refreshAllServers increments the failure counter when the status provider fails", async () => {
  const baseTime = Date.UTC(2026, 0, 1, 12, 0, 0);
  const dueServer = createServer({
    id: "due-server",
    name: "Due",
    refreshIntervalMinutes: 10,
    lastFetchedAtMs: baseTime - 11 * 60 * 1000,
    consecutiveFailureCount: 0,
  });

  const failureUpdates: Array<{
    id: string;
    consecutiveFailureCount: number;
    errorMessage: string;
    errorAtMs: number;
  }> = [];
  const originalDateNow = Date.now;

  Date.now = () => baseTime;

  try {
    const service = new PlayerCountService(
      createStore([dueServer], [], [], failureUpdates),
      defaultServiceOptions({
        resolveStatusProvider: () => ({
          async query() {
            return { ok: false, error: "Provider unavailable" };
          },
        }),
      }),
    );

    await service.refreshAllServers();
  } finally {
    Date.now = originalDateNow;
  }

  assert.equal(failureUpdates.length, 1);
  assert.equal(failureUpdates[0].id, "due-server");
  assert.equal(failureUpdates[0].consecutiveFailureCount, 1);
  assert.equal(failureUpdates[0].errorMessage, "Provider unavailable");
  assert.equal(failureUpdates[0].errorAtMs, baseTime);
});

test("buildChannelName substitutes {name} placeholder", () => {
  const server = createServer({ name: "Rusty Rust", displayFormat: "{name}: {count}/{max}" });
  const service = new PlayerCountService(
    createStore([], []),
    defaultServiceOptions({ discordBotToken: "" }),
  );

  assert.equal(service.buildChannelName(server), "Rusty Rust: 12/60");
});

test("buildChannelName shows conditional {queue?...} content when queue > 0", () => {
  const server = createServer({
    lastQueueSize: 4,
    displayFormat: "Players {count}/{max}{queue? Q:}",
  });
  const service = new PlayerCountService(
    createStore([], []),
    defaultServiceOptions({ discordBotToken: "" }),
  );

  assert.equal(service.buildChannelName(server), "Players 12/60 Q:4");
});

test("buildChannelName hides conditional {queue?...} content when queue is 0", () => {
  const server = createServer({
    displayFormat: "Players {count}/{max}{queue? Q:}",
  });
  const service = new PlayerCountService(
    createStore([], []),
    defaultServiceOptions({ discordBotToken: "" }),
  );

  assert.equal(service.buildChannelName(server), "Players 12/60");
});

test("buildChannelName supports {name} with conditional queue in alternate format", () => {
  const server = createServer({
    name: "Main PvP",
    lastQueueSize: 4,
    displayFormat: "{name}: {count}+{queue}/{max}",
  });
  const service = new PlayerCountService(
    createStore([], []),
    defaultServiceOptions({ discordBotToken: "" }),
  );

  assert.equal(service.buildChannelName(server), "Main PvP: 12+4/60");
});

test("formatServerStatus substitutes {name} placeholder", () => {
  const server = createServer({ name: "Rusty Rust" });
  const service = new PlayerCountService(
    createStore([], []),
    defaultServiceOptions({ discordBotToken: "" }),
  );

  assert.equal(service.formatServerStatus(server), "Rusty Rust: Players 12/60");
});

test("formatServerStatus shows conditional {queue?...} when queue is 0", () => {
  const server = createServer({
    lastQueueSize: 0,
    displayFormat: "Players {count}/{max}{queue? Q:}",
  });
  const service = new PlayerCountService(
    createStore([], []),
    defaultServiceOptions({ discordBotToken: "" }),
  );

  assert.equal(service.formatServerStatus(server), "Main PvP: Players 12/60");
});

test("formatServerStatus shows conditional {queue?...} when queue > 0", () => {
  const server = createServer({
    lastQueueSize: 4,
    displayFormat: "Players {count}/{max}{queue? Q:}",
  });
  const service = new PlayerCountService(
    createStore([], []),
    defaultServiceOptions({ discordBotToken: "" }),
  );

  assert.equal(service.formatServerStatus(server), "Main PvP: Players 12/60 Q:4");
});

test("buildPlayerCountStatusEmbed shows online and offline servers", () => {
  const online = createServer({
    id: "online",
    name: "Online Server",
    lastPlayerCount: 42,
    lastMaxSlots: 100,
    lastQueueSize: 5,
    lastFetchedAtMs: Date.now() - 2 * 60 * 1000,
  });
  const offline = createServer({
    id: "offline",
    name: "Offline Server",
    lastPlayerCount: null,
    consecutiveFailureCount: 4,
    lastFetchedAtMs: Date.now() - 10 * 60 * 1000,
  });

  const embed = buildPlayerCountStatusEmbed([online, offline]);

  assert.equal(embed.title, "🎮 Server Status");
  assert.equal(embed.fields?.length, 2);
  assert.ok(embed.fields?.[0].name.includes("Online Server"));
  assert.ok(embed.fields?.[0].value.includes("42/100"));
  assert.ok(embed.fields?.[0].value.includes("Queue: 5"));
  assert.ok(embed.fields?.[1].name.includes("Offline Server"));
  assert.ok(embed.fields?.[1].value.includes("Offline"));
  assert.ok(embed.fields?.[1].value.includes("4 failed checks"));
});

test("buildPlayerCountAlertEmbed includes server details and streak count", () => {
  const server = createServer({
    name: "Main PvP",
    steamHost: "123.45.67.89",
    steamPort: 27015,
  });

  const embed = buildPlayerCountAlertEmbed(server, 3, "Connection timed out");

  assert.equal(embed.title, "🚨 Player Count Alert");
  assert.ok(embed.description?.includes("Main PvP"));
  assert.ok(embed.description?.includes("3"));
  assert.ok(embed.fields?.some((f) => f.value === "123.45.67.89:27015"));
  assert.ok(embed.fields?.some((f) => f.value === "Connection timed out"));
});

test("applyPlayerCountTemplate handles {queue?prefix} when queue > 0", () => {
  const server = createServer({
    lastQueueSize: 4,
  });
  assert.equal(
    applyPlayerCountTemplate("Players {count}/{max}{queue? Q:}", server),
    "Players 12/60 Q:4",
  );
});

test("applyPlayerCountTemplate hides {queue?prefix} when queue is 0", () => {
  const server = createServer({});
  assert.equal(
    applyPlayerCountTemplate("Players {count}/{max}{queue? Q:}", server),
    "Players 12/60",
  );
});

test("applyPlayerCountTemplate handles {queue?} with no prefix", () => {
  const server = createServer({ lastQueueSize: 7 });
  assert.equal(applyPlayerCountTemplate("Players {count}/{max}{queue?}", server), "Players 12/607");
});

test("applyPlayerCountTemplate substitutes {name}, {count}, {max}", () => {
  const server = createServer({ name: "Rust Server" });
  assert.equal(applyPlayerCountTemplate("{name}: {count}/{max}", server), "Rust Server: 12/60");
});

test("applyPlayerCountTemplate substitutes {queue} directly", () => {
  const server = createServer({ lastQueueSize: 3 });
  assert.equal(applyPlayerCountTemplate("{count}/{max} ({queue})", server), "12/60 (3)");
});

test("applyPlayerCountTemplate handles reporter's format with {queue?Q: }", () => {
  const server = createServer({ lastQueueSize: 3 });
  assert.equal(
    applyPlayerCountTemplate("30/40 {queue?Q: } COLDASFK", server),
    "30/40 Q: 3 COLDASFK",
  );
});

test("applyPlayerCountTemplate hides {queue?Q: } when queue is 0 with reporter's format", () => {
  const server = createServer({ lastQueueSize: 0 });
  assert.equal(applyPlayerCountTemplate("30/40 {queue?Q: } COLDASFK", server), "30/40  COLDASFK");
});

test("PlayerCountService rejects foreign channel bindings before server persistence", async () => {
  const store = createStore([], []);
  let discordCalls = 0;
  const service = new PlayerCountService(
    store,
    defaultServiceOptions({
      guildResources: createStaticGuildResourceValidator({
        guilds: {
          "guild-1": { channels: [testChannel("own-voice", 2, "guild-1")], roles: [] },
          "guild-2": { channels: [testChannel("foreign-voice", 2, "guild-2")], roles: [] },
        },
      }),
      async modifyChannel() {
        discordCalls += 1;
      },
    }),
  );

  await assert.rejects(
    service.addServer({
      guildId: "guild-1",
      name: "Foreign binding",
      provider: "steam-web",
      providerServerId: "127.0.0.1:27015",
      channelId: "foreign-voice",
    }),
    GuildResourceValidationError,
  );
  assert.deepEqual(await store.listPlayerCountServers("guild-1"), []);
  assert.equal(discordCalls, 0);
});

test("PlayerCountService revalidates persisted channels before scheduled rename", async () => {
  const server = createServer({ channelId: "foreign-voice", lastRenamedAtMs: null });
  const renamedAtUpdates: Array<{ id: string; lastRenamedAtMs: number }> = [];
  let discordCalls = 0;
  const service = new PlayerCountService(
    createStore([server], renamedAtUpdates),
    defaultServiceOptions({
      guildResources: createStaticGuildResourceValidator({
        guilds: {
          "guild-1": { channels: [testChannel("own-voice", 2, "guild-1")], roles: [] },
          "guild-2": { channels: [testChannel("foreign-voice", 2, "guild-2")], roles: [] },
        },
      }),
      async modifyChannel() {
        discordCalls += 1;
      },
    }),
  );

  await service.renameDueChannels();
  assert.equal(discordCalls, 0);
  assert.deepEqual(renamedAtUpdates, []);
});

test("PlayerCountService rejects a persisted foreign alert destination before Discord", async () => {
  const baseTime = Date.UTC(2026, 0, 1, 12, 0, 0);
  const server = createServer({
    alertChannelId: "foreign-alert",
    lastFetchedAtMs: baseTime - 11 * 60 * 1000,
    consecutiveFailureCount: 2,
  });
  const fetchCalls: string[] = [];
  const originalDateNow = Date.now;
  const originalFetch = globalThis.fetch;
  Date.now = () => baseTime;
  globalThis.fetch = async (input) => {
    fetchCalls.push(String(input));
    return new Response("boom", { status: 500 });
  };

  try {
    const service = new PlayerCountService(
      createStore([server], []),
      defaultServiceOptions({
        steamWebApiKey: "steam-key",
        guildResources: createStaticGuildResourceValidator({
          guilds: {
            "guild-1": { channels: [], roles: [] },
            "guild-2": {
              channels: [testChannel("foreign-alert", 0, "guild-2")],
              roles: [],
            },
          },
        }),
      }),
    );

    await service.refreshAllServers();
    assert.equal(fetchCalls.length, 1);
    assert.ok(fetchCalls[0]?.includes("steampowered.com"));
  } finally {
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
  }
});

function createStore(
  servers: PlayerCountServer[],
  renamedAtUpdates: Array<{ id: string; lastRenamedAtMs: number }>,
  snapshotUpdates: Array<{
    id: string;
    lastPlayerCount: number | null;
    lastMaxSlots: number | null;
    lastQueueSize: number | null;
    lastFetchedAtMs: number | null;
  }> = [],
  failureUpdates: Array<{
    id: string;
    consecutiveFailureCount: number;
    errorMessage: string;
    errorAtMs: number;
  }> = [],
  resetFailureIds: string[] = [],
): PlayerCountStore {
  const fixture = createProductionRuntimeStores();
  const rawStore = fixture.stores.playerCount;
  const ready = Promise.all(servers.map((server) => rawStore.upsertPlayerCountServer(server)));
  const store = afterStoreSeed(rawStore, ready);
  return withStoreOverrides(store, {
    async updatePlayerCountSnapshot(body) {
      snapshotUpdates.push(body);
      return store.updatePlayerCountSnapshot(body);
    },
    async updateLastRenamedAt(body) {
      renamedAtUpdates.push(body);
      await store.updateLastRenamedAt(body);
    },
    async incrementPlayerCountFailure(body) {
      const result = await store.incrementPlayerCountFailure(body);
      if (result) {
        failureUpdates.push({ ...body, consecutiveFailureCount: result.consecutiveFailureCount });
      }
      return result;
    },
    async resetPlayerCountFailure(guildId, id) {
      resetFailureIds.push(id);
      return store.resetPlayerCountFailure(guildId, id);
    },
  });
}

function createServer(overrides: Partial<PlayerCountServer> = {}): PlayerCountServer {
  return {
    id: "server-1",
    guildId: "guild-1",
    name: "Main PvP",
    provider: "steam-web",
    providerServerId: "123.45.67.89:27015",
    channelId: "voice-1",
    alertChannelId: null,
    refreshIntervalMinutes: 10,
    displayFormat: "Players {count}/{max}",
    offlineFormat: "Players Offline",
    failureThreshold: 3,
    renameOffsetMinutes: 0,
    lastRenamedAtMs: null,
    lastPlayerCount: 12,
    lastMaxSlots: 60,
    lastQueueSize: 0,
    lastFetchedAtMs: null,
    consecutiveFailureCount: 0,
    lastErrorMessage: null,
    lastErrorAtMs: null,
    steamHost: "123.45.67.89",
    steamPort: 27015,
    createdAtMs: 0,
    updatedAtMs: 0,
    ...overrides,
  };
}

function createStoreWithRead(
  allServers: PlayerCountServer[],
  readResult: PlayerCountServer | null,
  capture?: {
    snapshotUpdates?: Array<unknown>;
    failureUpdates?: Array<unknown>;
  },
): PlayerCountStore {
  const fixture = createProductionRuntimeStores();
  const rawStore = fixture.stores.playerCount;
  const ready = Promise.all(allServers.map((server) => rawStore.upsertPlayerCountServer(server)));
  const store = afterStoreSeed(rawStore, ready);
  return withStoreOverrides(store, {
    async readPlayerCountServer(id) {
      await ready;
      return readResult?.id === id ? readResult : null;
    },
    async updatePlayerCountSnapshot(body) {
      capture?.snapshotUpdates?.push(body);
      return store.updatePlayerCountSnapshot(body);
    },
    async incrementPlayerCountFailure(body) {
      capture?.failureUpdates?.push(body);
      return store.incrementPlayerCountFailure(body);
    },
  });
}

test("disabled Player Count servers retain settings and snapshots without queries, renames, or alerts", async () => {
  const fixture = createProductionRuntimeStores();
  const server = createServer({ enabled: false });
  await fixture.stores.playerCount.upsertPlayerCountServer(server);
  fixture.database.execRaw(
    "INSERT INTO guild_entitlements (guild_id, plan, updated_at_ms) VALUES ('guild-1', 'premium', 1)",
  );
  let effects = 0;
  const service = new PlayerCountService(
    fixture.stores.playerCount,
    defaultServiceOptions({
      guildEntitlements: fixture.stores.guildEntitlements,
      resolveStatusProvider: () => ({
        async query() {
          effects++;
          return { ok: false, error: "offline" };
        },
      }),
      async modifyChannel() {
        effects++;
      },
      async postPlayerCountAuditEvent() {
        effects++;
      },
    }),
  );
  try {
    await service.refreshAllServers();
    await service.renameDueChannels();
    assert.equal(effects, 0);
    assert.deepEqual(await fixture.stores.playerCount.readPlayerCountServer(server.id), server);
  } finally {
    fixture.close();
  }
});

test("disabling Player Count fences an in-flight query and survives a stale configuration save", async () => {
  const fixture = createProductionRuntimeStores();
  const server = createServer();
  await fixture.stores.playerCount.upsertPlayerCountServer(server);
  fixture.database.execRaw(
    "INSERT INTO guild_entitlements (guild_id, plan, updated_at_ms) VALUES ('guild-1', 'premium', 1)",
  );
  let queries = 0;
  const service = new PlayerCountService(
    fixture.stores.playerCount,
    defaultServiceOptions({
      guildEntitlements: fixture.stores.guildEntitlements,
      resolveStatusProvider: () => ({
        async query() {
          queries++;
          if (queries === 1)
            await fixture.stores.playerCount.setPlayerCountServerEnabled(
              server.guildId,
              server.id,
              false,
            );
          return { ok: true, snapshot: { count: 7, maxSlots: 60, queue: 0 } };
        },
      }),
    }),
  );
  try {
    await service.refreshAllServers();
    const disabled = (await fixture.stores.playerCount.readPlayerCountServer(server.id))!;
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.lastFetchedAtMs, null);
    assert.equal(disabled.lastPlayerCount, 12);
    await fixture.stores.playerCount.upsertPlayerCountServer(server);
    assert.equal(
      (await fixture.stores.playerCount.readPlayerCountServer(server.id))?.enabled,
      false,
    );
    await fixture.stores.playerCount.setPlayerCountServerEnabled(server.guildId, server.id, true);
    await service.refreshAllServers();
    assert.equal(queries, 2);
    assert.equal(
      (await fixture.stores.playerCount.readPlayerCountServer(server.id))?.lastPlayerCount,
      7,
    );
  } finally {
    fixture.close();
  }
});
