import type { Cache } from "../src/runtime/discord-json-cache";
/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- The worker typecheck config omits Node built-ins and full node:test types conflict with Workers globals; tsconfig.tests provides the runtime test types.
import test from "node:test";

import { createAdminApiHandler as createBaseAdminApiHandler } from "./helpers/admin-api";
import type { AdminAccessRequirement } from "../src/runtime/admin-access";
import type { PlatformLinkConfig } from "../src/runtime/contracts/platform-link-store";
import type { TicketPanelConfig } from "../src/types";
import type { RuntimeStores } from "../src/runtime/app-types";
import {
  createProductionRuntimeStores,
  withStoreOverrides,
} from "./support/production-runtime-stores";
import { createPermissiveGuildResourceValidator } from "./helpers/guild-resource-validator";

function createAdminApiHandler(options: Parameters<typeof createBaseAdminApiHandler>[0]) {
  return createBaseAdminApiHandler({
    guildResources: createPermissiveGuildResourceValidator(),
    ...options,
  });
}

test("admin guild directory reuses cached Discord guilds until refresh is requested", async () => {
  const originalFetch = globalThis.fetch;
  const originalConsoleInfo = console.info;
  const discordRequests: string[] = [];
  const logs: unknown[][] = [];
  globalThis.fetch = async (input) => {
    discordRequests.push(String(input));
    return Response.json([{ id: "guild-1", name: "Guild One" }]);
  };
  console.info = (...args: unknown[]) => {
    logs.push(args);
  };

  try {
    const handler = createAdminApiHandler({
      stores: createStores(),
      discordBotToken: "token",
    });

    await handler(
      new Request("https://example.com/admin/api/guilds"),
      new URL("https://example.com/admin/api/guilds"),
    );
    await handler(
      new Request("https://example.com/admin/api/guilds"),
      new URL("https://example.com/admin/api/guilds"),
    );
    assert.deepEqual(discordRequests, ["https://discord.com/api/v10/users/@me/guilds"]);
    assert.deepEqual(logs, [["discord_cache", { event: "miss", resource: "bot-guilds" }]]);

    await handler(
      new Request("https://example.com/admin/api/guilds?refresh=1"),
      new URL("https://example.com/admin/api/guilds?refresh=1"),
    );
    assert.deepEqual(discordRequests, [
      "https://discord.com/api/v10/users/@me/guilds",
      "https://discord.com/api/v10/users/@me/guilds",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    console.info = originalConsoleInfo;
  }
});

test("admin guild directory reads bot guilds from KV on a fresh handler cache miss", async () => {
  const originalFetch = globalThis.fetch;
  const discordRequests: string[] = [];
  const kvGets: string[] = [];
  globalThis.fetch = async (input) => {
    discordRequests.push(String(input));
    return Response.json([{ id: "guild-discord", name: "Discord Guild" }]);
  };

  try {
    const handler = createAdminApiHandler({
      stores: createStores(),
      discordBotToken: "token-kv-read",
      discordCache: {
        async get(key: string) {
          kvGets.push(key);
          return JSON.stringify([{ guildId: "guild-kv", name: "KV Guild" }]);
        },
      } as unknown as Cache<string>,
    });

    const response = await handler(
      new Request("https://example.com/admin/api/guilds"),
      new URL("https://example.com/admin/api/guilds"),
    );

    assert.equal(response?.status, 200);
    assert.deepEqual(await response?.json(), {
      guilds: [{ guildId: "guild-kv", name: "KV Guild", label: "KV Guild", icon: null }],
    });
    assert.deepEqual(kvGets, ["bot-guilds"]);
    assert.deepEqual(discordRequests, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin guild directory refresh bypasses KV and updates cached bot guilds", async () => {
  const originalFetch = globalThis.fetch;
  const originalConsoleInfo = console.info;
  const discordRequests: string[] = [];
  const kvGets: string[] = [];
  const kvPuts: Array<{ key: string; value: string; options?: { ttlSeconds?: number } }> = [];
  const logs: unknown[][] = [];
  globalThis.fetch = async (input) => {
    discordRequests.push(String(input));
    return Response.json([{ id: "guild-refreshed", name: "Refreshed Guild" }]);
  };
  console.info = (...args: unknown[]) => {
    logs.push(args);
  };

  try {
    const handler = createAdminApiHandler({
      stores: createStores(),
      discordBotToken: "token-kv-refresh",
      discordCache: {
        async get(key: string) {
          kvGets.push(key);
          return JSON.stringify([{ guildId: "guild-kv", name: "KV Guild" }]);
        },
        async put(key: string, value: string, options?: { ttlSeconds?: number }) {
          kvPuts.push({ key, value, options });
        },
      } as unknown as Cache<string>,
    });

    const response = await handler(
      new Request("https://example.com/admin/api/guilds?refresh=1"),
      new URL("https://example.com/admin/api/guilds?refresh=1"),
    );

    assert.equal(response?.status, 200);
    assert.deepEqual(await response?.json(), {
      guilds: [
        {
          guildId: "guild-refreshed",
          name: "Refreshed Guild",
          label: "Refreshed Guild",
          icon: null,
        },
      ],
    });
    assert.deepEqual(kvGets, []);
    assert.deepEqual(discordRequests, ["https://discord.com/api/v10/users/@me/guilds"]);
    assert.deepEqual(kvPuts, [
      {
        key: "bot-guilds",
        value: JSON.stringify([
          { guildId: "guild-refreshed", name: "Refreshed Guild", icon: null },
        ]),
        options: { ttlSeconds: 900 },
      },
    ]);
    assert.deepEqual(logs, [
      ["discord_cache", { event: "refresh_bypass", resource: "bot-guilds" }],
    ]);
    assert.equal(JSON.stringify(logs).includes("token-kv-refresh"), false);
  } finally {
    globalThis.fetch = originalFetch;
    console.info = originalConsoleInfo;
  }
});

test("admin guild directory returns cached KV guilds when Discord rate limits refresh", async () => {
  const originalFetch = globalThis.fetch;
  const originalConsoleInfo = console.info;
  const discordRequests: string[] = [];
  const kvGets: string[] = [];
  const logs: unknown[][] = [];
  globalThis.fetch = async (input) => {
    discordRequests.push(String(input));
    return new Response("rate limited", { status: 429 });
  };
  console.info = (...args: unknown[]) => {
    logs.push(args);
  };

  try {
    const handler = createAdminApiHandler({
      stores: createStores(),
      discordBotToken: "token-kv-stale",
      discordCache: {
        async get(key: string) {
          kvGets.push(key);
          return JSON.stringify([{ guildId: "guild-stale", name: "Stale Guild" }]);
        },
        async put() {
          throw new Error("should not update KV after rate limit");
        },
      } as unknown as Cache<string>,
    });

    const response = await handler(
      new Request("https://example.com/admin/api/guilds?refresh=1"),
      new URL("https://example.com/admin/api/guilds?refresh=1"),
    );

    assert.equal(response?.status, 200);
    assert.deepEqual(await response?.json(), {
      guilds: [{ guildId: "guild-stale", name: "Stale Guild", label: "Stale Guild", icon: null }],
    });
    assert.deepEqual(discordRequests, ["https://discord.com/api/v10/users/@me/guilds"]);
    assert.deepEqual(kvGets, ["bot-guilds"]);
    assert.deepEqual(logs, [
      ["discord_cache", { event: "refresh_bypass", resource: "bot-guilds" }],
      ["discord_cache", { event: "discord_429", resource: "bot-guilds" }],
      ["discord_cache", { event: "stale_fallback", resource: "bot-guilds" }],
    ]);
    assert.equal(JSON.stringify(logs).includes("token-kv-stale"), false);
  } finally {
    globalThis.fetch = originalFetch;
    console.info = originalConsoleInfo;
  }
});

test("admin guild directory maps repeated Discord rate limits to a controlled error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ retry_after: 0.5, global: false }, { status: 429 });

  try {
    const handler = createAdminApiHandler({
      stores: createStores(),
      discordBotToken: "token-kv-rate-limited",
      discordCache: {
        async get() {
          return null;
        },
      } as unknown as Cache<string>,
    });

    const response = await handler(
      new Request("https://example.com/admin/api/guilds?refresh=1"),
      new URL("https://example.com/admin/api/guilds?refresh=1"),
    );

    assert.equal(response?.status, 429);
    const body = (await response?.json()) as { code: string; retryAfterSeconds: number };
    assert.equal(body.code, "discord_rate_limited");
    assert.equal(body.retryAfterSeconds, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin Steam Link compatibility API stores custom links in Platform Link", async () => {
  let savedCustomLinks: PlatformLinkConfig["customLinks"] | null = null;
  const handler = createAdminApiHandler({
    stores: createStores({
      upsertPlatformLinkConfig: async (config) => {
        savedCustomLinks = config.customLinks;
      },
    }),
    discordBotToken: "token",
  });

  const response = await handler(
    new Request("https://example.com/admin/api/player-link/config", {
      method: "POST",
      body: JSON.stringify({
        platform: "steam",
        guildId: "guild-1",
        linkedRoleId: null,
        logChannelId: null,
        gameAppIds: ["221100"],
        whoisFields: ["CFTools"],
        customLinks: [
          {
            label: "CFTools",
            url: "https://cfan.eu/players/{steamId64}",
          },
        ],
        panelTitle: "Link your Steam account",
        panelDescription: "Desc",
        panelButtonLabel: "Link Steam",
        panelButtonStyle: "Primary",
        allowRelink: true,
      }),
    }),
    new URL("https://example.com/admin/api/player-link/config"),
  );

  assert.equal(response?.status, 200);
  assert.deepEqual(savedCustomLinks, [
    {
      label: "CFTools",
      url: "https://cfan.eu/players/{steamId64}",
    },
  ]);
});

test("admin Steam Link sync roles API returns sync counters", async () => {
  let syncedGuildId: string | null = null;
  const handler = createAdminApiHandler({
    stores: createStores(),
    discordBotToken: "token",
    services: {
      platformLinkService: {
        syncLinkedRoles: async (guildId: string) => {
          syncedGuildId = guildId;
          return { total: 3, fixed: 2, skipped: 0, failed: 1 };
        },
      } as never,
    },
  });

  const response = await handler(
    new Request("https://example.com/admin/api/player-link/sync-roles", {
      method: "POST",
      body: JSON.stringify({ platform: "steam", guildId: "guild-1" }),
    }),
    new URL("https://example.com/admin/api/player-link/sync-roles"),
  );

  assert.equal(response?.status, 200);
  assert.equal(syncedGuildId, "guild-1");
  assert.deepEqual(await response?.json(), {
    ok: true,
    total: 3,
    fixed: 2,
    skipped: 0,
    failed: 1,
  });
});

test("admin webhook proxy logs API keeps combined missing parameter validation", async () => {
  const handler = createAdminApiHandler({
    stores: createStores(),
    discordBotToken: "token",
  });

  const response = await handler(
    new Request("https://example.com/admin/api/webhook-proxy/logs"),
    new URL("https://example.com/admin/api/webhook-proxy/logs"),
  );

  assert.equal(response?.status, 400);
  assert.equal(
    ((await response?.json()) as { error: string } | undefined)?.error,
    "guildId and publicId are required",
  );
});

test("admin permission checks cache warning results until refresh is requested", async () => {
  const originalFetch = globalThis.fetch;
  const discordRequests: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    discordRequests.push(url);
    if (url.endsWith("/channels")) {
      return Response.json([]);
    }
    if (url.endsWith("/roles")) {
      return Response.json([{ id: "guild-1", name: "@everyone", permissions: "0", position: 0 }]);
    }
    if (url.endsWith("/members/bot-1")) {
      return Response.json({ roles: [] });
    }
    throw new Error(`Unexpected Discord request ${url}`);
  };

  try {
    const handler = createAdminApiHandler({
      stores: createStores(),
      discordBotToken: "token",
    });
    const url = "https://example.com/admin/api/permissions?guildId=guild-1&feature=blocklist";

    const firstResponse = await handler(new Request(url), new URL(url));
    const secondResponse = await handler(new Request(url), new URL(url));
    assert.equal(firstResponse?.status, 200);
    assert.equal(secondResponse?.status, 200);
    assert.equal(discordRequests.length, 3);

    const refreshedUrl = `${url}&refresh=1`;
    await handler(new Request(refreshedUrl), new URL(refreshedUrl));
    assert.equal(discordRequests.length, 6);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin permission checks reuse cache when authorization allows requests", async () => {
  const originalFetch = globalThis.fetch;
  const discordRequests: string[] = [];
  const authorizationCalls: Array<{ mode: string; guildId?: string | null }> = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    discordRequests.push(url);
    if (url.endsWith("/channels")) {
      return Response.json([]);
    }
    if (url.endsWith("/roles")) {
      return Response.json([{ id: "guild-1", name: "@everyone", permissions: "0", position: 0 }]);
    }
    if (url.endsWith("/members/bot-auth")) {
      return Response.json({ roles: [] });
    }
    throw new Error(`Unexpected Discord request ${url}`);
  };

  try {
    const handler = createAdminApiHandler({
      stores: createStores({ botUserId: "bot-auth" }),
      discordBotToken: "token-auth-cache",
      adminAccess: {
        authorize(_request: Request, options: AdminAccessRequirement) {
          authorizationCalls.push(options);
          return Promise.resolve({ ok: true as const });
        },
      },
    });
    const url = "https://example.com/admin/api/permissions?guildId=guild-1&feature=blocklist";

    const firstResponse = await handler(new Request(url), new URL(url));
    const secondResponse = await handler(new Request(url), new URL(url));
    assert.equal(firstResponse?.status, 200);
    assert.equal(secondResponse?.status, 200);
    assert.equal(discordRequests.length, 3);
    assert.deepEqual(authorizationCalls, [
      { mode: "read", guildId: "guild-1" },
      { mode: "read", guildId: "guild-1" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin API read routes delegate authorization through the admin access seam", async () => {
  const originalFetch = globalThis.fetch;
  const discordRequests: string[] = [];
  const authorizations: AdminAccessRequirement[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    discordRequests.push(url);
    if (url.endsWith("/channels")) {
      return Response.json([]);
    }
    if (url.endsWith("/roles")) {
      return Response.json([
        { id: "guild-auth-seam", name: "@everyone", permissions: "0", position: 0 },
      ]);
    }
    if (url.endsWith("/members/bot-auth-seam")) {
      return Response.json({ roles: [] });
    }
    throw new Error(`Unexpected Discord request ${url}`);
  };

  try {
    const handler = createAdminApiHandler({
      stores: createStores({ botUserId: "bot-auth-seam" }),
      discordBotToken: "token-auth-seam",
      adminAccess: {
        authorize(_request: Request, options: AdminAccessRequirement) {
          authorizations.push(options);
          return Promise.resolve({ ok: true as const });
        },
      },
    });
    const url =
      "https://example.com/admin/api/permissions?guildId=guild-auth-seam&feature=blocklist";

    const response = await handler(new Request(url), new URL(url));

    assert.equal(response?.status, 200);
    assert.deepEqual(authorizations, [{ mode: "read", guildId: "guild-auth-seam" }]);
    assert.equal(discordRequests.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin permission checks map repeated Discord rate limits to a controlled error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ retry_after: 0.25, global: false }, { status: 429 });

  try {
    const handler = createAdminApiHandler({
      stores: createStores(),
      discordBotToken: "token-rate-limited-permissions",
    });
    const url = "https://example.com/admin/api/permissions?guildId=guild-1&feature=blocklist";

    const response = await handler(new Request(url), new URL(url));

    assert.equal(response?.status, 429);
    const body = (await response?.json()) as { code: string; retryAfterSeconds: number };
    assert.equal(body.code, "discord_rate_limited");
    assert.equal(body.retryAfterSeconds, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin API authorization blocks delegated routes before downstream work", async () => {
  const originalFetch = globalThis.fetch;
  const discordRequests: string[] = [];
  const authorizationCalls: Array<{ mode: string; guildId?: string | null }> = [];
  globalThis.fetch = async (input) => {
    discordRequests.push(String(input));
    throw new Error("should not fetch Discord");
  };

  try {
    const handler = createAdminApiHandler({
      stores: createStores(),
      discordBotToken: "token",
      adminAccess: {
        authorize(_request: Request, options: AdminAccessRequirement) {
          authorizationCalls.push(options);
          return Promise.resolve({
            ok: false as const,
            error: { _tag: "Forbidden" as const, message: "Forbidden" },
          });
        },
      },
    });
    const requests = [
      {
        request: new Request("https://example.com/admin/api/guilds"),
        expectedAuthorization: { mode: "read", customerSessionOnly: true },
      },
      {
        request: new Request("https://example.com/admin/api/marketplace?guildId=guild-1"),
        expectedAuthorization: { mode: "read", guildId: "guild-1" },
      },
      {
        request: new Request("https://example.com/admin/api/marketplace/config", {
          method: "POST",
          body: JSON.stringify({
            guildId: "guild-1",
            noticeChannelId: null,
            noticeMessageId: null,
            logChannelId: null,
            serverOptions: [{ id: "server-1", label: "Server One", emoji: null }],
          }),
        }),
        expectedAuthorization: { mode: "write", guildId: "guild-1" },
      },
      {
        request: new Request("https://example.com/admin/api/tickets/panel", {
          method: "POST",
          body: JSON.stringify(createTicketPanelConfig({ guildId: "guild-1" })),
        }),
        expectedAuthorization: { mode: "write", guildId: "guild-1" },
      },
      {
        request: new Request("https://example.com/admin/api/player-link?guildId=guild-1"),
        expectedAuthorization: { mode: "read", guildId: "guild-1" },
      },
      {
        request: new Request("https://example.com/admin/api/player-link/config", {
          method: "POST",
          body: JSON.stringify({
            platform: "steam",
            guildId: "guild-1",
            linkedRoleId: null,
            logChannelId: null,
            gameAppIds: ["221100"],
            panelTitle: "Link your Steam account",
            panelDescription: "Desc",
            panelButtonLabel: "Link Steam",
            panelButtonStyle: "Primary",
            allowRelink: true,
          }),
        }),
        expectedAuthorization: { mode: "write", guildId: "guild-1" },
      },
      {
        request: new Request("https://example.com/admin/api/guild-rbac/admin-role?guildId=guild-1"),
        expectedAuthorization: { mode: "read", guildId: "guild-1" },
      },
      {
        request: new Request("https://example.com/admin/api/guild-rbac/admin-role", {
          method: "POST",
          body: JSON.stringify({ guildId: "guild-1", adminRoleId: "123456789012345678" }),
        }),
        expectedAuthorization: {
          mode: "write",
          guildId: "guild-1",
          guildCapability: "manage-delegation",
        },
      },
    ];

    for (const { request } of requests) {
      const response = await handler(request, new URL(request.url));

      assert.equal(response?.status, 403);
      assert.equal(((await response?.json()) as { error: string } | undefined)?.error, "Forbidden");
    }
    assert.deepEqual(
      authorizationCalls,
      requests.map(({ expectedAuthorization }) => expectedAuthorization),
    );
    assert.deepEqual(discordRequests, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin access seam blocks delegated admin API routes before downstream work", async () => {
  const originalFetch = globalThis.fetch;
  const discordRequests: string[] = [];
  const authorizations: AdminAccessRequirement[] = [];
  globalThis.fetch = async (input) => {
    discordRequests.push(String(input));
    throw new Error("should not fetch Discord");
  };

  try {
    const handler = createAdminApiHandler({
      stores: createStores(),
      discordBotToken: "token",
      adminAccess: {
        authorize(_request: Request, options: AdminAccessRequirement) {
          authorizations.push(options);
          return Promise.resolve({
            ok: false as const,
            error: { _tag: "Forbidden" as const, message: "Forbidden" },
          });
        },
      },
    });

    const response = await handler(
      new Request("https://example.com/admin/api/marketplace?guildId=guild-1"),
      new URL("https://example.com/admin/api/marketplace?guildId=guild-1"),
    );

    assert.equal(response?.status, 403);
    assert.equal(((await response?.json()) as { error: string } | undefined)?.error, "Forbidden");
    assert.deepEqual(authorizations, [{ mode: "read", guildId: "guild-1" }]);
    assert.deepEqual(discordRequests, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("guild admin role API reads and updates the configured role", async () => {
  let storedRoleId: string | null = "111111111111111111";
  const authorizationCalls: Array<{
    mode: string;
    guildId?: string | null;
    workspaceOnly?: boolean;
  }> = [];
  const handler = createAdminApiHandler({
    stores: createStores({
      readGuildAdminRoleId: async (guildId) => {
        assert.equal(guildId, "guild-1");
        return storedRoleId;
      },
      upsertGuildAdminRoleId: async (guildId, roleId) => {
        assert.equal(guildId, "guild-1");
        storedRoleId = roleId;
      },
    }),
    discordBotToken: "token",
    adminAccess: {
      authorize(_request: Request, options: AdminAccessRequirement) {
        authorizationCalls.push(options);
        return Promise.resolve({ ok: true as const });
      },
    },
  });

  const readResponse = await handler(
    new Request("https://example.com/admin/api/guild-rbac/admin-role?guildId=guild-1"),
    new URL("https://example.com/admin/api/guild-rbac/admin-role?guildId=guild-1"),
  );
  assert.equal(readResponse?.status, 200);
  assert.deepEqual(await readResponse?.json(), {
    guildId: "guild-1",
    adminRoleId: "111111111111111111",
    manageServerAdminEnabled: true,
    canManageDelegation: true,
    canManageServerPolicy: true,
  });

  const writeResponse = await handler(
    new Request("https://example.com/admin/api/guild-rbac/admin-role", {
      method: "POST",
      body: JSON.stringify({ guildId: "guild-1", adminRoleId: "222222222222222222" }),
    }),
    new URL("https://example.com/admin/api/guild-rbac/admin-role"),
  );
  assert.equal(writeResponse?.status, 200);
  assert.deepEqual(await writeResponse?.json(), {
    guildId: "guild-1",
    adminRoleId: "222222222222222222",
    manageServerAdminEnabled: true,
  });
  assert.equal(storedRoleId, "222222222222222222");

  const clearResponse = await handler(
    new Request("https://example.com/admin/api/guild-rbac/admin-role", {
      method: "POST",
      body: JSON.stringify({ guildId: "guild-1", adminRoleId: null }),
    }),
    new URL("https://example.com/admin/api/guild-rbac/admin-role"),
  );
  assert.equal(clearResponse?.status, 200);
  assert.deepEqual(await clearResponse?.json(), {
    guildId: "guild-1",
    adminRoleId: null,
    manageServerAdminEnabled: true,
  });
  assert.equal(storedRoleId, null);
  assert.deepEqual(authorizationCalls, [
    { mode: "read", guildId: "guild-1" },
    { mode: "write", guildId: "guild-1", guildCapability: "manage-delegation" },
    { mode: "write", guildId: "guild-1", guildCapability: "manage-server-policy" },
    { mode: "write", guildId: "guild-1", guildCapability: "manage-delegation" },
    { mode: "write", guildId: "guild-1", guildCapability: "manage-delegation" },
  ]);
});

test("guild admin role API validates input before authorization and storage", async () => {
  const authorizationCalls: unknown[] = [];
  const storeCalls: unknown[] = [];
  const handler = createAdminApiHandler({
    stores: createStores({
      upsertGuildAdminRoleId: async (...args) => {
        storeCalls.push(args);
      },
    }),
    discordBotToken: "token",
    adminAccess: {
      authorize(_request: Request, options: AdminAccessRequirement) {
        authorizationCalls.push(options);
        return Promise.resolve({ ok: true as const });
      },
    },
  });

  const missingGuildResponse = await handler(
    new Request("https://example.com/admin/api/guild-rbac/admin-role"),
    new URL("https://example.com/admin/api/guild-rbac/admin-role"),
  );
  assert.equal(missingGuildResponse?.status, 400);
  assert.equal(
    ((await missingGuildResponse?.json()) as { error: string } | undefined)?.error,
    "guildId is required",
  );

  const invalidPostResponse = await handler(
    new Request("https://example.com/admin/api/guild-rbac/admin-role", {
      method: "POST",
      body: JSON.stringify({ guildId: "guild-1", adminRoleId: "role-name" }),
    }),
    new URL("https://example.com/admin/api/guild-rbac/admin-role"),
  );
  assert.equal(invalidPostResponse?.status, 400);
  const invalidPostBody = (await invalidPostResponse?.json()) as {
    error: string;
    fieldIssues: Array<{ path: string; message: string }>;
  };
  assert.equal(invalidPostBody.error, "Invalid request body");
  assert.equal(invalidPostBody.fieldIssues[0]?.path, "adminRoleId");
  assert.equal(invalidPostBody.fieldIssues[0]?.message, "adminRoleId must be a Discord role ID");
  assert.deepEqual(authorizationCalls, []);
  assert.deepEqual(storeCalls, []);
});

test("ticket panel POST routes require guildId before delegated handling", async () => {
  const handler = createAdminApiHandler({
    stores: createStores(),
    discordBotToken: "token",
  });
  const requests = [
    new Request("https://example.com/admin/api/tickets/panel", {
      method: "POST",
      body: JSON.stringify({}),
    }),
    new Request("https://example.com/admin/api/tickets/panel/publish", {
      method: "POST",
      body: JSON.stringify({ guildId: "" }),
    }),
  ];

  for (const request of requests) {
    const response = await handler(request, new URL(request.url));

    assert.equal(response?.status, 400);
    const body = (await response?.json()) as {
      error: string;
      fieldIssues?: Array<{ path: string }>;
    };
    assert.equal(body.error, "Invalid request body");
    assert.ok(body.fieldIssues?.some((issue) => issue.path === "guildId"));
  }
});

test("ticket panel POST routes reject invalid JSON before authorization or delegated handling", async () => {
  const authorizationCalls: unknown[] = [];
  const storeCalls: string[] = [];
  const handler = createAdminApiHandler({
    stores: createStores({
      upsertTicketPanelConfig: async () => {
        storeCalls.push("upsert");
      },
    }),
    discordBotToken: "token",
    adminAccess: {
      authorize(_request: Request, options: AdminAccessRequirement) {
        authorizationCalls.push(options);
        return Promise.resolve({ ok: true as const });
      },
    },
  });

  const response = await handler(
    new Request("https://example.com/admin/api/tickets/panel", {
      method: "POST",
      body: "{",
    }),
    new URL("https://example.com/admin/api/tickets/panel"),
  );

  assert.equal(response?.status, 400);
  const body = (await response?.json()) as { error: string; fieldIssues?: Array<{ code: string }> };
  assert.ok(body.error.length > 0);
  assert.ok(body.fieldIssues?.some((issue) => issue.code === "invalid_json"));
  assert.deepEqual(authorizationCalls, []);
  assert.deepEqual(storeCalls, []);
});

test("admin permission diagnostics reuse cache until refresh is requested", async () => {
  const originalFetch = globalThis.fetch;
  const discordRequests: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    discordRequests.push(url);
    if (url.endsWith("/channels")) {
      return Response.json([]);
    }
    if (url.endsWith("/roles")) {
      return Response.json([{ id: "guild-1", name: "@everyone", permissions: "0", position: 0 }]);
    }
    if (url.endsWith("/members/bot-overview")) {
      return Response.json({ roles: [] });
    }
    throw new Error(`Unexpected Discord request ${url}`);
  };

  try {
    const handler = createAdminApiHandler({
      stores: createStores({ botUserId: "bot-overview" }),
      discordBotToken: "token-overview",
    });
    const url = "https://example.com/admin/api/permissions/diagnostics?guildId=guild-overview";

    const firstResponse = await handler(new Request(url), new URL(url));
    const secondResponse = await handler(new Request(url), new URL(url));
    assert.equal(firstResponse?.status, 200);
    assert.equal(secondResponse?.status, 200);
    assert.equal(discordRequests.length, 3);

    const refreshedUrl = `${url}&refresh=1`;
    await handler(new Request(refreshedUrl), new URL(refreshedUrl));
    assert.equal(discordRequests.length, 6);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin permission checks cache Discord lookup failures until refresh is requested", async () => {
  const originalFetch = globalThis.fetch;
  const discordRequests: string[] = [];
  globalThis.fetch = async (input) => {
    discordRequests.push(String(input));
    return new Response("discord unavailable", { status: 500 });
  };

  try {
    const handler = createAdminApiHandler({
      stores: createStores(),
      discordBotToken: "token-failure",
    });
    const url = "https://example.com/admin/api/permissions?guildId=guild-1&feature=blocklist";

    const firstResponse = await handler(new Request(url), new URL(url));
    const secondResponse = await handler(new Request(url), new URL(url));
    assert.equal(firstResponse?.status, 502);
    assert.equal(secondResponse?.status, 502);
    assert.equal(discordRequests.length, 3);

    const refreshedUrl = `${url}&refresh=1`;
    await handler(new Request(refreshedUrl), new URL(refreshedUrl));
    assert.equal(discordRequests.length, 6);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function createStores(options?: {
  botUserId?: string;
  upsertTicketPanelConfig?: () => Promise<void>;
  upsertPlatformLinkConfig?: (config: PlatformLinkConfig) => Promise<void>;
  readGuildAdminRoleId?: (guildId: string) => Promise<string | null>;
  upsertGuildAdminRoleId?: (guildId: string, roleId: string | null) => Promise<void>;
}): RuntimeStores {
  const fixture = createProductionRuntimeStores({ botUserId: options?.botUserId ?? "bot-1" });
  return {
    ...fixture.stores,
    tickets: options?.upsertTicketPanelConfig
      ? withStoreOverrides(fixture.stores.tickets, {
          upsertTicketPanelConfig: options.upsertTicketPanelConfig,
        })
      : fixture.stores.tickets,
    platformLink: options?.upsertPlatformLinkConfig
      ? withStoreOverrides(fixture.stores.platformLink, {
          upsertPlatformLinkConfig: options.upsertPlatformLinkConfig,
        })
      : fixture.stores.platformLink,
    guildRbac:
      options?.readGuildAdminRoleId || options?.upsertGuildAdminRoleId
        ? withStoreOverrides(fixture.stores.guildRbac, {
            ...(options.readGuildAdminRoleId
              ? { readGuildAdminRoleId: options.readGuildAdminRoleId }
              : {}),
            ...(options.upsertGuildAdminRoleId
              ? { upsertGuildAdminRoleId: options.upsertGuildAdminRoleId }
              : {}),
          })
        : fixture.stores.guildRbac,
  };
}

function createTicketPanelConfig(overrides: Partial<TicketPanelConfig> = {}): TicketPanelConfig {
  return {
    guildId: "guild-1",
    panelChannelId: "panel-channel",
    categoryChannelId: "category-1",
    transcriptChannelId: "transcript-channel",
    panelEmoji: null,
    panelTitle: null,
    panelDescription: null,
    panelFooter: null,
    panelMessageId: null,
    ticketCreationLimit: null,
    ticketLimitRejectionMessage: null,
    enableTicketClaiming: false,
    ticketTypes: [
      {
        id: "support",
        label: "Support",
        emoji: null,
        buttonStyle: "primary",
        supportRoleId: "role-1",
        channelNamePrefix: "ticket",
        responseRules: [],
        anonymousSupportEnabled: false,
        staffDiscussionThreadEnabled: false,
        limitExclusion: false,
        questions: [],
      },
    ],
    ...overrides,
  };
}
