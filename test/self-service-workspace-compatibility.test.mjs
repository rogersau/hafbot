import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { createProductionRuntimeStores } from "../dist-tests/test/support/production-runtime-stores.js";
import { createCustomerAuth } from "../dist-tests/src/runtime/auth/auth.js";
import { createCloudflareWorkspaceStore } from "../dist-tests/src/runtime/cloudflare-workspace-store.js";
import { createRuntimeApp } from "../dist-tests/src/runtime/app.js";

async function createWorkspaceLinkFixture(t) {
  const fixture = createProductionRuntimeStores();
  t.after(() => fixture.close());
  const guildId = "998877665544332211";
  const discordUserId = "123456789012345678";
  const discord = {
    owner: false,
    permissions: "32",
    rolePermissions: null,
    discoveryGuildId: guildId,
    unavailablePath: null,
  };
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (discord.unavailablePath && url.endsWith(discord.unavailablePath)) {
      return Response.json({ message: "Synthetic Discord outage" }, { status: 503 });
    }
    if (url.endsWith("/users/@me/guilds")) {
      return Response.json([
        {
          id: discord.discoveryGuildId,
          name: "Synthetic Guild",
          owner: discord.owner,
          permissions: discord.permissions,
        },
      ]);
    }
    if (url.endsWith(`/guilds/${guildId}`)) {
      return Response.json({
        id: guildId,
        name: "Synthetic Guild",
        owner_id: discord.owner ? discordUserId : "999999999999999999",
      });
    }
    if (url.endsWith(`/guilds/${guildId}/members/${discordUserId}`)) {
      return Response.json({ user: { id: discordUserId }, roles: ["staff-role"] });
    }
    if (url.endsWith(`/guilds/${guildId}/roles`)) {
      return Response.json([
        { id: guildId, name: "@everyone", permissions: "0", position: 0 },
        {
          id: "staff-role",
          name: "Staff",
          permissions: discord.rolePermissions ?? discord.permissions,
          position: 1,
        },
      ]);
    }
    throw new Error(`Unexpected isolated Discord request: ${url}`);
  });
  const secret = "synthetic-workspace-link-auth-secret-at-least-32-chars";
  const auth = createCustomerAuth({
    database: fixture.database.d1,
    betterAuthSecret: secret,
    betterAuthUrl: "http://localhost:8787",
    discordOAuthClientId: "synthetic",
    discordOAuthClientSecret: "synthetic",
  });
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser({
    name: "Synthetic workspace owner",
    email: "workspace-owner@example.invalid",
    emailVerified: false,
    discordUserId,
  });
  const session = await ctx.internalAdapter.createSession(user.id);
  const signature = createHmac("sha256", secret).update(session.token).digest("base64");
  const headers = {
    cookie: `better-auth.session_token=${encodeURIComponent(session.token + "." + signature)}`,
    origin: "http://localhost:8787",
  };
  const organization = await auth.api.createOrganization({
    headers,
    body: { name: "Fresh workspace", slug: "fresh-workspace" },
  });
  const workspaceStore = createCloudflareWorkspaceStore(fixture.database.d1);
  await fixture.stores.guildRbac.setManageServerAdminEnabled(guildId, false);
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: `synthetic-workspace-link-${user.id}`,
    discordAccounts: { readDiscordAccessToken: async () => `synthetic-oauth-${user.id}` },
    customerAuth: auth,
    workspaceStore,
    stores: fixture.stores,
    gateway: { status: async () => ({ status: "ready" }) },
  });
  const get = (path) =>
    app.fetch(new Request(`http://localhost:8787/admin/api/${path}`, { headers }));
  const post = (path, body) =>
    app.fetch(
      new Request(`http://localhost:8787/admin/api/${path}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  return {
    ...fixture,
    guildId,
    discord,
    workspaceStore,
    workspaceId: organization.id,
    user,
    get,
    post,
  };
}

test("new workspace links cannot bypass a disabled Manage Server policy", async (t) => {
  const { guildId, workspaceId, workspaceStore, stores, get, post } =
    await createWorkspaceLinkFixture(t);
  assert.equal((await get(`blocklist?guildId=${guildId}`)).status, 403);
  assert.equal((await post("blocklist", { guildId, action: "add", emoji: "🦆" })).status, 403);

  assert.equal((await post("workspace-guilds", { workspaceId, guildId })).status, 403);

  assert.deepEqual(await workspaceStore.listGuildsForWorkspace(workspaceId), []);
  assert.deepEqual(await workspaceStore.listWorkspaceGuildAuditEvents(workspaceId), []);
  assert.equal((await get(`blocklist?guildId=${guildId}`)).status, 403);
  assert.equal((await post("blocklist", { guildId, action: "add", emoji: "🦆" })).status, 403);
  assert.deepEqual((await stores.blocklist.readConfig()).guilds[guildId]?.emojis ?? [], []);
  assert.equal(await stores.guildRbac.readManageServerAdminEnabled(guildId), false);
});

test("new workspace links retain enabled-manager, owner and Administrator access", async (t) => {
  for (const actor of ["enabled-manager", "owner", "administrator"]) {
    await t.test(actor, async (t) => {
      const { guildId, workspaceId, workspaceStore, stores, discord, get, post } =
        await createWorkspaceLinkFixture(t);
      if (actor === "enabled-manager") {
        await stores.guildRbac.setManageServerAdminEnabled(guildId, true);
      } else if (actor === "owner") {
        discord.owner = true;
        discord.permissions = "0";
      } else {
        discord.permissions = "8";
      }

      assert.equal((await post("workspace-guilds", { workspaceId, guildId })).status, 200);
      assert.equal(await workspaceStore.isGuildLinkedToWorkspace(workspaceId, guildId), true);
      assert.equal((await workspaceStore.listWorkspaceGuildAuditEvents(workspaceId)).length, 1);
      assert.equal((await get(`blocklist?guildId=${guildId}`)).status, 200);
      assert.equal((await post("blocklist", { guildId, action: "add", emoji: "🦆" })).status, 200);
      assert.deepEqual((await stores.blocklist.readConfig()).guilds[guildId].emojis, ["🦆"]);
      assert.equal(
        await stores.guildRbac.readManageServerAdminEnabled(guildId),
        actor === "enabled-manager",
      );
    });
  }
});

test("existing workspace links preserve read, write and relink access with the policy disabled", async (t) => {
  const { guildId, workspaceId, workspaceStore, stores, user, get, post } =
    await createWorkspaceLinkFixture(t);
  await workspaceStore.linkGuildToWorkspace({
    workspaceId,
    guildId,
    linkedByUserId: user.id,
    linkedAtMs: 1,
  });

  assert.equal((await get(`blocklist?guildId=${guildId}`)).status, 200);
  assert.equal((await post("blocklist", { guildId, action: "add", emoji: "🦆" })).status, 200);
  assert.equal((await post("workspace-guilds", { workspaceId, guildId })).status, 200);
  assert.equal((await workspaceStore.listGuildsForWorkspace(workspaceId)).length, 1);
  assert.deepEqual((await stores.blocklist.readConfig()).guilds[guildId].emojis, ["🦆"]);
  assert.equal(await stores.guildRbac.readManageServerAdminEnabled(guildId), false);
  assert.equal((await post("guild-rbac/admin-role", { guildId, adminRoleId: null })).status, 403);
});

test("nominated HAF roles keep feature access without gaining workspace linking eligibility", async (t) => {
  const { guildId, workspaceId, workspaceStore, stores, discord, get, post } =
    await createWorkspaceLinkFixture(t);
  discord.permissions = "0";
  await stores.guildRbac.upsertGuildAdminRoleId(guildId, "staff-role");

  assert.equal((await get(`blocklist?guildId=${guildId}`)).status, 200);
  assert.equal((await post("workspace-guilds", { workspaceId, guildId })).status, 403);
  assert.deepEqual(await workspaceStore.listGuildsForWorkspace(workspaceId), []);
  assert.deepEqual(await workspaceStore.listWorkspaceGuildAuditEvents(workspaceId), []);
  assert.equal((await post("blocklist", { guildId, action: "add", emoji: "🦆" })).status, 200);
});

test("new workspace links fail closed on missing target-Guild or fresh provider evidence", async (t) => {
  for (const failure of [
    "cross-guild",
    "discovery",
    "guild",
    "member",
    "roles",
    "policy",
    "lost-admin",
  ]) {
    await t.test(failure, async (t) => {
      const { guildId, workspaceId, workspaceStore, stores, discord, get, post } =
        await createWorkspaceLinkFixture(t);
      discord.permissions = "8";
      // Warm the normal read caches so an access-control change cannot reuse stale authority.
      assert.equal((await get(`blocklist?guildId=${guildId}`)).status, 200);
      if (failure === "cross-guild") {
        discord.discoveryGuildId = "887766554433221100";
      } else if (failure === "policy") {
        t.mock.method(stores.guildRbac, "readManageServerAdminEnabled", async () => {
          throw new Error("Synthetic policy store outage");
        });
      } else if (failure === "lost-admin") {
        discord.rolePermissions = "32";
      } else {
        discord.unavailablePath = {
          discovery: "/users/@me/guilds",
          guild: `/guilds/${guildId}`,
          member: `/guilds/${guildId}/members/123456789012345678`,
          roles: `/guilds/${guildId}/roles`,
        }[failure];
      }

      assert.equal((await post("workspace-guilds", { workspaceId, guildId })).status, 403);
      assert.deepEqual(await workspaceStore.listGuildsForWorkspace(workspaceId), []);
      assert.deepEqual(await workspaceStore.listWorkspaceGuildAuditEvents(workspaceId), []);
      assert.deepEqual((await stores.blocklist.readConfig()).guilds[guildId]?.emojis ?? [], []);
    });
  }
});

test("real Better Auth membership preserves legacy workspace grants without workspace bootstrap", async () => {
  const fixture = createProductionRuntimeStores();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ message: "Missing Access" }, { status: 403 });
  try {
    const secret = "synthetic-local-auth-secret-at-least-32-chars";
    const auth = createCustomerAuth({
      database: fixture.database.d1,
      betterAuthSecret: secret,
      betterAuthUrl: "http://localhost:8787",
      discordOAuthClientId: "synthetic",
      discordOAuthClientSecret: "synthetic",
    });
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser({
      name: "Synthetic owner",
      email: "synthetic@example.invalid",
      emailVerified: false,
      discordUserId: "123456789012345678",
    });
    const session = await ctx.internalAdapter.createSession(user.id);
    const signature = createHmac("sha256", secret).update(session.token).digest("base64");
    const headers = {
      cookie: `better-auth.session_token=${encodeURIComponent(session.token + "." + signature)}`,
      origin: "http://localhost:8787",
    };
    const organization = await auth.api.createOrganization({
      headers,
      body: { name: "Synthetic workspace", slug: "synthetic-workspace" },
    });
    const organizations = await auth.api.listOrganizations({ headers });
    assert.equal(organizations[0].role, undefined, "real organization list omits membership role");
    const workspaceStore = createCloudflareWorkspaceStore(fixture.database.d1);
    await workspaceStore.linkGuildToWorkspace({
      workspaceId: organization.id,
      guildId: "guild-1",
      linkedByUserId: user.id,
      linkedAtMs: Date.now(),
    });
    await fixture.stores.guildRbac.setManageServerAdminEnabled("guild-1", false);
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "synthetic-compatibility",
      customerAuth: auth,
      workspaceStore,
      stores: fixture.stores,
      gateway: { status: async () => ({ status: "ready" }) },
    });
    const get = (path) =>
      app.fetch(new Request(`http://localhost:8787/admin/api/${path}`, { headers }));
    const workspaces = await get("workspaces");
    assert.equal(workspaces.status, 200);
    const body = await workspaces.json();
    assert.equal(body.workspaces[0].id, organization.id);
    assert.equal(body.workspaces[0].role, "owner");
    assert.equal(
      (await get("blocklist?guildId=guild-1")).status,
      200,
      "linked workspace access remains without explicit workspace query",
    );
    assert.equal((await get("blocklist?guildId=guild-2")).status, 403);
    const policy = await app.fetch(
      new Request("http://localhost:8787/admin/api/guild-rbac/admin-role", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          guildId: "guild-1",
          workspaceId: organization.id,
          manageServerAdminEnabled: true,
        }),
      }),
    );
    assert.equal(policy.status, 403, "workspace owner cannot override Discord-owner capability");
    assert.equal(await fixture.stores.guildRbac.readManageServerAdminEnabled("guild-1"), false);
    for (const action of ["preview", "execute"]) {
      const setup = await app.fetch(
        new Request(`http://localhost:8787/admin/api/feature-resource-setup/${action}`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            guildId: "guild-1",
            workspaceId: organization.id,
            surfaceKey: "guild_access",
            dependencyKey: "admin_role",
            choice: { action: "create", name: "Synthetic role" },
          }),
        }),
      );
      assert.equal(setup.status, 403, "workspace grants cannot create delegation resources");
    }

    assert.equal((await workspaceStore.listGuildsForWorkspace(organization.id)).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    fixture.close();
  }
});

