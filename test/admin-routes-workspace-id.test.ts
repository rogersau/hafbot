/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- The worker typecheck config omits Node built-ins and full node:test types conflict with Workers globals; tsconfig.tests provides the runtime test types.
import test from "node:test";

import { createAdminApiHandler as createAdminApiHandlerRuntime } from "./helpers/admin-api";
import type { AdminAccess, AdminAccessRequirement } from "../src/runtime/admin-access";
import type { PlatformLinkConfig } from "../src/runtime/contracts/platform-link-store";
import {
  createPermissiveGuildResourceValidator,
  createStaticGuildResourceValidator,
  testChannel,
  testRole,
} from "./helpers/guild-resource-validator";

function createAdminApiHandler(options: Parameters<typeof createAdminApiHandlerRuntime>[0]) {
  return createAdminApiHandlerRuntime({
    ...options,
    guildResources: options.guildResources ?? createPermissiveGuildResourceValidator(),
  });
}

test("GET /admin/api/entitlement preserves workspaceId in the parsed query and threads it into the access requirement", async () => {
  const { capture, access } = createCapturingAccess();
  const handler = createAdminApiHandler({
    stores: createStores(),
    discordBotToken: "token",
    adminAccess: access,
  });

  const response = await handler(
    new Request("https://example.com/admin/api/entitlement?workspaceId=ws-1&guildId=guild-1"),
    new URL("https://example.com/admin/api/entitlement?workspaceId=ws-1&guildId=guild-1"),
  );

  assert.equal(response?.status, 403);
  assert.deepEqual(capture.requirements, [
    { mode: "read", guildId: "guild-1", workspaceId: "ws-1" },
  ]);
});

test("GET /admin/api/entitlement omits workspaceId from the access requirement when not provided", async () => {
  const { capture, access } = createCapturingAccess();
  const handler = createAdminApiHandler({
    stores: createStores(),
    discordBotToken: "token",
    adminAccess: access,
  });

  const response = await handler(
    new Request("https://example.com/admin/api/entitlement?guildId=guild-1"),
    new URL("https://example.com/admin/api/entitlement?guildId=guild-1"),
  );

  assert.equal(response?.status, 403);
  assert.deepEqual(capture.requirements, [{ mode: "read", guildId: "guild-1" }]);
});

test("GET /admin/api/blocklist preserves workspaceId in the access requirement", async () => {
  const { capture, access } = createCapturingAccess();
  const handler = createAdminApiHandler({
    stores: createStores(),
    discordBotToken: "token",
    adminAccess: access,
    adminRouteServices: createAdminRouteServices(),
  });

  const response = await handler(
    new Request("https://example.com/admin/api/blocklist?workspaceId=ws-1&guildId=guild-1"),
    new URL("https://example.com/admin/api/blocklist?workspaceId=ws-1&guildId=guild-1"),
  );

  assert.equal(response?.status, 403);
  assert.deepEqual(capture.requirements, [
    { mode: "read", guildId: "guild-1", workspaceId: "ws-1" },
  ]);
});

test("GET /admin/api/timed-roles preserves workspaceId in the access requirement", async () => {
  const { capture, access } = createCapturingAccess();
  const handler = createAdminApiHandler({
    stores: createStores(),
    discordBotToken: "token",
    adminAccess: access,
    adminRouteServices: createAdminRouteServices(),
  });

  const response = await handler(
    new Request("https://example.com/admin/api/timed-roles?workspaceId=ws-1&guildId=guild-1"),
    new URL("https://example.com/admin/api/timed-roles?workspaceId=ws-1&guildId=guild-1"),
  );

  assert.equal(response?.status, 403);
  assert.deepEqual(capture.requirements, [
    { mode: "read", guildId: "guild-1", workspaceId: "ws-1" },
  ]);
});

