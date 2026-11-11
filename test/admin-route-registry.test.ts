/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import {
  defineRoute,
  dispatchAdminRoute,
  PUBLIC_ADMIN_ROUTE_ACCESS,
  type Route,
  checkRouteCollisions,
} from "../src/runtime/admin-route-registry";
import { createAdminRoutes } from "../src/runtime/admin-routes";
import { createAdminApiHandler as createRuntimeAdminApiHandler } from "../src/runtime/admin-api";
import { createServiceFactory } from "../src/runtime/service-factory";
import { allowAllAdminAccess, createAdminApiHandler } from "./helpers/admin-api";
import type { RuntimeStores } from "../src/runtime/app-types";
import { z } from "zod";
import {
  parseAdminBody,
  parseAdminQuery,
  type ParseError,
} from "../src/runtime/admin-route-parsers";
import type { ProductAnalyticsEvent } from "../src/product-analytics";

function createStubStores(): RuntimeStores {
  return {
    blocklist: {
      readConfig: async () => ({ guilds: {}, botUserId: "bot-1" }),
    },
    memberVerification: {
      readConfig: async () => null,
      upsertConfig: async () => {},
      readVerificationState: async () => null,
      upsertVerificationState: async () => {},
    },
  } as unknown as RuntimeStores;
}

function createDispatchOptions(
  overrides: Partial<{ adminAccess: any; features: any; stores: any }> = {},
) {
  return {
    adminAccess: allowAllAdminAccess,
    features: {
      lfg: true,
      marketplace: true,
      tickets: true,
      blocklist: true,
      timedRoles: true,
      webhookProxy: true,
      adminUi: true,
      playerCount: true,
      steamLink: true,
      evidenceVault: true,
    },
    stores: createStubStores(),
    ...overrides,
  };
}

test("createAdminRoutes joins each feature module's route array into a flat list", () => {
  const routes = createAdminRoutes({
    stores: createStubStores(),
    adminAccess: allowAllAdminAccess,
    discordBotToken: "test",
  });
  assert.ok(Array.isArray(routes));
  for (const entry of routes) {
    assert.equal(typeof entry.method, "string");
    assert.equal(typeof entry.path, "string");
    assert.ok(entry.access, `${entry.method} ${entry.path} must declare access`);
    assert.equal(typeof entry.handler, "function");
  }
});

test("service factory exposes feature services through the runtime seam", () => {
  const services = createServiceFactory({
    stores: {} as RuntimeStores,
    discordBotToken: "test-token",
  });

  for (const service of [
    services.blocklistService,
    services.timedRoleService,
    services.marketplaceService,
    services.lfgService,
    services.playerCountService,
    services.webhookProxyService,
    services.platformLinkService,
    services.evidenceVaultService,
    services.ticketPanelService,
    services.ticketLifecycle,
  ]) {
    assert.ok(service);
  }
});

test("defineRoute is a typed identity that returns the route entry unchanged", () => {
  const entry: Route<undefined, undefined, Response> = {
    method: "GET",
    path: "/admin/api/example",
    access: PUBLIC_ADMIN_ROUTE_ACCESS,
    handler: () => new Response("ok"),
  };

  assert.equal(defineRoute(entry), entry);
});

