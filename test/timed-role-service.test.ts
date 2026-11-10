/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import { TimedRoleService } from "../src/services/timed-role-service";
import { assignTimedRole } from "../src/services/timed-roles/assign-timed-role";
import { DiscordApiError } from "../src/discord";
import type { CreateChannelMessageInput } from "../src/discord/messages";
import type { TimedRoleStore } from "../src/runtime/contracts";
import {
  createProductionRuntimeStores,
  type ProductionRuntimeStoresFixture,
  withStoreOverrides,
} from "./support/production-runtime-stores";
import type {
  ManualAssignmentTimedRoleConfig,
  NewMemberTimedRoleConfig,
  TimedRoleAssignment,
} from "../src/types";
import {
  createPermissiveGuildResourceValidator,
  createStaticGuildResourceValidator,
  testRole,
} from "./helpers/guild-resource-validator";
import { GuildResourceValidationError } from "../src/discord/guild-resource-validator";

const timedRoleFixtures = new Set<ProductionRuntimeStoresFixture>();

test.after(() => {
  for (const fixture of timedRoleFixtures) fixture.close();
  timedRoleFixtures.clear();
});

function createTimedRoleStore(overrides: Partial<TimedRoleStore> = {}): TimedRoleStore {
  const fixture = createProductionRuntimeStores();
  timedRoleFixtures.add(fixture);
  return withStoreOverrides(fixture.stores.timedRoles, overrides);
}

test("TimedRoleService rejects foreign configuration roles before persistence", async () => {
  let persisted = 0;
  const store = createTimedRoleStore({
    async upsertTimedRoleConfigRules() {
      persisted += 1;
    },
  });
  const service = new TimedRoleService(
    store,
    "bot-token",
    createStaticGuildResourceValidator({
      guilds: {
        "guild-1": { channels: [], roles: [testRole("own-role")] },
        "guild-2": { channels: [], roles: [testRole("foreign-role")] },
      },
    }),
  );

  await assert.rejects(
    service.updateNewMemberTimedRoleConfig({
      guildId: "guild-1",
      roles: [{ roleId: "foreign-role", durationInput: "1h", dmMessage: null }],
    }),
    GuildResourceValidationError,
  );
  assert.equal(persisted, 0);
});

