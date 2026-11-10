/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import {
  extractSteamIdsFromBody,
  SteamBanLookupService,
  type SteamBanLookupCacheEntry,
} from "../src/services/steam-ban-lookup-service";

test("extractSteamIdsFromBody finds raw and profile URL SteamID64 values once", () => {
  assert.deepEqual(
    extractSteamIdsFromBody(
      JSON.stringify({
        raw: "76561198000000001",
        url: "https://steamcommunity.com/profiles/76561198000000001",
        invalid: "76561180000000001",
      }),
    ),
    ["76561198000000001"],
  );
});

test("SteamBanLookupService returns a retry without logging provider URLs or API keys", async () => {
  const logs: unknown[][] = [];
  const secret = "super-secret-steam-key";
  const notificationUrl = "https://example.com/webhook/super-secret-token";
  const service = new SteamBanLookupService({
    steamWebApiKey: secret,
    store: {
      async read() {
        return null;
      },
      async write() {},
    },
    fetch: async (input) => {
      throw new Error(`request failed for ${String(input)}`);
    },
    logger: { error: (...args) => logs.push(args) },
  });

  const result = await service.processBatch([
    {
      guildId: "guild-1",
      steamIds: ["76561198000000001"],
      notificationUrl,
      banLookupAppIds: [],
    },
  ]);

  assert.deepEqual(result, { status: "retry", reasonCode: "steam_api_network_error" });
  assert.doesNotMatch(JSON.stringify(logs), new RegExp(`${secret}|super-secret-token`));
});

test("SteamBanLookupService does not log a notification URL embedded in a fetch error", async () => {
  const logs: unknown[][] = [];
  const notificationUrl = "https://example.com/webhook/super-secret-token";
  const service = new SteamBanLookupService({
    steamWebApiKey: "steam-key",
    store: {
      async read() {
        return null;
      },
      async write() {},
    },
    fetch: async (input) => {
      if (String(input).includes("GetPlayerBans")) {
        return Response.json({
          players: [
            {
              SteamId: "76561198000000001",
              CommunityBanned: false,
              VACBanned: true,
              NumberOfVACBans: 1,
              DaysSinceLastBan: 1,
              NumberOfGameBans: 0,
              EconomyBan: "none",
              bans: [],
            },
          ],
        });
      }
      throw new Error(`request failed for ${String(input)}`);
    },
    logger: { error: (...args) => logs.push(args) },
  });

  const result = await service.processBatch([
    {
      guildId: "guild-1",
      steamIds: ["76561198000000001"],
      notificationUrl,
      banLookupAppIds: [],
    },
  ]);

  assert.deepEqual(result, { status: "retry", reasonCode: "notification_network_error" });
  assert.doesNotMatch(JSON.stringify(logs), /super-secret-token/);
});

