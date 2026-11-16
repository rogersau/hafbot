/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { createFeatureResourceSetupAdminRoutes } from "../src/runtime/admin-routes/feature-resource-setup";
import type { RuntimeStores } from "../src/runtime/app-types";
import { createSqliteFeatureSetupStore } from "./support/sqlite/runtime/sqlite-feature-setup-store";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("Feature Resource Setup route creates a private Forum with selected staff access", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    requests.push({ url, method, body });
    if (url.endsWith("/channels") && method === "GET") return Response.json([]);
    if (url.endsWith("/roles")) {
      return Response.json([
        { id: "guild-1", name: "@everyone", permissions: "8", position: 0 },
        { id: "role-1", name: "Ban Staff", permissions: "0", position: 1 },
      ]);
    }
    if (url.endsWith("/members/bot-1")) return Response.json({ roles: [] });
    if (url.endsWith("/channels") && method === "POST") {
      return Response.json({ id: "forum-1", name: "🎮・ban cases!" });
    }
    throw new Error(`Unexpected Discord request: ${method} ${url}`);
  };

  try {
    const featureSetup = createSqliteFeatureSetupStore(
      new SqliteD1Database() as unknown as D1Database,
    );
    const routes = createFeatureResourceSetupAdminRoutes({
      stores: {
        featureSetup,
        guildAuditLog: { readConfig: async () => null },
      } as unknown as RuntimeStores,
      discordBotToken: "token",
      discordBotUserId: "bot-1",
      readCustomerAdminSession: async () => ({
        user: { id: "account-1", discordUserId: "admin-1", name: "Admin" },
      }),
    });
    const previewRoute = routes.find((route) => route.path.endsWith("/preview"))!;
    const executeRoute = routes.find((route) => route.path.endsWith("/execute"))!;
    const input = {
      guildId: "guild-1",
      surfaceKey: "ban_cases",
      dependencyKey: "forum_channel",
      choice: { action: "create" as const, name: " 🎮・ban cases! " },
      accessRoleIds: ["role-1"],
      accessChannelIds: [],
    };
    const previewResponse = await previewRoute.handler(
      routeContext(previewRoute.body!.parse(input)),
    );
    const previewBody = (await previewResponse.json()) as {
      preview: { confirmationId: string };
    };
    const executeResponse = await executeRoute.handler(
      routeContext(
        executeRoute.body!.parse({ ...input, confirmationId: previewBody.preview.confirmationId }),
      ),
    );
    const result = (await executeResponse.json()) as {
      run: { status: string; actorUserId: string };
      resource: { id: string; kind: string };
    };

    assert.equal(result.run.status, "completed");
    assert.equal(result.run.actorUserId, "admin-1");
    assert.deepEqual(result.resource, {
      id: "forum-1",
      name: "🎮・ban cases!",
      kind: "forum_channel",
    });
    const createRequest = requests.find(
      (request) => request.method === "POST" && request.url.endsWith("/channels"),
    );
    assert.ok(createRequest);
    assert.equal((createRequest.body as { name: string }).name, "🎮・ban cases!");
    assert.equal((createRequest.body as { type: number }).type, 15);
    assert.deepEqual(
      (
        createRequest.body as { permission_overwrites: Array<{ id: string }> }
      ).permission_overwrites.map((overwrite) => overwrite.id),
      ["guild-1", "bot-1", "role-1"],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Feature Resource Setup route rejects dependencies outside the server catalog", async () => {
  const routes = createFeatureResourceSetupAdminRoutes({
    stores: { featureSetup: {} } as RuntimeStores,
    discordBotToken: "token",
    discordBotUserId: "bot-1",
  });
  const route = routes.find((candidate) => candidate.path.endsWith("/preview"))!;
  const response = await route.handler(
    routeContext(
      route.body!.parse({
        guildId: "guild-1",
        surfaceKey: "made_up",
        dependencyKey: "dangerous_resource",
        choice: { action: "create", name: "nope" },
      }),
    ),
  );
  assert.equal(response.status, 400);
});

function routeContext(body: unknown) {
  const request = new Request("https://example.test/admin/api/feature-resource-setup");
  return {
    request,
    url: new URL(request.url),
    params: {},
    query: undefined,
    body,
  };
}