test("GET /admin/api/tickets/panel preserves workspaceId in the access requirement", async () => {
  const { capture, access } = createCapturingAccess();
  const handler = createAdminApiHandler({
    stores: createStores(),
    discordBotToken: "token",
    adminAccess: access,
  });

  const response = await handler(
    new Request("https://example.com/admin/api/tickets/panel?workspaceId=ws-1&guildId=guild-1"),
    new URL("https://example.com/admin/api/tickets/panel?workspaceId=ws-1&guildId=guild-1"),
  );

  assert.equal(response?.status, 403);
  assert.deepEqual(capture.requirements, [
    { mode: "read", guildId: "guild-1", workspaceId: "ws-1" },
  ]);
});

test("GET /admin/api/reaction-limits preserves workspaceId in the access requirement", async () => {
  const { capture, access } = createCapturingAccess();
  const handler = createAdminApiHandler({
    stores: createStores(),
    discordBotToken: "token",
    adminAccess: access,
  });

  const response = await handler(
    new Request("https://example.com/admin/api/reaction-limits?workspaceId=ws-1&guildId=guild-1"),
    new URL("https://example.com/admin/api/reaction-limits?workspaceId=ws-1&guildId=guild-1"),
  );

  assert.equal(response?.status, 403);
  assert.deepEqual(capture.requirements, [
    { mode: "read", guildId: "guild-1", workspaceId: "ws-1" },
  ]);
});

test("GET /admin/api/evidence-vault preserves workspaceId in the access requirement", async () => {
  const { capture, access } = createCapturingAccess();
  const handler = createAdminApiHandler({
    stores: createStores({
      readEntitlement: async () => ({ tier: "premium", updatedAtMs: 0 }),
    }),
    discordBotToken: "token",
    adminAccess: access,
  });

  const response = await handler(
    new Request("https://example.com/admin/api/evidence-vault?workspaceId=ws-1&guildId=guild-1"),
    new URL("https://example.com/admin/api/evidence-vault?workspaceId=ws-1&guildId=guild-1"),
  );

  assert.equal(response?.status, 403);
  assert.deepEqual(capture.requirements, [
    { mode: "read", guildId: "guild-1", workspaceId: "ws-1" },
  ]);
});

test("GET /admin/api/guild-rbac/admin-role preserves workspaceId in the access requirement", async () => {
  const { capture, access } = createCapturingAccess();
  const handler = createAdminApiHandler({
    stores: createStores(),
    discordBotToken: "token",
    adminAccess: access,
  });

  const response = await handler(
    new Request(
      "https://example.com/admin/api/guild-rbac/admin-role?workspaceId=ws-1&guildId=guild-1",
    ),
    new URL("https://example.com/admin/api/guild-rbac/admin-role?workspaceId=ws-1&guildId=guild-1"),
  );

  assert.equal(response?.status, 403);
  assert.deepEqual(capture.requirements, [
    { mode: "read", guildId: "guild-1", workspaceId: "ws-1" },
  ]);
});

test("GET /admin/api/marketplace preserves workspaceId in the access requirement", async () => {
  const { capture, access } = createCapturingAccess();
  const handler = createAdminApiHandler({
    stores: createStores(),
    discordBotToken: "token",
    adminAccess: access,
  });

  const response = await handler(
    new Request("https://example.com/admin/api/marketplace?workspaceId=ws-1&guildId=guild-1"),
    new URL("https://example.com/admin/api/marketplace?workspaceId=ws-1&guildId=guild-1"),
  );

  assert.equal(response?.status, 403);
  assert.deepEqual(capture.requirements, [
    { mode: "read", guildId: "guild-1", workspaceId: "ws-1" },
  ]);
});

test("GET /admin/api/lfg preserves workspaceId in the access requirement", async () => {
  const { capture, access } = createCapturingAccess();
  const handler = createAdminApiHandler({
    stores: createStores(),
    discordBotToken: "token",
    adminAccess: access,
  });

  const response = await handler(
    new Request("https://example.com/admin/api/lfg?workspaceId=ws-1&guildId=guild-1"),
    new URL("https://example.com/admin/api/lfg?workspaceId=ws-1&guildId=guild-1"),
  );

  assert.equal(response?.status, 403);
  assert.deepEqual(capture.requirements, [
    { mode: "read", guildId: "guild-1", workspaceId: "ws-1" },
  ]);
});

