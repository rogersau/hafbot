/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createSqliteGuildRbacStore } from "./support/sqlite/runtime/sqlite-guild-rbac-store";
import { createSqliteTimedRoleStore } from "./support/sqlite/runtime/sqlite-timed-role-store";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("Timed Role and Guild RBAC stores use the migrated unified database without runtime DDL", async () => {
  const database = new SqliteD1Database();
  const timedRoles = createSqliteTimedRoleStore(database as unknown as D1Database);
  const rbac = createSqliteGuildRbacStore(database as unknown as D1Database);

  await timedRoles.upsertTimedRole({
    guildId: "guild-1",
    userId: "user-1",
    roleId: "role-1",
    durationInput: "1h",
    expiresAtMs: 200,
  });
  assert.ok(timedRoles.upsertTimedRoleConfigRules);
  assert.ok(timedRoles.readTimedRoleConfigRules);
  await timedRoles.upsertTimedRoleConfigRules("guild-1", "new-member", [
    { roleId: "role-new", durationInput: "2h" },
  ]);
  await timedRoles.upsertTimedRoleConfigRules("guild-1", "manual-assignment", [
    { roleId: "role-manual", durationInput: "3h" },
  ]);
  await rbac.upsertGuildAdminRoleId("guild-1", "admin-role-1");

  assert.deepEqual(await timedRoles.listExpiredTimedRoles(250), [
    {
      guildId: "guild-1",
      userId: "user-1",
      roleId: "role-1",
      durationInput: "1h",
      expiresAtMs: 200,
    },
  ]);
  assert.deepEqual(await timedRoles.readTimedRoleConfigRules("guild-1", "new-member"), [
    { roleId: "role-new", durationInput: "2h" },
  ]);
  assert.deepEqual(await timedRoles.readTimedRoleConfigRules("guild-1", "manual-assignment"), [
    { roleId: "role-manual", durationInput: "3h" },
  ]);
  assert.equal(await rbac.readGuildAdminRoleId("guild-1"), "admin-role-1");
  assert.equal(database.execCalls, 0);
});

test("Timed Role store adds, updates, lists, expires, and removes assignments", async () => {
  const database = new SqliteD1Database();
  const timedRoles = createSqliteTimedRoleStore(database as unknown as D1Database);

  await timedRoles.upsertTimedRole({
    guildId: "guild-1",
    userId: "user-1",
    roleId: "role-1",
    durationInput: "1h",
    expiresAtMs: 300,
  });
  await timedRoles.upsertTimedRole({
    guildId: "guild-1",
    userId: "user-2",
    roleId: "role-2",
    targetDisplayName: "Fresh Spawn",
    durationInput: "2h",
    expiresAtMs: 200,
  });
  await timedRoles.upsertTimedRole({
    guildId: "guild-2",
    userId: "user-3",
    roleId: "role-3",
    durationInput: "3h",
    expiresAtMs: 100,
  });
  await timedRoles.upsertTimedRole({
    guildId: "guild-1",
    userId: "user-1",
    roleId: "role-1",
    durationInput: "4h",
    expiresAtMs: 400,
  });

  assert.deepEqual(await timedRoles.listTimedRolesByGuild("guild-1"), [
    {
      guildId: "guild-1",
      userId: "user-2",
      roleId: "role-2",
      targetDisplayName: "Fresh Spawn",
      durationInput: "2h",
      expiresAtMs: 200,
    },
    {
      guildId: "guild-1",
      userId: "user-1",
      roleId: "role-1",
      durationInput: "4h",
      expiresAtMs: 400,
    },
  ]);
  assert.deepEqual(await timedRoles.listTimedRoles(), [
    {
      guildId: "guild-1",
      userId: "user-2",
      roleId: "role-2",
      targetDisplayName: "Fresh Spawn",
      durationInput: "2h",
      expiresAtMs: 200,
    },
    {
      guildId: "guild-1",
      userId: "user-1",
      roleId: "role-1",
      durationInput: "4h",
      expiresAtMs: 400,
    },
    {
      guildId: "guild-2",
      userId: "user-3",
      roleId: "role-3",
      durationInput: "3h",
      expiresAtMs: 100,
    },
  ]);
  assert.deepEqual(await timedRoles.listExpiredTimedRoles(250), [
    {
      guildId: "guild-2",
      userId: "user-3",
      roleId: "role-3",
      durationInput: "3h",
      expiresAtMs: 100,
    },
    {
      guildId: "guild-1",
      userId: "user-2",
      roleId: "role-2",
      targetDisplayName: "Fresh Spawn",
      durationInput: "2h",
      expiresAtMs: 200,
    },
  ]);

  await timedRoles.deleteTimedRole({ guildId: "guild-1", userId: "user-2", roleId: "role-2" });

  assert.deepEqual(await timedRoles.listTimedRolesByGuild("guild-1"), [
    {
      guildId: "guild-1",
      userId: "user-1",
      roleId: "role-1",
      durationInput: "4h",
      expiresAtMs: 400,
    },
  ]);
  assert.equal(database.execCalls, 0);
});

