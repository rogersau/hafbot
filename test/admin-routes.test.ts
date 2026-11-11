import { adminErrorResponse } from "./support/admin-error-response";
/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- The worker typecheck config omits Node built-ins and full node:test types conflict with Workers globals; tsconfig.tests provides the runtime test types.
import test from "node:test";
import { createLegacyAdminSessionCookie as createAdminSessionCookie } from "./support/legacy-admin-session";

import worker from "./support/application";
import {
  createAdminApiHandler as createBaseAdminApiHandler,
  type AdminApiHandlerOptions,
} from "../src/runtime/admin-api";
import { createAdminSpaRoutes } from "../src/runtime/admin-spa-routes";
import { createAdminApiHandler as createTestAdminApiHandler } from "./helpers/admin-api";
import type { AdminAccessRequirement } from "../src/runtime/admin-access";
import type { AdminSpaRouteOptions } from "../src/runtime/admin-spa-routes";
import { QuantityLimitError } from "../src/runtime/entitlement-checks";
import { createPermissiveGuildResourceValidator } from "./helpers/guild-resource-validator";
import { allowAllAdminAccess } from "./helpers/admin-api";

type TestAdminRouteOptions = AdminSpaRouteOptions &
  Partial<Omit<AdminApiHandlerOptions, "services">>;

function createAdminRoutes(options: TestAdminRouteOptions) {
  const api = createTestAdminApiHandler({
    ...options,
    stores: options.stores ?? ({} as never),
    discordBotToken: options.discordBotToken ?? "test-token",
    adminAccess: options.adminAccess ?? allowAllAdminAccess,
    guildResources: options.guildResources ?? createPermissiveGuildResourceValidator(),
  });
  const spa = createAdminSpaRoutes(options);
  return (request: Request) => {
    const url = new URL(request.url);
    return url.pathname.startsWith("/admin/api/") ? api(request, url) : spa(request);
  };
}

