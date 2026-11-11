/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { defaultClanManagementConfig, type Clan, type ClanRequest } from "../src/clans";
import { getGuildEntitlementLimits } from "../src/types";
import { SqliteD1Database } from "./support/sqlite-d1-database";

const request = (id: string, requesterId = `user-${id}`): ClanRequest => ({
  id,
  guildId: "guild-1",
  requesterId,
  name: `Clan ${id}`,
  normalizedName: `clan ${id}`,
  tag: id,
  normalizedTag: id.toLowerCase(),
  description: "A clan",
  focus: "DayZ",
  recruitmentState: "applications-open",
  proposedOfficerIds: [],
  status: "pending",
  revision: 1,
  reviewerId: null,
  reviewReason: null,
  clanId: null,
  createdAtMs: 100,
  updatedAtMs: 100,
  terminalAtMs: null,
  retentionExpiresAtMs: null,
});

const clan = (id: string, requestId = `request-${id}`): Clan => ({
  id,
  guildId: "guild-1",
  requestId,
  name: `Clan ${id}`,
  normalizedName: `clan ${id}`,
  tag: id,
  normalizedTag: id.toLowerCase(),
  description: "A clan",
  focus: "DayZ",
  icon: null,
  recruitmentState: "applications-open",
  lifecycleState: "active",
  roleId: `role-${id}`,
  textChannelId: `text-${id}`,
  voiceChannelId: `voice-${id}`,
  boardProjectionId: null,
  boardProjectionChannelId: null,
  operation: null,
  degradedReason: null,
  sensitiveManagementFrozen: false,
  clanLfgLeadershipOnly: false,
  latestActivityAtMs: 100,
  latestActivityType: "management",
  inactivityWarnedAtMs: null,
  deletionDueAtMs: null,
  createdAtMs: 100,
  updatedAtMs: 100,
  permanentlyDeletedAtMs: null,
});

test("Clan entitlements are complete on Free and equal per Guild on paid plans", () => {
  assert.deepEqual(
    {
      clans: getGuildEntitlementLimits("free").clansMax,
      members: getGuildEntitlementLimits("free").clanMembersMax,
      officers: getGuildEntitlementLimits("free").clanOfficersMax,
    },
    { clans: 5, members: 25, officers: 5 },
  );
  const premium = getGuildEntitlementLimits("premium");
  const plus = getGuildEntitlementLimits("premium_plus");
  assert.deepEqual(
    [premium.clansMax, premium.clanMembersMax, premium.clanOfficersMax],
    [plus.clansMax, plus.clanMembersMax, plus.clanOfficersMax],
  );
});

test("Clan store round-trips configuration and uses optimistic request revisions", async () => {
  const { createSqliteClanStore } = await import("./support/sqlite/runtime/sqlite-clan-store");
  const store = createSqliteClanStore(new SqliteD1Database() as unknown as D1Database);
  const config = {
    ...defaultClanManagementConfig("guild-1", 100),
    reviewerRoleIds: ["reviewer"],
    localClansMax: 3,
  };
  await store.upsertConfig(config);
  assert.deepEqual(await store.readConfig("guild-1"), config);

  const original = request("request-1");
  await store.createRequest(original);
  assert.equal(
    await store.updateRequest({ ...original, status: "changes-requested", revision: 2 }, 9),
    false,
  );
  assert.equal(
    await store.updateRequest({ ...original, status: "changes-requested", revision: 2 }, 1),
    true,
  );
  assert.equal((await store.readRequest("guild-1", original.id))?.revision, 2);
});

test("Clan schema enforces one pending request and one active Guild membership", async () => {
  const { createSqliteClanStore } = await import("./support/sqlite/runtime/sqlite-clan-store");
  const store = createSqliteClanStore(new SqliteD1Database() as unknown as D1Database);
  await store.createRequest(request("request-1", "member-1"));
  await assert.rejects(store.createRequest(request("request-2", "member-1")));

  await store.createClan(clan("a", "request-1"));
  const secondRequest = { ...request("request-b", "member-2"), status: "approved" as const };
  await store.createRequest(secondRequest);
  await store.createClan(clan("b", "request-b"));
  await store.createMembership({
    clanId: "a",
    guildId: "guild-1",
    userId: "member-1",
    rank: "owner",
    joinedAtMs: 100,
    leftAtMs: null,
  });
  await assert.rejects(
    store.createMembership({
      clanId: "b",
      guildId: "guild-1",
      userId: "member-1",
      rank: "member",
      joinedAtMs: 101,
      leftAtMs: null,
    }),
  );
});

test("Clan schema enforces case-normalized name and tag uniqueness", async () => {
  const { createSqliteClanStore } = await import("./support/sqlite/runtime/sqlite-clan-store");
  const store = createSqliteClanStore(new SqliteD1Database() as unknown as D1Database);
  await store.createRequest(request("request-1"));
  await store.createClan(clan("a", "request-1"));
  await store.createRequest({ ...request("request-2"), normalizedName: "clan a" });
  await assert.rejects(
    store.createClan({ ...clan("b", "request-2"), name: "CLAN A", normalizedName: "clan a" }),
  );
});