test("Timed Role store reads, writes, and clears new-member config", async () => {
  const database = new SqliteD1Database();
  const timedRoles = createSqliteTimedRoleStore(database as unknown as D1Database);

  assert.ok(timedRoles.readTimedRoleConfigRules);
  assert.ok(timedRoles.upsertTimedRoleConfigRules);
  assert.deepEqual(await timedRoles.readTimedRoleConfigRules("guild-1", "new-member"), []);

  await timedRoles.upsertTimedRoleConfigRules("guild-1", "new-member", [
    { roleId: "role-new", durationInput: "2h", dmMessage: "Welcome {user}" },
  ]);

  assert.deepEqual(await timedRoles.readTimedRoleConfigRules("guild-1", "new-member"), [
    { roleId: "role-new", durationInput: "2h", dmMessage: "Welcome {user}" },
  ]);

  await timedRoles.upsertTimedRoleConfigRules("guild-1", "new-member", []);

  assert.deepEqual(await timedRoles.readTimedRoleConfigRules("guild-1", "new-member"), []);
  assert.equal(database.execCalls, 0);
});

test("Timed Role store reads, writes, and clears manual-assignment config", async () => {
  const database = new SqliteD1Database();
  const timedRoles = createSqliteTimedRoleStore(database as unknown as D1Database);

  assert.ok(timedRoles.readTimedRoleConfigRules);
  assert.ok(timedRoles.upsertTimedRoleConfigRules);
  assert.deepEqual(await timedRoles.readTimedRoleConfigRules("guild-1", "manual-assignment"), []);
  assert.equal(
    database.prepareCalls.some((query) => query.includes("manual_assignment_timed_role_configs")),
    false,
    "empty current config must not query the dropped legacy table",
  );

  await timedRoles.upsertTimedRoleConfigRules("guild-1", "manual-assignment", [
    { roleId: "role-manual", durationInput: "3h" },
  ]);

  assert.deepEqual(await timedRoles.readTimedRoleConfigRules("guild-1", "manual-assignment"), [
    { roleId: "role-manual", durationInput: "3h" },
  ]);

  await timedRoles.upsertTimedRoleConfigRules("guild-1", "manual-assignment", []);

  assert.deepEqual(await timedRoles.readTimedRoleConfigRules("guild-1", "manual-assignment"), []);
  assert.equal(database.execCalls, 0);
});

