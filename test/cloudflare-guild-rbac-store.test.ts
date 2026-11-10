/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createCloudflareGuildRbacStore } from "../src/runtime/cloudflare-guild-rbac-store";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("createCloudflareGuildRbacStore reads missing role ids as null", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareGuildRbacStore(database as unknown as D1Database);

  assert.equal(await store.readGuildAdminRoleId("guild-1"), null);
});

test("createCloudflareGuildRbacStore upserts, replaces, and deletes role ids", async () => {
  const database = new SqliteD1Database();
  const firstStore = createCloudflareGuildRbacStore(database as unknown as D1Database);
  const secondStore = createCloudflareGuildRbacStore(database as unknown as D1Database);

  assert.strictEqual(firstStore, secondStore);

  await firstStore.upsertGuildAdminRoleId("guild-1", "role-1");
  assert.equal(await firstStore.readGuildAdminRoleId("guild-1"), "role-1");

  await firstStore.upsertGuildAdminRoleId("guild-1", "role-2");
  assert.equal(await firstStore.readGuildAdminRoleId("guild-1"), "role-2");
  await firstStore.upsertGuildAdminRoleId("guild-2", "role-3");
  assert.deepEqual(await firstStore.listGuildAdminRoleAssignments(), [
    { guildId: "guild-1", roleId: "role-2" },
    { guildId: "guild-2", roleId: "role-3" },
  ]);

  await firstStore.upsertGuildAdminRoleId("guild-1", null);
  assert.equal(await firstStore.readGuildAdminRoleId("guild-1"), null);
  assert.deepEqual(await firstStore.listGuildAdminRoleAssignments(), [
    { guildId: "guild-2", roleId: "role-3" },
  ]);
  assert.equal(database.execCalls, 0);
});

test("manager policy defaults on, is guild scoped, and survives role changes", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareGuildRbacStore(database as unknown as D1Database);
  assert.equal(await store.readManageServerAdminEnabled("guild-1"), true);
  await store.setManageServerAdminEnabled("guild-1", false);
  await store.upsertGuildAdminRoleId("guild-1", "role-1");
  assert.equal(await store.readManageServerAdminEnabled("guild-1"), false);
  await store.upsertGuildAdminRoleId("guild-1", null);
  assert.equal(await store.readManageServerAdminEnabled("guild-1"), false);
  assert.equal(await store.readManageServerAdminEnabled("guild-2"), true);
  await store.setManageServerAdminEnabled("guild-1", true);
  assert.equal(await store.readManageServerAdminEnabled("guild-1"), true);
});