test("GET /admin/api/webhook-proxy preserves workspaceId in the access requirement", async () => {
  const { capture, access } = createCapturingAccess();
  const handler = createAdminApiHandler({
    stores: createStores(),
    discordBotToken: "token",
    adminAccess: access,
  });

  const response = await handler(
    new Request("https://example.com/admin/api/webhook-proxy?workspaceId=ws-1&guildId=guild-1"),
    new URL("https://example.com/admin/api/webhook-proxy?workspaceId=ws-1&guildId=guild-1"),
  );

  assert.equal(response?.status, 403);
  assert.deepEqual(capture.requirements, [
    { mode: "read", guildId: "guild-1", workspaceId: "ws-1" },
  ]);
});

test("GET /admin/api/webhook-proxy/logs preserves workspaceId in the access requirement", async () => {
  const { capture, access } = createCapturingAccess();
  const handler = createAdminApiHandler({
    stores: createStores(),
    discordBotToken: "token",
    adminAccess: access,
  });

  const response = await handler(
    new Request(
      "https://example.com/admin/api/webhook-proxy/logs?workspaceId=ws-1&guildId=guild-1&publicId=abcdef0123456789abcdef0123456789",
    ),
    new URL(
      "https://example.com/admin/api/webhook-proxy/logs?workspaceId=ws-1&guildId=guild-1&publicId=abcdef0123456789abcdef0123456789",
    ),
  );

  assert.equal(response?.status, 403);
  assert.deepEqual(capture.requirements, [
    { mode: "read", guildId: "guild-1", workspaceId: "ws-1" },
  ]);
});

test("GET /admin/api/player-count preserves workspaceId in the access requirement", async () => {
  const { capture, access } = createCapturingAccess();
  const handler = createAdminApiHandler({
    stores: createStores(),
    discordBotToken: "token",
    adminAccess: access,
  });

  const response = await handler(
    new Request("https://example.com/admin/api/player-count?workspaceId=ws-1&guildId=guild-1"),
    new URL("https://example.com/admin/api/player-count?workspaceId=ws-1&guildId=guild-1"),
  );

  assert.equal(response?.status, 403);
  assert.deepEqual(capture.requirements, [
    { mode: "read", guildId: "guild-1", workspaceId: "ws-1" },
  ]);
});

test("GET /admin/api/player-link preserves workspaceId in the access requirement", async () => {
  const { capture, access } = createCapturingAccess();
  const handler = createAdminApiHandler({
    stores: createStores(),
    discordBotToken: "token",
    adminAccess: access,
  });

  const response = await handler(
    new Request("https://example.com/admin/api/player-link?workspaceId=ws-1&guildId=guild-1"),
    new URL("https://example.com/admin/api/player-link?workspaceId=ws-1&guildId=guild-1"),
  );

  assert.equal(response?.status, 403);
  assert.deepEqual(capture.requirements, [
    { mode: "read", guildId: "guild-1", workspaceId: "ws-1" },
  ]);
});

test("GET /admin/api/player-link preserves workspaceId in the access requirement", async () => {
  const { capture, access } = createCapturingAccess();
  const handler = createAdminApiHandler({
    stores: createStores(),
    discordBotToken: "token",
    adminAccess: access,
  });

  const response = await handler(
    new Request(
      "https://example.com/admin/api/player-link?workspaceId=ws-1&guildId=guild-1&platform=xbox",
    ),
    new URL(
      "https://example.com/admin/api/player-link?workspaceId=ws-1&guildId=guild-1&platform=xbox",
    ),
  );

  assert.equal(response?.status, 403);
  assert.deepEqual(capture.requirements, [
    { mode: "read", guildId: "guild-1", workspaceId: "ws-1" },
  ]);
});

