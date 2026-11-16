import assert from "node:assert/strict";
import test from "node:test";

import type { AdminAccess, AdminAccessRequirement } from "../src/runtime/admin-access";
import { dispatchAdminRoute } from "../src/runtime/admin-route-registry";
import { createPermissionsAdminRoutes } from "../src/runtime/admin-routes/permissions";
import { ALL_FEATURES_ENABLED } from "../src/runtime/features";
import type { AdminPermissionCheckResponse } from "../src/runtime/admin-types";
import { createProductionRuntimeStores } from "./support/production-runtime-stores";

let fixtureId = 0;

async function withPermissionsFixture(
  run: (fixture: {
    request(query: string): Promise<Response>;
    calls: {
      requirements: AdminAccessRequirement[];
      configReads: number;
      entitlementGuilds: string[];
      discordPaths: string[];
    };
  }) => Promise<void>,
  options: { blocklistEnabled?: boolean; discordStatus?: number } = {},
): Promise<void> {
  const fixture = createProductionRuntimeStores();
  const originalFetch = globalThis.fetch;
  const calls = {
    requirements: [] as AdminAccessRequirement[],
    configReads: 0,
    entitlementGuilds: [] as string[],
    discordPaths: [] as string[],
  };
  try {
    for (const guildId of ["guild-A", "guild-B"]) {
      await fixture.stores.blocklist.applyGuildEmojiMutation({
        guildId,
        emoji: "🚫",
        action: "add",
      });
    }
    const readConfig = fixture.stores.blocklist.readConfig.bind(fixture.stores.blocklist);
    fixture.stores.blocklist.readConfig = async () => {
      calls.configReads += 1;
      return readConfig();
    };
    const readEntitlement = fixture.stores.guildEntitlements.readGuildEntitlement.bind(
      fixture.stores.guildEntitlements,
    );
    fixture.stores.guildEntitlements.readGuildEntitlement = async (guildId) => {
      calls.entitlementGuilds.push(guildId);
      return readEntitlement(guildId);
    };
    const adminAccess: AdminAccess = {
      async authorize(_request, requirement) {
        calls.requirements.push(requirement);
        if (
          requirement.mode === "read" &&
          requirement.guildId === "guild-A" &&
          (requirement.workspaceId === undefined || requirement.workspaceId === "ws-A")
        ) {
          return { ok: true };
        }
        return { ok: false, error: { _tag: "Forbidden", message: "Guild scope denied" } };
      },
    };
    const features = { ...ALL_FEATURES_ENABLED, blocklist: options.blocklistEnabled ?? true };
    const routes = createPermissionsAdminRoutes({
      stores: fixture.stores,
      adminAccess,
      discordBotToken: `plan001-local-fixture-${++fixtureId}`,
      features,
    });
    globalThis.fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      calls.discordPaths.push(url.pathname);
      assert.equal(url.origin, "https://discord.com");
      const match = url.pathname.match(
        /\/guilds\/(guild-[AB])\/(channels|roles|members\/bot-user-id)$/,
      );
      assert.ok(match, `Unexpected Discord request: ${url.pathname}`);
      const [, guildId, resource] = match;
      if (options.discordStatus) {
        return Response.json(
          { message: "Missing Access", code: 50001 },
          { status: options.discordStatus },
        );
      }
      if (resource === "channels") {
        return Response.json([
          {
            id: `${guildId}-channel`,
            name: `${guildId}-private`,
            type: 0,
            permission_overwrites: [],
          },
        ]);
      }
      if (resource === "roles") {
        return Response.json([
          { id: guildId, name: "@everyone", permissions: "9216", position: 0 },
        ]);
      }
      return Response.json({ user: { id: "bot-user-id" }, roles: [] });
    };
    await run({
      calls,
      async request(query) {
        // Exclude seeding, route construction and previous requests from each oracle.
        calls.requirements.length = 0;
        calls.configReads = 0;
        calls.entitlementGuilds.length = 0;
        calls.discordPaths.length = 0;
        const response = await dispatchAdminRoute(
          routes,
          new Request(`https://example.com/admin/api/permissions?${query}`),
          { adminAccess, stores: fixture.stores, features },
        );
        assert.ok(response);
        return response;
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    fixture.close();
  }
}

for (const query of [
  "guildId=guild-A&guildId=guild-B",
  "guildId=guild-B&guildId=guild-A",
  "guildId=guild-A&guildId=guild-A",
]) {
  test(`plan001: permissions rejects ${query} before any downstream work`, async () => {
    await withPermissionsFixture(async ({ request, calls }) => {
      const response = await request(`${query}&feature=blocklist`);
      assert.equal(response.status, 400);
      const body = (await response.json()) as {
        error: string;
        fieldIssues: Array<{ path: string; code: string }>;
      };
      assert.equal(body.error, "Invalid request query");
      assert.ok(
        body.fieldIssues.some(
          (issue) => issue.path === "guildId" && issue.code === "duplicate_query_parameter",
        ),
      );
      assert.deepEqual(calls, {
        requirements: [],
        configReads: 0,
        entitlementGuilds: [],
        discordPaths: [],
      });
    });
  });
}

for (const workspace of [true, false]) {
  test(`plan001: permissions authorizes and reads only Guild A ${workspace ? "with" : "without"} workspace context`, async () => {
    await withPermissionsFixture(async ({ request, calls }) => {
      const response = await request(
        `guildId=guild-A&feature=blocklist${workspace ? "&workspaceId=ws-A" : ""}`,
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as AdminPermissionCheckResponse;
      assert.deepEqual(body, {
        guildId: "guild-A",
        feature: "blocklist",
        checks: [
          {
            id: "blocklist-visible-text-channels",
            label: "Visible text channels",
            status: "ok",
            detail: "The bot can view 1 of 1 text channels in this server.",
          },
          {
            id: "blocklist-manage-messages",
            label: "Manage Messages in text channels",
            status: "ok",
            detail: "Manage Messages is available in all 1 visible text channels.",
          },
        ],
      });
      assert.deepEqual(calls.requirements, [
        workspace
          ? { mode: "read", guildId: "guild-A", workspaceId: "ws-A" }
          : { mode: "read", guildId: "guild-A" },
      ]);
      assert.equal(calls.configReads, 1);
      assert.deepEqual(calls.entitlementGuilds, ["guild-A"]);
      assert.deepEqual(calls.discordPaths.slice().sort(), [
        "/api/v10/guilds/guild-A/channels",
        "/api/v10/guilds/guild-A/members/bot-user-id",
        "/api/v10/guilds/guild-A/roles",
      ]);
    });
  });
}

for (const [query, requirement] of [
  ["guildId=guild-B", { mode: "read", guildId: "guild-B" }],
  ["guildId=guild-A&workspaceId=ws-B", { mode: "read", guildId: "guild-A", workspaceId: "ws-B" }],
] as const) {
  test(`plan001: permissions denies ${query} without permission work`, async () => {
    await withPermissionsFixture(async ({ request, calls }) => {
      const response = await request(`${query}&feature=blocklist`);
      assert.equal(response.status, 403);
      assert.deepEqual(calls, {
        requirements: [requirement],
        configReads: 0,
        entitlementGuilds: [],
        discordPaths: [],
      });
    });
  });
}

for (const [feature, error] of [
  ["", "guildId and feature are required"],
  ["&feature=invalid-feature", /^feature must be one of:/],
] as const) {
  test(`plan001: permissions preserves ${feature ? "invalid" : "missing"} feature errors`, async () => {
    await withPermissionsFixture(async ({ request, calls }) => {
      const response = await request(`guildId=guild-A${feature}`);
      assert.equal(response.status, 400);
      const body = (await response.json()) as { error: string };
      if (typeof error === "string") assert.equal(body.error, error);
      else assert.match(body.error, error);
      assert.deepEqual(calls, {
        requirements: [{ mode: "read", guildId: "guild-A" }],
        configReads: 0,
        entitlementGuilds: [],
        discordPaths: [],
      });
    });
  });
}

test("plan001: permissions preserves the disabled feature response without permission work", async () => {
  await withPermissionsFixture(
    async ({ request, calls }) => {
      const response = await request("guildId=guild-A&feature=blocklist");
      assert.equal(response.status, 404);
      assert.equal(((await response.json()) as { error: string }).error, "Not found");
      assert.deepEqual(calls, {
        requirements: [{ mode: "read", guildId: "guild-A" }],
        configReads: 0,
        entitlementGuilds: [],
        discordPaths: [],
      });
    },
    { blocklistEnabled: false },
  );
});

test("plan001: a single refresh=1 bypasses the permission cache without changing scope", async () => {
  await withPermissionsFixture(async ({ request, calls }) => {
    const query = "guildId=guild-A&feature=blocklist";
    assert.equal((await request(query)).status, 200);
    assert.equal(calls.discordPaths.length, 3);
    assert.equal((await request(query)).status, 200);
    assert.equal(calls.discordPaths.length, 0);
    assert.equal((await request(`${query}&refresh=1`)).status, 200);
    assert.deepEqual(calls.requirements, [{ mode: "read", guildId: "guild-A" }]);
    assert.deepEqual(calls.entitlementGuilds, ["guild-A"]);
    assert.equal(calls.discordPaths.length, 3);
    assert.ok(calls.discordPaths.every((path) => path.includes("/guilds/guild-A/")));
  });
});

test("plan001: permissions preserves Discord failure responses", async () => {
  await withPermissionsFixture(
    async ({ request, calls }) => {
      const response = await request("guildId=guild-A&feature=blocklist");
      assert.equal(response.status, 502);
      assert.equal(typeof ((await response.json()) as { error: string }).error, "string");
      assert.equal(calls.configReads, 1);
      assert.equal(calls.discordPaths.length, 3);
      assert.deepEqual(calls.entitlementGuilds, []);
    },
    { discordStatus: 403 },
  );
});
