/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";
import { JSDOM } from "jsdom";

import { createPlatformLinkRoutes } from "../src/routes/platform-link-routes";
import { createSteamPlatformConfig } from "../src/services/steam-platform-config";
import { createXboxPlatformConfig } from "../src/services/xbox-platform-config";
import {
  createPlatformLinkService,
  type PlatformLinkService,
  type PlatformLinkServiceOptions,
} from "../src/services/platform-link-service";
import type { PlatformAuthConfig } from "../src/services/platform-auth-config";
import type {
  PendingPlatformLink,
  PlatformLink,
  PlatformLinkConfig,
} from "../src/runtime/contracts/platform-link-store";
import { afterStoreSeed, createProductionRuntimeStores } from "./support/production-runtime-stores";

test("PlatformLinkRoutes serves only the canonical Steam start URL", async () => {
  const pendingLinks: PendingPlatformLink[] = [
    {
      state: "state-1",
      guildId: "guild-1",
      userId: "user-1",
      platform: "steam",
      createdAtMs: Date.now(),
    },
  ];
  const service = createMockPlatformLinkService({ pendingLinks });
  const config = createSteamPlatformConfig();
  const routes = createPlatformLinkRoutes({ platformLinkService: service, platformConfig: config });

  const response = await routes(
    new Request("https://runtime.example/auth/steam/start?state=state-1"),
  );
  assert.equal(response?.status, 302);
  const location = response?.headers.get("location") ?? "";
  assert.ok(
    location.includes("steamcommunity.com/openid/login"),
    `Expected Steam auth URL, got: ${location}`,
  );
  assert.equal(await routes(new Request("https://runtime.example/auth/steam?state=state-1")), null);
});

test("PlatformLinkRoutes redirects to Xbox auth URL on /auth/xbox/start", async () => {
  const pendingLinks: PendingPlatformLink[] = [
    {
      state: "state-1",
      guildId: "guild-1",
      userId: "user-1",
      platform: "xbox",
      createdAtMs: Date.now(),
    },
  ];
  const service = createMockPlatformLinkService({ pendingLinks });
  const config = createXboxPlatformConfig({
    clientId: "test-client-id",
    clientSecret: "test-secret",
  });
  const routes = createPlatformLinkRoutes({ platformLinkService: service, platformConfig: config });

  const response = await routes(
    new Request("https://runtime.example/auth/xbox/start?state=state-1"),
  );

  assert.equal(response?.status, 302);
  const location = response?.headers.get("location") ?? "";
  assert.ok(
    location.includes("login.microsoftonline.com"),
    `Expected Microsoft auth URL, got: ${location}`,
  );
  assert.ok(
    location.includes("client_id=test-client-id"),
    `Expected client_id in URL, got: ${location}`,
  );
});

