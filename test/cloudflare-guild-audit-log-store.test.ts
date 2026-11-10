/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import type { GuildAuditLogConfig } from "../src/types";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("guild audit log store reads and writes config", async () => {
  const { createCloudflareGuildAuditLogStore } =
    await import("../src/runtime/cloudflare-guild-audit-log-store");
  const database = new SqliteD1Database();
  const store = createCloudflareGuildAuditLogStore(database as unknown as D1Database);

  assert.equal(await store.readConfig("guild-1"), null);

  const config: GuildAuditLogConfig = {
    guildId: "guild-1",
    auditChannelId: "audit-channel-1",
    groupChannelIds: { member: "member-channel-1", message: "" },
    eventStates: {
      groups: { member: true, message: false },
      overrides: { "member.nickname-change": false },
    },
    excludedChannelIds: ["excluded-channel-1"],
    excludedRoleIds: ["excluded-role-1"],
    updatedAtMs: 100,
  };
  await store.upsertConfig(config);

  const saved = await store.readConfig("guild-1");
  assert.notEqual(saved, null);
  assert.equal(saved!.guildId, "guild-1");
  assert.equal(saved!.auditChannelId, "audit-channel-1");
  assert.deepEqual(saved!.groupChannelIds, { member: "member-channel-1" });
  assert.deepEqual(saved!.eventStates.groups, { member: true, message: false });
  assert.deepEqual(saved!.eventStates.overrides, { "member.nickname-change": false });
  assert.deepEqual(saved!.excludedChannelIds, ["excluded-channel-1"]);
  assert.deepEqual(saved!.excludedRoleIds, ["excluded-role-1"]);
});

test("guild audit log store does not leak between guilds", async () => {
  const { createCloudflareGuildAuditLogStore } =
    await import("../src/runtime/cloudflare-guild-audit-log-store");
  const database = new SqliteD1Database();
  const store = createCloudflareGuildAuditLogStore(database as unknown as D1Database);

  await store.upsertConfig({
    guildId: "guild-1",
    auditChannelId: "ch-1",
    groupChannelIds: {},
    eventStates: { groups: {}, overrides: {} },
    updatedAtMs: 100,
  });

  assert.equal(await store.readConfig("guild-2"), null);
});

test("guild audit log store updates existing config", async () => {
  const { createCloudflareGuildAuditLogStore } =
    await import("../src/runtime/cloudflare-guild-audit-log-store");
  const database = new SqliteD1Database();
  const store = createCloudflareGuildAuditLogStore(database as unknown as D1Database);

  await store.upsertConfig({
    guildId: "guild-1",
    auditChannelId: "ch-1",
    groupChannelIds: {},
    eventStates: { groups: {}, overrides: {} },
    updatedAtMs: 100,
  });

  await store.upsertConfig({
    guildId: "guild-1",
    auditChannelId: "ch-2",
    groupChannelIds: {},
    eventStates: { groups: { member: true }, overrides: {} },
    updatedAtMs: 200,
  });

  const saved = await store.readConfig("guild-1");
  assert.equal(saved!.auditChannelId, "ch-2");
  assert.deepEqual(saved!.eventStates.groups, { member: true });
  assert.equal(saved!.updatedAtMs, 200);
});
