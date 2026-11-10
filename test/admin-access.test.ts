/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import {
  createAdminAccessDeniedResponse,
  createRuntimeAdminAccess,
  type AdminAccessDenied,
  type AdminAccessRequirement,
} from "../src/runtime/admin-access";

test("runtime admin access allows guild-scoped reads through guild admin fallback when workspace access is denied", async () => {
  const requirement: AdminAccessRequirement = {
    mode: "read",
    guildId: "guild-1",
  };
  const workspaceDenied: AdminAccessDenied = {
    _tag: "Forbidden",
    message: "Guild is not linked to this workspace.",
  };
  const access = createRuntimeAdminAccess({
    readCustomerSession: async () => ({
      user: {
        id: "user-1",
        discordUserId: "discord-user-1",
        name: "User One",
      },
    }),
    authorizeWorkspaceAccess: async () => ({ ok: false, error: workspaceDenied }),
    authorizeGuildAccess: async (_request: Request, options: AdminAccessRequirement) => {
      assert.deepEqual(options, requirement);
      return true;
    },
  });

  const result = await access.authorize(
    new Request("https://example.com/admin/api/blocklist?workspaceId=workspace-1&guildId=guild-1"),
    requirement,
  );

  assert.deepEqual(result, { ok: true });
});

test("runtime admin access returns unauthorized when no customer session exists", async () => {
  const access = createRuntimeAdminAccess({
    readCustomerSession: async () => null,
  });

  const result = await access.authorize(new Request("https://example.com/admin/api/overview"), {
    mode: "read",
    allowGuildAdminDirectory: true,
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      _tag: "Unauthorized",
      message: "Unauthorized",
    },
  });
});

test("runtime admin access allows customer-session-only routes for signed-in customer admins", async () => {
  const access = createRuntimeAdminAccess({
    readCustomerSession: async () => ({
      user: {
        id: "user-1",
        discordUserId: "discord-user-1",
        name: "User One",
      },
    }),
  });

  const result = await access.authorize(new Request("https://example.com/admin/api/guilds"), {
    mode: "read",
    customerSessionOnly: true,
  });

  assert.deepEqual(result, { ok: true });
});

test("runtime admin access preserves workspace denial when no guild fallback allows access", async () => {
  const access = createRuntimeAdminAccess({
    readCustomerSession: async () => ({
      user: {
        id: "user-1",
        discordUserId: "discord-user-1",
        name: "User One",
      },
    }),
    authorizeWorkspaceAccess: async () => ({
      ok: false,
      error: {
        _tag: "Forbidden",
        message: "Guild is not linked to this workspace.",
      },
    }),
    authorizeGuildAccess: async () => false,
  });

  const result = await access.authorize(
    new Request("https://example.com/admin/api/blocklist?workspaceId=workspace-1&guildId=guild-2"),
    { mode: "read", guildId: "guild-2" },
  );

  assert.deepEqual(result, {
    ok: false,
    error: {
      _tag: "Forbidden",
      message: "Guild is not linked to this workspace.",
    },
  });
});

test("typed admin access failures map to the existing HTTP responses", async () => {
  const responses = [
    createAdminAccessDeniedResponse({ _tag: "BadRequest", message: "bad request" }),
    createAdminAccessDeniedResponse({ _tag: "Unauthorized", message: "Unauthorized" }),
    createAdminAccessDeniedResponse({ _tag: "Forbidden", message: "Forbidden" }),
    createAdminAccessDeniedResponse({ _tag: "NotFound", message: "Not found" }),
  ];

  assert.deepEqual(
    await Promise.all(
      responses.map(async (response) => ({
        status: response.status,
        body: await response.json(),
      })),
    ),
    [
      { status: 400, body: { error: "bad request" } },
      { status: 401, body: { error: "Unauthorized" } },
      { status: 403, body: { error: "Forbidden" } },
      { status: 404, body: { error: "Not found" } },
    ],
  );
});

test("an authorization dependency failure rejects without trying a permissive fallback", async () => {
  let guildChecks = 0;
  const failure = new Error("Workspace authorization unavailable");
  const access = createRuntimeAdminAccess({
    readCustomerSession: async () => ({
      user: { id: "user-1", discordUserId: "discord-1", name: "Admin" },
    }),
    authorizeWorkspaceAccess: async () => {
      throw failure;
    },
    authorizeGuildAccess: async () => {
      guildChecks++;
      return true;
    },
  });
  await assert.rejects(
    access.authorize(new Request("https://example.com/admin/api/tickets/panel"), {
      mode: "write",
      guildId: "guild-1",
      workspaceId: "workspace-1",
    }),
    (error) => error === failure,
  );
  assert.equal(guildChecks, 0);
});
