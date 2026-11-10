/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import type { AdminLoaderContext, AdminRouteTableRow } from "../src/admin/lib/admin-loader-client";
import { createAdminLoaderClient } from "../src/admin/lib/admin-loader-client";
import type { EntitlementInfo } from "../src/admin/hooks/use-entitlement";

test("admin loader client GETs JSON with route query parameters and abort signal", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let capturedInput: RequestInfo | URL | null = null;
  let capturedInit: RequestInit | undefined;

  globalThis.fetch = async (input, init) => {
    capturedInput = input;
    capturedInit = init;
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const client = createAdminLoaderClient(controller.signal);
    const data = await client.getJson<{ ok: boolean }>("/admin/api/example", {
      workspaceId: " workspace-1 ",
      guildId: "guild-1",
      search: { refresh: "1", empty: "" },
    });

    assert.deepEqual(data, { ok: true });
    assert.equal(
      String(capturedInput),
      "/admin/api/example?workspaceId=workspace-1&guildId=guild-1&refresh=1",
    );
    assert.equal(capturedInit?.signal, controller.signal);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin loader client POSTs JSON with workspace/guild threading and parses errors", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let capturedInput: RequestInfo | URL | null = null;
  let capturedInit: RequestInit | undefined;

  globalThis.fetch = async (input, init) => {
    capturedInput = input;
    capturedInit = init;
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const client = createAdminLoaderClient(controller.signal);
    const data = await client.postJson<{ ok: boolean }>(
      "/admin/api/example",
      { name: "value" },
      { workspaceId: "workspace-1", guildId: "guild-1" },
    );

    assert.deepEqual(data, { ok: true });
    assert.equal(String(capturedInput), "/admin/api/example");
    assert.equal(capturedInit?.method, "POST");
    const headers = new Headers(capturedInit?.headers);
    assert.equal(headers.get("content-type"), "application/json");
    assert.equal(
      capturedInit?.body,
      JSON.stringify({ name: "value", workspaceId: "workspace-1", guildId: "guild-1" }),
    );
    assert.equal(capturedInit?.signal, controller.signal);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin loader client reports POST error body via readResponseError", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "bad request" }), {
      status: 400,
      statusText: "Bad Request",
    });

  try {
    const client = createAdminLoaderClient();
    await assert.rejects(client.postJson("/admin/api/example", { foo: "bar" }), {
      message: "bad request",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("admin loader client reports friendly non-JSON failures", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("<!DOCTYPE html><html><body>Worker exception</body></html>", {
      status: 500,
      statusText: "Internal Server Error",
    });

  try {
    const client = createAdminLoaderClient();
    await assert.rejects(client.getJson("/admin/api/guilds"), {
      message: "Discord lookup failed right now.",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loadRoute GETs row path with guild query and abort signal", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let capturedPath = "";
  let capturedInit: RequestInit | undefined;

  globalThis.fetch = async (input, init) => {
    capturedPath = String(input);
    capturedInit = init;
    return new Response(JSON.stringify({ value: 1 }), {
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const client = createAdminLoaderClient();
    const ctx: AdminLoaderContext = {
      abortController: controller,
      params: { guildId: "guild-1" },
      location: { searchStr: "?workspaceId=workspace-1" },
    };
    const row: AdminRouteTableRow<{ value: number }> = {
      path: "/admin/api/route",
    };
    const result = await client.loadRoute(row, ctx, async () => null);

    assert.equal(capturedPath, "/admin/api/route?workspaceId=workspace-1&guildId=guild-1");
    assert.equal(capturedInit?.signal, controller.signal);
    assert.deepEqual(result.data, { value: 1 });
    assert.equal(typeof result.loadedAt, "number");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loadRoute attaches entitlement via transform", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ config: "ok" }), {
      headers: { "content-type": "application/json" },
    });

  try {
    const client = createAdminLoaderClient();
    const ctx: AdminLoaderContext = { params: { guildId: "g1" } };
    const entitlement: EntitlementInfo = {
      tier: "premium",
      limits: {} as EntitlementInfo["limits"],
      supportInvite: null,
      r2Usage: { usedBytes: 0, reservedBytes: 0, maxBytes: 0, lastReconciledAtMs: null },
    };
    const row: AdminRouteTableRow<{ config: string }, { config: string; tier: string }> = {
      path: "/admin/api/route",
      entitlementGate: "attach",
      transform: (data, _ctx, info) => ({ config: data.config, tier: info?.tier ?? "none" }),
    };

    const result = await client.loadRoute(row, ctx, async () => entitlement);
    assert.deepEqual(result.data, { config: "ok", tier: "premium" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loadRoute returns null-on-free without fetching", async () => {
  const originalFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    return new Response(JSON.stringify({ config: "ok" }));
  };

  try {
    const client = createAdminLoaderClient();
    const ctx: AdminLoaderContext = { params: { guildId: "g1" } };
    const entitlement: EntitlementInfo = {
      tier: "free",
      limits: {} as EntitlementInfo["limits"],
      supportInvite: null,
      r2Usage: { usedBytes: 0, reservedBytes: 0, maxBytes: 0, lastReconciledAtMs: null },
    };
    const row: AdminRouteTableRow<{ config: string }, { config: string | null; tier: string }> = {
      path: "/admin/api/route",
      entitlementGate: "return-null-on-free",
      freeTierFallback: (_ctx, info) => ({ config: null, tier: info?.tier ?? "none" }),
    };

    const result = await client.loadRoute(row, ctx, async () => entitlement);
    assert.equal(fetched, false);
    assert.deepEqual(result.data, { config: null, tier: "free" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loadRoute fetchErrorFallback swallows GET failure", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("error", { status: 500, statusText: "Internal Server Error" });

  try {
    const client = createAdminLoaderClient();
    const ctx: AdminLoaderContext = { params: { guildId: "g1" } };
    const row: AdminRouteTableRow<{ value: number }, { value: number } | null> = {
      path: "/admin/api/route",
      fetchErrorFallback: () => null,
    };

    const result = await client.loadRoute(row, ctx, async () => null);
    assert.equal(result.data, null);
    assert.equal(typeof result.loadedAt, "number");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loadRoute freeTierFallback does not swallow premium GET failures", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("error", { status: 500, statusText: "Internal Server Error" });

  try {
    const client = createAdminLoaderClient();
    const ctx: AdminLoaderContext = { params: { guildId: "g1" } };
    const entitlement: EntitlementInfo = {
      tier: "premium",
      limits: {} as EntitlementInfo["limits"],
      supportInvite: null,
      r2Usage: { usedBytes: 0, reservedBytes: 0, maxBytes: 0, lastReconciledAtMs: null },
    };
    const row: AdminRouteTableRow<{ value: number }, { value: number } | null> = {
      path: "/admin/api/route",
      entitlementGate: "return-null-on-free",
      freeTierFallback: () => null,
    };

    await assert.rejects(
      client.loadRoute(row, ctx, async () => entitlement),
      { message: "error" },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
