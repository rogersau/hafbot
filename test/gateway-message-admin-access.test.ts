/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import { hasGatewayMessageAdminAccess } from "../src/runtime/gateway-message-admin-access";

test("hasGatewayMessageAdminAccess trusts permissions supplied by Discord", async () => {
  let storeReads = 0;
  const access = await hasGatewayMessageAdminAccess({
    guildId: "guild-1",
    userId: "admin-1",
    memberRoleIds: [],
    memberPermissions: String(1n << 3n),
    store: {
      readManageServerAdminEnabled: async () => true,
      async readGuildAdminRoleId() {
        storeReads += 1;
        return null;
      },
    },
    discord: unreachableDiscord(),
  });

  assert.equal(access, true);
  assert.equal(storeReads, 0);
});

test("hasGatewayMessageAdminAccess accepts the configured HAF administrator role", async () => {
  const access = await hasGatewayMessageAdminAccess({
    guildId: "guild-1",
    userId: "admin-1",
    memberRoleIds: ["haf-admin-role"],
    store: {
      readManageServerAdminEnabled: async () => true,
      async readGuildAdminRoleId() {
        return "haf-admin-role";
      },
    },
    discord: unreachableDiscord(),
  });

  assert.equal(access, true);
});

test("hasGatewayMessageAdminAccess resolves Manage Guild from member roles", async () => {
  const access = await hasGatewayMessageAdminAccess({
    guildId: "guild-1",
    userId: "admin-1",
    memberRoleIds: ["manager-role"],
    store: noConfiguredAdminRole(),
    discord: {
      async fetchGuildSummary() {
        return { id: "guild-1", name: "Guild", owner_id: "owner-1" };
      },
      async listGuildRoles() {
        return [
          { id: "guild-1", name: "@everyone", permissions: "0", position: 0 },
          {
            id: "manager-role",
            name: "Manager",
            permissions: String(1n << 5n),
            position: 1,
          },
        ];
      },
    },
  });

  assert.equal(access, true);
});

test("hasGatewayMessageAdminAccess accepts the Guild owner", async () => {
  const access = await hasGatewayMessageAdminAccess({
    guildId: "guild-1",
    userId: "owner-1",
    memberRoleIds: [],
    store: noConfiguredAdminRole(),
    discord: {
      async fetchGuildSummary() {
        return { id: "guild-1", name: "Guild", owner_id: "owner-1" };
      },
      async listGuildRoles() {
        return [{ id: "guild-1", name: "@everyone", permissions: "0", position: 0 }];
      },
    },
  });

  assert.equal(access, true);
});

test("hasGatewayMessageAdminAccess denies ordinary members", async () => {
  const access = await hasGatewayMessageAdminAccess({
    guildId: "guild-1",
    userId: "member-1",
    memberRoleIds: ["member-role"],
    store: noConfiguredAdminRole(),
    discord: {
      async fetchGuildSummary() {
        return { id: "guild-1", name: "Guild", owner_id: "owner-1" };
      },
      async listGuildRoles() {
        return [
          { id: "guild-1", name: "@everyone", permissions: "0", position: 0 },
          { id: "member-role", name: "Member", permissions: "0", position: 1 },
        ];
      },
    },
  });

  assert.equal(access, false);
});

function noConfiguredAdminRole() {
  return {
    readManageServerAdminEnabled: async () => true,
    async readGuildAdminRoleId() {
      return null;
    },
  };
}

function unreachableDiscord() {
  return {
    async fetchGuildSummary(): Promise<never> {
      throw new Error("Discord should not be queried");
    },
    async listGuildRoles(): Promise<never> {
      throw new Error("Discord should not be queried");
    },
  };
}