test("gateway and interaction policy leaves Administrator and nominated-role access independent", async () => {
  const { hasGatewayMessageAdminAccess } =
    await import("../dist-tests/src/runtime/gateway-message-admin-access.js");
  const { hasInteractionAdminAccess } =
    await import("../dist-tests/src/runtime/interaction-admin-access.js");
  const fixture = createProductionRuntimeStores();
  try {
    await fixture.stores.guildRbac.setManageServerAdminEnabled("guild-1", false);
    await fixture.stores.guildRbac.upsertGuildAdminRoleId("guild-1", "haf-role");
    const discord = {
      fetchGuildSummary: async () => ({ id: "guild-1", name: "Synthetic", owner_id: "owner" }),
      listGuildRoles: async () => [
        { id: "guild-1", name: "@everyone", permissions: "0", position: 0 },
        { id: "manager", name: "Manager", permissions: "32", position: 1 },
      ],
    };
    for (const [userId, permissions, roles, expected] of [
      ["admin", "8", [], true],
      ["manager", "32", ["manager"], false],
      ["nominated", "32", ["manager", "haf-role"], true],
      ["ordinary", "0", [], false],
    ]) {
      assert.equal(
        await hasGatewayMessageAdminAccess({
          guildId: "guild-1",
          userId,
          memberPermissions: permissions,
          memberRoleIds: roles,
          store: fixture.stores.guildRbac,
          discord,
        }),
        expected,
        userId,
      );
      assert.equal(
        await hasInteractionAdminAccess(
          { guild_id: "guild-1", member: { permissions, roles, user: { id: userId } } },
          fixture.stores,
        ),
        expected,
        userId,
      );
    }
    assert.equal(
      await hasGatewayMessageAdminAccess({
        guildId: "guild-1",
        userId: "owner",
        memberRoleIds: [],
        store: fixture.stores.guildRbac,
        discord,
      }),
      true,
    );
  } finally {
    fixture.close();
  }
});