test("SteamBanLookupService notifies staff about recent VAC bans", async () => {
  const writes: Array<{ key: string; entry: SteamBanLookupCacheEntry }> = [];
  const posts: Array<{ url: string; body: unknown }> = [];
  const service = new SteamBanLookupService({
    steamWebApiKey: "steam-key",
    nowMs: () => Date.parse("2026-06-05T00:00:00.000Z"),
    store: {
      async read() {
        return null;
      },
      async write(steamId64, entry) {
        writes.push({ key: steamId64, entry });
      },
    },
    fetch: (async (input, init) => {
      const url = String(input);
      if (url.includes("GetPlayerBans")) {
        return new Response(
          JSON.stringify({
            players: [
              {
                SteamId: "76561198000000001",
                CommunityBanned: false,
                VACBanned: true,
                NumberOfVACBans: 1,
                DaysSinceLastBan: 30,
                NumberOfGameBans: 0,
                EconomyBan: "none",
                bans: [],
              },
            ],
          }),
        );
      }

      posts.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });

  await service.processBatch([
    {
      guildId: "guild-1",
      steamIds: ["76561198000000001"],
      notificationUrl: "https://example.com/ban-reports",
      banLookupAppIds: [],
    },
  ]);

  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.key, "76561198000000001");
  assert.deepEqual(posts, [
    {
      url: "https://example.com/ban-reports",
      body: {
        type: "steam_ban_report",
        steamId64: "76561198000000001",
        communityBanned: false,
        vacBanned: true,
        numberOfVacBans: 1,
        daysSinceLastBan: 30,
        numberOfGameBans: 0,
        economyBan: "none",
        gameBans: [],
        detectedAtIso: "2026-06-05T00:00:00.000Z",
      },
    },
  ]);
});

test("SteamBanLookupService suppresses notifications when rechecked ban status is unchanged", async () => {
  const posts: unknown[] = [];
  const service = new SteamBanLookupService({
    steamWebApiKey: "steam-key",
    nowMs: () => Date.parse("2026-06-05T00:00:00.000Z"),
    store: {
      async read() {
        return {
          lastCheckedAtMs: Date.parse("2026-06-03T00:00:00.000Z"),
          communityBanned: false,
          vacBanned: true,
          numberOfVacBans: 1,
          daysSinceLastBan: 30,
          numberOfGameBans: 0,
          economyBan: "none",
          gameBans: [],
        };
      },
      async write() {},
    },
    fetch: (async (input, init) => {
      if (String(input).includes("GetPlayerBans")) {
        return new Response(
          JSON.stringify({
            players: [
              {
                SteamId: "76561198000000001",
                CommunityBanned: false,
                VACBanned: true,
                NumberOfVACBans: 1,
                DaysSinceLastBan: 30,
                NumberOfGameBans: 0,
                EconomyBan: "none",
                bans: [],
              },
            ],
          }),
        );
      }

      posts.push(init?.body);
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });

  await service.processBatch([
    {
      guildId: "guild-1",
      steamIds: ["76561198000000001"],
      notificationUrl: "https://example.com/ban-reports",
      banLookupAppIds: [],
    },
  ]);

  assert.deepEqual(posts, []);
});

test("SteamBanLookupService batches lookup messages that share notification settings", async () => {
  const steamApiCalls: string[] = [];
  const service = new SteamBanLookupService({
    steamWebApiKey: "steam-key",
    store: {
      async read() {
        return null;
      },
      async write() {},
    },
    fetch: (async (input) => {
      const url = String(input);
      steamApiCalls.push(url);
      return new Response(
        JSON.stringify({
          players: [
            {
              SteamId: "76561198000000001",
              CommunityBanned: false,
              VACBanned: false,
              NumberOfVACBans: 0,
              DaysSinceLastBan: 0,
              NumberOfGameBans: 0,
              EconomyBan: "none",
              bans: [],
            },
            {
              SteamId: "76561198000000002",
              CommunityBanned: false,
              VACBanned: false,
              NumberOfVACBans: 0,
              DaysSinceLastBan: 0,
              NumberOfGameBans: 0,
              EconomyBan: "none",
              bans: [],
            },
          ],
        }),
      );
    }) as typeof fetch,
  });

  await service.processBatch([
    {
      guildId: "guild-1",
      steamIds: ["76561198000000001"],
      notificationUrl: "https://example.com/ban-reports",
      banLookupAppIds: [221100],
    },
    {
      guildId: "guild-1",
      steamIds: ["76561198000000002"],
      notificationUrl: "https://example.com/ban-reports",
      banLookupAppIds: [221100],
    },
  ]);

  assert.equal(steamApiCalls.length, 1);
  assert.match(steamApiCalls[0] ?? "", /steamids=76561198000000001%2C76561198000000002/);
});

test("SteamBanLookupService returns a retry when notification delivery fails", async () => {
  const errors: unknown[] = [];
  const service = new SteamBanLookupService({
    steamWebApiKey: "steam-key",
    store: {
      async read() {
        return null;
      },
      async write() {},
    },
    fetch: (async (input) => {
      const url = String(input);
      if (url.includes("GetPlayerBans")) {
        return new Response(
          JSON.stringify({
            players: [
              {
                SteamId: "76561198000000001",
                CommunityBanned: false,
                VACBanned: true,
                NumberOfVACBans: 1,
                DaysSinceLastBan: 30,
                NumberOfGameBans: 0,
                EconomyBan: "none",
                bans: [],
              },
            ],
          }),
        );
      }

      return new Response("upstream down", { status: 502 });
    }) as typeof fetch,
    logger: { error: (...args: unknown[]) => errors.push(args) },
  });

  const result = await service.processBatch([
    {
      guildId: "guild-1",
      steamIds: ["76561198000000001"],
      notificationUrl: "https://example.com/ban-reports",
      banLookupAppIds: [],
    },
  ]);

  assert.deepEqual(result, { status: "retry", reasonCode: "notification_unavailable" });
  assert.ok(errors.length >= 1);
  assert.doesNotMatch(JSON.stringify(errors), /example\.com\/ban-reports/);
});

test("SteamBanLookupService notifies on game bans matching the App ID filter", async () => {
  const posts: Array<{ url: string; body: unknown }> = [];
  const service = new SteamBanLookupService({
    steamWebApiKey: "steam-key",
    store: {
      async read() {
        return null;
      },
      async write() {},
    },
    fetch: (async (input, init) => {
      const url = String(input);
      if (url.includes("GetPlayerBans")) {
        return new Response(
          JSON.stringify({
            players: [
              {
                SteamId: "76561198000000001",
                CommunityBanned: false,
                VACBanned: false,
                NumberOfVACBans: 0,
                DaysSinceLastBan: 0,
                NumberOfGameBans: 1,
                EconomyBan: "none",
                bans: [{ AppIdMin: 221100, BanStartTime: 1700000000, BanType: 0 }],
              },
            ],
          }),
        );
      }

      posts.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });

  await service.processBatch([
    {
      guildId: "guild-1",
      steamIds: ["76561198000000001"],
      notificationUrl: "https://example.com/ban-reports",
      banLookupAppIds: [221100],
    },
  ]);

  assert.equal(posts.length, 1);
  assert.equal((posts[0]?.body as { numberOfGameBans: number } | undefined)?.numberOfGameBans, 1);
  assert.deepEqual((posts[0]?.body as { gameBans: unknown[] } | undefined)?.gameBans, [
    { appId: 221100, banStartTimeUnix: 1700000000, banType: 0 },
  ]);
});

test("SteamBanLookupService suppresses notifications for game bans outside the App ID filter", async () => {
  const posts: Array<{ url: string; body: unknown }> = [];
  const service = new SteamBanLookupService({
    steamWebApiKey: "steam-key",
    store: {
      async read() {
        return null;
      },
      async write() {},
    },
    fetch: (async (input, init) => {
      const url = String(input);
      if (url.includes("GetPlayerBans")) {
        return new Response(
          JSON.stringify({
            players: [
              {
                SteamId: "76561198000000001",
                CommunityBanned: false,
                VACBanned: false,
                NumberOfVACBans: 0,
                DaysSinceLastBan: 0,
                NumberOfGameBans: 1,
                EconomyBan: "none",
                bans: [{ AppIdMin: 999999, BanStartTime: 1700000000, BanType: 0 }],
              },
            ],
          }),
        );
      }

      posts.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });

  await service.processBatch([
    {
      guildId: "guild-1",
      steamIds: ["76561198000000001"],
      notificationUrl: "https://example.com/ban-reports",
      banLookupAppIds: [221100],
    },
  ]);

  assert.deepEqual(posts, []);
});

test("SteamBanLookupService notifies on game bans when App ID filter is empty", async () => {
  const posts: Array<{ url: string; body: unknown }> = [];
  const service = new SteamBanLookupService({
    steamWebApiKey: "steam-key",
    store: {
      async read() {
        return null;
      },
      async write() {},
    },
    fetch: (async (input, init) => {
      const url = String(input);
      if (url.includes("GetPlayerBans")) {
        return new Response(
          JSON.stringify({
            players: [
              {
                SteamId: "76561198000000001",
                CommunityBanned: false,
                VACBanned: false,
                NumberOfVACBans: 0,
                DaysSinceLastBan: 0,
                NumberOfGameBans: 1,
                EconomyBan: "none",
                bans: [{ AppIdMin: 999999, BanStartTime: 1700000000, BanType: 0 }],
              },
            ],
          }),
        );
      }

      posts.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });

  await service.processBatch([
    {
      guildId: "guild-1",
      steamIds: ["76561198000000001"],
      notificationUrl: "https://example.com/ban-reports",
      banLookupAppIds: [],
    },
  ]);

  assert.equal(posts.length, 1);
});

test("SteamBanLookupService suppresses VAC ban notifications older than 365 days", async () => {
  const posts: Array<{ url: string; body: unknown }> = [];
  const service = new SteamBanLookupService({
    steamWebApiKey: "steam-key",
    store: {
      async read() {
        return null;
      },
      async write() {},
    },
    fetch: (async (input, init) => {
      const url = String(input);
      if (url.includes("GetPlayerBans")) {
        return new Response(
          JSON.stringify({
            players: [
              {
                SteamId: "76561198000000001",
                CommunityBanned: false,
                VACBanned: true,
                NumberOfVACBans: 1,
                DaysSinceLastBan: 400,
                NumberOfGameBans: 0,
                EconomyBan: "none",
                bans: [],
              },
            ],
          }),
        );
      }

      posts.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });

  await service.processBatch([
    {
      guildId: "guild-1",
      steamIds: ["76561198000000001"],
      notificationUrl: "https://example.com/ban-reports",
      banLookupAppIds: [],
    },
  ]);

  assert.deepEqual(posts, []);
});

test("SteamBanLookupService notifies again after 24h recheck detects a new ban", async () => {
  const posts: Array<{ url: string; body: unknown }> = [];
  let now = Date.parse("2026-06-01T00:00:00.000Z");
  const cached: Record<string, SteamBanLookupCacheEntry> = {
    "76561198000000001": {
      lastCheckedAtMs: Date.parse("2026-05-30T00:00:00.000Z"),
      communityBanned: false,
      vacBanned: false,
      numberOfVacBans: 0,
      daysSinceLastBan: 0,
      numberOfGameBans: 0,
      economyBan: "none",
      gameBans: [],
    },
  };

  const service = new SteamBanLookupService({
    steamWebApiKey: "steam-key",
    nowMs: () => now,
    store: {
      async read(steamId64) {
        return cached[steamId64] ?? null;
      },
      async write() {},
    },
    fetch: (async (input, init) => {
      const url = String(input);
      if (url.includes("GetPlayerBans")) {
        return new Response(
          JSON.stringify({
            players: [
              {
                SteamId: "76561198000000001",
                CommunityBanned: false,
                VACBanned: true,
                NumberOfVACBans: 1,
                DaysSinceLastBan: 5,
                NumberOfGameBans: 0,
                EconomyBan: "none",
                bans: [],
              },
            ],
          }),
        );
      }

      posts.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });

  await service.processBatch([
    {
      guildId: "guild-1",
      steamIds: ["76561198000000001"],
      notificationUrl: "https://example.com/ban-reports",
      banLookupAppIds: [],
    },
  ]);

  assert.equal(posts.length, 1);
  assert.equal((posts[0]?.body as { vacBanned: boolean } | undefined)?.vacBanned, true);
});
