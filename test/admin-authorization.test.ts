/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- The worker typecheck config omits Node built-ins and full node:test types conflict with Workers globals; tsconfig.tests provides the runtime test types.
import test from "node:test";

import {
  authorizeWorkspaceRequest,
  requireWorkspaceRole,
  type CustomerSession,
  type WorkspaceMembershipResolver,
} from "../src/runtime/admin-authorization";
import { readCustomerSession } from "../src/runtime/auth/customer-session";
import { createMemoryWorkspaceStore } from "./helpers/memory-workspace-store";

const session: CustomerSession = {
  user: {
    id: "user-1",
    discordUserId: "discord-user-1",
    name: "User One",
  },
};

test("customer sessions use the Discord provider user ID", async () => {
  const result = await readCustomerSession(
    new Request("https://example.test"),
    createCustomerAuthWithSession({
      session: { activeOrganizationId: "workspace-1" },
      user: {
        id: "internal-user-1",
        discordUserId: "discord-provider-user-1",
        name: "User One",
        email: "user@example.com",
      },
    }),
  );

  assert.deepEqual(result, {
    activeOrganizationId: "workspace-1",
    user: {
      id: "internal-user-1",
      discordUserId: "discord-provider-user-1",
      name: "User One",
      email: "user@example.com",
      image: null,
    },
  });
});

test("customer session lookup rejects sessions without Discord user IDs", async () => {
  const result = await readCustomerSession(
    new Request("https://example.test"),
    createCustomerAuthWithSession({
      user: {
        id: "internal-user-1",
        name: "User One",
      },
    }),
  );

  assert.equal(result, null);
});

test("authorization rejects missing sessions", async () => {
  const result = await authorizeWorkspaceRequest({
    session: null,
    workspaceId: "workspace-1",
    workspaceStore: createMemoryWorkspaceStore(),
    membershipResolver: createMembershipResolver("owner"),
  });

  assert.equal(result.ok, false);
  assert.equal(result.response.status, 401);
});

test("authorization rejects missing workspace IDs", async () => {
  const result = await authorizeWorkspaceRequest({
    session,
    workspaceId: null,
    workspaceStore: createMemoryWorkspaceStore(),
    membershipResolver: createMembershipResolver("owner"),
  });

  assert.equal(result.ok, false);
  assert.equal(result.response.status, 400);
});

test("authorization rejects missing workspace stores", async () => {
  const result = await authorizeWorkspaceRequest({
    session,
    workspaceId: "workspace-1",
    workspaceStore: undefined,
    membershipResolver: createMembershipResolver("owner"),
  });

  assert.equal(result.ok, false);
  assert.equal(result.response.status, 404);
});

test("authorization rejects missing membership", async () => {
  const result = await authorizeWorkspaceRequest({
    session,
    workspaceId: "workspace-1",
    workspaceStore: createMemoryWorkspaceStore(),
    membershipResolver: createMembershipResolver(null),
  });

  assert.equal(result.ok, false);
  assert.equal(result.response.status, 403);
});

test("authorization rejects guilds outside the workspace", async () => {
  const store = createMemoryWorkspaceStore();
  await store.linkGuildToWorkspace({
    workspaceId: "workspace-2",
    guildId: "guild-1",
    linkedByUserId: "user-2",
    linkedAtMs: 100,
  });

  const result = await authorizeWorkspaceRequest({
    session,
    workspaceId: "workspace-1",
    guildId: "guild-1",
    workspaceStore: store,
    membershipResolver: createMembershipResolver("admin"),
  });

  assert.equal(result.ok, false);
  assert.equal(result.response.status, 403);
});

test("authorization allows workspace members", async () => {
  const result = await authorizeWorkspaceRequest({
    session,
    workspaceId: "workspace-1",
    workspaceStore: createMemoryWorkspaceStore(),
    membershipResolver: createMembershipResolver("admin"),
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.session, session);
    assert.equal(result.membership.role, "admin");
  }
});

test("viewer can read but cannot mutate", async () => {
  assert.equal(requireWorkspaceRole("viewer", "read"), null);
  assert.equal(requireWorkspaceRole("viewer", "write")?.status, 403);
});

test("admin and owner can mutate", async () => {
  assert.equal(requireWorkspaceRole("admin", "write"), null);
  assert.equal(requireWorkspaceRole("owner", "write"), null);
});

test("only owners can perform owner operations", async () => {
  assert.equal(requireWorkspaceRole("owner", "owner"), null);
  assert.equal(requireWorkspaceRole("admin", "owner")?.status, 403);
  assert.equal(requireWorkspaceRole("viewer", "owner")?.status, 403);
});

function createMembershipResolver(
  role: "owner" | "admin" | "viewer" | null,
): WorkspaceMembershipResolver {
  return async () =>
    role
      ? {
          workspaceId: "workspace-1",
          userId: "user-1",
          role,
        }
      : null;
}

function createCustomerAuthWithSession(session: unknown) {
  return {
    api: {
      getSession: async () => session,
    },
  } as Parameters<typeof readCustomerSession>[1];
}
