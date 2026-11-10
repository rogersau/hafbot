import assert from "node:assert/strict";
import test from "node:test";
import { ReputationService, type ReputationDiscord } from "../src/reputation/service";
import {
  assertReputationEligibility,
  defaultReputationConfig,
  ReputationError,
  reputationSettingsSchema,
  type ReputationConfig,
  type ReputationStore,
} from "../src/reputation/types";
import { handleReputationInteraction } from "../src/reputation/interaction";
import type { GuildPermissionContext } from "../src/runtime/admin-permissions";
import { createReputationAdminRoutes } from "../src/runtime/admin-routes/reputation";
import { dispatchAdminRoute } from "../src/runtime/admin-route-registry";
import { ALL_FEATURES_ENABLED } from "../src/runtime/features";
import { createReputationRuntime } from "../src/reputation/runtime";
import { createReputationDiscord } from "../src/reputation/discord";

function fixture(isSuspended: (guildId: string) => Promise<boolean> = async () => false) {
  let config: ReputationConfig = { ...defaultReputationConfig("100"), enabled: true, revision: 1 };
  const members = new Map([
    ["101", { userId: "101", displayName: "Helpful gamer", bot: false, roleIds: ["300"] }],
    ["102", { userId: "102", displayName: "Guide writer", bot: false, roleIds: [] }],
  ]);
  const context: GuildPermissionContext = {
    guildId: "100",
    botUserId: "900",
    channels: [],
    roles: [
      { id: "100", name: "@everyone", position: 0, permissions: "0" },
      { id: "400", name: "HAF", position: 10, permissions: String(1n << 28n) },
      { id: "300", name: "Player", position: 1, permissions: "0" },
      { id: "301", name: "Helper", position: 2, permissions: "0" },
    ],
    member: { user: { id: "900" }, roles: ["400"] },
  };
  const calls = {
    awards: 0,
    saves: 0,
    added: [] as string[],
    delivered: 0,
    deferred: 0,
    membership: [] as string[],
  };
  let restricted = new Set<string>();
  let suspended = false;
  let failRole = false;
  let pending = false;
  const store: ReputationStore = {
    getConfig: async () => config,
    saveConfig: async (guildId, settings, expectedRevision) => {
      if (expectedRevision !== config.revision)
        throw new ReputationError("Settings changed.", "conflict");
      calls.saves += 1;
      return (config = { ...settings, guildId, revision: config.revision + 1 });
    },
    award: async () => {
      calls.awards += 1;
      return { interactionId: "200", recipientId: "102", total: 5, duplicate: false };
    },
    score: async () => 5,
    topScores: async () => [
      { userId: "199", total: 100 },
      { userId: "102", total: 5 },
    ],
    setMembership: async (_guildId, userId, current) => {
      calls.membership.push(`${userId}:${current}`);
    },
    pendingRewards: async () =>
      pending ? [{ guildId: "100", userId: "102", roleId: "301", threshold: 5 }] : [],
    completeReward: async () => {
      calls.delivered += 1;
    },
    deferReward: async () => {
      calls.deferred += 1;
    },
    eraseMember: async () => {},
  };
  const discord: ReputationDiscord = {
    fetchMember: async (_guildId, userId) => members.get(userId) ?? null,
    loadPermissionContext: async () => context,
    readRestrictedRoleIds: async () => restricted,
    isRoleSuspended: async () => suspended,
    addRole: async (_guildId, _userId, roleId) => {
      if (failRole) throw new Error("Discord unavailable");
      calls.added.push(roleId);
    },
  };
  return {
    service: new ReputationService(store, discord, () => 10_000, isSuspended),
    store,
    members,
    context,
    calls,
    setConfig: (value: Partial<ReputationConfig>) => {
      config = { ...config, ...value };
    },
    setRestricted: (ids: string[]) => {
      restricted = new Set(ids);
    },
    setSuspended: (value: boolean) => {
      suspended = value;
    },
    setFailRole: (value: boolean) => {
      failRole = value;
    },
    setPending: (value: boolean) => {
      pending = value;
    },
  };
}

