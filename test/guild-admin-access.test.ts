/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import { resolveGuildAdminAccess } from "../src/runtime/guild-admin-access";

test("resolveGuildAdminAccess denies when no guild admin role is configured", async () => {
  const result = await resolveGuildAdminAccess({
    guildId: "guild-1",
    userId: "user-1",
    store: { readGuildAdminRoleId: async () => null },
    suppliedRoleIds: ["role-1"],
  });

  assert.deepEqual(result, { ok: false, reason: "no-admin-role-configured" });
});

test("resolveGuildAdminAccess grants when supplied roles include configured admin role", async () => {
  const result = await resolveGuildAdminAccess({
    guildId: "guild-1",
    userId: "user-1",
    store: { readGuildAdminRoleId: async () => "admin-role" },
    suppliedRoleIds: ["member-role", "admin-role"],
  });

  assert.deepEqual(result, { ok: true, reason: "role-match" });
});

test("resolveGuildAdminAccess fetches roles when supplied roles are absent", async () => {
  const calls: Array<{ guildId: string; userId: string }> = [];
  const result = await resolveGuildAdminAccess({
    guildId: "guild-1",
    userId: "user-1",
    store: { readGuildAdminRoleId: async () => "admin-role" },
    fetchMemberRoleIds: async (guildId, userId) => {
      calls.push({ guildId, userId });
      return ["admin-role"];
    },
  });

  assert.deepEqual(result, { ok: true, reason: "role-match" });
  assert.deepEqual(calls, [{ guildId: "guild-1", userId: "user-1" }]);
});

test("resolveGuildAdminAccess reports missing membership from injected fetcher", async () => {
  const result = await resolveGuildAdminAccess({
    guildId: "guild-1",
    userId: "user-1",
    store: { readGuildAdminRoleId: async () => "admin-role" },
    fetchMemberRoleIds: async () => null,
  });

  assert.deepEqual(result, { ok: false, reason: "not-a-member" });
});