test("TimedRoleService rejects stale or unmanageable suspended roles before config persistence", async () => {
  let persisted = 0;
  const store = createTimedRoleStore({
    async upsertTimedRoleConfigRules() {
      persisted += 1;
    },
  });
  const service = new TimedRoleService(
    store,
    "bot-token",
    createStaticGuildResourceValidator({
      guilds: {
        "guild-1": {
          channels: [],
          roles: [
            { ...testRole("access-role"), position: 2 },
            { ...testRole("timed-role"), position: 4 },
            { ...testRole("bot-highest"), position: 8 },
            { ...testRole("too-high"), position: 9 },
          ],
        },
      },
    }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => [],
    async () => ["bot-highest"],
  );

  await assert.rejects(
    service.updateNewMemberTimedRoleConfig({
      guildId: "guild-1",
      roles: [
        {
          roleId: "timed-role",
          durationInput: "1h",
          suspendedRoleIds: ["too-high"],
        },
      ],
    }),
    GuildResourceValidationError,
  );
  assert.equal(persisted, 0);
});

test("TimedRoleService rejects a foreign assignment role before Discord or persistence", async () => {
  let persisted = 0;
  let discordCalls = 0;
  const store = createTimedRoleStore({
    async upsertTimedRole() {
      persisted += 1;
    },
  });
  const service = new TimedRoleService(
    store,
    "bot-token",
    createStaticGuildResourceValidator({
      guilds: {
        "guild-1": { channels: [], roles: [testRole("own-role")] },
        "guild-2": { channels: [], roles: [testRole("foreign-role")] },
      },
    }),
    async () => {
      discordCalls += 1;
    },
  );

  await assert.rejects(
    service.assignTimedRole({
      guildId: "guild-1",
      userId: "user-1",
      roleId: "foreign-role",
      durationInput: "1h",
      expiresAtMs: Date.now() + 60_000,
    }),
    GuildResourceValidationError,
  );
  assert.equal(discordCalls, 0);
  assert.equal(persisted, 0);
});

test("TimedRoleService leaves a stale expiry retryable and makes no Discord call", async () => {
  const expired: TimedRoleAssignment = {
    guildId: "guild-1",
    userId: "user-1",
    roleId: "foreign-role",
    durationInput: "1h",
    expiresAtMs: 1,
  };
  let deleted = 0;
  let discordCalls = 0;
  const store = createTimedRoleStore({
    async listExpiredTimedRoles() {
      return [expired];
    },
    async deleteTimedRole() {
      deleted += 1;
    },
  });
  const service = new TimedRoleService(
    store,
    "bot-token",
    createStaticGuildResourceValidator({
      guilds: {
        "guild-1": { channels: [], roles: [testRole("own-role")] },
        "guild-2": { channels: [], roles: [testRole("foreign-role")] },
      },
    }),
    undefined,
    async () => {
      discordCalls += 1;
    },
  );

  await service.expireDueTimedRoles(2);
  assert.equal(discordCalls, 0);
  assert.equal(deleted, 0);
});

test("TimedRoleService.assignTimedRole persists role and assigns via Discord", async () => {
  const upsertedRoles: TimedRoleAssignment[] = [];
  const assignedRoles: Array<{ guildId: string; userId: string; roleId: string }> = [];
  const notificationCalls: Array<{ channelId: string; body: CreateChannelMessageInput }> = [];

  const store = createTimedRoleStore({
    async upsertTimedRole(role: TimedRoleAssignment) {
      upsertedRoles.push(role);
    },
  });

  const service = new TimedRoleService(
    store,
    "bot-token",
    createPermissiveGuildResourceValidator(),
    async (guildId: string, userId: string, roleId: string) => {
      assignedRoles.push({ guildId, userId, roleId });
    },
    undefined,
    {
      readGuildNotificationChannel: async (_guildId: string, _feature: string) => "log-channel-1",
    },
    async (channelId, body) => {
      notificationCalls.push({ channelId, body });
    },
  );

  await service.assignTimedRole(
    {
      guildId: "guild-1",
      userId: "user-1",
      roleId: "role-1",
      targetDisplayName: "Fresh Spawn",
      durationInput: "1h",
      expiresAtMs: Date.now() + 3600000,
    },
    { label: "Admin dashboard", userId: "admin-1" },
  );

  assert.equal(upsertedRoles.length, 1);
  assert.equal(assignedRoles.length, 1);
  assert.deepEqual(assignedRoles[0], { guildId: "guild-1", userId: "user-1", roleId: "role-1" });
  assert.equal(notificationCalls.length, 1);
  assert.equal(notificationCalls[0]?.channelId, "log-channel-1");
  assert.equal(notificationCalls[0]?.body.content, undefined);
  assert.equal(notificationCalls[0]?.body.embeds?.[0]?.title, "⏱ Timed Role Update");
  assert.deepEqual(notificationCalls[0]?.body.embeds?.[0]?.fields, [
    { name: "Actor", value: "<@admin-1>\nID: admin-1", inline: false },
    { name: "Target Member", value: "Fresh Spawn\n<@user-1>\nID: user-1", inline: false },
    { name: "Role", value: "<@&role-1>", inline: false },
    { name: "Duration", value: "1h", inline: false },
    {
      name: "Expires",
      value: `<t:${Math.floor(upsertedRoles[0]!.expiresAtMs / 1000)}:R>`,
      inline: false,
    },
  ]);
  assert.deepEqual(notificationCalls[0]?.body.embeds?.[0]?.footer, { text: "hafbot.xyz" });
  assert.deepEqual(notificationCalls[0]?.body.allowed_mentions, { parse: [] });
});

test("TimedRoleService suspends only selected roles that the member holds and the bot can manage", async () => {
  const persisted: TimedRoleAssignment[] = [];
  const mutations: string[] = [];
  const store = createTimedRoleStore({
    async upsertTimedRole(assignment) {
      persisted.push(assignment);
    },
    async updateTimedRoleSuspension(update) {
      const assignment = persisted.at(-1);
      if (!assignment) return;
      if (update.pendingSuspensionRoleIds.length > 0) {
        assignment.pendingSuspensionRoleIds = update.pendingSuspensionRoleIds;
      } else {
        delete assignment.pendingSuspensionRoleIds;
      }
      assignment.removedRoleIds = update.removedRoleIds;
      assignment.pendingRestorationRoleIds = update.pendingRestorationRoleIds;
    },
  });
  const service = new TimedRoleService(
    store,
    "bot-token",
    createStaticGuildResourceValidator({
      guilds: {
        "guild-1": {
          channels: [],
          roles: [
            { ...testRole("guild-1"), position: 0 },
            { ...testRole("not-held"), position: 2 },
            { ...testRole("managed"), position: 3, managed: true },
            { ...testRole("held-access"), position: 4 },
            { ...testRole("timed-role"), position: 5 },
            { ...testRole("bot-highest"), position: 8 },
            { ...testRole("too-high"), position: 9 },
          ],
        },
      },
    }),
    async (_guildId, _userId, roleId) => {
      mutations.push(`add:${roleId}`);
    },
    async (_guildId, _userId, roleId) => {
      mutations.push(`remove:${roleId}`);
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => ["managed", "held-access", "too-high"],
    async () => ["bot-highest"],
  );

  await service.assignTimedRole({
    guildId: "guild-1",
    userId: "user-1",
    roleId: "timed-role",
    durationInput: "1h",
    expiresAtMs: 10_000,
    suspendedRoleIds: ["guild-1", "timed-role", "held-access", "not-held", "managed", "too-high"],
  });

  assert.deepEqual(mutations, ["add:timed-role", "remove:held-access"]);
  assert.deepEqual(persisted, [
    {
      guildId: "guild-1",
      userId: "user-1",
      roleId: "timed-role",
      durationInput: "1h",
      expiresAtMs: 10_000,
      suspendedRoleIds: ["held-access", "not-held"],
      removedRoleIds: ["held-access"],
      pendingRestorationRoleIds: ["held-access"],
    },
  ]);
});

test("TimedRoleService persists the held-role recovery snapshot before removing a selected role", async () => {
  const events: string[] = [];
  const store = createTimedRoleStore({
    async listTimedRolesByGuild() {
      return [];
    },
    async upsertTimedRole(assignment) {
      events.push(`capture:${(assignment.pendingSuspensionRoleIds ?? []).join(",")}`);
    },
  });
  const service = new TimedRoleService(
    store,
    "bot-token",
    createStaticGuildResourceValidator({
      guilds: {
        "guild-1": {
          channels: [],
          roles: [
            { ...testRole("access-role"), position: 2 },
            { ...testRole("timed-role"), position: 4 },
            { ...testRole("bot-highest"), position: 8 },
          ],
        },
      },
    }),
    async (_guildId, _userId, roleId) => {
      events.push(`add:${roleId}`);
    },
    async (_guildId, _userId, roleId) => {
      events.push(`remove:${roleId}`);
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => ["access-role"],
    async () => ["bot-highest"],
  );

  await service.assignTimedRole({
    guildId: "guild-1",
    userId: "user-1",
    roleId: "timed-role",
    durationInput: "1h",
    expiresAtMs: 10_000,
    suspendedRoleIds: ["access-role"],
  });

  assert.deepEqual(events, ["add:timed-role", "capture:access-role", "remove:access-role"]);
});

test("TimedRoleService resumes a captured selected-role removal after assignment replay", async () => {
  const existing: TimedRoleAssignment = {
    guildId: "guild-1",
    userId: "user-1",
    roleId: "timed-role",
    durationInput: "1h",
    expiresAtMs: Date.now() + 60_000,
    suspendedRoleIds: ["access-role"],
    removedRoleIds: ["access-role"],
    pendingRestorationRoleIds: ["access-role"],
  };
  const mutations: string[] = [];
  const store = createTimedRoleStore({
    async listTimedRolesByGuild() {
      return [existing];
    },
  });
  const service = new TimedRoleService(
    store,
    "bot-token",
    createStaticGuildResourceValidator({
      guilds: {
        "guild-1": {
          channels: [],
          roles: [
            { ...testRole("access-role"), position: 2 },
            { ...testRole("timed-role"), position: 4 },
            { ...testRole("bot-highest"), position: 8 },
          ],
        },
      },
    }),
    async (_guildId, _userId, roleId) => {
      mutations.push(`add:${roleId}`);
    },
    async (_guildId, _userId, roleId) => {
      mutations.push(`remove:${roleId}`);
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => ["timed-role", "access-role"],
    async () => ["bot-highest"],
  );

  await service.assignTimedRole({
    ...existing,
    durationInput: "2h",
    expiresAtMs: Date.now() + 120_000,
  });

  assert.deepEqual(mutations, ["remove:access-role"]);
});

test("TimedRoleService preserves an active assignment suspension snapshot when its expiry is updated", async () => {
  const existing: TimedRoleAssignment = {
    guildId: "guild-1",
    userId: "user-1",
    roleId: "timed-role",
    durationInput: "1h",
    expiresAtMs: Date.now() + 60_000,
    suspendedRoleIds: ["access-a"],
    removedRoleIds: ["access-a"],
    pendingRestorationRoleIds: ["access-a"],
  };
  const persisted: TimedRoleAssignment[] = [];
  const mutations: string[] = [];
  const store = createTimedRoleStore({
    async listTimedRolesByGuild() {
      return [existing];
    },
    async upsertTimedRole(assignment) {
      persisted.push(assignment);
    },
  });
  const service = new TimedRoleService(
    store,
    "bot-token",
    createStaticGuildResourceValidator({
      guilds: {
        "guild-1": {
          channels: [],
          roles: [
            { ...testRole("access-a"), position: 2 },
            { ...testRole("access-b"), position: 3 },
            { ...testRole("timed-role"), position: 4 },
            { ...testRole("bot-highest"), position: 8 },
          ],
        },
      },
    }),
    async (_guildId, _userId, roleId) => {
      mutations.push(`add:${roleId}`);
    },
    async (_guildId, _userId, roleId) => {
      mutations.push(`remove:${roleId}`);
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => ["timed-role", "access-b"],
    async () => ["bot-highest"],
  );
  const updatedExpiry = Date.now() + 120_000;

  await service.assignTimedRole({
    guildId: "guild-1",
    userId: "user-1",
    roleId: "timed-role",
    durationInput: "2h",
    expiresAtMs: updatedExpiry,
    suspendedRoleIds: ["access-b"],
  });

  assert.deepEqual(mutations, []);
  assert.deepEqual(persisted, [
    {
      ...existing,
      durationInput: "2h",
      expiresAtMs: updatedExpiry,
    },
  ]);
});

test("TimedRoleService compensates role mutations when a selected suspension fails", async () => {
  let persisted = 0;
  let deleted = 0;
  const mutations: string[] = [];
  const store = createTimedRoleStore({
    async upsertTimedRole() {
      persisted += 1;
    },
    async deleteTimedRole() {
      deleted += 1;
    },
  });
  const service = new TimedRoleService(
    store,
    "bot-token",
    createStaticGuildResourceValidator({
      guilds: {
        "guild-1": {
          channels: [],
          roles: [
            { ...testRole("access-a"), position: 2 },
            { ...testRole("access-b"), position: 3 },
            { ...testRole("timed-role"), position: 4 },
            { ...testRole("bot-highest"), position: 8 },
          ],
        },
      },
    }),
    async (_guildId, _userId, roleId) => {
      mutations.push(`add:${roleId}`);
    },
    async (_guildId, _userId, roleId) => {
      mutations.push(`remove:${roleId}`);
      if (roleId === "access-b") throw new Error("Discord remove failed");
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => ["access-a", "access-b"],
    async () => ["bot-highest"],
  );

  await assert.rejects(
    service.assignTimedRole({
      guildId: "guild-1",
      userId: "user-1",
      roleId: "timed-role",
      durationInput: "1h",
      expiresAtMs: 10_000,
      suspendedRoleIds: ["access-a", "access-b"],
    }),
    /Discord remove failed/,
  );

  assert.deepEqual(mutations, [
    "add:timed-role",
    "remove:access-a",
    "remove:access-b",
    "add:access-b",
    "add:access-a",
    "remove:timed-role",
  ]);
  assert.equal(persisted, 2);
  assert.equal(deleted, 1);
});

test("TimedRoleService persists exact recovery work when assignment compensation fails", async () => {
  const persisted: TimedRoleAssignment[] = [];
  const store = createTimedRoleStore({
    async upsertTimedRole(assignment) {
      persisted.push(assignment);
    },
  });
  const service = new TimedRoleService(
    store,
    "bot-token",
    createStaticGuildResourceValidator({
      guilds: {
        "guild-1": {
          channels: [],
          roles: [
            { ...testRole("access-a"), position: 2 },
            { ...testRole("access-b"), position: 3 },
            { ...testRole("timed-role"), position: 4 },
            { ...testRole("bot-highest"), position: 8 },
          ],
        },
      },
    }),
    async (_guildId, _userId, roleId) => {
      if (roleId === "access-a") throw new Error("restore failed");
    },
    async (_guildId, _userId, roleId) => {
      if (roleId === "access-b") throw new Error("suspension failed");
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => ["access-a", "access-b"],
    async () => ["bot-highest"],
  );

  await assert.rejects(
    service.assignTimedRole({
      guildId: "guild-1",
      userId: "user-1",
      roleId: "timed-role",
      durationInput: "1h",
      expiresAtMs: 10_000,
      suspendedRoleIds: ["access-a", "access-b"],
    }),
    /rollback failed/,
  );

  assert.equal(persisted.length, 3);
  assert.deepEqual(persisted.at(-1)?.removedRoleIds, ["access-a", "access-b"]);
  assert.deepEqual(persisted.at(-1)?.pendingRestorationRoleIds, ["access-a"]);
  assert.ok((persisted.at(-1)?.expiresAtMs ?? Number.MAX_SAFE_INTEGER) <= Date.now());
  assert.equal(persisted.at(-1)?.restorationStartedAtMs, undefined);
});

test("TimedRoleService.assignTimedRole sends configured assignment DM", async () => {
  const dmCalls: Array<{ userId: string; body: CreateChannelMessageInput }> = [];
  const store = createTimedRoleStore({
    async readTimedRoleConfigRules(guildId, configType) {
      return guildId === "guild-1" && configType === "new-member"
        ? [
            {
              roleId: "role-1",
              durationInput: "1h",
              dmMessage: "Hi {username}, you got {rolename} in {guild}: {role}.",
            },
          ]
        : [];
    },
  });

  const service = new TimedRoleService(
    store,
    "bot-token",
    createPermissiveGuildResourceValidator(),
    async () => {},
    undefined,
    undefined,
    undefined,
    async (userId, body) => {
      dmCalls.push({ userId, body });
    },
    async () => ({ guildName: "Guild One", roleName: "Raider" }),
  );

  await service.assignTimedRole({
    guildId: "guild-1",
    userId: "user-1",
    roleId: "role-1",
    targetDisplayName: "Fresh Spawn",
    durationInput: "1h",
    expiresAtMs: 1_700_003_600_000,
  });

  assert.equal(dmCalls.length, 1);
  assert.equal(dmCalls[0]?.userId, "user-1");
  assert.deepEqual(dmCalls[0]?.body.embeds?.[0], {
    title: "Role Assigned",
    color: 0x57f287,
    description: "Hi Fresh Spawn, you got Raider in Guild One: <@&role-1>.",
    fields: [
      { name: "Role", value: "<@&role-1>", inline: false },
      { name: "Duration", value: "1h", inline: false },
      { name: "Expires", value: "<t:1700003600:R>", inline: false },
    ],
    footer: { text: "hafbot.xyz" },
    timestamp: dmCalls[0]?.body.embeds?.[0]?.timestamp,
  });
  assert.deepEqual(dmCalls[0]?.body.allowed_mentions, { parse: [] });
});

test("TimedRoleService.assignTimedRole resolves White-Label footer text for active guilds", async () => {
  const dmCalls: Array<{ userId: string; body: CreateChannelMessageInput }> = [];
  const store = createTimedRoleStore({
    async readTimedRoleConfigRules(guildId, configType) {
      return guildId === "guild-wl" && configType === "new-member"
        ? [
            {
              roleId: "role-1",
              durationInput: "1h",
              dmMessage: "Hi {username}, you got {rolename} in {guild}: {role}.",
            },
          ]
        : [];
    },
  });

  const service = new TimedRoleService(
    store,
    "bot-token",
    createPermissiveGuildResourceValidator(),
    async () => {},
    undefined,
    undefined,
    undefined,
    async (userId, body) => {
      dmCalls.push({ userId, body });
    },
    async () => ({ guildName: "White-Label Guild", roleName: "Member" }),
    async (guildId) => (guildId === "guild-wl" ? "custom-footer.example" : "hafbot.xyz"),
  );

  await service.assignTimedRole({
    guildId: "guild-wl",
    userId: "user-1",
    roleId: "role-1",
    targetDisplayName: "Member",
    durationInput: "1h",
    expiresAtMs: 1_700_003_600_000,
  });

  assert.equal(dmCalls.length, 1);
  assert.deepEqual(dmCalls[0]?.body.embeds?.[0]?.footer, { text: "custom-footer.example" });
});

test("TimedRoleService.assignTimedRole falls back to a mention without a display name", async () => {
  const notificationCalls: Array<{ channelId: string; body: CreateChannelMessageInput }> = [];
  const store = createTimedRoleStore({});

  const service = new TimedRoleService(
    store,
    "bot-token",
    createPermissiveGuildResourceValidator(),
    async () => {},
    undefined,
    {
      readGuildNotificationChannel: async (_guildId: string, _feature: string) => "log-channel-1",
    },
    async (channelId, body) => {
      notificationCalls.push({ channelId, body });
    },
  );

  await service.assignTimedRole({
    guildId: "guild-1",
    userId: "user-1",
    roleId: "role-1",
    durationInput: "1h",
    expiresAtMs: Date.now() + 3600000,
  });

  assert.deepEqual(notificationCalls[0]?.body.embeds?.[0]?.fields?.[1], {
    name: "Target Member",
    value: "<@user-1>\nID: user-1",
    inline: false,
  });
  assert.deepEqual(notificationCalls[0]?.body.allowed_mentions, { parse: [] });
});

test("TimedRoleService.assignTimedRole rolls back database when Discord role assignment fails", async () => {
  const upsertedRoles: TimedRoleAssignment[] = [];
  const deletedRoles: Array<{ guildId: string; userId: string; roleId: string }> = [];
  const notificationCalls: Array<{ channelId: string; content?: string }> = [];

  const store = createTimedRoleStore({
    async upsertTimedRole(role: TimedRoleAssignment) {
      upsertedRoles.push(role);
    },
    async deleteTimedRole(key: { guildId: string; userId: string; roleId: string }) {
      deletedRoles.push(key);
    },
  });

  const service = new TimedRoleService(
    store,
    "bot-token",
    createPermissiveGuildResourceValidator(),
    async () => {
      throw new Error("Discord API failed");
    },
    undefined,
    {
      readGuildNotificationChannel: async (_guildId: string, _feature: string) => "log-channel-1",
    },
    async (channelId, body) => {
      notificationCalls.push({ channelId, content: body.content });
    },
  );

  await assert.rejects(
    async () =>
      service.assignTimedRole({
        guildId: "guild-1",
        userId: "user-1",
        roleId: "role-1",
        durationInput: "1h",
        expiresAtMs: Date.now() + 3600000,
      }),
    /Discord API failed/,
  );

  assert.equal(upsertedRoles.length, 1, "Role should be persisted before Discord call");
  assert.equal(deletedRoles.length, 1, "Role should be deleted after Discord failure");
  assert.deepEqual(deletedRoles[0], { guildId: "guild-1", userId: "user-1", roleId: "role-1" });
  assert.deepEqual(notificationCalls, []);
});

test("TimedRoleService.removeTimedRole removes from Discord then deletes from database", async () => {
  const deletedRoles: Array<{ guildId: string; userId: string; roleId: string }> = [];
  const removedRoles: Array<{ guildId: string; userId: string; roleId: string }> = [];
  const notificationCalls: Array<{ channelId: string; body: CreateChannelMessageInput }> = [];

  const store = createTimedRoleStore({
    async deleteTimedRole(key: { guildId: string; userId: string; roleId: string }) {
      deletedRoles.push(key);
    },
  });

  const service = new TimedRoleService(
    store,
    "bot-token",
    createPermissiveGuildResourceValidator(),
    undefined,
    async (guildId: string, userId: string, roleId: string) => {
      removedRoles.push({ guildId, userId, roleId });
    },
    {
      readGuildNotificationChannel: async (_guildId: string, _feature: string) => "log-channel-1",
    },
    async (channelId, body) => {
      notificationCalls.push({ channelId, body });
    },
  );

  await service.removeTimedRole(
    {
      guildId: "guild-1",
      userId: "user-1",
      roleId: "role-1",
      targetDisplayName: "Fresh Spawn",
      durationInput: "1w",
      expiresAtMs: 1_700_604_800_000,
    },
    { label: "Admin dashboard", userId: "admin-1" },
  );

  assert.equal(removedRoles.length, 1, "Should remove from Discord first");
  assert.equal(deletedRoles.length, 1, "Should delete from database after Discord removal");
  assert.deepEqual(deletedRoles[0], {
    guildId: "guild-1",
    userId: "user-1",
    roleId: "role-1",
    targetDisplayName: "Fresh Spawn",
    durationInput: "1w",
    expiresAtMs: 1_700_604_800_000,
  });
  assert.equal(notificationCalls.length, 1);
  assert.equal(notificationCalls[0]?.channelId, "log-channel-1");
  assert.equal(notificationCalls[0]?.body.embeds?.[0]?.title, "⏱ Timed Role Update");
  assert.deepEqual(notificationCalls[0]?.body.embeds?.[0]?.fields, [
    { name: "Actor", value: "<@admin-1>\nID: admin-1", inline: false },
    { name: "Target Member", value: "Fresh Spawn\n<@user-1>\nID: user-1", inline: false },
    { name: "Role", value: "<@&role-1>", inline: false },
    { name: "Duration", value: "1w", inline: false },
    { name: "Expires", value: "<t:1700604800:R>", inline: false },
  ]);
  assert.deepEqual(notificationCalls[0]?.body.allowed_mentions, { parse: [] });
});

test("TimedRoleService.removeTimedRole restores the assignment suspension snapshot", async () => {
  const assignment: TimedRoleAssignment = {
    guildId: "guild-1",
    userId: "user-1",
    roleId: "timed-role",
    durationInput: "1h",
    expiresAtMs: 10_000,
    suspendedRoleIds: ["access-role"],
    removedRoleIds: ["access-role"],
    pendingRestorationRoleIds: ["access-role"],
  };
  const mutations: string[] = [];
  const deleted: TimedRoleAssignment[] = [];
  const store = createTimedRoleStore({
    async listTimedRolesByGuild() {
      return [assignment];
    },
    async deleteTimedRole(key) {
      deleted.push({ ...assignment, ...key });
    },
  });
  const service = new TimedRoleService(
    store,
    "bot-token",
    createStaticGuildResourceValidator({
      guilds: {
        "guild-1": {
          channels: [],
          roles: [
            { ...testRole("access-role"), position: 2 },
            { ...testRole("timed-role"), position: 4 },
            { ...testRole("bot-highest"), position: 8 },
          ],
        },
      },
    }),
    async (_guildId, _userId, roleId) => {
      mutations.push(`add:${roleId}`);
    },
    async (_guildId, _userId, roleId) => {
      mutations.push(`remove:${roleId}`);
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => [],
    async () => ["bot-highest"],
  );

  await service.removeTimedRole(assignment, { label: "Admin dashboard" });

  assert.deepEqual(mutations, ["remove:timed-role", "add:access-role"]);
  assert.equal(deleted.length, 1);
});

test("TimedRoleService keeps a failed early target-role removal scheduled for automatic retry", async () => {
  const assignment: TimedRoleAssignment = {
    guildId: "guild-1",
    userId: "user-1",
    roleId: "timed-role",
    durationInput: "1h",
    expiresAtMs: Date.now() + 3_600_000,
    suspendedRoleIds: ["access-role"],
    removedRoleIds: ["access-role"],
    pendingRestorationRoleIds: ["access-role"],
  };
  let targetRemovalAttempts = 0;
  let restored = 0;
  let deleted = 0;
  const store = createTimedRoleStore({
    async listExpiredTimedRoles() {
      return assignment.restorationStartedAtMs != null ? [assignment] : [];
    },
    async listTimedRolesByGuild() {
      return [assignment];
    },
    async updateTimedRoleRestoration(update) {
      assignment.pendingRestorationRoleIds = update.pendingRestorationRoleIds;
      assignment.restorationStartedAtMs = update.restorationStartedAtMs;
      assignment.targetRoleRemovalCompletedAtMs = update.targetRoleRemovalCompletedAtMs;
    },
    async deleteTimedRole() {
      deleted += 1;
    },
  });
  const service = new TimedRoleService(
    store,
    "bot-token",
    createStaticGuildResourceValidator({
      guilds: {
        "guild-1": {
          channels: [],
          roles: [
            { ...testRole("access-role"), position: 2 },
            { ...testRole("timed-role"), position: 4 },
            { ...testRole("bot-highest"), position: 8 },
          ],
        },
      },
    }),
    async (_guildId, _userId, roleId) => {
      if (roleId === "access-role") restored += 1;
    },
    async () => {
      targetRemovalAttempts += 1;
      if (targetRemovalAttempts === 1) {
        throw new DiscordApiError("Discord unavailable", 500, "temporary");
      }
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => [],
    async () => ["bot-highest"],
  );

  await assert.rejects(service.removeTimedRole(assignment), /Failed to restore/);
  assert.equal(typeof assignment.restorationStartedAtMs, "number");
  assert.equal(assignment.targetRoleRemovalCompletedAtMs, null);
  assert.equal(deleted, 0);

  await service.expireDueTimedRoles(Date.now());
  assert.equal(targetRemovalAttempts, 2);
  assert.equal(restored, 1);
  assert.equal(deleted, 1);
  assert.equal(typeof assignment.targetRoleRemovalCompletedAtMs, "number");
});

test("TimedRoleService defers overlapping restoration until the final assignment ends", async () => {
  const assignment: TimedRoleAssignment = {
    guildId: "guild-1",
    userId: "user-1",
    roleId: "timed-role-a",
    durationInput: "1h",
    expiresAtMs: 100,
    suspendedRoleIds: ["access-role"],
    removedRoleIds: ["access-role"],
    pendingRestorationRoleIds: ["access-role"],
  };
  const blocker: TimedRoleAssignment = {
    guildId: "guild-1",
    userId: "user-1",
    roleId: "timed-role-b",
    durationInput: "2h",
    expiresAtMs: 1_000,
    suspendedRoleIds: ["access-role"],
    removedRoleIds: [],
    pendingRestorationRoleIds: [],
  };
  let blockerActive = true;
  let deleted = 0;
  const mutations: string[] = [];
  const restorationUpdates: string[][] = [];
  const store = createTimedRoleStore({
    async listExpiredTimedRoles() {
      return [assignment];
    },
    async listTimedRolesByGuild() {
      return blockerActive ? [assignment, blocker] : [assignment];
    },
    async updateTimedRoleRestoration(update) {
      assignment.pendingRestorationRoleIds = update.pendingRestorationRoleIds;
      assignment.restorationStartedAtMs = update.restorationStartedAtMs;
      assignment.targetRoleRemovalCompletedAtMs = update.targetRoleRemovalCompletedAtMs;
      restorationUpdates.push(update.pendingRestorationRoleIds);
    },
    async deleteTimedRole() {
      deleted += 1;
    },
  });
  const service = new TimedRoleService(
    store,
    "bot-token",
    createStaticGuildResourceValidator({
      guilds: {
        "guild-1": {
          channels: [],
          roles: [
            { ...testRole("access-role"), position: 2 },
            { ...testRole("timed-role-a"), position: 4 },
            { ...testRole("timed-role-b"), position: 5 },
            { ...testRole("bot-highest"), position: 8 },
          ],
        },
      },
    }),
    async (_guildId, _userId, roleId) => {
      mutations.push(`add:${roleId}`);
    },
    async (_guildId, _userId, roleId) => {
      mutations.push(`remove:${roleId}`);
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => [],
    async () => ["bot-highest"],
  );

  await service.expireDueTimedRoles(100);
  assert.deepEqual(mutations, ["remove:timed-role-a"]);
  assert.deepEqual(restorationUpdates, [["access-role"], ["access-role"]]);
  assert.equal(deleted, 0);

  blockerActive = false;
  await service.expireDueTimedRoles(101);
  assert.deepEqual(mutations, ["remove:timed-role-a", "add:access-role"]);
  assert.equal(deleted, 1);
});

test("TimedRoleService keeps failed role restoration retryable", async () => {
  const assignment: TimedRoleAssignment = {
    guildId: "guild-1",
    userId: "user-1",
    roleId: "timed-role",
    durationInput: "1h",
    expiresAtMs: 100,
    suspendedRoleIds: ["access-role"],
    removedRoleIds: ["access-role"],
    pendingRestorationRoleIds: ["access-role"],
  };
  let restorationAttempts = 0;
  let deleted = 0;
  const store = createTimedRoleStore({
    async listExpiredTimedRoles() {
      return [assignment];
    },
    async listTimedRolesByGuild() {
      return [assignment];
    },
    async updateTimedRoleRestoration(update) {
      assignment.pendingRestorationRoleIds = update.pendingRestorationRoleIds;
      assignment.restorationStartedAtMs = update.restorationStartedAtMs;
      assignment.targetRoleRemovalCompletedAtMs = update.targetRoleRemovalCompletedAtMs;
    },
    async deleteTimedRole() {
      deleted += 1;
    },
  });
  const service = new TimedRoleService(
    store,
    "bot-token",
    createStaticGuildResourceValidator({
      guilds: {
        "guild-1": {
          channels: [],
          roles: [
            { ...testRole("access-role"), position: 2 },
            { ...testRole("timed-role"), position: 4 },
            { ...testRole("bot-highest"), position: 8 },
          ],
        },
      },
    }),
    async () => {
      restorationAttempts += 1;
      if (restorationAttempts === 1) {
        throw new DiscordApiError("Discord unavailable", 500, "temporary");
      }
    },
    async () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => [],
    async () => ["bot-highest"],
  );

  await service.expireDueTimedRoles(100);
  assert.deepEqual(assignment.pendingRestorationRoleIds, ["access-role"]);
  assert.equal(deleted, 0);

  await service.expireDueTimedRoles(101);
  assert.equal(restorationAttempts, 2);
  assert.equal(deleted, 1);
});

test("TimedRoleService skips a deleted suspended role and completes restoration", async () => {
  const assignment: TimedRoleAssignment = {
    guildId: "guild-1",
    userId: "user-1",
    roleId: "timed-role",
    durationInput: "1h",
    expiresAtMs: 100,
    suspendedRoleIds: ["deleted-role"],
    removedRoleIds: ["deleted-role"],
    pendingRestorationRoleIds: ["deleted-role"],
  };
  let restored = 0;
  let deleted = 0;
  const store = createTimedRoleStore({
    async listExpiredTimedRoles() {
      return [assignment];
    },
    async listTimedRolesByGuild() {
      return [assignment];
    },
    async deleteTimedRole() {
      deleted += 1;
    },
  });
  const service = new TimedRoleService(
    store,
    "bot-token",
    createStaticGuildResourceValidator({
      guilds: {
        "guild-1": {
          channels: [],
          roles: [
            { ...testRole("timed-role"), position: 4 },
            { ...testRole("bot-highest"), position: 8 },
          ],
        },
      },
    }),
    async () => {
      restored += 1;
    },
    async () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => [],
    async () => ["bot-highest"],
  );

  await service.expireDueTimedRoles(100);
  assert.equal(restored, 0);
  assert.equal(deleted, 1);
});

test("TimedRoleService does not falsely restore a role that became unmanageable", async () => {
  const assignment: TimedRoleAssignment = {
    guildId: "guild-1",
    userId: "user-1",
    roleId: "timed-role",
    durationInput: "1h",
    expiresAtMs: 100,
    suspendedRoleIds: ["access-role"],
    removedRoleIds: ["access-role"],
    pendingRestorationRoleIds: ["access-role"],
  };
  let restored = 0;
  let deleted = 0;
  let pending: string[] = [];
  const store = createTimedRoleStore({
    async listExpiredTimedRoles() {
      return [assignment];
    },
    async listTimedRolesByGuild() {
      return [assignment];
    },
    async updateTimedRoleRestoration(update) {
      pending = update.pendingRestorationRoleIds;
      assignment.restorationStartedAtMs = update.restorationStartedAtMs;
      assignment.targetRoleRemovalCompletedAtMs = update.targetRoleRemovalCompletedAtMs;
    },
    async deleteTimedRole() {
      deleted += 1;
    },
  });
  const service = new TimedRoleService(
    store,
    "bot-token",
    createStaticGuildResourceValidator({
      guilds: {
        "guild-1": {
          channels: [],
          roles: [
            { ...testRole("timed-role"), position: 4 },
            { ...testRole("bot-highest"), position: 8 },
            { ...testRole("access-role"), position: 9 },
          ],
        },
      },
    }),
    async () => {
      restored += 1;
    },
    async () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => [],
    async () => ["bot-highest"],
  );

  await service.expireDueTimedRoles(100);
  assert.equal(restored, 0);
  assert.deepEqual(pending, ["access-role"]);
  assert.equal(deleted, 0);
});

test("TimedRoleService.assignConfiguredNewMemberRole assigns the configured role until expiry", async () => {
  const upsertedRoles: TimedRoleAssignment[] = [];
  const assignedRoles: Array<{ guildId: string; userId: string; roleId: string }> = [];
  const notificationCalls: Array<{ channelId: string; body: CreateChannelMessageInput }> = [];
  const config: NewMemberTimedRoleConfig = {
    guildId: "guild-1",
    roles: [{ roleId: "role-newbie", durationInput: "2h" }],
  };

  const store = createTimedRoleStore({
    async readNewMemberTimedRoleConfig(guildId: string) {
      return guildId === config.guildId ? config : { guildId, roles: [] };
    },
    async upsertTimedRole(role: TimedRoleAssignment) {
      upsertedRoles.push(role);
    },
  });

  const service = new TimedRoleService(
    store,
    "bot-token",
    createPermissiveGuildResourceValidator(),
    async (guildId: string, userId: string, roleId: string) => {
      assignedRoles.push({ guildId, userId, roleId });
    },
    undefined,
    {
      readGuildNotificationChannel: async (_guildId: string, _feature: string) => "log-channel-1",
    },
    async (channelId, body) => {
      notificationCalls.push({ channelId, body });
    },
  );

  const assignments = await service.assignConfiguredNewMemberRole({
    guildId: "guild-1",
    userId: "user-1",
    targetDisplayName: "Fresh Spawn",
    nowMs: 1_700_000_000_000,
  });

  assert.deepEqual(assignments, [
    {
      guildId: "guild-1",
      userId: "user-1",
      roleId: "role-newbie",
      targetDisplayName: "Fresh Spawn",
      durationInput: "2h",
      expiresAtMs: 1_700_007_200_000,
    },
  ]);
  assert.deepEqual(upsertedRoles, assignments);
  assert.deepEqual(assignedRoles, [
    { guildId: "guild-1", userId: "user-1", roleId: "role-newbie" },
  ]);
  assert.equal(notificationCalls.length, 1);
  assert.equal(notificationCalls[0]?.body.embeds?.[0]?.title, "⏱ Timed Role Update");
  assert.deepEqual(notificationCalls[0]?.body.embeds?.[0]?.fields?.slice(0, 3), [
    { name: "Actor", value: "New member automation", inline: false },
    { name: "Target Member", value: "Fresh Spawn\n<@user-1>\nID: user-1", inline: false },
    { name: "Role", value: "<@&role-newbie>", inline: false },
  ]);
  assert.deepEqual(notificationCalls[0]?.body.allowed_mentions, { parse: [] });
});

test("TimedRoleService.assignConfiguredNewMemberRole applies configured role suspension", async () => {
  const mutations: string[] = [];
  const store = createTimedRoleStore({
    async readNewMemberTimedRoleConfig() {
      return {
        guildId: "guild-1",
        roles: [
          {
            roleId: "timed-role",
            durationInput: "1h",
            suspendedRoleIds: ["access-role"],
          },
        ],
      };
    },
  });
  const service = new TimedRoleService(
    store,
    "bot-token",
    createStaticGuildResourceValidator({
      guilds: {
        "guild-1": {
          channels: [],
          roles: [
            { ...testRole("access-role"), position: 2 },
            { ...testRole("timed-role"), position: 4 },
            { ...testRole("bot-highest"), position: 8 },
          ],
        },
      },
    }),
    async (_guildId, _userId, roleId) => {
      mutations.push(`add:${roleId}`);
    },
    async (_guildId, _userId, roleId) => {
      mutations.push(`remove:${roleId}`);
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => ["access-role"],
    async () => ["bot-highest"],
  );

  await service.assignConfiguredNewMemberRole({
    guildId: "guild-1",
    userId: "user-1",
    nowMs: 1_000,
  });

  assert.deepEqual(mutations, ["add:timed-role", "remove:access-role"]);
  const [persisted] = await store.listTimedRolesByGuild("guild-1");
  assert.deepEqual(persisted?.removedRoleIds, ["access-role"]);
  assert.deepEqual(persisted?.pendingRestorationRoleIds, ["access-role"]);
});

test("TimedRoleService.assignConfiguredNewMemberRole assigns every configured new-member role", async () => {
  const upsertedRoles: TimedRoleAssignment[] = [];
  const assignedRoles: Array<{ guildId: string; userId: string; roleId: string }> = [];
  const config: NewMemberTimedRoleConfig = {
    guildId: "guild-1",
    roles: [
      { roleId: "role-trial", durationInput: "2h" },
      { roleId: "role-newbie", durationInput: "1w" },
    ],
  };

  const store = createTimedRoleStore({
    async readNewMemberTimedRoleConfig(guildId: string) {
      return guildId === config.guildId ? config : { guildId, roles: [] };
    },
    async upsertTimedRole(role: TimedRoleAssignment) {
      upsertedRoles.push(role);
    },
  });

  const service = new TimedRoleService(
    store,
    "bot-token",
    createPermissiveGuildResourceValidator(),
    async (guildId: string, userId: string, roleId: string) => {
      assignedRoles.push({ guildId, userId, roleId });
    },
  );

  const assignments = await service.assignConfiguredNewMemberRole({
    guildId: "guild-1",
    userId: "user-1",
    targetDisplayName: "Fresh Spawn",
    nowMs: 1_700_000_000_000,
  });

  assert.deepEqual(assignments, [
    {
      guildId: "guild-1",
      userId: "user-1",
      roleId: "role-trial",
      targetDisplayName: "Fresh Spawn",
      durationInput: "2h",
      expiresAtMs: 1_700_007_200_000,
    },
    {
      guildId: "guild-1",
      userId: "user-1",
      roleId: "role-newbie",
      targetDisplayName: "Fresh Spawn",
      durationInput: "1w",
      expiresAtMs: 1_700_604_800_000,
    },
  ]);
  assert.deepEqual(upsertedRoles, assignments);
  assert.deepEqual(assignedRoles, [
    { guildId: "guild-1", userId: "user-1", roleId: "role-trial" },
    { guildId: "guild-1", userId: "user-1", roleId: "role-newbie" },
  ]);
});

test("TimedRoleService.expireDueTimedRoles posts an automatic expiry audit embed", async () => {
  const expiredRole: TimedRoleAssignment = {
    guildId: "guild-1",
    userId: "user-1",
    roleId: "role-1",
    targetDisplayName: "Fresh Spawn",
    durationInput: "1h",
    expiresAtMs: 1_700_003_600_000,
  };
  const deletedRoles: Array<{ guildId: string; userId: string; roleId: string }> = [];
  const removedRoles: Array<{ guildId: string; userId: string; roleId: string }> = [];
  const notificationCalls: Array<{ channelId: string; body: CreateChannelMessageInput }> = [];

  const store = createTimedRoleStore({
    async deleteTimedRole(key: { guildId: string; userId: string; roleId: string }) {
      deletedRoles.push(key);
    },
    async listExpiredTimedRoles() {
      return [expiredRole];
    },
  });

  const service = new TimedRoleService(
    store,
    "bot-token",
    createPermissiveGuildResourceValidator(),
    undefined,
    async (guildId: string, userId: string, roleId: string) => {
      removedRoles.push({ guildId, userId, roleId });
    },
    {
      readGuildNotificationChannel: async (_guildId: string, _feature: string) => "log-channel-1",
    },
    async (channelId, body) => {
      notificationCalls.push({ channelId, body });
    },
  );

  await service.expireDueTimedRoles(1_700_003_600_000);

  assert.deepEqual(removedRoles, [{ guildId: "guild-1", userId: "user-1", roleId: "role-1" }]);
  assert.deepEqual(deletedRoles, [{ guildId: "guild-1", userId: "user-1", roleId: "role-1" }]);
  assert.equal(notificationCalls.length, 1);
  assert.equal(notificationCalls[0]?.channelId, "log-channel-1");
  assert.equal(notificationCalls[0]?.body.embeds?.[0]?.title, "⏱ Timed Role Update");
  assert.deepEqual(notificationCalls[0]?.body.embeds?.[0]?.fields, [
    { name: "Result", value: "Expired automatically", inline: false },
    { name: "Target Member", value: "Fresh Spawn\n<@user-1>\nID: user-1", inline: false },
    { name: "Role", value: "<@&role-1>", inline: false },
    { name: "Expired", value: "<t:1700003600:R>", inline: false },
  ]);
  assert.deepEqual(notificationCalls[0]?.body.allowed_mentions, { parse: [] });
});

test("TimedRoleService.expireDueTimedRoles cleans up when the member has left the guild", async () => {
  const expiredRole: TimedRoleAssignment = {
    guildId: "guild-1",
    userId: "departed-user",
    roleId: "role-1",
    durationInput: "1h",
    expiresAtMs: 1_700_003_600_000,
  };
  const deletedRoles: Array<{ guildId: string; userId: string; roleId: string }> = [];
  const notificationCalls: CreateChannelMessageInput[] = [];
  const loggedErrors: unknown[][] = [];

  const store = createTimedRoleStore({
    async deleteTimedRole(key: { guildId: string; userId: string; roleId: string }) {
      deletedRoles.push(key);
    },
    async listExpiredTimedRoles() {
      return [expiredRole];
    },
  });

  const service = new TimedRoleService(
    store,
    "bot-token",
    createPermissiveGuildResourceValidator(),
    undefined,
    async () => {
      throw new DiscordApiError(
        'Discord API error: 404 {"message":"Unknown Member","code":10007}',
        404,
        '{"message":"Unknown Member","code":10007}',
      );
    },
    {
      readGuildNotificationChannel: async () => "log-channel-1",
    },
    async (_channelId, body) => {
      notificationCalls.push(body);
    },
  );

  const originalConsoleError = console.error;
  try {
    console.error = (...args: unknown[]) => {
      loggedErrors.push(args);
    };
    await service.expireDueTimedRoles(1_700_003_600_000);
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(deletedRoles, [
    { guildId: "guild-1", userId: "departed-user", roleId: "role-1" },
  ]);
  assert.equal(notificationCalls.length, 1);
  assert.deepEqual(loggedErrors, []);
});

test("TimedRoleService.assignConfiguredNewMemberRole skips when no join role is configured", async () => {
  const store = createTimedRoleStore({
    async readNewMemberTimedRoleConfig(guildId: string) {
      return { guildId, roles: [] };
    },
    async upsertTimedRole() {
      assert.fail("should not persist an assignment without a configured role");
    },
  });

  const service = new TimedRoleService(
    store,
    "bot-token",
    createPermissiveGuildResourceValidator(),
    async () => {
      assert.fail("should not call Discord without a configured role");
    },
  );

  assert.equal(
    await service.assignConfiguredNewMemberRole({
      guildId: "guild-1",
      userId: "user-1",
      nowMs: 1_700_000_000_000,
    }),
    null,
  );
});

test("TimedRoleService.createManualAssignmentTimedRole creates assignments for configured roles", async () => {
  const upsertedRoles: TimedRoleAssignment[] = [];
  const config: ManualAssignmentTimedRoleConfig = {
    guildId: "guild-1",
    roles: [
      { roleId: "role-timeout", durationInput: "2h" },
      { roleId: "role-reminder", durationInput: "1h" },
    ],
  };
  const store = createTimedRoleStore({
    async readManualAssignmentTimedRoleConfig(guildId: string) {
      return guildId === config.guildId ? config : { guildId, roles: [] };
    },
    async upsertTimedRole(role: TimedRoleAssignment) {
      upsertedRoles.push(role);
    },
    async listTimedRoles() {
      return upsertedRoles;
    },
    async listTimedRolesByGuild(guildId: string) {
      return upsertedRoles.filter((role) => role.guildId === guildId);
    },
  });
  const service = new TimedRoleService(
    store,
    "bot-token",
    createPermissiveGuildResourceValidator(),
  );

  const firstAssignment = await service.createManualAssignmentTimedRole({
    guildId: "guild-1",
    userId: "user-1",
    roleIds: ["role-timeout", "role-reminder"],
    targetDisplayName: "Fresh Spawn",
    nowMs: 1_700_000_000_000,
  });
  const repeatedAssignment = await service.createManualAssignmentTimedRole({
    guildId: "guild-1",
    userId: "user-1",
    roleIds: ["role-timeout", "role-reminder"],
    targetDisplayName: "Fresh Spawn",
    nowMs: 1_700_001_800_000,
  });

  assert.deepEqual(firstAssignment, [
    {
      guildId: "guild-1",
      userId: "user-1",
      roleId: "role-timeout",
      targetDisplayName: "Fresh Spawn",
      durationInput: "2h",
      expiresAtMs: 1_700_007_200_000,
    },
    {
      guildId: "guild-1",
      userId: "user-1",
      roleId: "role-reminder",
      targetDisplayName: "Fresh Spawn",
      durationInput: "1h",
      expiresAtMs: 1_700_003_600_000,
    },
  ]);
  assert.equal(repeatedAssignment, null);
  assert.deepEqual(upsertedRoles, firstAssignment);
});

test("TimedRoleService resumes manual assignment DM and audit after persistence", async () => {
  const assignments: TimedRoleAssignment[] = [];
  const completed = new Set<string>();
  const operations = {
    async run(handlerKey: string, operation: () => Promise<unknown>) {
      if (completed.has(handlerKey)) return false;
      await operation();
      completed.add(handlerKey);
      return true;
    },
    async hasStarted(handlerKey: string) {
      return completed.has(handlerKey);
    },
  };
  const store = createTimedRoleStore({
    async readManualAssignmentTimedRoleConfig(guildId) {
      return {
        guildId,
        roles: [{ roleId: "role-1", durationInput: "1h", dmMessage: "Assigned" }],
      };
    },
    async readTimedRoleConfigRules(_guildId, configType) {
      return configType === "manual-assignment"
        ? [{ roleId: "role-1", durationInput: "1h", dmMessage: "Assigned" }]
        : [];
    },
    async upsertTimedRole(assignment) {
      assignments.splice(0, assignments.length, assignment);
    },
    async listTimedRoles() {
      return assignments;
    },
    async listTimedRolesByGuild() {
      return assignments;
    },
  });
  const dmNonces: Array<string | number | undefined> = [];
  const audits: CreateChannelMessageInput[] = [];
  let failDm = true;
  const service = new TimedRoleService(
    store,
    "bot-token",
    createPermissiveGuildResourceValidator(),
    undefined,
    undefined,
    { readGuildNotificationChannel: async () => "audit-channel" },
    async (_channelId, body) => {
      audits.push(body);
    },
    async (_userId, body) => {
      dmNonces.push(body.nonce);
      if (failDm) throw new Error("crash after persistence");
    },
    undefined,
    undefined,
    undefined,
    operations,
    (kind, assignment, destinationId) => `${kind}:${assignment.roleId}:${destinationId}`,
  );
  const input = {
    guildId: "guild-1",
    userId: "user-1",
    roleIds: ["role-1"],
    nowMs: 1_700_000_000_000,
  };

  await assert.rejects(service.createManualAssignmentTimedRole(input), /crash after persistence/);
  failDm = false;
  await service.createManualAssignmentTimedRole({ ...input, nowMs: input.nowMs + 1_000 });

  assert.equal(assignments.length, 1);
  assert.deepEqual(dmNonces, ["dm:role-1:user-1", "dm:role-1:user-1"]);
  assert.equal(audits.length, 1);
  assert.equal(audits[0]?.nonce, "audit:role-1:audit-channel");
});

test("TimedRoleService.createManualAssignmentTimedRole skips active rules and assigns later matches", async () => {
  const upsertedRoles: TimedRoleAssignment[] = [
    {
      guildId: "guild-1",
      userId: "user-1",
      roleId: "role-timeout",
      durationInput: "2h",
      expiresAtMs: 1_700_007_200_000,
    },
  ];
  const config: ManualAssignmentTimedRoleConfig = {
    guildId: "guild-1",
    roles: [
      { roleId: "role-timeout", durationInput: "2h" },
      { roleId: "role-reminder", durationInput: "1h" },
    ],
  };
  const store = createTimedRoleStore({
    async readManualAssignmentTimedRoleConfig(guildId: string) {
      return guildId === config.guildId ? config : { guildId, roles: [] };
    },
    async upsertTimedRole(role: TimedRoleAssignment) {
      upsertedRoles.push(role);
    },
    async listTimedRoles() {
      return upsertedRoles;
    },
    async listTimedRolesByGuild(guildId: string) {
      return upsertedRoles.filter((role) => role.guildId === guildId);
    },
  });
  const service = new TimedRoleService(
    store,
    "bot-token",
    createPermissiveGuildResourceValidator(),
  );

  const assignment = await service.createManualAssignmentTimedRole({
    guildId: "guild-1",
    userId: "user-1",
    roleIds: ["role-timeout", "role-reminder"],
    targetDisplayName: "Fresh Spawn",
    nowMs: 1_700_000_000_000,
  });

  assert.deepEqual(assignment, [
    {
      guildId: "guild-1",
      userId: "user-1",
      roleId: "role-reminder",
      targetDisplayName: "Fresh Spawn",
      durationInput: "1h",
      expiresAtMs: 1_700_003_600_000,
    },
  ]);
  assert.equal(upsertedRoles.length, 2);
});

test("assignTimedRole rolls back persisted state when the Discord add fails", async () => {
  const calls: string[] = [];

  await assert.rejects(
    assignTimedRole(
      {
        upsertTimedRole: async () => {
          calls.push("upsert");
        },
        deleteTimedRole: async () => {
          calls.push("rollback");
        },
      },
      async () => {
        throw new Error("discord failed");
      },
      {
        guildId: "guild",
        userId: "user",
        roleId: "role",
        durationInput: "1h",
        expiresAtMs: 123,
      },
    ),
    /discord failed/,
  );

  assert.deepEqual(calls, ["upsert", "rollback"]);
});

test("TimedRoleService recovers a possibly removed suspended role from its persisted intent", async () => {
  const store = createTimedRoleStore();
  await store.upsertTimedRole({
    guildId: "guild-1",
    userId: "user-1",
    roleId: "timed-role",
    durationInput: "1h",
    expiresAtMs: 100,
    suspendedRoleIds: ["access-role"],
    pendingSuspensionRoleIds: ["access-role"],
    removedRoleIds: [],
    pendingRestorationRoleIds: [],
  });
  const mutations: string[] = [];
  const service = createRecoveryService(store, mutations);

  await service.expireDueTimedRoles(100);

  assert.deepEqual(mutations, ["remove:timed-role", "add:access-role"]);
  assert.deepEqual(await store.listTimedRolesByGuild("guild-1"), []);
});

test("TimedRoleService waits for the target removal checkpoint before restoring suspended roles", async () => {
  const store = createTimedRoleStore();
  await store.upsertTimedRole({
    guildId: "guild-1",
    userId: "user-1",
    roleId: "timed-role",
    durationInput: "1h",
    expiresAtMs: 100,
    suspendedRoleIds: ["access-role"],
    removedRoleIds: ["access-role"],
    pendingRestorationRoleIds: ["access-role"],
  });
  let checkpointFailed = false;
  const mutations: string[] = [];
  const service = createRecoveryService(
    {
      ...store,
      async updateTimedRoleRestoration(update) {
        if (update.targetRoleRemovalCompletedAtMs != null && !checkpointFailed) {
          checkpointFailed = true;
          throw new Error("Checkpoint unavailable");
        }
        await store.updateTimedRoleRestoration(update);
      },
    },
    mutations,
  );

  await service.expireDueTimedRoles(100);
  assert.deepEqual(mutations, ["remove:timed-role"]);
  const [pending] = await store.listTimedRolesByGuild("guild-1");
  assert.equal(pending.restorationStartedAtMs, 100);
  assert.equal(pending.targetRoleRemovalCompletedAtMs, undefined);
  assert.deepEqual(pending.pendingRestorationRoleIds, ["access-role"]);

  await service.expireDueTimedRoles(101);
  assert.deepEqual(mutations, ["remove:timed-role", "remove:timed-role", "add:access-role"]);
  assert.deepEqual(await store.listTimedRolesByGuild("guild-1"), []);
});

for (const failRestoration of [false, true]) {
  test(`TimedRoleService recovers a lost suspension response with failed restoration=${failRestoration}`, async () => {
    const store = createTimedRoleStore();
    const held = new Set(["access-role"]);
    let failRestore = failRestoration;
    let loseResponse = true;
    const mutations: string[] = [];
    const base = createRecoveryService(store, mutations);
    // Exercise the service boundary with Discord having committed before transport failure.
    const service = new TimedRoleService(
      store,
      "bot-token",
      createStaticGuildResourceValidator({
        guilds: {
          "guild-1": {
            channels: [],
            roles: [
              { ...testRole("access-role"), position: 2 },
              { ...testRole("timed-role"), position: 4 },
              { ...testRole("bot-highest"), position: 8 },
            ],
          },
        },
      }),
      async (_guild, _user, roleId) => {
        if (roleId === "access-role" && failRestore) throw new Error("restore unavailable");
        held.add(roleId);
      },
      async (_guild, _user, roleId) => {
        held.delete(roleId);
        if (roleId === "access-role" && loseResponse) {
          loseResponse = false;
          throw new Error("response lost");
        }
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => [...held],
      async () => ["bot-highest"],
    );
    await assert.rejects(
      service.assignTimedRole({
        guildId: "guild-1",
        userId: "user-1",
        roleId: "timed-role",
        durationInput: "1h",
        expiresAtMs: 100,
        suspendedRoleIds: ["access-role"],
      }),
      failRestoration ? /rollback failed/ : /response lost/,
    );
    if (failRestoration) {
      const [pending] = await store.listTimedRolesByGuild("guild-1");
      assert.deepEqual(pending.pendingRestorationRoleIds, ["access-role"]);
      failRestore = false;
      // A new service instance resumes the durable record through scheduled expiry.
      await base.expireDueTimedRoles(101);
      assert.deepEqual(mutations, ["remove:timed-role", "add:access-role"]);
    } else {
      assert.equal(held.has("access-role"), true);
    }
    assert.equal(held.has("timed-role"), false);
    assert.deepEqual(await store.listTimedRolesByGuild("guild-1"), []);
  });
}

function createRecoveryService(store: TimedRoleStore, mutations: string[]): TimedRoleService {
  return new TimedRoleService(
    store,
    "bot-token",
    createStaticGuildResourceValidator({
      guilds: {
        "guild-1": {
          channels: [],
          roles: [
            { ...testRole("access-role"), position: 2 },
            { ...testRole("timed-role"), position: 4 },
            { ...testRole("bot-highest"), position: 8 },
          ],
        },
      },
    }),
    async (_guildId, _userId, roleId) => {
      mutations.push(`add:${roleId}`);
    },
    async (_guildId, _userId, roleId) => {
      mutations.push(`remove:${roleId}`);
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => [],
    async () => ["bot-highest"],
  );
}

test("disabled Timed Role rules keep their configuration and existing assignments", async () => {
  const fixture = createProductionRuntimeStores();
  const rule = {
    roleId: "role-1",
    durationInput: "1h",
    dmMessage: "Welcome {user}",
    enabled: false,
  };
  const active = {
    guildId: "guild-1",
    userId: "existing",
    roleId: "role-1",
    durationInput: "1h",
    expiresAtMs: Date.now() + 3600000,
  };
  try {
    await fixture.stores.timedRoles.upsertNewMemberTimedRoleConfig?.({
      guildId: "guild-1",
      roles: [rule],
    });
    await fixture.stores.timedRoles.upsertManualAssignmentTimedRoleConfig?.({
      guildId: "guild-1",
      roles: [rule],
    });
    await fixture.stores.timedRoles.upsertTimedRole(active);
    const service = new TimedRoleService(
      fixture.stores.timedRoles,
      "token",
      createPermissiveGuildResourceValidator(),
    );
    assert.equal(
      await service.assignConfiguredNewMemberRole({ guildId: "guild-1", userId: "new" }),
      null,
    );
    assert.equal(
      await service.createManualAssignmentTimedRole({
        guildId: "guild-1",
        userId: "new",
        roleIds: ["role-1"],
      }),
      null,
    );
    assert.deepEqual((await service.getNewMemberTimedRoleConfig("guild-1")).roles, [rule]);
    assert.deepEqual(await fixture.stores.timedRoles.listTimedRolesByGuild("guild-1"), [active]);
  } finally {
    fixture.close();
  }
});