test("POST /admin/api/player-link/config saves Xbox settings for the selected guild", async () => {
  let savedConfig: PlatformLinkConfig | null = null;
  const handler = createAdminApiHandler({
    stores: {
      ...(createStores() as Record<string, unknown>),
      platformLink: {
        readPlatformLinkConfig: async () => null,
        upsertPlatformLinkConfig: async (config: PlatformLinkConfig) => {
          savedConfig = config;
        },
        listPlatformLinks: async () => [],
      },
    } as never,
    discordBotToken: "token",
    adminAccess: createAllowingAccess(),
  });

  const response = await handler(
    new Request("https://example.com/admin/api/player-link/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: "ws-1",
        guildId: "guild-1",
        platform: "xbox",
        linkedRoleId: "role-1",
        logChannelId: "channel-1",
        panelTitle: "Link your Xbox account",
        panelDescription: "Sign in with Xbox.",
        panelButtonLabel: "Link Xbox",
        panelButtonStyle: "Success",
        allowRelink: true,
        allowMultipleLinks: false,
        requireRelinkOnRejoin: true,
        whoisFields: ["profile"],
        customLinks: [],
      }),
    }),
    new URL("https://example.com/admin/api/player-link/config"),
  );

  assert.equal(response?.status, 200);
  const savedUpdatedAt = (savedConfig as PlatformLinkConfig | null)?.updatedAtMs;
  assert.deepEqual(savedConfig, {
    guildId: "guild-1",
    platform: "xbox",
    linkedRoleId: "role-1",
    logChannelId: "channel-1",
    gameAppIds: [],
    panelTitle: "Link your Xbox account",
    panelDescription: "Sign in with Xbox.",
    panelButtonLabel: "Link Xbox",
    panelButtonStyle: "Success",
    panelColor: 0x107c10,
    allowRelink: true,
    allowMultipleLinks: false,
    requireRelinkOnRejoin: true,
    whoisFields: ["profile"],
    customLinks: [],
    panelChannelId: null,
    panelMessageId: null,
    updatedAtMs: savedUpdatedAt,
  });
});

test("POST /admin/api/player-link/config rejects foreign Guild resources generically", async () => {
  let savedConfig: PlatformLinkConfig | null = null;
  const handler = createAdminApiHandler({
    stores: {
      ...(createStores() as Record<string, unknown>),
      platformLink: {
        readPlatformLinkConfig: async () => null,
        upsertPlatformLinkConfig: async (config: PlatformLinkConfig) => {
          savedConfig = config;
        },
        listPlatformLinks: async () => [],
      },
    } as never,
    discordBotToken: "token",
    adminAccess: createAllowingAccess(),
    guildResources: createStaticGuildResourceValidator({
      guilds: {
        "guild-1": {
          channels: [testChannel("own-text", 0, "guild-1")],
          roles: [testRole("own-role")],
        },
        "guild-2": {
          channels: [testChannel("foreign-text", 0, "guild-2")],
          roles: [testRole("foreign-role")],
        },
      },
    }),
  });

  const response = await handler(
    new Request("https://example.com/admin/api/player-link/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        guildId: "guild-1",
        platform: "xbox",
        linkedRoleId: "foreign-role",
        logChannelId: null,
        panelTitle: "Link Xbox",
        panelDescription: "Link your account.",
        panelButtonLabel: "Link",
        panelButtonStyle: "Success",
        allowRelink: true,
        allowMultipleLinks: false,
        whoisFields: [],
        customLinks: [],
      }),
    }),
    new URL("https://example.com/admin/api/player-link/config"),
  );

  assert.equal(response?.status, 400);
  const body = (await response!.json()) as { error: string };
  assert.equal(body.error, "Invalid Discord resource.");
  assert.equal(body.error.includes("foreign-role"), false);
  assert.equal(savedConfig, null);
});

