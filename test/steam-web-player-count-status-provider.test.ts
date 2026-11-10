/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createSteamWebPlayerCountStatusProvider } from "../src/services/steam-web-player-count-status-provider";
import type { PlayerCountServer } from "../src/types/player-count";

test("Steam Web Player Count status provider maps the normalized server snapshot", async () => {
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
              gametype: "rust,lqs2",
              name: "Live",
              map: "Procedural Map",
            },
          ],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  try {
    const provider = createSteamWebPlayerCountStatusProvider({ apiKey: "steam-key" });

    assert.deepEqual(await provider.query(createServer()), {
      ok: true,
      snapshot: {
        count: 42,
        maxSlots: 100,
        queue: 2,
        serverName: "Live",
        map: "Procedural Map",
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Steam lookup discovers the exact server's App ID after an empty address-only query", async () => {
  const originalFetch = globalThis.fetch;
  const requests: URL[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    const responses = [
      { response: {} },
      {
        response: {
          servers: [
            { addr: "20.5.103.82:2403", appid: 730 },
            { addr: "20.5.103.82:2303", appid: 221100 },
          ],
        },
      },
      {
        response: {
          servers: [
            {
              addr: "20.5.103.82:2303",
              gameport: 2302,
              players: 7,
              max_players: 12,
              gametype: "dayz,lqs2",
              name: "Deathmatch",
              map: "namalsk",
            },
          ],
        },
      },
    ];
    assert.ok(requests.length <= responses.length, "Lookup must not retry indefinitely");
    return Response.json(responses[requests.length - 1]);
  };
  try {
    const provider = createSteamWebPlayerCountStatusProvider({ apiKey: "steam-key" });
    assert.deepEqual(
      await provider.query(createServer({ steamHost: "20.5.103.82", steamPort: 2303 })),
      {
        ok: true,
        snapshot: { count: 7, maxSlots: 12, queue: 2, serverName: "Deathmatch", map: "namalsk" },
      },
    );
    assert.equal(requests.length, 3);
    assert.equal(requests[0]!.searchParams.get("filter"), "\\addr\\20.5.103.82:2303");
    assert.equal(requests[1]!.pathname, "/ISteamApps/GetServersAtAddress/v1/");
    assert.equal(requests[1]!.searchParams.get("addr"), "20.5.103.82:2303");
    assert.equal(requests[1]!.searchParams.has("key"), false);
    assert.equal(requests[2]!.searchParams.get("key"), "steam-key");
    assert.equal(
      requests[2]!.searchParams.get("filter"),
      "\\addr\\20.5.103.82:2303\\appid\\221100",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Steam App ID fallback resolves a hostname before exact address discovery", async () => {
  const originalFetch = globalThis.fetch;
  const requests: URL[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    if (requests.length === 1) return Response.json({ response: {} });
    if (requests.length === 2) {
      assert.equal(url.hostname, "cloudflare-dns.com");
      assert.equal(url.searchParams.get("name"), "dayz.example.com");
      assert.equal(url.searchParams.get("type"), "A");
      assert.equal(url.searchParams.has("key"), false);
      return Response.json({
        Status: 0,
        Answer: [
          { type: 5, data: "server.example.com" },
          { type: 1, data: "20.5.103.82" },
        ],
      });
    }
    if (requests.length === 3) {
      assert.equal(url.searchParams.get("addr"), "20.5.103.82:2303");
      return Response.json({
        response: { servers: [{ addr: "20.5.103.82:2303", appid: 221100 }] },
      });
    }
    assert.equal(requests.length, 4);
    assert.equal(url.searchParams.get("filter"), "\\addr\\20.5.103.82:2303\\appid\\221100");
    return Response.json({
      response: {
        servers: [
          { gameport: 2302, players: 7, max_players: 12, name: "Deathmatch", map: "namalsk" },
        ],
      },
    });
  };
  try {
    const provider = createSteamWebPlayerCountStatusProvider({ apiKey: "steam-key" });
    assert.deepEqual(
      await provider.query(createServer({ steamHost: "dayz.example.com", steamPort: 2303 })),
      {
        ok: true,
        snapshot: { count: 7, maxSlots: 12, queue: 0, serverName: "Deathmatch", map: "namalsk" },
      },
    );
    assert.equal(requests.length, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Steam hostname discovery reports DNS failures without querying unrelated servers", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const scenario of ["http-failure", "not-found", "invalid-answer"]) {
      let requests = 0;
      globalThis.fetch = async () => {
        requests += 1;
        assert.ok(requests <= 2);
        if (requests === 1) return Response.json({ response: {} });
        if (scenario === "http-failure") return new Response("unavailable", { status: 503 });
        return Response.json({
          Status: scenario === "not-found" ? 3 : 0,
          Answer: [{ type: 1, data: "999.5.103.82" }],
        });
      };
      const provider = createSteamWebPlayerCountStatusProvider({ apiKey: "steam-key" });
      assert.deepEqual(await provider.query(createServer({ steamHost: "dayz.example.com" })), {
        ok: false,
        error:
          scenario === "http-failure"
            ? "Steam hostname lookup error 503"
            : "Could not resolve Steam server hostname dayz.example.com",
      });
      assert.equal(requests, 2);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Steam App ID fallback rejects unrelated addresses and invalid App IDs", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const entry of [
      { addr: "123.45.67.89:27016", appid: 221100 },
      { addr: "123.45.67.89:27015", appid: 0 },
      { addr: "123.45.67.89:27015", appid: 221100.5 },
    ]) {
      let requests = 0;
      globalThis.fetch = async () => {
        requests += 1;
        assert.ok(requests <= 2, "Invalid discovery must not issue a scoped query");
        return Response.json({ response: { servers: requests === 1 ? [] : [entry] } });
      };
      const provider = createSteamWebPlayerCountStatusProvider({ apiKey: "steam-key" });
      assert.deepEqual(await provider.query(createServer()), {
        ok: false,
        error: "Server 123.45.67.89:27015 not found in Steam directory",
      });
      assert.equal(requests, 2);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Steam App ID fallback preserves HTTP failures and an empty scoped query", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const scenario of ["discovery-failure", "scoped-failure", "scoped-empty"]) {
      let requests = 0;
      globalThis.fetch = async () => {
        requests += 1;
        assert.ok(requests <= 3);
        if (requests === 1) return Response.json({ response: {} });
        if (requests === 2) {
          if (scenario === "discovery-failure") return new Response("unavailable", { status: 503 });
          return Response.json({
            response: { servers: [{ addr: "123.45.67.89:27015", appid: 221100 }] },
          });
        }
        return scenario === "scoped-failure"
          ? new Response("forbidden", { status: 403 })
          : Response.json({ response: {} });
      };
      const provider = createSteamWebPlayerCountStatusProvider({ apiKey: "steam-key" });
      assert.deepEqual(await provider.query(createServer()), {
        ok: false,
        error:
          scenario === "discovery-failure"
            ? "Steam address lookup error 503"
            : scenario === "scoped-failure"
              ? "Steam Web API error 403"
              : "Server 123.45.67.89:27015 not found in Steam directory",
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Steam lookup redacts its API key from request errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`Request failed: ${String(input)}`);
  };
  try {
    const provider = createSteamWebPlayerCountStatusProvider({ apiKey: "steam-key" });
    const result = await provider.query(createServer());
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(!result.error.includes("steam-key"));
      assert.ok(result.error.includes("[redacted]"));
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Steam Web Player Count status provider reports a missing API key without querying Steam", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Steam Web API should not be called");
  };

  try {
    const provider = createSteamWebPlayerCountStatusProvider({});

    assert.deepEqual(await provider.query(createServer()), {
      ok: false,
      error: "Player count provider not configured",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Steam Web Player Count status provider reports a missing host without querying Steam", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Steam Web API should not be called");
  };

  try {
    const provider = createSteamWebPlayerCountStatusProvider({ apiKey: "steam-key" });

    assert.deepEqual(await provider.query(createServer({ steamHost: null })), {
      ok: false,
      error: "Player count provider not configured",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Steam Web Player Count status provider preserves explicit Steam failures", async () => {
  const originalFetch = globalThis.fetch;
  const provider = createSteamWebPlayerCountStatusProvider({ apiKey: "steam-key" });

  try {
    globalThis.fetch = async () => new Response("forbidden", { status: 403 });
    assert.deepEqual(await provider.query(createServer()), {
      ok: false,
      error: "Steam Web API error 403",
    });

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ response: { servers: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    assert.deepEqual(await provider.query(createServer()), {
      ok: false,
      error: "Server 123.45.67.89:27015 not found in Steam directory",
    });

    globalThis.fetch = async () => {
      throw new Error("Steam network unavailable");
    };
    assert.deepEqual(await provider.query(createServer()), {
      ok: false,
      error: "Steam network unavailable",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function createServer(overrides: Partial<PlayerCountServer> = {}): PlayerCountServer {
  return {
    id: "server-1",
    guildId: "guild-1",
    name: "Main PvP",
    provider: "steam-web",
    providerServerId: "123.45.67.89:27015",
    channelId: null,
    alertChannelId: null,
    refreshIntervalMinutes: 10,
    displayFormat: "Players {count}/{max}",
    offlineFormat: "Players Offline",
    failureThreshold: 3,
    renameOffsetMinutes: 0,
    lastRenamedAtMs: null,
    lastPlayerCount: null,
    lastMaxSlots: null,
    lastQueueSize: null,
    lastFetchedAtMs: null,
    steamHost: "123.45.67.89",
    steamPort: 27015,
    consecutiveFailureCount: 0,
    lastErrorMessage: null,
    lastErrorAtMs: null,
    createdAtMs: 0,
    updatedAtMs: 0,
    ...overrides,
  };
}