test("PlatformLinkRoutes handles Steam callback and saves link", async () => {
  const pendingLinks: PendingPlatformLink[] = [
    {
      state: "state-1",
      guildId: "guild-1",
      userId: "user-1",
      platform: "steam",
      createdAtMs: Date.now(),
    },
  ];
  const links: PlatformLink[] = [];
  const configs: PlatformLinkConfig[] = [createConfig({ guildId: "guild-1", platform: "steam" })];
  const service = createMockPlatformLinkService({ pendingLinks, links, configs });
  const config = createSteamPlatformConfig();
  const routes = createPlatformLinkRoutes({ platformLinkService: service, platformConfig: config });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("is_valid:true", { status: 200 });

  try {
    const response = await routes(
      new Request(
        `https://runtime.example/auth/steam/callback?state=state-1&openid.mode=id_res&openid.claimed_id=https://steamcommunity.com/openid/id/76561198000000001`,
      ),
    );

    assert.equal(response?.status, 200);
    const html = await response?.text();
    assert.ok(html?.includes("76561198000000001"), `Expected SteamID64 in response, got: ${html}`);
    const savedLinks = await service.listLinks("guild-1");
    assert.equal(savedLinks.length, 1);
    assert.equal(savedLinks[0]?.platform, "steam");
    assert.equal(savedLinks[0]?.platformId, "76561198000000001");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("PlatformLinkRoutes reactivates a retained inactive link", async () => {
  const pendingLinks: PendingPlatformLink[] = [
    {
      state: "state-relink",
      guildId: "guild-1",
      userId: "user-1",
      platform: "steam",
      createdAtMs: Date.now(),
    },
  ];
  const links: PlatformLink[] = [
    {
      guildId: "guild-1",
      userId: "user-1",
      platform: "steam",
      platformId: "76561198000000001",
      linkedAtMs: 1,
      manual: false,
      actionedByUserId: null,
      metadataJson: null,
      active: false,
    },
  ];
  const service = createMockPlatformLinkService({
    pendingLinks,
    links,
    configs: [createConfig({ requireRelinkOnRejoin: true, allowRelink: false })],
  });
  const routes = createPlatformLinkRoutes({
    platformLinkService: service,
    platformConfig: createSteamPlatformConfig(),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) =>
    String(input).includes("steamcommunity.com")
      ? new Response("is_valid:true", { status: 200 })
      : new Response(null, { status: 204 });

  try {
    const response = await routes(
      new Request(
        "https://runtime.example/auth/steam/callback?state=state-relink&openid.mode=id_res&openid.claimed_id=https://steamcommunity.com/openid/id/76561198000000001",
      ),
    );

    assert.equal(response?.status, 200);
    const retained = await service.listLinks("guild-1", "steam");
    assert.equal(retained.length, 1);
    assert.equal(retained[0]?.active, true);
    assert.ok((retained[0]?.linkedAtMs ?? 0) > 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("PlatformLinkRoutes handles Xbox callback and saves link", async () => {
  const pendingLinks: PendingPlatformLink[] = [
    {
      state: "state-1",
      guildId: "guild-1",
      userId: "user-1",
      platform: "xbox",
      createdAtMs: Date.now(),
    },
  ];
  const links: PlatformLink[] = [];
  const configs: PlatformLinkConfig[] = [createConfig({ guildId: "guild-1", platform: "xbox" })];
  const service = createMockPlatformLinkService({ pendingLinks, links, configs });
  const config = createXboxPlatformConfig({
    clientId: "test-client-id",
    clientSecret: "test-secret",
  });
  const routes = createPlatformLinkRoutes({ platformLinkService: service, platformConfig: config });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: RequestInfo | URL) => {
    const urlStr = url.toString();
    if (urlStr.includes("/consumers/oauth2/v2.0/token")) {
      return new Response(JSON.stringify({ access_token: "ms-access-token" }));
    }
    if (urlStr.includes("user.auth.xboxlive.com")) {
      return new Response(
        JSON.stringify({
          Token: "xbl-user-token",
          DisplayClaims: { xui: [{ uhs: "user-hash" }] },
        }),
      );
    }
    if (urlStr.includes("xsts.auth.xboxlive.com")) {
      return new Response(
        JSON.stringify({
          Token: "xsts-token",
          DisplayClaims: { xui: [{ uhs: "user-hash" }] },
        }),
      );
    }
    if (urlStr.includes("profile.xboxlive.com")) {
      return new Response(
        JSON.stringify({
          profileUsers: [
            {
              settings: [{ id: "Gamertag", value: "TestGamer" }],
            },
          ],
        }),
      );
    }
    return new Response("{}", { status: 200 });
  };

  try {
    const response = await routes(
      new Request("https://runtime.example/auth/xbox/callback?state=state-1&code=test-auth-code"),
    );

    assert.equal(response?.status, 200);
    const html = await response?.text();
    assert.ok(html?.includes("TestGamer"), `Expected gamertag in response, got: ${html}`);
    const savedLinks = await service.listLinks("guild-1");
    assert.equal(savedLinks.length, 1);
    assert.equal(savedLinks[0]?.platform, "xbox");
    assert.equal(savedLinks[0]?.platformId, "TestGamer");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Xbox callback sends the correct RelyingParty for User Auth and XSTS", async () => {
  const pendingLinks: PendingPlatformLink[] = [
    {
      state: "state-1",
      guildId: "guild-1",
      userId: "user-1",
      platform: "xbox",
      createdAtMs: Date.now(),
    },
  ];
  const links: PlatformLink[] = [];
  const configs: PlatformLinkConfig[] = [createConfig({ guildId: "guild-1", platform: "xbox" })];
  const service = createMockPlatformLinkService({ pendingLinks, links, configs });
  const config = createXboxPlatformConfig({
    clientId: "test-client-id",
    clientSecret: "test-secret",
  });
  const routes = createPlatformLinkRoutes({ platformLinkService: service, platformConfig: config });

  const capturedRequests: Array<{ url: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = url.toString();
    const bodyText = typeof init?.body === "string" ? init.body : "";
    let parsed: unknown = bodyText;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      // not JSON, keep as text
    }
    capturedRequests.push({ url: urlStr, body: parsed });

    if (urlStr.includes("/consumers/oauth2/v2.0/token")) {
      return new Response(JSON.stringify({ access_token: "ms-access-token" }));
    }
    if (urlStr.includes("user.auth.xboxlive.com")) {
      return new Response(
        JSON.stringify({
          Token: "xbl-user-token",
          DisplayClaims: { xui: [{ uhs: "user-hash" }] },
        }),
      );
    }
    if (urlStr.includes("xsts.auth.xboxlive.com")) {
      return new Response(
        JSON.stringify({
          Token: "xsts-token",
          DisplayClaims: { xui: [{ uhs: "user-hash" }] },
        }),
      );
    }
    if (urlStr.includes("profile.xboxlive.com")) {
      return new Response(
        JSON.stringify({
          profileUsers: [{ settings: [{ id: "Gamertag", value: "TestGamer" }] }],
        }),
      );
    }
    return new Response("{}", { status: 200 });
  };

  try {
    const response = await routes(
      new Request("https://runtime.example/auth/xbox/callback?state=state-1&code=test-auth-code"),
    );

    assert.equal(response?.status, 200);

    const userAuthCall = capturedRequests.find((r) => r.url.includes("user.auth.xboxlive.com"));
    assert.ok(userAuthCall, "Expected a request to user.auth.xboxlive.com");
    const userAuthBody = userAuthCall?.body as { RelyingParty?: string };
    assert.equal(
      userAuthBody.RelyingParty,
      "http://auth.xboxlive.com",
      `User Auth must use http://auth.xboxlive.com, got: ${userAuthBody.RelyingParty}`,
    );

    const xstsCall = capturedRequests.find((r) => r.url.includes("xsts.auth.xboxlive.com"));
    assert.ok(xstsCall, "Expected a request to xsts.auth.xboxlive.com");
    const xstsBody = xstsCall?.body as { RelyingParty?: string };
    assert.equal(
      xstsBody.RelyingParty,
      "http://xboxlive.com",
      `XSTS must use http://xboxlive.com, got: ${xstsBody.RelyingParty}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Xbox callback exchanges scopes only for xboxlive.signin and xboxlive.offline_access", async () => {
  const pendingLinks: PendingPlatformLink[] = [
    {
      state: "state-1",
      guildId: "guild-1",
      userId: "user-1",
      platform: "xbox",
      createdAtMs: Date.now(),
    },
  ];
  const service = createMockPlatformLinkService({ pendingLinks, links: [], configs: [] });
  const config = createXboxPlatformConfig({
    clientId: "test-client-id",
    clientSecret: "test-secret",
  });
  const routes = createPlatformLinkRoutes({ platformLinkService: service, platformConfig: config });

  const response = await routes(
    new Request("https://runtime.example/auth/xbox/start?state=state-1"),
  );

  const location = response?.headers.get("location") ?? "";
  const queryStart = location.indexOf("?");
  assert.ok(queryStart >= 0, `Expected query string in auth URL, got: ${location}`);
  const params = new URLSearchParams(location.slice(queryStart + 1));
  const scope = params.get("scope") ?? "";
  assert.equal(
    scope,
    "xboxlive.signin xboxlive.offline_access",
    `Xbox auth URL must request only xboxlive scopes, got: ${scope}`,
  );
  assert.doesNotMatch(scope, /openid/);
  assert.doesNotMatch(scope, /profile/);
  assert.doesNotMatch(scope, /email/);
});

test("Xbox callback validates state before exchanging the authorization code", async () => {
  const pendingLinks: PendingPlatformLink[] = [
    {
      state: "expected-state",
      guildId: "guild-1",
      userId: "user-1",
      platform: "xbox",
      createdAtMs: Date.now(),
    },
  ];
  const service = createMockPlatformLinkService({ pendingLinks });
  const config = createXboxPlatformConfig({
    clientId: "test-client-id",
    clientSecret: "test-secret",
  });
  const routes = createPlatformLinkRoutes({ platformLinkService: service, platformConfig: config });

  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response(JSON.stringify({ access_token: "ms-access-token" }));
  };

  try {
    const response = await routes(
      new Request("https://runtime.example/auth/xbox/callback?state=tampered-state&code=test-code"),
    );

    assert.equal(response?.status, 400, "Expected 400 for tampered state");
    assert.equal(fetchCalled, false, "fetch must not be called when state is invalid");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Xbox callback logs status, body, and correlation id when XSTS fails", async () => {
  const pendingLinks: PendingPlatformLink[] = [
    {
      state: "state-1",
      guildId: "guild-1",
      userId: "user-1",
      platform: "xbox",
      createdAtMs: Date.now(),
    },
  ];
  const service = createMockPlatformLinkService({ pendingLinks });
  const config = createXboxPlatformConfig({
    clientId: "test-client-id",
    clientSecret: "test-secret",
  });
  const routes = createPlatformLinkRoutes({ platformLinkService: service, platformConfig: config });

  const errorLogs: unknown[] = [];
  const originalConsoleError = console.error;
  const originalFetch = globalThis.fetch;
  console.error = (...args: unknown[]) => errorLogs.push(args);

  globalThis.fetch = async (url: RequestInfo | URL) => {
    const urlStr = url.toString();
    if (urlStr.includes("/consumers/oauth2/v2.0/token")) {
      return new Response(JSON.stringify({ access_token: "ms-access-token" }));
    }
    if (urlStr.includes("user.auth.xboxlive.com")) {
      return new Response(
        JSON.stringify({
          Token: "xbl-user-token",
          DisplayClaims: { xui: [{ uhs: "user-hash" }] },
        }),
      );
    }
    if (urlStr.includes("xsts.auth.xboxlive.com")) {
      return new Response("upstream xsts failure", {
        status: 401,
        headers: { "x-xbl-correlation-id": "corr-123" },
      });
    }
    return new Response("{}", { status: 200 });
  };

  try {
    const response = await routes(
      new Request("https://runtime.example/auth/xbox/callback?state=state-1&code=test-auth-code"),
    );

    assert.equal(response?.status, 401);
    const xstsLog = errorLogs.find(
      (entry) => Array.isArray(entry) && entry[0] === "Xbox XSTS exchange failed",
    );
    assert.ok(xstsLog, "Expected Xbox XSTS exchange failure to be logged");
    const xstsDetails = (xstsLog as unknown[])[1] as Record<string, unknown>;
    assert.equal(xstsDetails.status, 401);
    assert.equal(xstsDetails.correlationId, "corr-123");
    assert.equal(xstsDetails.body, "upstream xsts failure");
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  }
});

test("PlatformLinkRoutes rejects callback with wrong platform in pending link", async () => {
  const pendingLinks: PendingPlatformLink[] = [
    {
      state: "state-1",
      guildId: "guild-1",
      userId: "user-1",
      platform: "steam",
      createdAtMs: Date.now(),
    },
  ];
  const service = createMockPlatformLinkService({ pendingLinks });
  const config = createXboxPlatformConfig({
    clientId: "test-client-id",
    clientSecret: "test-secret",
  });
  const routes = createPlatformLinkRoutes({ platformLinkService: service, platformConfig: config });

  const response = await routes(
    new Request("https://runtime.example/auth/xbox/callback?state=state-1&code=test-code"),
  );

  assert.equal(response?.status, 400);
  const text = await response?.text();
  assert.ok(text?.includes("Invalid or expired"), `Expected invalid message, got: ${text}`);
});

test("PlatformLinkRoutes returns 409 when platform account already linked to another user", async () => {
  const pendingLinks: PendingPlatformLink[] = [
    {
      state: "state-1",
      guildId: "guild-1",
      userId: "user-2",
      platform: "steam",
      createdAtMs: Date.now(),
    },
  ];
  const links: PlatformLink[] = [
    {
      guildId: "guild-1",
      userId: "user-1",
      platform: "steam",
      platformId: "76561198000000001",
      linkedAtMs: 1000,
      manual: false,
      actionedByUserId: null,
      metadataJson: null,
      active: true,
    },
  ];
  const configs: PlatformLinkConfig[] = [createConfig({ guildId: "guild-1", platform: "steam" })];
  const service = createMockPlatformLinkService({ pendingLinks, links, configs });
  const config = createSteamPlatformConfig();
  const routes = createPlatformLinkRoutes({ platformLinkService: service, platformConfig: config });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("is_valid:true", { status: 200 });

  try {
    const response = await routes(
      new Request(
        `https://runtime.example/auth/steam/callback?state=state-1&openid.mode=id_res&openid.claimed_id=https://steamcommunity.com/openid/id/76561198000000001`,
      ),
    );

    assert.equal(response?.status, 409);
    const text = await response?.text();
    assert.ok(
      text?.includes("already linked to another"),
      `Expected duplicate message, got: ${text}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function createConfig(overrides: Partial<PlatformLinkConfig> = {}): PlatformLinkConfig {
  return {
    guildId: "guild-1",
    platform: "steam",
    linkedRoleId: null,
    logChannelId: null,
    gameAppIds: [],
    panelTitle: "Link your account",
    panelDescription: "Link your account",
    panelButtonLabel: "Link",
    panelButtonStyle: "Primary",
    allowRelink: true,
    allowMultipleLinks: false,
    requireRelinkOnRejoin: false,
    updatedAtMs: 1,
    whoisFields: [],
    customLinks: [],
    panelChannelId: null,
    panelMessageId: null,
    ...overrides,
  };
}

function createMockPlatformLinkService(options: {
  pendingLinks?: PendingPlatformLink[];
  links?: PlatformLink[];
  configs?: PlatformLinkConfig[];
}): PlatformLinkService {
  const fixture = createProductionRuntimeStores();
  const rawStore = fixture.stores.platformLink;
  const ready = (async () => {
    for (const config of options.configs ?? []) await rawStore.upsertPlatformLinkConfig(config);
    for (const pending of options.pendingLinks ?? [])
      await rawStore.createPendingPlatformLink(pending);
    for (const link of options.links ?? []) await rawStore.upsertPlatformLink(link);
  })();
  return createPlatformLinkService({
    platformLinkStore: afterStoreSeed(rawStore, ready),
    discordBotToken: "token",
  });
}

async function createReplacementRouteFixture(
  options: {
    config?: Partial<PlatformLinkConfig> | null;
    pending?: Partial<PendingPlatformLink>;
    service?: Partial<PlatformLinkServiceOptions>;
    auth?: Partial<PlatformAuthConfig>;
  } = {},
) {
  const fixture = createProductionRuntimeStores();
  const guildId = "123456789012345678";
  const original: PlatformLink = {
    guildId,
    userId: "user-1",
    platform: "steam",
    platformId: "original",
    linkedAtMs: 1,
    manual: false,
    actionedByUserId: null,
    metadataJson: '{"original":true}',
    active: true,
  };
  const store = fixture.stores.platformLink;
  await store.upsertPlatformLink(original);
  if (options.config !== null)
    await store.upsertPlatformLinkConfig(createConfig({ guildId, ...options.config }));
  await store.createPendingPlatformLink({
    state: "replacement-state",
    guildId,
    userId: "user-1",
    platform: "steam",
    createdAtMs: Date.now(),
    ...options.pending,
  });
  const service = createPlatformLinkService({
    platformLinkStore: store,
    discordBotToken: "token",
    ...options.service,
  });
  const routes = createPlatformLinkRoutes({
    platformLinkService: service,
    platformConfig: {
      ...createSteamPlatformConfig(),
      verifyAssertion: async () => "replacement",
      ...options.auth,
    },
  });
  return { fixture, original, service, routes, guildId };
}

for (const failure of ["provider", "storage"] as const) {
  test(`Platform Link callback retains the old identity and earning state on ${failure} failure`, async () => {
    let removalCalls = 0;
    const context = await createReplacementRouteFixture({
      service: {
        onLinksReplacing: async (_link, replaceLinks) => {
          await replaceLinks();
          removalCalls += 1;
        },
        identityAdapters: {
          steam: {
            platform: "steam",
            describe: () => ({ accountLines: [], detailFields: [], whoisLines: [] }),
            enrichMetadata: async () => {
              if (failure === "provider") throw new Error("private provider failure details");
              return '{"enriched":true}';
            },
          },
        },
      },
    });
    try {
      const effects: string[] = [];
      context.service.assignLinkedRole = async () => {
        effects.push("role");
      };
      context.service.sendLogEmbed = async () => {
        effects.push("audit");
      };
      if (failure === "storage")
        context.fixture.database.execRaw(`
        CREATE TRIGGER fail_replacement BEFORE INSERT ON platform_links
        WHEN NEW.platform_id = 'replacement' BEGIN SELECT RAISE(ABORT, 'private storage failure details'); END`);
      const response = await context.routes(
        new Request("https://runtime.example/auth/steam/callback?state=replacement-state"),
      );
      assert.equal(response?.status, 500);
      assert.deepEqual(await context.service.listLinks(context.guildId), [context.original]);
      assert.equal(removalCalls, 0);
      assert.deepEqual(effects, []);
      assert.equal(await context.service.readPendingLink("replacement-state"), null);
      const html = await response!.text();
      assert.match(html, /start a new request/);
      assert.doesNotMatch(html, /account was saved/);
      assert.doesNotMatch(html, /private .* failure details/);
      const document = new JSDOM(html).window.document;
      assert.equal(document.querySelector("main h1")?.textContent, "Could not finish linking");
      assert.equal(
        document.querySelector("a")?.href,
        `https://discord.com/channels/${context.guildId}`,
      );
      assert.match(response!.headers.get("cache-control")!, /no-store/);
      assert.match(response!.headers.get("content-security-policy")!, /script-src 'none'/);
      assert.equal(response!.headers.get("x-frame-options"), "DENY");
      assert.equal(response!.headers.get("referrer-policy"), "no-referrer");
    } finally {
      context.fixture.close();
    }
  });
}

for (const scenario of [
  "replace",
  "multiple",
  "disabled",
  "active",
  "reactivate",
  "owned",
  "no-config",
] as const) {
  test(`Platform Link callback preserves linking policy: ${scenario}`, async () => {
    const context = await createReplacementRouteFixture({
      config:
        scenario === "no-config"
          ? null
          : {
              allowRelink: scenario !== "disabled" && scenario !== "reactivate",
              allowMultipleLinks: scenario === "multiple",
            },
      auth: {
        verifyAssertion: async () =>
          scenario === "active" || scenario === "reactivate" ? "original" : "replacement",
      },
    });
    try {
      const effects: string[] = [];
      context.service.assignLinkedRole = async () => {
        effects.push("role");
      };
      context.service.sendLogEmbed = async () => {
        effects.push("audit");
      };
      if (scenario === "reactivate")
        await context.fixture.stores.platformLink.upsertPlatformLink({
          ...context.original,
          active: false,
        });
      if (scenario === "owned")
        await context.fixture.stores.platformLink.upsertPlatformLink({
          ...context.original,
          userId: "other-user",
          platformId: "replacement",
        });
      const before = await context.service.listLinks(context.guildId);
      const response = await context.routes(
        new Request("https://runtime.example/auth/steam/callback?state=replacement-state"),
      );
      const rejected = ["disabled", "active", "owned", "no-config"].includes(scenario);
      assert.equal(response?.status, scenario === "no-config" ? 400 : rejected ? 409 : 200);
      assert.deepEqual(effects, rejected ? [] : ["role", "audit"]);
      const after = await context.service.listLinks(context.guildId);
      if (rejected) assert.deepEqual(after, before);
      else if (scenario === "multiple")
        assert.deepEqual(after.map((link) => link.platformId).sort(), ["original", "replacement"]);
      else {
        assert.equal(after.length, 1);
        assert.equal(after[0]?.platformId, scenario === "reactivate" ? "original" : "replacement");
        assert.equal(after[0]?.active, true);
      }
      assert.equal(await context.service.readPendingLink("replacement-state"), null);
    } finally {
      context.fixture.close();
    }
  });
}

for (const path of ["start", "callback"]) {
  for (const state of ["missing", "unknown", "wrong-platform", "expired"]) {
    test(`Platform Link ${path} failure only offers a Discord link from trusted pending context: ${state}`, async () => {
      const context = await createReplacementRouteFixture({
        pending:
          state === "wrong-platform"
            ? { platform: "xbox" }
            : state === "expired"
              ? { createdAtMs: Date.now() - 16 * 60 * 1000 }
              : {},
      });
      try {
        const value =
          state === "missing" ? "" : state === "unknown" ? "unknown" : "replacement-state";
        const response = await context.routes(
          new Request(
            `https://runtime.example/auth/steam/${path}?state=${value}&guildId=999999999999999999&returnUrl=https://evil.example`,
          ),
        );
        assert.equal(response?.status, 400);
        const html = await response!.text();
        const document = new JSDOM(html).window.document;
        assert.ok(document.querySelector("main h1"));
        assert.ok(document.querySelector("h2"));
        assert.equal(
          document.querySelector("a")?.href,
          state === "expired" ? `https://discord.com/channels/${context.guildId}` : undefined,
        );
        assert.doesNotMatch(html, /evil\.example|999999999999999999/);
        if (state === "expired")
          assert.equal(await context.service.readPendingLink("replacement-state"), null);
      } finally {
        context.fixture.close();
      }
    });
  }
}

test("Platform Link login failure escapes provider names and keeps the authentication status", async () => {
  const context = await createReplacementRouteFixture({
    auth: { displayName: '<img src=x onerror="alert(1)">', verifyAssertion: async () => null },
  });
  try {
    const response = await context.routes(
      new Request("https://runtime.example/auth/steam/callback?state=replacement-state"),
    );
    assert.equal(response?.status, 401);
    const html = await response!.text();
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img/);
    const document = new JSDOM(html).window.document;
    assert.match(document.querySelector("h1")!.textContent!, /<img/);
    assert.equal(document.querySelector("script, img, [onerror]"), null);
  } finally {
    context.fixture.close();
  }
});

for (const failure of ["finalization", "role", "audit"] as const) {
  test(`Platform Link attempts independent follow-up work after ${failure} failure`, async () => {
    const context = await createReplacementRouteFixture({
      service: {
        onLinksReplacing: async (_link, replaceLinks) => {
          await replaceLinks();
          if (failure === "finalization") throw new Error("cleanup unavailable");
        },
      },
    });
    try {
      const effects: string[] = [];
      context.service.assignLinkedRole = async () => {
        effects.push("role");
        if (failure === "role") throw new Error("role unavailable");
      };
      context.service.sendLogEmbed = async () => {
        effects.push("audit");
        if (failure === "audit") throw new Error("audit unavailable");
      };
      const response = await context.routes(
        new Request("https://runtime.example/auth/steam/callback?state=replacement-state"),
      );
      assert.equal(response?.status, 500);
      const links = await context.service.listLinks(context.guildId);
      assert.equal(links.length, 1);
      assert.equal(links[0]?.platformId, "replacement");
      assert.equal(links[0]?.active, true);
      assert.deepEqual(effects, ["role", "audit"]);
      assert.equal(await context.service.readPendingLink("replacement-state"), null);
      const html = await response!.text();
      assert.match(html, /Account linked; follow-up needed/);
      assert.match(html, /account was saved/);
      assert.doesNotMatch(html, /unavailable|start a new request/i);
      assert.equal(
        new JSDOM(html).window.document.querySelector("a")?.href,
        `https://discord.com/channels/${context.guildId}`,
      );
      const replay = await context.routes(
        new Request("https://runtime.example/auth/steam/callback?state=replacement-state"),
      );
      assert.equal(replay?.status, 400);
      assert.deepEqual(effects, ["role", "audit"]);
    } finally {
      context.fixture.close();
    }
  });
}