test("worker redirects unauthenticated nested dashboard routes to Discord login", async () => {
  const response = await worker.fetch(
    new Request("https://worker.example/admin/guild-1/tickets"),
    createEnv(),
    {} as ExecutionContext,
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/admin/login?next=%2Fadmin%2Fguild-1%2Ftickets");
});

test("worker redirects the unauthenticated admin home route to Discord login", async () => {
  const response = await worker.fetch(
    new Request("https://worker.example/admin"),
    createEnv(),
    {} as ExecutionContext,
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/admin/login");
});

test("worker redirects the unauthenticated billing dashboard route to Discord login", async () => {
  const response = await worker.fetch(
    new Request("https://worker.example/admin/billing"),
    createEnv(),
    {} as ExecutionContext,
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/admin/login?next=%2Fadmin%2Fbilling");
});

test("worker rejects the legacy signed HTTP reaction ingress path", async () => {
  const response = await worker.fetch(
    new Request("https://worker.example", { method: "POST", body: "{}" }),
    createEnv(),
    {} as ExecutionContext,
  );

  assert.equal(response.status, 404);
});

test("worker returns 404 for an unknown admin API", async () => {
  const response = await worker.fetch(
    new Request("https://worker.example/admin/api/not-a-route"),
    createEnv(),
    {} as ExecutionContext,
  );

  assert.equal(response.status, 404);
});

test("Admin API requires registry dependencies at construction", () => {
  const spaOptions: AdminSpaRouteOptions = {
    redirect: (location) => new Response(null, { status: 302, headers: { location } }),
    getAdminLoginLocation: () => "/admin/login",
    renderAdminShell: () => new Response("ok"),
    isAdminUiAuthorized: async () => true,
  };

  assert.throws(
    () =>
      createBaseAdminApiHandler({
        ...spaOptions,
        discordBotToken: "test-token",
        adminAccess: allowAllAdminAccess,
      } as never),
    /stores are required/,
  );
  assert.throws(
    () =>
      createBaseAdminApiHandler({
        ...spaOptions,
        stores: {} as never,
        discordBotToken: "",
        adminAccess: allowAllAdminAccess,
      } as never),
    /Discord bot token is required/,
  );
  assert.throws(
    () =>
      createBaseAdminApiHandler({
        ...spaOptions,
        stores: {} as never,
        discordBotToken: "test-token",
      } as never),
    /authorizer is required/,
  );
});

function createEnv(options?: {
  DISCORD_APPLICATION_ID?: string;
  HAF_ADMIN_GUILD_ID?: string;
  HAF_DB?: D1Database;
  HAF_MAINTENANCE_MODE?: string;
  gatewayFetch?: (input: Request | string | URL, init?: RequestInit) => Response;
}) {
  return {
    DISCORD_BOT_TOKEN: "bot-token",
    GATEWAY_ENABLED: "true",
    BOT_USER_ID: "bot-user-id",
    DISCORD_PUBLIC_KEY: "a".repeat(64),
    COMPONENT_ID_SIGNING_SECRET: "component-id-signing-secret-for-production-tests",
    DISCORD_APPLICATION_ID: options?.DISCORD_APPLICATION_ID,
    HAF_ADMIN_GUILD_ID: options?.HAF_ADMIN_GUILD_ID,
    HAF_MAINTENANCE_MODE: options?.HAF_MAINTENANCE_MODE,
    HAF_DB: options?.HAF_DB ?? createMockD1Database(),
    GATEWAY_SESSION_DO: {
      idFromName() {
        return "gateway-session-id" as never;
      },
      get() {
        return {
          fetch: async (input: Request | string | URL, init?: RequestInit) =>
            options?.gatewayFetch?.(input, init) ?? Response.json({ status: "idle" }),
        };
      },
    } as never,
    GATEWAY_EVENT_QUEUE: { send: async () => undefined } as never,
  } as never;
}

function createMockD1Database(): D1Database {
  return {
    prepare() {
      return {
        bind() {
          return this;
        },
        first() {
          return Promise.resolve(null);
        },
        all() {
          return Promise.resolve({ results: [], success: true, meta: {} as never });
        },
        raw() {
          return Promise.resolve([]);
        },
        run() {
          return Promise.resolve({ success: true, meta: {} as never });
        },
      } as never;
    },
    exec() {
      return Promise.resolve({} as never);
    },
    batch() {
      return Promise.resolve([]);
    },
    dump() {
      return Promise.resolve(new ArrayBuffer(0));
    },
    withSession() {
      return this as unknown as D1Database;
    },
  } as unknown as D1Database;
}

test("worker returns 401 for /admin/api/* without a customer session", async () => {
  const response = await worker.fetch(
    new Request("https://worker.example/admin/api/blocklist?guildId=guild-1"),
    createEnv(),
    {} as ExecutionContext,
  );

  assert.equal(response.status, 401);
  const body = (await response.json()) as { error: string };
  assert.equal(body.error, "Unauthorized");
});

test("worker does not expose the retired global app config route", async () => {
  const response = await worker.fetch(
    new Request("https://worker.example/admin/api/config"),
    createEnv(),
    {} as ExecutionContext,
  );

  assert.equal(response.status, 404);
});

test("POST /admin/api/blocklist validates JSON before calling the blocklist workflow", async () => {
  const route = createAdminRoutes({
    adminRouteServices: {
      gatewayService: {} as never,
      adminOverviewService: {} as never,
      blocklistService: {
        applyMutation: async () => {
          throw new Error("should not be called");
        },
      } as never,
      timedRoleService: {} as never,
    },
    redirect: (location) => new Response(null, { status: 302, headers: { location } }),
    getAdminLoginLocation: () => "/admin/login",
    renderAdminShell: () => new Response("ok"),
    isAdminUiAuthorized: async () => true,
  });

  const response = await route(
    new Request("https://example.com/admin/api/blocklist", {
      method: "POST",
      body: JSON.stringify({ guildId: 123 }),
    }),
  );

  assert.equal(response?.status, 400);
});

test("GET /admin/api/overview passes refresh requests to the overview service", async () => {
  const refreshValues: unknown[] = [];
  const route = createAdminRoutes({
    adminRouteServices: {
      gatewayService: {} as never,
      adminOverviewService: {
        getOverview: async (refresh?: boolean) => {
          refreshValues.push(refresh);
          return { gateway: { status: "ready" }, guilds: [] };
        },
      } as never,
      blocklistService: {} as never,
      timedRoleService: {} as never,
    },
    redirect: (location) => new Response(null, { status: 302, headers: { location } }),
    getAdminLoginLocation: () => "/admin/login",
    renderAdminShell: () => new Response("ok"),
    isAdminUiAuthorized: async () => true,
  });

  const response = await route(new Request("https://example.com/admin/api/overview?refresh=1"));

  assert.equal(response?.status, 200);
  assert.deepEqual(refreshValues, [true]);
});

test("GET /admin/api/overview delegates read access through the admin access seam", async () => {
  const authorizations: Array<{ url: string; options: unknown }> = [];
  const route = createAdminRoutes({
    adminRouteServices: {
      gatewayService: {} as never,
      adminOverviewService: {
        getOverview: async () => ({ gateway: { status: "ready" }, guilds: [] }),
      } as never,
      blocklistService: {} as never,
      timedRoleService: {} as never,
    },
    adminAccess: {
      authorize(request: Request, options: AdminAccessRequirement) {
        authorizations.push({ url: request.url, options });
        return Promise.resolve({ ok: true as const });
      },
    },
    redirect: (location) => new Response(null, { status: 302, headers: { location } }),
    getAdminLoginLocation: () => "/admin/login",
    renderAdminShell: () => new Response("ok"),
    isAdminUiAuthorized: async () => true,
  });

  const response = await route(new Request("https://example.com/admin/api/overview"));

  assert.equal(response?.status, 200);
  assert.deepEqual(authorizations, [
    {
      url: "https://example.com/admin/api/overview",
      options: { mode: "read", allowGuildAdminDirectory: true },
    },
  ]);
});

test("GET /admin/api/overview preserves denied responses from the admin access seam", async () => {
  const route = createAdminRoutes({
    adminRouteServices: {
      gatewayService: {} as never,
      adminOverviewService: {
        getOverview: async () => {
          throw new Error("overview service should not run for denied requests");
        },
      } as never,
      blocklistService: {} as never,
      timedRoleService: {} as never,
    },
    adminAccess: {
      authorize() {
        return Promise.resolve({
          ok: false as const,
          error: { _tag: "Forbidden" as const, message: "Forbidden" },
        });
      },
    },
    redirect: (location) => new Response(null, { status: 302, headers: { location } }),
    getAdminLoginLocation: () => "/admin/login",
    renderAdminShell: () => new Response("ok"),
    isAdminUiAuthorized: async () => true,
  });

  const response = await route(new Request("https://example.com/admin/api/overview"));

  assert.equal(response?.status, 403);
  assert.equal(((await response?.json()) as { error: string } | undefined)?.error, "Forbidden");
});

test("GET /admin/api/workspaces returns the current user's workspaces", async () => {
  const route = createAdminRoutes({
    adminRouteServices: {
      gatewayService: {} as never,
      adminOverviewService: {} as never,
      blocklistService: {} as never,
      timedRoleService: {} as never,
    },
    workspaceApi: {
      listWorkspaces: async () => ({
        workspaces: [
          { id: "workspace-1", name: "Workspace One", slug: "workspace-one", role: "owner" },
        ],
      }),
    } as never,
    redirect: (location) => new Response(null, { status: 302, headers: { location } }),
    getAdminLoginLocation: () => "/admin/login",
    renderAdminShell: () => new Response("ok"),
    isAdminUiAuthorized: async () => true,
  });

  const response = await route(new Request("https://example.com/admin/api/workspaces"));

  assert.equal(response?.status, 200);
  assert.deepEqual(await response?.json(), {
    workspaces: [
      { id: "workspace-1", name: "Workspace One", slug: "workspace-one", role: "owner" },
    ],
  });
});

test("POST /admin/api/workspace-guilds requires an owner or admin", async () => {
  const route = createAdminRoutes({
    adminRouteServices: {
      gatewayService: {} as never,
      adminOverviewService: {} as never,
      blocklistService: {} as never,
      timedRoleService: {} as never,
    },
    workspaceApi: {
      linkGuild: async () => adminErrorResponse("Forbidden", 403),
    } as never,
    redirect: (location) => new Response(null, { status: 302, headers: { location } }),
    getAdminLoginLocation: () => "/admin/login",
    renderAdminShell: () => new Response("ok"),
    isAdminUiAuthorized: async () => true,
  });

  const response = await route(
    new Request("https://example.com/admin/api/workspace-guilds", {
      method: "POST",
      body: JSON.stringify({ workspaceId: "workspace-1", guildId: "guild-1" }),
    }),
  );

  assert.equal(response?.status, 403);
});

test("workspace API endpoints return 404 when workspace administration is not configured", async () => {
  const route = createWorkspaceTestRoute();
  const requests = [
    new Request("https://example.com/admin/api/workspaces"),
    new Request("https://example.com/admin/api/workspace-guilds?workspaceId=workspace-1"),
    new Request("https://example.com/admin/api/workspace-guilds", {
      method: "POST",
      body: JSON.stringify({ workspaceId: "workspace-1", guildId: "guild-1" }),
    }),
    new Request("https://example.com/admin/api/workspace-guilds/delete", {
      method: "POST",
      body: JSON.stringify({ workspaceId: "workspace-1", guildId: "guild-1" }),
    }),
  ];

  for (const request of requests) {
    const response = await route(request);

    assert.equal(response?.status, 404);
    assert.equal(
      ((await response?.json()) as { error: string } | undefined)?.error,
      "Workspace administration is not configured.",
    );
  }
});

test("GET /admin/api/workspace-guilds requires a workspaceId query parameter", async () => {
  const route = createWorkspaceTestRoute({
    listWorkspaceGuilds: async () => {
      throw new Error("should not be called");
    },
  });

  const response = await route(new Request("https://example.com/admin/api/workspace-guilds"));

  assert.equal(response?.status, 400);
  const body = (await response?.json()) as { error: string; fieldIssues?: Array<{ path: string }> };
  assert.equal(body.error, "Invalid request query");
  assert.ok(body.fieldIssues?.some((issue) => issue.path === "workspaceId"));
});

test("GET /admin/api/workspace-guilds delegates to the workspace API", async () => {
  const calls: Array<{ requestUrl: string; workspaceId: string }> = [];
  const route = createWorkspaceTestRoute({
    listWorkspaceGuilds: async (request: Request, workspaceId: string) => {
      calls.push({ requestUrl: request.url, workspaceId });
      return {
        workspaceId,
        guilds: [
          {
            workspaceId,
            guildId: "guild-1",
            linkedByUserId: "user-1",
            linkedAtMs: 123,
          },
        ],
      };
    },
  });

  const response = await route(
    new Request("https://example.com/admin/api/workspace-guilds?workspaceId=workspace-1"),
  );

  assert.equal(response?.status, 200);
  assert.deepEqual(await response?.json(), {
    workspaceId: "workspace-1",
    guilds: [
      {
        workspaceId: "workspace-1",
        guildId: "guild-1",
        linkedByUserId: "user-1",
        linkedAtMs: 123,
      },
    ],
  });
  assert.deepEqual(calls, [
    {
      requestUrl: "https://example.com/admin/api/workspace-guilds?workspaceId=workspace-1",
      workspaceId: "workspace-1",
    },
  ]);
});

test("POST /admin/api/workspace-guilds delegates to the workspace API", async () => {
  const calls: Array<{ method: string; pathname: string; body: string }> = [];
  const route = createWorkspaceTestRoute({
    linkGuild: async (request: Request) => {
      const url = new URL(request.url);
      calls.push({
        method: request.method,
        pathname: url.pathname,
        body: await request.text(),
      });
      return Response.json({ ok: true });
    },
  });

  const body = JSON.stringify({ workspaceId: "workspace-1", guildId: "guild-1" });
  const response = await route(
    new Request("https://example.com/admin/api/workspace-guilds", {
      method: "POST",
      body,
    }),
  );

  assert.equal(response?.status, 200);
  assert.deepEqual(await response?.json(), { ok: true });
  assert.deepEqual(calls, [
    {
      method: "POST",
      pathname: "/admin/api/workspace-guilds",
      body,
    },
  ]);
});

test("POST /admin/api/workspace-guilds/delete delegates to the workspace API", async () => {
  const calls: string[] = [];
  const route = createWorkspaceTestRoute({
    unlinkGuild: async (request: Request) => {
      calls.push(await request.text());
      return Response.json({ ok: true });
    },
  });

  const response = await route(
    new Request("https://example.com/admin/api/workspace-guilds/delete", {
      method: "POST",
      body: JSON.stringify({ workspaceId: "workspace-1", guildId: "guild-1" }),
    }),
  );

  assert.equal(response?.status, 200);
  assert.deepEqual(await response?.json(), { ok: true });
  assert.deepEqual(calls, [JSON.stringify({ workspaceId: "workspace-1", guildId: "guild-1" })]);
});

test("GET /admin/api/blocklist requires linked guild access", async () => {
  const route = createAdminRoutes({
    adminRouteServices: {
      gatewayService: {} as never,
      adminOverviewService: {} as never,
      blocklistService: {
        getGuildBlocklist: async () => ({ enabled: true, emojis: [] }),
        getGuildNotificationChannel: async () => null,
      } as never,
      timedRoleService: {} as never,
    },
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
    redirect: (location) => new Response(null, { status: 302, headers: { location } }),
    getAdminLoginLocation: () => "/admin/login",
    renderAdminShell: () => new Response("ok"),
    isAdminUiAuthorized: async () => true,
  });

  const response = await route(
    new Request("https://example.com/admin/api/blocklist?workspaceId=workspace-1&guildId=guild-1"),
  );

  assert.equal(response?.status, 403);
});

test("viewer cannot mutate blocklist", async () => {
  const route = createAdminRoutes({
    adminRouteServices: {
      gatewayService: {} as never,
      adminOverviewService: {} as never,
      blocklistService: {
        addEmoji: async () => {
          throw new Error("should not be called");
        },
      } as never,
      timedRoleService: {} as never,
    },
    adminAccess: {
      authorize(_request: Request, options: AdminAccessRequirement) {
        return options.mode === "write"
          ? Promise.resolve({
              ok: false as const,
              error: { _tag: "Forbidden" as const, message: "Forbidden" },
            })
          : Promise.resolve({ ok: true as const });
      },
    },
    redirect: (location) => new Response(null, { status: 302, headers: { location } }),
    getAdminLoginLocation: () => "/admin/login",
    renderAdminShell: () => new Response("ok"),
    isAdminUiAuthorized: async () => true,
  });

  const response = await route(
    new Request("https://example.com/admin/api/blocklist", {
      method: "POST",
      body: JSON.stringify({
        workspaceId: "workspace-1",
        guildId: "guild-1",
        emoji: "😀",
        action: "add",
      }),
    }),
  );

  assert.equal(response?.status, 403);
});

test("GET /admin/api/blocklist returns the guild channel filter", async () => {
  const route = createAdminRoutes({
    adminRouteServices: {
      gatewayService: {} as never,
      adminOverviewService: {} as never,
      blocklistService: {
        getGuildBlocklist: async () => ({
          enabled: true,
          emojis: ["✅"],
          channelMode: "exclude",
          channelIds: ["channel-9"],
        }),
        getGuildNotificationChannel: async () => "log-channel-1",
      } as never,
      timedRoleService: {} as never,
    },
    adminAccess: {
      authorize() {
        return Promise.resolve({ ok: true as const });
      },
    },
    redirect: (location) => new Response(null, { status: 302, headers: { location } }),
    getAdminLoginLocation: () => "/admin/login",
    renderAdminShell: () => new Response("ok"),
    isAdminUiAuthorized: async () => true,
  });

  const response = await route(
    new Request("https://example.com/admin/api/blocklist?workspaceId=workspace-1&guildId=guild-1"),
  );

  assert.equal(response?.status, 200);
  assert.deepEqual(await response?.json(), {
    guildId: "guild-1",
    enabled: true,
    emojis: ["✅"],
    channelMode: "exclude",
    channelIds: ["channel-9"],
    notificationChannelId: "log-channel-1",
  });
});

test("POST /admin/api/blocklist-channel-filter validates and saves the filter", async () => {
  const calls: Array<{
    guildId: string;
    channelMode: "include" | "exclude";
    channelIds: string[];
  }> = [];
  const authorizations: unknown[] = [];
  const route = createAdminRoutes({
    adminRouteServices: {
      gatewayService: {} as never,
      adminOverviewService: {} as never,
      blocklistService: {
        updateGuildChannelFilter: async (
          guildId: string,
          channelMode: "include" | "exclude",
          channelIds: string[],
        ) => {
          calls.push({ guildId, channelMode, channelIds });
        },
      } as never,
      timedRoleService: {} as never,
    },
    adminAccess: {
      authorize(_request: Request, options: AdminAccessRequirement) {
        authorizations.push(options);
        return Promise.resolve({ ok: true as const });
      },
    },
    redirect: (location) => new Response(null, { status: 302, headers: { location } }),
    getAdminLoginLocation: () => "/admin/login",
    renderAdminShell: () => new Response("ok"),
    isAdminUiAuthorized: async () => true,
  });

  const response = await route(
    new Request("https://example.com/admin/api/blocklist-channel-filter", {
      method: "POST",
      body: JSON.stringify({
        workspaceId: "workspace-1",
        guildId: "guild-1",
        channelMode: "include",
        channelIds: ["channel-1", "channel-2"],
      }),
    }),
  );

  assert.equal(response?.status, 200);
  assert.deepEqual(await response?.json(), { ok: true });
  assert.deepEqual(calls, [
    { guildId: "guild-1", channelMode: "include", channelIds: ["channel-1", "channel-2"] },
  ]);
  assert.deepEqual(authorizations, [
    { mode: "write", guildId: "guild-1", workspaceId: "workspace-1" },
  ]);
});

test("POST /admin/api/blocklist delegates write access through the admin access seam", async () => {
  const authorizations: AdminAccessRequirement[] = [];
  const calls: Array<{ guildId: string; emoji: string[] }> = [];
  const route = createAdminRoutes({
    adminRouteServices: {
      gatewayService: {} as never,
      adminOverviewService: {} as never,
      blocklistService: {
        addEmojis: async (guildId: string, emoji: string[]) => {
          calls.push({ guildId, emoji });
        },
      } as never,
      timedRoleService: {} as never,
    },
    adminAccess: {
      authorize(_request: Request, options: AdminAccessRequirement) {
        authorizations.push(options);
        return Promise.resolve({ ok: true as const });
      },
    },
    redirect: (location) => new Response(null, { status: 302, headers: { location } }),
    getAdminLoginLocation: () => "/admin/login",
    renderAdminShell: () => new Response("ok"),
    isAdminUiAuthorized: async () => true,
  });

  const response = await route(
    new Request("https://example.com/admin/api/blocklist", {
      method: "POST",
      body: JSON.stringify({ guildId: "guild-1", emoji: "✅", action: "add" }),
    }),
  );

  assert.equal(response?.status, 200);
  assert.deepEqual(await response?.json(), { ok: true });
  assert.deepEqual(authorizations, [{ mode: "write", guildId: "guild-1" }]);
  assert.deepEqual(calls, [{ guildId: "guild-1", emoji: ["✅"] }]);
});

test("POST /admin/api/blocklist preserves denied write responses from the admin access seam", async () => {
  const route = createAdminRoutes({
    adminRouteServices: {
      gatewayService: {} as never,
      adminOverviewService: {} as never,
      blocklistService: {
        addEmojis: async () => {
          throw new Error("blocklist mutation should not run for denied writes");
        },
      } as never,
      timedRoleService: {} as never,
    },
    adminAccess: {
      authorize() {
        return Promise.resolve({
          ok: false as const,
          error: { _tag: "Forbidden" as const, message: "Forbidden" },
        });
      },
    },
    redirect: (location) => new Response(null, { status: 302, headers: { location } }),
    getAdminLoginLocation: () => "/admin/login",
    renderAdminShell: () => new Response("ok"),
    isAdminUiAuthorized: async () => true,
  });

  const response = await route(
    new Request("https://example.com/admin/api/blocklist", {
      method: "POST",
      body: JSON.stringify({ guildId: "guild-1", emoji: "✅", action: "add" }),
    }),
  );

  assert.equal(response?.status, 403);
  assert.equal(((await response?.json()) as { error: string } | undefined)?.error, "Forbidden");
});

test("POST /admin/api/blocklist-channel-filter rejects invalid channelMode", async () => {
  const route = createAdminRoutes({
    adminRouteServices: {
      gatewayService: {} as never,
      adminOverviewService: {} as never,
      blocklistService: {
        updateGuildChannelFilter: async () => {
          throw new Error("should not save invalid filter");
        },
      } as never,
      timedRoleService: {} as never,
    },
    adminAccess: {
      authorize() {
        return Promise.resolve({ ok: true as const });
      },
    },
    redirect: (location) => new Response(null, { status: 302, headers: { location } }),
    getAdminLoginLocation: () => "/admin/login",
    renderAdminShell: () => new Response("ok"),
    isAdminUiAuthorized: async () => true,
  });

  const response = await route(
    new Request("https://example.com/admin/api/blocklist-channel-filter", {
      method: "POST",
      body: JSON.stringify({ guildId: "guild-1", channelMode: "other", channelIds: [] }),
    }),
  );

  assert.equal(response?.status, 400);
});

test("POST /admin/api/timed-roles/new-member-config saves a full multi-rule list", async () => {
  const savedConfigs: unknown[] = [];
  const route = createAdminRoutes({
    adminRouteServices: {
      gatewayService: {} as never,
      adminOverviewService: {} as never,
      blocklistService: {} as never,
      timedRoleService: {
        updateNewMemberTimedRoleConfig: async (config: unknown) => {
          savedConfigs.push(config);
        },
        getNewMemberTimedRoleConfig: async () => ({
          guildId: "guild-1",
          roles: [
            { roleId: "role-trial", durationInput: "2h" },
            { roleId: "role-newbie", durationInput: "1w" },
          ],
        }),
      } as never,
    },
    adminAccess: {
      authorize() {
        return Promise.resolve({ ok: true as const });
      },
    },
    redirect: (location) => new Response(null, { status: 302, headers: { location } }),
    getAdminLoginLocation: () => "/admin/login",
    renderAdminShell: () => new Response("ok"),
    isAdminUiAuthorized: async () => true,
  });

  const response = await route(
    new Request("https://example.com/admin/api/timed-roles/new-member-config", {
      method: "POST",
      body: JSON.stringify({
        guildId: "guild-1",
        roles: [
          { roleId: "role-trial", durationInput: "2h" },
          { roleId: "role-newbie", durationInput: "1w" },
        ],
      }),
    }),
  );

  assert.equal(response?.status, 200);
  assert.deepEqual(savedConfigs, [
    {
      guildId: "guild-1",
      roles: [
        { roleId: "role-trial", durationInput: "2h" },
        { roleId: "role-newbie", durationInput: "1w" },
      ],
    },
  ]);
  assert.deepEqual(await response?.json(), {
    newMemberRoleConfig: {
      guildId: "guild-1",
      roles: [
        { roleId: "role-trial", durationInput: "2h" },
        { roleId: "role-newbie", durationInput: "1w" },
      ],
    },
  });
});

test("POST /admin/api/timed-roles/manual-assignment-config rejects duplicate roles", async () => {
  const route = createAdminRoutes({
    adminRouteServices: {
      gatewayService: {} as never,
      adminOverviewService: {} as never,
      blocklistService: {} as never,
      timedRoleService: {
        updateManualAssignmentTimedRoleConfig: async () => {
          throw new Error("should not save duplicate roles");
        },
      } as never,
    },
    adminAccess: {
      authorize() {
        return Promise.resolve({ ok: true as const });
      },
    },
    redirect: (location) => new Response(null, { status: 302, headers: { location } }),
    getAdminLoginLocation: () => "/admin/login",
    renderAdminShell: () => new Response("ok"),
    isAdminUiAuthorized: async () => true,
  });

  const response = await route(
    new Request("https://example.com/admin/api/timed-roles/manual-assignment-config", {
      method: "POST",
      body: JSON.stringify({
        guildId: "guild-1",
        roles: [
          { roleId: "role-timeout", durationInput: "2h" },
          { roleId: "role-timeout", durationInput: "1w" },
        ],
      }),
    }),
  );

  assert.equal(response?.status, 400);
  assert.equal(
    ((await response?.json()) as { error: string } | undefined)?.error,
    "Duplicate roleId",
  );
});

test("POST /admin/api/blocklist adds each emoji from one add input", async () => {
  const addedEmojis: string[] = [];
  const route = createAdminRoutes({
    adminRouteServices: {
      gatewayService: {} as never,
      adminOverviewService: {} as never,
      blocklistService: {
        addEmoji: async (_guildId: string, emoji: string) => {
          addedEmojis.push(emoji);
          return { alreadyBlocked: false };
        },
        addEmojis: async (_guildId: string, emojis: string[]) => {
          addedEmojis.push(...emojis);
          return { added: emojis, alreadyBlocked: [] };
        },
      } as never,
      timedRoleService: {} as never,
    },
    adminAccess: {
      authorize() {
        return Promise.resolve({ ok: true as const });
      },
    },
    redirect: (location) => new Response(null, { status: 302, headers: { location } }),
    getAdminLoginLocation: () => "/admin/login",
    renderAdminShell: () => new Response("ok"),
    isAdminUiAuthorized: async () => true,
  });

  const response = await route(
    new Request("https://example.com/admin/api/blocklist", {
      method: "POST",
      body: JSON.stringify({
        workspaceId: "workspace-1",
        guildId: "guild-1",
        emoji: "✅ 🚫",
        action: "add",
      }),
    }),
  );

  assert.equal(response?.status, 200);
  assert.deepEqual(await response?.json(), { ok: true });
  assert.deepEqual(addedEmojis, ["✅", "🚫"]);
});

test("POST /admin/api/blocklist accepts a bounded batch emoji payload", async () => {
  const calls: Array<{ guildId: string; emojis: string[] }> = [];
  const route = createAdminRoutes({
    adminRouteServices: {
      gatewayService: {} as never,
      adminOverviewService: {} as never,
      blocklistService: {
        addEmojis: async (guildId: string, emojis: string[]) => {
          calls.push({ guildId, emojis });
          return { added: ["✅", "verified:111"], alreadyBlocked: ["🚫"] };
        },
        getGuildBlocklist: async () => ({
          enabled: true,
          emojis: ["🚫", "✅", "verified:111"],
          channelMode: "include" as const,
          channelIds: [],
        }),
      } as never,
      timedRoleService: {} as never,
    },
    adminAccess: {
      authorize() {
        return Promise.resolve({ ok: true as const });
      },
    },
    redirect: (location) => new Response(null, { status: 302, headers: { location } }),
    getAdminLoginLocation: () => "/admin/login",
    renderAdminShell: () => new Response("ok"),
    isAdminUiAuthorized: async () => true,
  });

  const response = await route(
    new Request("https://example.com/admin/api/blocklist", {
      method: "POST",
      body: JSON.stringify({
        guildId: "guild-1",
        action: "add",
        emojis: [" ✅ ", ":verified:111", "🚫"],
      }),
    }),
  );

  assert.equal(response?.status, 200);
  assert.deepEqual(calls, [{ guildId: "guild-1", emojis: [" ✅ ", ":verified:111", "🚫"] }]);
  assert.deepEqual(await response?.json(), {
    ok: true,
    added: ["✅", "verified:111"],
    alreadyBlocked: ["🚫"],
    blocklist: {
      enabled: true,
      emojis: ["🚫", "✅", "verified:111"],
      channelMode: "include",
      channelIds: [],
    },
  });
});

test("POST /admin/api/blocklist rejects a batch over the emoji bound before mutation", async () => {
  let called = false;
  const route = createAdminRoutes({
    adminRouteServices: {
      gatewayService: {} as never,
      adminOverviewService: {} as never,
      blocklistService: {
        addEmojis: async () => {
          called = true;
          return { added: [], alreadyBlocked: [] };
        },
      } as never,
      timedRoleService: {} as never,
    },
    adminAccess: {
      authorize() {
        return Promise.resolve({ ok: true as const });
      },
    },
    redirect: (location) => new Response(null, { status: 302, headers: { location } }),
    getAdminLoginLocation: () => "/admin/login",
    renderAdminShell: () => new Response("ok"),
    isAdminUiAuthorized: async () => true,
  });

  const response = await route(
    new Request("https://example.com/admin/api/blocklist", {
      method: "POST",
      body: JSON.stringify({
        guildId: "guild-1",
        action: "add",
        emojis: Array.from({ length: 51 }, (_, index) => `emoji-${index}`),
      }),
    }),
  );

  assert.equal(response?.status, 400);
  assert.equal(called, false);
});

test("POST /admin/api/blocklist returns the free-tier batch limit without reading after failure", async () => {
  let readAfterFailure = false;
  const route = createAdminRoutes({
    adminRouteServices: {
      gatewayService: {} as never,
      adminOverviewService: {} as never,
      blocklistService: {
        addEmojis: async () => {
          throw new QuantityLimitError(
            "Free servers can block up to 10 emojis. Upgrade to premium for unlimited blocklist entries.",
          );
        },
        getGuildBlocklist: async () => {
          readAfterFailure = true;
          return {
            enabled: true,
            emojis: [],
            channelMode: "include" as const,
            channelIds: [],
          };
        },
      } as never,
      timedRoleService: {} as never,
    },
    adminAccess: {
      authorize() {
        return Promise.resolve({ ok: true as const });
      },
    },
    redirect: (location) => new Response(null, { status: 302, headers: { location } }),
    getAdminLoginLocation: () => "/admin/login",
    renderAdminShell: () => new Response("ok"),
    isAdminUiAuthorized: async () => true,
  });

  const response = await route(
    new Request("https://example.com/admin/api/blocklist", {
      method: "POST",
      body: JSON.stringify({
        guildId: "guild-1",
        action: "add",
        emojis: ["✅", "🚫"],
      }),
    }),
  );

  assert.equal(response?.status, 400);
  const body = (await response?.json()) as { error: string };
  assert.equal(
    body.error,
    "Free servers can block up to 10 emojis. Upgrade to premium for unlimited blocklist entries.",
  );
  assert.equal(readAfterFailure, false);
});

test("legacy password login is no longer served from /admin/login", async () => {
  const response = await worker.fetch(
    new Request("https://worker.example/admin/login"),
    createEnv(),
    {} as ExecutionContext,
  );

  assert.equal(response.status, 200);
  assert.match(await response.text(), /Sign in with Discord/);
});

test("POST /admin/logout does not emit the retired global session cookie", async () => {
  const cookie = await createAdminSessionCookie("session-secret");
  const response = await worker.fetch(
    new Request("https://worker.example/admin/logout", {
      method: "POST",
      headers: { cookie },
    }),
    createEnv(),
    {} as ExecutionContext,
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/admin/login");
  assert.equal(response.headers.get("set-cookie"), null);
});

function createWorkspaceTestRoute(workspaceApi?: unknown) {
  return createAdminRoutes({
    adminRouteServices: {
      gatewayService: {} as never,
      adminOverviewService: {} as never,
      blocklistService: {} as never,
      timedRoleService: {} as never,
    },
    ...(workspaceApi === undefined ? {} : { workspaceApi: workspaceApi as never }),
    redirect: (location) => new Response(null, { status: 302, headers: { location } }),
    getAdminLoginLocation: () => "/admin/login",
    renderAdminShell: () => new Response("ok"),
    isAdminUiAuthorized: async () => true,
  });
}