test("Timed Role store persists immutable suspension snapshots and mutable restoration work", async () => {
  const database = new SqliteD1Database();
  const timedRoles = createSqliteTimedRoleStore(database as unknown as D1Database);

  await timedRoles.upsertTimedRole({
    guildId: "guild-1",
    userId: "user-1",
    roleId: "timed-role",
    durationInput: "1h",
    expiresAtMs: 200,
    suspendedRoleIds: ["access-a", "access-b"],
    pendingSuspensionRoleIds: ["access-b"],
    removedRoleIds: ["access-a"],
    pendingRestorationRoleIds: ["access-a"],
  });

  await timedRoles.upsertTimedRole({
    guildId: "guild-1",
    userId: "user-1",
    roleId: "timed-role",
    durationInput: "2h",
    expiresAtMs: 400,
    suspendedRoleIds: ["edited-after-assignment"],
    removedRoleIds: [],
    pendingRestorationRoleIds: [],
  });

  assert.deepEqual(await timedRoles.listTimedRolesByGuild("guild-1"), [
    {
      guildId: "guild-1",
      userId: "user-1",
      roleId: "timed-role",
      durationInput: "2h",
      expiresAtMs: 400,
      suspendedRoleIds: ["access-a", "access-b"],
      pendingSuspensionRoleIds: ["access-b"],
      removedRoleIds: ["access-a"],
      pendingRestorationRoleIds: ["access-a"],
    },
  ]);

  await timedRoles.updateTimedRoleSuspension({
    guildId: "guild-1",
    userId: "user-1",
    roleId: "timed-role",
    pendingSuspensionRoleIds: [],
    removedRoleIds: ["access-a", "access-b"],
    pendingRestorationRoleIds: ["access-a", "access-b"],
  });

  await timedRoles.updateTimedRoleRestoration({
    guildId: "guild-1",
    userId: "user-1",
    roleId: "timed-role",
    pendingRestorationRoleIds: [],
    restorationStartedAtMs: 500,
    targetRoleRemovalCompletedAtMs: 501,
  });

  assert.deepEqual(await timedRoles.listTimedRolesByGuild("guild-1"), [
    {
      guildId: "guild-1",
      userId: "user-1",
      roleId: "timed-role",
      durationInput: "2h",
      expiresAtMs: 400,
      suspendedRoleIds: ["access-a", "access-b"],
      removedRoleIds: ["access-a", "access-b"],
      pendingRestorationRoleIds: [],
      restorationStartedAtMs: 500,
      targetRoleRemovalCompletedAtMs: 501,
    },
  ]);
  assert.equal(
    (await timedRoles.listExpiredTimedRoles(100))[0]?.restorationStartedAtMs,
    500,
    "early-removal restoration work must remain visible to scheduled retries",
  );
});

test("Timed Role store persists explicitly configured suspended roles", async () => {
  const database = new SqliteD1Database();
  const timedRoles = createSqliteTimedRoleStore(database as unknown as D1Database);

  await timedRoles.upsertTimedRoleConfigRules("guild-1", "new-member", [
    {
      roleId: "timed-role",
      durationInput: "1h",
      suspendedRoleIds: ["access-a", "access-b"],
    },
  ]);

  assert.deepEqual(await timedRoles.readTimedRoleConfigRules("guild-1", "new-member"), [
    {
      roleId: "timed-role",
      durationInput: "1h",
      suspendedRoleIds: ["access-a", "access-b"],
    },
  ]);
});

test("Timed Role rule replacement keeps the previous rules when the insert fails", async () => {
  const database = new SqliteD1Database();
  const timedRoles = createSqliteTimedRoleStore(database as unknown as D1Database);
  const previousRule = { roleId: "old-role", durationInput: "2h", dmMessage: "Old {user}" };
  const otherConfigRule = { roleId: "manual-role", durationInput: "3h" };
  await timedRoles.upsertTimedRoleConfigRules("guild-1", "new-member", [previousRule]);
  await timedRoles.upsertTimedRoleConfigRules("guild-1", "manual-assignment", [otherConfigRule]);

  const failingStore = createSqliteTimedRoleStore(databaseWithFailingRuleInsert(database));
  await assert.rejects(
    failingStore.upsertTimedRoleConfigRules("guild-1", "new-member", [
      { roleId: "replacement-role", durationInput: "1h" },
    ]),
    /injected timed-role rule insert failure/,
  );

  assert.deepEqual(await timedRoles.readTimedRoleConfigRules("guild-1", "new-member"), [
    previousRule,
  ]);
  assert.deepEqual(await timedRoles.readTimedRoleConfigRules("guild-1", "manual-assignment"), [
    otherConfigRule,
  ]);

  const replacement = { roleId: "replacement-role", durationInput: "1h" };
  await timedRoles.upsertTimedRoleConfigRules("guild-1", "new-member", [replacement]);
  assert.deepEqual(await timedRoles.readTimedRoleConfigRules("guild-1", "new-member"), [
    replacement,
  ]);
});

function databaseWithFailingRuleInsert(database: SqliteD1Database): D1Database {
  const underlying = database.d1;
  const failingStatement = {
    bind: () => failingStatement,
    runSync: () => {
      throw new Error("injected timed-role rule insert failure");
    },
  };
  return {
    ...underlying,
    prepare(query: string) {
      if (/insert\s+into\s+["`]?timed_role_config_rules/i.test(query)) {
        return failingStatement as unknown as D1PreparedStatement;
      }
      return underlying.prepare(query);
    },
    batch(statements: D1PreparedStatement[]) {
      return database.batch(statements as never) as never;
    },
  } as unknown as D1Database;
}