test("Dashboard mutation analytics uses exact route allowlists instead of path substrings", async () => {
  const events: ProductAnalyticsEvent[] = [];
  const body = z.object({ guildId: z.string(), enabled: z.boolean().optional() });
  const routes = [
    defineRoute({
      method: "POST",
      path: "/admin/api/tickets/panel",
      body,
      access: PUBLIC_ADMIN_ROUTE_ACCESS,
      handler: async () => Response.json({ saved: true }),
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/tickets/panel/publish",
      body,
      access: PUBLIC_ADMIN_ROUTE_ACCESS,
      handler: async () => Response.json({ published: true }),
    }),
  ];
  const options = {
    ...createDispatchOptions(),
    productAnalytics: { report: async (event: ProductAnalyticsEvent) => void events.push(event) },
  };

  for (const path of ["/admin/api/tickets/panel", "/admin/api/tickets/panel/publish"]) {
    await dispatchAdminRoute(
      routes,
      new Request(`https://example.com${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ guildId: "guild-1" }),
      }),
      options,
    );
  }

  assert.equal(events.length, 1);
  assert.equal(events[0]!.name, "dashboard_milestone");
  assert.equal(
    (events[0] as Extract<ProductAnalyticsEvent, { name: "dashboard_milestone" }>).action,
    "configuration_saved",
  );
});

test("Route interface accepts a body schema and propagates the inferred type to the handler", () => {
  type Body = { guildId: string };
  const bodySchema = z.object({ guildId: z.string() }) as unknown as Route<
    undefined,
    Body,
    Response
  >["body"];

  const entry: Route<undefined, Body, Response> = {
    method: "POST",
    path: "/admin/api/example",
    body: bodySchema,
    access: PUBLIC_ADMIN_ROUTE_ACCESS,
    handler: ({ body }) => {
      const guildId: string = body.guildId;
      return new Response(guildId);
    },
  };

  assert.equal(entry.path, "/admin/api/example");
  assert.equal(entry.method, "POST");
});

test("dispatcher matches by method and path and returns the handler response", async () => {
  const route: Route = defineRoute({
    method: "GET",
    path: "/admin/api/ping",
    access: PUBLIC_ADMIN_ROUTE_ACCESS,
    handler: () => new Response("pong"),
  });

  const response = await dispatchAdminRoute(
    [route],
    new Request("https://example.com/admin/api/ping"),
    createDispatchOptions(),
  );

  assert.equal(response?.status, 200);
  assert.equal(await response?.text(), "pong");
});

test("dispatcher returns JSON 500 when a handler throws an unexpected error", async () => {
  const route: Route = defineRoute({
    method: "POST",
    path: "/admin/api/player-count/server",
    access: PUBLIC_ADMIN_ROUTE_ACCESS,
    handler: () => {
      throw new Error("D1 insert failed");
    },
  });

  const response = await dispatchAdminRoute(
    [route],
    new Request("https://example.com/admin/api/player-count/server", { method: "POST" }),
    createDispatchOptions(),
  );

  assert.ok(response);
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("content-type"), "application/json");
  const body = (await response.json()) as { error: string };
  assert.equal(typeof body.error, "string");
  assert.ok(body.error.length > 0);
});

test("dispatcher leaves unmatched requests for the public handler seam", async () => {
  const route: Route = defineRoute({
    method: "GET",
    path: "/admin/api/ping",
    access: PUBLIC_ADMIN_ROUTE_ACCESS,
    handler: () => new Response("pong"),
  });

  const response = await dispatchAdminRoute(
    [route],
    new Request("https://example.com/admin/api/other"),
    createDispatchOptions(),
  );

  assert.equal(response, null);
});

test("public admin handler returns JSON 404 for an unmatched request", async () => {
  const handler = createAdminApiHandler({
    stores: createStubStores(),
    discordBotToken: "test",
  });
  const response = await handler(
    new Request("https://example.com/admin/api/other"),
    new URL("https://example.com/admin/api/other"),
  );

  assert.ok(response);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Not found" });
});

test("production admin handler construction requires stores, a token, and an authorizer", () => {
  assert.throws(
    () =>
      createRuntimeAdminApiHandler({
        discordBotToken: "test",
        adminAccess: allowAllAdminAccess,
      } as never),
    /stores are required/,
  );
  assert.throws(
    () =>
      createRuntimeAdminApiHandler({
        stores: createStubStores(),
        discordBotToken: "",
        adminAccess: allowAllAdminAccess,
      }),
    /Discord bot token is required/,
  );
  assert.throws(
    () =>
      createRuntimeAdminApiHandler({
        stores: createStubStores(),
        discordBotToken: "test",
      } as never),
    /authorizer is required/,
  );
});

test("dispatcher returns null when the method does not match even if the path matches", async () => {
  const route: Route = defineRoute({
    method: "GET",
    path: "/admin/api/ping",
    access: PUBLIC_ADMIN_ROUTE_ACCESS,
    handler: () => new Response("pong"),
  });

  const response = await dispatchAdminRoute(
    [route],
    new Request("https://example.com/admin/api/ping", { method: "POST" }),
    createDispatchOptions(),
  );

  assert.equal(response, null);
});

test("dispatcher parses path parameters and passes them to the handler as params", async () => {
  const route: Route = defineRoute({
    method: "GET",
    path: "/admin/api/blocklist/:id",
    access: PUBLIC_ADMIN_ROUTE_ACCESS,
    handler: ({ params }) => new Response(params.id),
  });

  const response = await dispatchAdminRoute(
    [route],
    new Request("https://example.com/admin/api/blocklist/abc-123"),
    createDispatchOptions(),
  );

  assert.equal(response?.status, 200);
  assert.equal(await response?.text(), "abc-123");
});

test("dispatcher parses multiple path parameters", async () => {
  const route: Route = defineRoute({
    method: "GET",
    path: "/admin/api/guilds/:guildId/channels/:channelId",
    access: PUBLIC_ADMIN_ROUTE_ACCESS,
    handler: ({ params }) => new Response(`${params.guildId}:${params.channelId}`),
  });

  const response = await dispatchAdminRoute(
    [route],
    new Request("https://example.com/admin/api/guilds/g1/channels/c2"),
    createDispatchOptions(),
  );

  assert.equal(await response?.text(), "g1:c2");
});

test("matchPath returns null when path parameter count does not match", () => {
  const { matchPath } = require("../src/runtime/admin-route-registry");
  assert.equal(matchPath("/admin/api/blocklist/:id", "/admin/api/blocklist"), null);
  assert.equal(matchPath("/admin/api/blocklist/:id", "/admin/api/blocklist/a/b"), null);
});

test("dispatcher does not match paths that differ in a non-parameter segment", async () => {
  const route: Route = defineRoute({
    method: "GET",
    path: "/admin/api/blocklist/:id",
    access: PUBLIC_ADMIN_ROUTE_ACCESS,
    handler: ({ params }) => new Response(params.id),
  });

  const response = await dispatchAdminRoute(
    [route],
    new Request("https://example.com/admin/api/other/abc"),
    createDispatchOptions(),
  );

  assert.equal(response, null);
});

test("parseAdminBody succeeds when JSON body matches the zod schema", async () => {
  const schema = z.object({ key: z.string(), value: z.string() });
  const request = new Request("https://example.com/x", {
    method: "POST",
    body: JSON.stringify({ key: "k", value: "v" }),
    headers: { "content-type": "application/json" },
  });
  const result = await parseAdminBody(request, schema);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value, { key: "k", value: "v" });
  }
});

test("parseAdminBody returns a structured ParseError with field-level issues when body is invalid", async () => {
  const schema = z.object({ key: z.string(), value: z.string() });
  const request = new Request("https://example.com/x", {
    method: "POST",
    body: JSON.stringify({ key: 123 }),
    headers: { "content-type": "application/json" },
  });
  const result = await parseAdminBody(request, schema);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error._tag, "ParseError");
    const error = result.error as ParseError;
    assert.ok(error.issues.length > 0);
    assert.equal(error.issues[0]?.path, "key");
  }
});

test("parseAdminBody returns a ParseError when the request body is not valid JSON", async () => {
  const schema = z.object({ key: z.string() });
  const request = new Request("https://example.com/x", {
    method: "POST",
    body: "{not json",
    headers: { "content-type": "application/json" },
  });
  const result = await parseAdminBody(request, schema);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error._tag, "ParseError");
  }
});

test("parseAdminQuery parses URLSearchParams against a zod schema", () => {
  const schema = z.object({ guildId: z.string() });
  const url = new URL("https://example.com/x?guildId=guild-1");
  const result = parseAdminQuery(url, schema);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value, { guildId: "guild-1" });
  }
});

test("parseAdminQuery returns a ParseError with field-level issues when query is invalid", () => {
  const schema = z.object({ guildId: z.string() });
  const url = new URL("https://example.com/x");
  const result = parseAdminQuery(url, schema);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error._tag, "ParseError");
    assert.equal(result.error.issues[0]?.path, "guildId");
  }
});

for (const [key, query] of [
  ["guildId", "guildId=private-A&guildId=private-B"],
  ["guildId", "guildId=private-B&guildId=private-A"],
  ["guildId", "guildId=private-A&guildId=private-A"],
  ["guildId", "guildId=private-A&%67uildId=private-B"],
  ["workspaceId", "workspaceId=private-A&workspaceId=private-B"],
  ["feature", "feature=private-A&feature=private-B"],
  ["refresh", "refresh=private-A&refresh=private-B"],
  ["unknown", "unknown=private-A&unknown=private-B"],
  ["constructor", "constructor=private-A&constructor=private-B"],
] as const) {
  test(`plan001: parseAdminQuery rejects repeated ${query}`, () => {
    const result = parseAdminQuery(
      new URL(`https://example.com/x?${query}`),
      z.object({ guildId: z.string().optional() }),
    );
    assert.equal(result.ok, false);
    if (result.ok) assert.fail("Repeated scalar query keys must be rejected");
    assert.equal(result.error._tag, "ParseError");
    assert.equal(result.error.target, "query");
    assert.equal(result.error.message, "Invalid request query");
    assert.ok(
      result.error.issues.some(
        (issue) => issue.path === key && issue.code === "duplicate_query_parameter",
      ),
    );
    assert.doesNotMatch(JSON.stringify(result.error), /private-A|private-B/);
  });
}

test("plan001: parseAdminQuery accepts single scalar values including inherited property names", () => {
  const result = parseAdminQuery(
    new URL(
      "https://example.com/x?guildId=guild-1&workspaceId=ws-1&feature=blocklist&refresh=1&constructor=value",
    ),
    z.object({ guildId: z.string(), workspaceId: z.string(), feature: z.string() }),
  );
  assert.deepEqual(result, {
    ok: true,
    value: { guildId: "guild-1", workspaceId: "ws-1", feature: "blocklist" },
  });
});

test("plan001: duplicate queries stop before authorization, feature stores and the handler", async () => {
  const calls = { access: 0, authorize: 0, store: 0, handler: 0 };
  const route = defineRoute({
    method: "GET",
    path: "/admin/api/example",
    query: z.object({ guildId: z.string() }),
    paidOnly: "reaction-limits",
    access: () => {
      calls.access += 1;
      return { mode: "read", guildId: "guild-A" };
    },
    handler: () => {
      calls.handler += 1;
      return Response.json({ ok: true });
    },
  });
  const stores = createStubStores();
  stores.guildEntitlements = {
    async readGuildEntitlement(guildId) {
      calls.store += 1;
      return { guildId, tier: "premium", updatedAtMs: 0 };
    },
  };
  const response = await dispatchAdminRoute(
    [route],
    new Request("https://example.com/admin/api/example?guildId=guild-A&guildId=guild-B"),
    createDispatchOptions({
      stores,
      adminAccess: {
        async authorize() {
          calls.authorize += 1;
          return { ok: true };
        },
      },
    }),
  );
  assert.equal(response?.status, 400);
  assert.deepEqual(calls, { access: 0, authorize: 0, store: 0, handler: 0 });
});

test("dispatcher parses the route body schema and returns 400 on parse failure", async () => {
  const schema = z.object({ key: z.string() });
  const route = defineRoute({
    method: "POST" as const,
    path: "/admin/api/example",
    body: schema,
    access: PUBLIC_ADMIN_ROUTE_ACCESS,
    handler: ({ body }: { body: { key: string } }) => new Response(JSON.stringify(body)),
  });
  const request = new Request("https://example.com/admin/api/example", {
    method: "POST",
    body: JSON.stringify({ key: 1 }),
    headers: { "content-type": "application/json" },
  });
  const response = await dispatchAdminRoute([route], request, createDispatchOptions());
  assert.equal(response?.status, 400);
  const payload = (await response?.json()) as {
    error: string;
    fieldIssues: Array<{ path: string }>;
  };
  assert.equal(payload.error, "Invalid request body");
  assert.ok(payload.fieldIssues.length > 0);
});

test("dispatcher parses the route query schema and returns 400 on parse failure", async () => {
  const schema = z.object({ guildId: z.string() });
  const route = defineRoute({
    method: "GET" as const,
    path: "/admin/api/example",
    query: schema,
    access: PUBLIC_ADMIN_ROUTE_ACCESS,
    handler: ({ query }: { query: { guildId: string } }) => new Response(query.guildId),
  });
  const request = new Request("https://example.com/admin/api/example");
  const response = await dispatchAdminRoute([route], request, createDispatchOptions());
  assert.equal(response?.status, 400);
  const payload = (await response?.json()) as {
    error: string;
    fieldIssues: Array<{ path: string }>;
  };
  assert.equal(payload.error, "Invalid request query");
  assert.equal(payload.fieldIssues[0]?.path, "guildId");
});

test("dispatcher passes the parsed body to the route handler", async () => {
  const schema = z.object({ name: z.string() });
  const route = defineRoute({
    method: "POST" as const,
    path: "/admin/api/echo",
    body: schema,
    access: PUBLIC_ADMIN_ROUTE_ACCESS,
    handler: ({ body }: { body: { name: string } }) => new Response(body.name),
  });
  const request = new Request("https://example.com/admin/api/echo", {
    method: "POST",
    body: JSON.stringify({ name: "hello" }),
    headers: { "content-type": "application/json" },
  });
  const response = await dispatchAdminRoute([route], request, createDispatchOptions());
  assert.equal(response?.status, 200);
  assert.equal(await response?.text(), "hello");
});

test("dispatcher returns 404 when the feature flag is disabled", async () => {
  const route = defineRoute({
    method: "GET" as const,
    path: "/admin/api/feature",
    feature: "lfg",
    access: PUBLIC_ADMIN_ROUTE_ACCESS,
    handler: () => new Response("ok"),
  });
  const request = new Request("https://example.com/admin/api/feature");
  const response = await dispatchAdminRoute(
    [route],
    request,
    createDispatchOptions({
      features: {
        lfg: false,
        marketplace: true,
        tickets: true,
        blocklist: true,
        timedRoles: true,
        webhookProxy: true,
        adminUi: true,
        playerCount: true,
        steamLink: true,
        evidenceVault: true,
      },
    }),
  );
  assert.equal(response?.status, 404);
});

test("dispatcher allows the route when the feature flag is enabled", async () => {
  const route = defineRoute({
    method: "GET" as const,
    path: "/admin/api/feature",
    feature: "lfg",
    access: PUBLIC_ADMIN_ROUTE_ACCESS,
    handler: () => new Response("ok"),
  });
  const request = new Request("https://example.com/admin/api/feature");
  const response = await dispatchAdminRoute(
    [route],
    request,
    createDispatchOptions({
      features: {
        lfg: true,
        marketplace: true,
        tickets: true,
        blocklist: true,
        timedRoles: true,
        webhookProxy: true,
        adminUi: true,
        playerCount: true,
        steamLink: true,
        evidenceVault: true,
      },
    }),
  );
  assert.equal(response?.status, 200);
});

test("dispatcher returns the premium guard response when premium guard fails for a non-premium guild", async () => {
  const route = defineRoute({
    method: "GET" as const,
    path: "/admin/api/premium-feature",
    paidOnly: "premium-only-features",
    access: PUBLIC_ADMIN_ROUTE_ACCESS,
    handler: () => new Response("ok"),
  });
  const request = new Request("https://example.com/admin/api/premium-feature?guildId=guild-1");
  const response = await dispatchAdminRoute(
    [route],
    request,
    createDispatchOptions({
      stores: {
        ...createStubStores(),
        guildEntitlements: {
          readGuildEntitlement: async () => ({ tier: "free" as const, limits: {} as never }),
        },
      } as never,
    }),
  );
  assert.equal(response?.status, 402);
});

test("dispatcher allows the route when the premium guard passes for a premium guild", async () => {
  const route = defineRoute({
    method: "GET" as const,
    path: "/admin/api/premium-feature",
    paidOnly: "premium-only-features",
    access: PUBLIC_ADMIN_ROUTE_ACCESS,
    handler: () => new Response("ok"),
  });
  const request = new Request("https://example.com/admin/api/premium-feature?guildId=guild-1");
  const response = await dispatchAdminRoute(
    [route],
    request,
    createDispatchOptions({
      stores: {
        ...createStubStores(),
        guildEntitlements: {
          readGuildEntitlement: async () => ({ tier: "premium" as const, limits: {} as never }),
        },
      } as never,
    }),
  );
  assert.equal(response?.status, 200);
});

test("dispatcher skips the premium guard when the route has no paidOnly field", async () => {
  const route = defineRoute({
    method: "GET" as const,
    path: "/admin/api/free",
    access: PUBLIC_ADMIN_ROUTE_ACCESS,
    handler: () => new Response("ok"),
  });
  const request = new Request("https://example.com/admin/api/free");
  const response = await dispatchAdminRoute([route], request, createDispatchOptions());
  assert.equal(response?.status, 200);
});

test("dispatcher skips the authorizer only for an explicitly public route", async () => {
  const route = defineRoute({
    method: "GET" as const,
    path: "/admin/api/open",
    access: PUBLIC_ADMIN_ROUTE_ACCESS,
    handler: () => new Response("ok"),
  });
  const request = new Request("https://example.com/admin/api/open");
  const response = await dispatchAdminRoute(
    [route],
    request,
    createDispatchOptions({
      adminAccess: {
        authorize: () => {
          throw new Error("should not be called");
        },
      },
    }),
  );
  assert.equal(response?.status, 200);
});

test("dispatcher fails closed if an unguarded route bypasses registration", async () => {
  let handled = false;
  const route = {
    method: "GET" as const,
    path: "/admin/api/unguarded",
    handler: () => {
      handled = true;
      return new Response("unsafe");
    },
  } as unknown as Route;

  const response = await dispatchAdminRoute(
    [route],
    new Request("https://example.com/admin/api/unguarded"),
    createDispatchOptions(),
  );

  assert.equal(response?.status, 500);
  assert.equal(handled, false);
});

test("dispatcher applies the access guard when the route has an access field and returns the denied response", async () => {
  const route = defineRoute({
    method: "GET" as const,
    path: "/admin/api/guarded",
    access: { mode: "write" },
    handler: () => new Response("ok"),
  });
  const request = new Request("https://example.com/admin/api/guarded");
  const response = await dispatchAdminRoute(
    [route],
    request,
    createDispatchOptions({
      adminAccess: {
        authorize: () =>
          Promise.resolve({
            ok: false as const,
            error: { _tag: "Forbidden" as const, message: "Forbidden" },
          }),
      },
    }),
  );
  assert.equal(response?.status, 403);
});

test("checkRouteCollisions throws when a (method, path) pair is registered twice", () => {
  const a = defineRoute({
    method: "GET" as const,
    path: "/admin/api/dupe",
    access: PUBLIC_ADMIN_ROUTE_ACCESS,
    handler: () => new Response("a"),
  });
  const b = defineRoute({
    method: "GET" as const,
    path: "/admin/api/dupe",
    access: PUBLIC_ADMIN_ROUTE_ACCESS,
    handler: () => new Response("b"),
  });
  assert.throws(() => checkRouteCollisions([a, b]), /Duplicate admin route registration/);
});

test("checkRouteCollisions does not throw when all routes are unique", () => {
  const a = defineRoute({
    method: "GET" as const,
    path: "/admin/api/one",
    access: PUBLIC_ADMIN_ROUTE_ACCESS,
    handler: () => new Response("a"),
  });
  const b = defineRoute({
    method: "POST" as const,
    path: "/admin/api/one",
    access: PUBLIC_ADMIN_ROUTE_ACCESS,
    handler: () => new Response("b"),
  });
  assert.doesNotThrow(() => checkRouteCollisions([a, b]));
});

test("checkRouteCollisions rejects an admin route without an access policy", () => {
  const route = {
    method: "GET" as const,
    path: "/admin/api/unguarded",
    handler: () => new Response("unsafe"),
  } as unknown as Route;

  assert.throws(() => checkRouteCollisions([route]), /has no access policy/);
});