test("POST /admin/api/player-link/publish rejects a foreign Guild channel before Discord", async () => {
  let savedConfig: PlatformLinkConfig | null = null;
  let discordCalls = 0;
  const existing: PlatformLinkConfig = {
    guildId: "guild-1",
    platform: "xbox",
    linkedRoleId: null,
    logChannelId: null,
    gameAppIds: [],
    panelTitle: "Link Xbox",
    panelDescription: "Link your account.",
    panelButtonLabel: "Link",
    panelButtonStyle: "Success",
    panelColor: 0x107c10,
    allowRelink: true,
    allowMultipleLinks: false,
    requireRelinkOnRejoin: false,
    whoisFields: [],
    customLinks: [],
    panelChannelId: null,
    panelMessageId: null,
    updatedAtMs: 1,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    discordCalls += 1;
    return new Response("{}", { status: 200 });
  };
  try {
    const handler = createAdminApiHandler({
      stores: {
        ...(createStores() as Record<string, unknown>),
        platformLink: {
          readPlatformLinkConfig: async () => existing,
          upsertPlatformLinkConfig: async (config: PlatformLinkConfig) => {
            savedConfig = config;
          },
          listPlatformLinks: async () => [],
        },
      } as never,
      discordBotToken: "token",
      adminAccess: createAllowingAccess(),
      guildResources: createStaticGuildResourceValidator({
        guilds: {
          "guild-1": { channels: [testChannel("own-text", 0, "guild-1")], roles: [] },
          "guild-2": { channels: [testChannel("foreign-text", 0, "guild-2")], roles: [] },
        },
      }),
    });

    const response = await handler(
      new Request("https://example.com/admin/api/player-link/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          guildId: "guild-1",
          platform: "xbox",
          panelChannelId: "foreign-text",
        }),
      }),
      new URL("https://example.com/admin/api/player-link/publish"),
    );

    assert.equal(response?.status, 400);
    assert.equal(discordCalls, 0);
    assert.equal(savedConfig, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GET /admin/api/permissions/diagnostics preserves workspaceId in the access requirement", async () => {
  const { capture, access } = createCapturingAccess();
  const handler = createAdminApiHandler({
    stores: createStores(),
    discordBotToken: "token",
    adminAccess: access,
  });

  const response = await handler(
    new Request(
      "https://example.com/admin/api/permissions/diagnostics?workspaceId=ws-1&guildId=guild-1",
    ),
    new URL(
      "https://example.com/admin/api/permissions/diagnostics?workspaceId=ws-1&guildId=guild-1",
    ),
  );

  assert.equal(response?.status, 403);
  assert.deepEqual(capture.requirements, [
    { mode: "read", guildId: "guild-1", workspaceId: "ws-1" },
  ]);
});

test("GET /admin/api/permissions/diagnostics returns 403 when workspaceId doesn't own guildId", async () => {
  const handler = createAdminApiHandler({
    stores: createStores(),
    discordBotToken: "token",
    adminAccess: {
      authorize() {
        return Promise.resolve({
          ok: false as const,
          error: {
            _tag: "Forbidden" as const,
            message: "Guild is not linked to this workspace.",
          },
        });
      },
    },
  });

  const response = await handler(
    new Request(
      "https://example.com/admin/api/permissions/diagnostics?workspaceId=ws-1&guildId=guild-1",
    ),
    new URL(
      "https://example.com/admin/api/permissions/diagnostics?workspaceId=ws-1&guildId=guild-1",
    ),
  );

  assert.equal(response?.status, 403);
  assert.equal(
    ((await response?.json()) as { error: string } | undefined)?.error,
    "Guild is not linked to this workspace.",
  );
});