test("Reputation validates settings and refuses self-thanks, absent members and oversized reasons before awards", async () => {
  const h = fixture();
  assert.equal(defaultReputationConfig("100").enabled, false);
  assert.equal(
    reputationSettingsSchema.safeParse({ ...defaultReputationConfig("100"), cooldownSeconds: 0 })
      .success,
    false,
  );
  await assert.rejects(
    () =>
      h.service.give({ guildId: "100", interactionId: "200", giverId: "101", recipientId: "101" }),
    /yourself/,
  );
  await assert.rejects(
    () =>
      h.service.give({ guildId: "100", interactionId: "200", giverId: "101", recipientId: "199" }),
    /currently belong/,
  );
  await assert.rejects(
    () =>
      h.service.give({
        guildId: "100",
        interactionId: "200",
        giverId: "101",
        recipientId: "102",
        reason: "x".repeat(301),
      }),
    /300/,
  );
  assert.equal(h.calls.awards, 0);
});

test("Reputation eligibility excludes bots, unqualified givers and excluded recipients", () => {
  const config = {
    ...defaultReputationConfig("100"),
    enabled: true,
    giverRoleIds: ["300"],
    excludedRoleIds: ["399"],
  };
  const input = {
    guildId: "100",
    interactionId: "200",
    giver: { userId: "101", displayName: "Giver", bot: false, roleIds: ["300"] },
    recipient: { userId: "102", displayName: "Recipient", bot: false, roleIds: [] },
    reason: null,
    nowMs: 1_000,
  };
  assert.doesNotThrow(() => assertReputationEligibility(config, input));
  assert.throws(
    () => assertReputationEligibility(config, { ...input, giver: { ...input.giver, bot: true } }),
    /bots/,
  );
  assert.throws(
    () => assertReputationEligibility(config, { ...input, giver: { ...input.giver, roleIds: [] } }),
    /role that can give/,
  );
  assert.throws(
    () =>
      assertReputationEligibility(config, {
        ...input,
        recipient: { ...input.recipient, roleIds: ["399"] },
      }),
    /excludes/,
  );
});

test("Reputation fails closed for suspended Guilds and defers global rewards without resolving a bot", async () => {
  const h = fixture(async () => true);
  h.setConfig({ rewards: [{ threshold: 5, roleId: "301" }] });
  h.setPending(true);
  await assert.rejects(
    () =>
      h.service.give({ guildId: "100", interactionId: "200", giverId: "101", recipientId: "102" }),
    /Service unavailable/,
  );
  await assert.rejects(
    () => h.service.saveConfig("100", defaultReputationConfig("100"), 1),
    /Service unavailable/,
  );
  assert.deepEqual(await h.service.processRewards(), { delivered: 0, deferred: 1 });
  let identities = 0;
  const runtime = createReputationRuntime({
    store: h.store,
    resolveGuildBotIdentity: async () => {
      identities += 1;
      return { token: "test-token", userId: "900" };
    },
    rolePolicy: {
      readRestrictedRoleIds: async () => new Set(),
      isRoleSuspended: async () => false,
      listPanels: async () => [],
    },
    isSuspended: async () => true,
  });
  assert.deepEqual(await runtime.processRewards(), { delivered: 0, deferred: 1 });
  assert.equal(identities, 0);
  assert.equal(h.calls.awards, 0);
  assert.deepEqual(h.calls.added, []);
});

test("Reputation rewards reject reaction-panel roles without rejecting their own configured reward roles", async () => {
  let excludedOwnRewards = false;
  const adapter = createReputationDiscord({
    token: "test-token",
    botUserId: "900",
    rolePolicy: {
      readRestrictedRoleIds: async (_guildId, options) => {
        excludedOwnRewards = options?.excludeReputationRewards === true;
        return new Set(["399"]);
      },
      isRoleSuspended: async () => false,
      listPanels: async () =>
        [{ options: [{ roleId: "300" }], publishedOptions: [{ roleId: "302" }] }] as never,
    },
  });
  assert.deepEqual([...(await adapter.readRestrictedRoleIds("100"))].sort(), ["300", "302", "399"]);
  assert.equal(excludedOwnRewards, true);
});

