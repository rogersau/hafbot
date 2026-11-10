/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createCloudflareGuildRbacStore } from "../src/runtime/cloudflare-guild-rbac-store";
import { createCloudflareTimedRoleStore } from "../src/runtime/cloudflare-timed-role-store";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("Timed Role and Guild RBAC stores use the migrated unified database without runtime DDL", async () => {
  const database = new SqliteD1Database();
  const timedRoles = createCloudflareTimedRoleStore(database as unknown as D1Database);
  const rbac = createCloudflareGuildRbacStore(database as unknown as D1Database);

  await timedRoles.upsertTimedRole({
    guildId: "guild-1",
    userId: "user-1",
    roleId: "role-1",
    durationInput: "1h",
    expiresAtMs: 200,
  });
  assert.ok(timedRoles.upsertNewMemberTimedRoleConfig);
  assert.ok(timedRoles.upsertManualAssignmentTimedRoleConfig);
  assert.ok(timedRoles.readNewMemberTimedRoleConfig);
  assert.ok(timedRoles.readManualAssignmentTimedRoleConfig);
  await timedRoles.upsertNewMemberTimedRoleConfig({
    guildId: "guild-1",
    roles: [{ roleId: "role-new", durationInput: "2h" }],
  });
  await timedRoles.upsertManualAssignmentTimedRoleConfig({
    guildId: "guild-1",
    roles: [{ roleId: "role-manual", durationInput: "3h" }],
  });
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
  assert.deepEqual(await timedRoles.readNewMemberTimedRoleConfig("guild-1"), {
    guildId: "guild-1",
    roles: [{ roleId: "role-new", durationInput: "2h" }],
  });
  assert.deepEqual(await timedRoles.readManualAssignmentTimedRoleConfig("guild-1"), {
    guildId: "guild-1",
    roles: [{ roleId: "role-manual", durationInput: "3h" }],
  });
  assert.equal(await rbac.readGuildAdminRoleId("guild-1"), "admin-role-1");
  assert.equal(database.execCalls, 0);
});

test("Timed Role store adds, updates, lists, expires, and removes assignments", async () => {
  const database = new SqliteD1Database();
  const timedRoles = createCloudflareTimedRoleStore(database as unknown as D1Database);

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
  const timedRoles = createCloudflareTimedRoleStore(database as unknown as D1Database);

  assert.ok(timedRoles.readNewMemberTimedRoleConfig);
  assert.ok(timedRoles.upsertNewMemberTimedRoleConfig);
  assert.deepEqual(await timedRoles.readNewMemberTimedRoleConfig("guild-1"), {
    guildId: "guild-1",
    roles: [],
  });

  await timedRoles.upsertNewMemberTimedRoleConfig({
    guildId: "guild-1",
    roles: [{ roleId: "role-new", durationInput: "2h", dmMessage: "Welcome {user}" }],
  });

  assert.deepEqual(await timedRoles.readNewMemberTimedRoleConfig("guild-1"), {
    guildId: "guild-1",
    roles: [{ roleId: "role-new", durationInput: "2h", dmMessage: "Welcome {user}" }],
  });

  await timedRoles.upsertNewMemberTimedRoleConfig({
    guildId: "guild-1",
    roles: [],
  });

  assert.deepEqual(await timedRoles.readNewMemberTimedRoleConfig("guild-1"), {
    guildId: "guild-1",
    roles: [],
  });
  assert.equal(database.execCalls, 0);
});

test("Timed Role store reads, writes, and clears manual-assignment config", async () => {
  const database = new SqliteD1Database();
  const timedRoles = createCloudflareTimedRoleStore(database as unknown as D1Database);

  assert.ok(timedRoles.readManualAssignmentTimedRoleConfig);
  assert.ok(timedRoles.upsertManualAssignmentTimedRoleConfig);
  assert.deepEqual(await timedRoles.readManualAssignmentTimedRoleConfig("guild-1"), {
    guildId: "guild-1",
    roles: [],
  });
  assert.equal(
    database.prepareCalls.some((query) => query.includes("manual_assignment_timed_role_configs")),
    false,
    "empty current config must not query the dropped legacy table",
  );

  await timedRoles.upsertManualAssignmentTimedRoleConfig({
    guildId: "guild-1",
    roles: [{ roleId: "role-manual", durationInput: "3h" }],
  });

  assert.deepEqual(await timedRoles.readManualAssignmentTimedRoleConfig("guild-1"), {
    guildId: "guild-1",
    roles: [{ roleId: "role-manual", durationInput: "3h" }],
  });

  await timedRoles.upsertManualAssignmentTimedRoleConfig({
    guildId: "guild-1",
    roles: [],
  });

  assert.deepEqual(await timedRoles.readManualAssignmentTimedRoleConfig("guild-1"), {
    guildId: "guild-1",
    roles: [],
  });
  assert.equal(database.execCalls, 0);
});

test("Timed Role store persists immutable suspension snapshots and mutable restoration work", async () => {
  const database = new SqliteD1Database();
  const timedRoles = createCloudflareTimedRoleStore(database as unknown as D1Database);

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
  const timedRoles = createCloudflareTimedRoleStore(database as unknown as D1Database);

  await timedRoles.upsertNewMemberTimedRoleConfig!({
    guildId: "guild-1",
    roles: [
      {
        roleId: "timed-role",
        durationInput: "1h",
        suspendedRoleIds: ["access-a", "access-b"],
      },
    ],
  });

  assert.deepEqual(await timedRoles.readNewMemberTimedRoleConfig!("guild-1"), {
    guildId: "guild-1",
    roles: [
      {
        roleId: "timed-role",
        durationInput: "1h",
        suspendedRoleIds: ["access-a", "access-b"],
      },
    ],
  });
});