for (const workspace of [true, false]) {
  test(`plan001: GET /admin/api/permissions ${workspace ? "preserves" : "omits"} workspaceId in the access requirement`, async () => {
    const { capture, access } = createCapturingAccess();
    const handler = createAdminApiHandler({
      stores: createStores(),
      discordBotToken: "token",
      adminAccess: access,
    });
    const url = new URL(
      `https://example.com/admin/api/permissions?guildId=guild-1&feature=blocklist${workspace ? "&workspaceId=ws-1" : ""}`,
    );
    const response = await handler(new Request(url), url);
    assert.equal(response?.status, 403);
    assert.deepEqual(capture.requirements, [
      workspace
        ? { mode: "read", guildId: "guild-1", workspaceId: "ws-1" }
        : { mode: "read", guildId: "guild-1" },
    ]);
  });
}

function createCapturingAccess(): {
  capture: { requirements: AdminAccessRequirement[] };
  access: AdminAccess;
} {
  const requirements: AdminAccessRequirement[] = [];
  return {
    capture: { requirements },
    access: {
      authorize(_request: Request, requirement: AdminAccessRequirement) {
        requirements.push(requirement);
        return Promise.resolve({
          ok: false as const,
          error: { _tag: "Forbidden" as const, message: "test-stop" },
        });
      },
    },
  };
}

function createAllowingAccess() {
  return {
    authorize() {
      return Promise.resolve({ ok: true as const });
    },
  };
}

function createAdminRouteServices() {
  return {
    gatewayService: {} as never,
    adminOverviewService: {} as never,
    blocklistService: {} as never,
    timedRoleService: {} as never,
  };
}

function createStores(options?: {
  readEntitlement?: (guildId: string) => Promise<{ tier: "free" | "premium"; updatedAtMs: number }>;
}) {
  return {
    blocklist: {
      readConfig: async () => ({ botUserId: "bot-1", guilds: {} }),
    },
    timedRoles: {
      listTimedRolesByGuild: async () => [],
    },
    tickets: {
      readTicketPanelConfig: async () => null,
      upsertTicketPanelConfig: async () => {},
    },
    marketplace: {
      readMarketplaceConfig: async () => null,
      listMarketplacePosts: async () => [],
      listMarketplaceLogs: async () => [],
      upsertMarketplaceConfig: async () => {},
      closeMarketplacePost: async () => null,
    },
    lfg: {
      readLfgConfig: async () => null,
      listLfgPosts: async () => [],
      countActiveLfgPosts: async () => 0,
      upsertLfgConfig: async () => {},
      closeLfgPost: async () => null,
      updateLfgPost: async () => {},
      listDueLfgPostExpiries: async () => [],
      listDueLfgRenewalReminders: async () => [],
    },
    playerCount: {
      listPlayerCountServers: async () => [],
      readPlayerCountServer: async () => null,
      upsertPlayerCountServer: async () => {},
      deletePlayerCountServer: async () => false,
    },
    appConfig: {
      upsertAppConfig: async () => {},
    },
    guildRbac: {
      readGuildAdminRoleId: async () => null,
      upsertGuildAdminRoleId: async () => {},
    },
    steamLink: {
      readSteamLinkConfig: async () => null,
      upsertSteamLinkConfig: async () => {},
      listSteamLinks: async () => [],
    },
    webhookProxy: {
      listWebhookProxyConfigs: async () => [],
      readWebhookProxyConfig: async () => null,
      upsertWebhookProxyConfig: async () => {},
      deleteWebhookProxyConfig: async () => {},
      listWebhookProxyForwardLogs: async () => [],
    },
    guildEntitlements: {
      readGuildEntitlement: options?.readEntitlement
        ? async (guildId: string) => ({ guildId, ...(await options.readEntitlement!(guildId)) })
        : async (guildId: string) => ({ guildId, tier: "free" as const, updatedAtMs: 0 }),
    },
    guildR2Objects: {
      getGuildUsageBytes: async () => 0,
    },
    evidenceVault: {
      readConfig: async () => null,
      upsertConfig: async () => {},
    },
  } as never;
}