test("Reputation configuration rejects privileged, protected and duplicate reward roles", async () => {
  const h = fixture();
  const settings = {
    ...defaultReputationConfig("100"),
    enabled: true,
    rewards: [{ threshold: 5, roleId: "301" }],
  };
  h.context.roles[3]!.permissions = "8";
  await assert.rejects(() => h.service.saveConfig("100", settings, 1), /management permissions/);
  h.context.roles[3]!.permissions = "0";
  h.setRestricted(["301"]);
  await assert.rejects(() => h.service.saveConfig("100", settings, 1), /workflow/);
  h.setRestricted([]);
  await assert.rejects(
    () =>
      h.service.saveConfig(
        "100",
        { ...settings, rewards: [...settings.rewards, ...settings.rewards] },
        1,
      ),
    /only once/,
  );
  assert.equal(h.calls.saves, 0);
  assert.equal((await h.service.saveConfig("100", settings, 1)).revision, 2);
  await assert.rejects(() => h.service.saveConfig("100", settings, 1), /changed/);
});

test("Reputation rewards respect fresh role safety and Timed Role suspension and retry without duplicating points", async () => {
  const h = fixture();
  h.setConfig({ rewards: [{ threshold: 5, roleId: "301" }] });
  h.setPending(true);
  h.setSuspended(true);
  assert.deepEqual(await h.service.processRewards(), { delivered: 0, deferred: 1 });
  h.setSuspended(false);
  h.setRestricted(["301"]);
  assert.deepEqual(await h.service.processRewards(), { delivered: 0, deferred: 1 });
  h.setRestricted([]);
  h.setFailRole(true);
  const award = await h.service.give({
    guildId: "100",
    interactionId: "200",
    giverId: "101",
    recipientId: "102",
  });
  assert.equal(award.total, 5);
  assert.equal(h.calls.awards, 1);
  assert.equal(h.calls.delivered, 0);
  h.setFailRole(false);
  assert.deepEqual(await h.service.processRewards(), { delivered: 1, deferred: 0 });
  assert.deepEqual(h.calls.added, ["301"]);
  assert.equal(h.calls.awards, 1);
});

test("Reputation leaderboards verify current membership and return no raw IDs or award reasons", async () => {
  const h = fixture();
  const leaders = await h.service.leaderboard("100");
  assert.deepEqual(leaders, [{ displayName: "Guide writer", total: 5 }]);
  assert.deepEqual(h.calls.membership, ["199:false"]);
  const response = await handleReputationInteraction(
    {
      id: "200",
      type: 2,
      guild_id: "100",
      member: { user: { id: "101" } },
      data: { name: "rep", options: [{ name: "leaderboard", type: 1 }] },
    },
    h.service,
  );
  const body = (await response.json()) as {
    data: { content: string; allowed_mentions: { parse: string[] } };
  };
  assert.match(body.data.content, /Guide writer/);
  assert.doesNotMatch(body.data.content, /102|199/);
  assert.deepEqual(body.data.allowed_mentions.parse, []);
  h.setConfig({ enabled: false });
  await assert.rejects(() => h.service.profile("100", "102"), /disabled/);
});

test("Reputation admin routes bind both reads and writes to authorized Guild scope before service access", async () => {
  const h = fixture();
  let serviceReads = 0;
  const routes = createReputationAdminRoutes({
    serviceForGuild: async () => {
      serviceReads += 1;
      return h.service;
    },
  });
  const requirements: unknown[] = [];
  const authorization = {
    authorize: async (_request: Request, requirement: unknown) => {
      requirements.push(requirement);
      return { ok: false as const, error: { _tag: "Forbidden" as const, message: "Denied" } };
    },
  };
  for (const request of [
    new Request("https://example.com/admin/api/reputation?guildId=100&workspaceId=workspace-a"),
    new Request("https://example.com/admin/api/reputation/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        guildId: "100",
        workspaceId: "workspace-a",
        settings: defaultReputationConfig("100"),
        expectedRevision: 0,
      }),
    }),
  ]) {
    const response = await dispatchAdminRoute(routes, request, {
      adminAccess: authorization,
      features: ALL_FEATURES_ENABLED,
      stores: {} as never,
    });
    assert.equal(response?.status, 403);
  }
  assert.equal(serviceReads, 0);
  assert.deepEqual(requirements, [
    { mode: "read", guildId: "100", workspaceId: "workspace-a" },
    { mode: "write", guildId: "100", workspaceId: "workspace-a" },
  ]);
});
