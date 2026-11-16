/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import {
  ClanDomainError,
  ClanJoinRecoveryError,
  ClanService,
  type ClanDiscordApi,
} from "../src/services/clan-service";
import { defaultClanManagementConfig, type Clan, type ClanRequest } from "../src/clans";
import type { ClanStore } from "../src/runtime/contracts";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("ClanService resumes provisioning after a Discord failure without duplicating resources", async () => {
  const { createSqliteClanStore } = await import("./support/sqlite/runtime/sqlite-clan-store");
  const store = createSqliteClanStore(new SqliteD1Database().d1);
  let failVoice = true;
  const discord: ClanDiscordApi = {
    async createCategory() {
      return { id: "category-1" };
    },
    async createRole() {
      return { id: "role-1" };
    },
    async createTextChannel() {
      return { id: "text-1" };
    },
    async createVoiceChannel() {
      if (failVoice) {
        failVoice = false;
        throw new Error("Discord unavailable");
      }
      return { id: "voice-1" };
    },
    async addMemberRole() {},
    async removeMemberRole() {},
    async deleteChannel() {},
    async deleteRole() {},
    async setClanArchivedPermissions() {},
  };
  let id = 0;
  const service = new ClanService(
    store,
    discord,
    { getTier: async () => "free" },
    "bot-1",
    () => 1_000_000_000,
    () => `id-${++id}`,
  );
  const request = await service.submitRequest({
    guildId: "guild-1",
    requesterId: "member-1",
    name: "Night Owls",
    tag: "NO",
    description: "Night players",
    focus: "DayZ",
    recruitmentState: "applications-open",
    eligibility: { isBot: false, roleIds: [], accountCreatedAtMs: 0, guildJoinedAtMs: 0 },
  });
  await assert.rejects(
    service.reviewRequest({
      guildId: "guild-1",
      requestId: request.id,
      reviewerId: "admin-1",
      reviewerRoleIds: [],
      isGuildAdmin: true,
      expectedRevision: 1,
      decision: "approve",
    }),
    (error: unknown) =>
      error instanceof ClanDomainError && error.code === "provider-failure" && error.retryable,
  );
  const clan = await service.reviewRequest({
    guildId: "guild-1",
    requestId: request.id,
    reviewerId: "admin-1",
    reviewerRoleIds: [],
    isGuildAdmin: true,
    expectedRevision: 1,
    decision: "approve",
  });
  assert.equal("lifecycleState" in clan && clan.lifecycleState, "active");
  assert.equal("roleId" in clan && clan.roleId, "role-1");
  assert.equal("textChannelId" in clan && clan.textChannelId, "text-1");
  assert.equal("voiceChannelId" in clan && clan.voiceChannelId, "voice-1");
  assert.equal((await store.readActiveMembership("guild-1", "member-1"))?.rank, "owner");
  assert.equal((await store.readRequest("guild-1", request.id))?.status, "approved");
});

test("ClanService enforces one pending request per member", async () => {
  const { createSqliteClanStore } = await import("./support/sqlite/runtime/sqlite-clan-store");
  const store = createSqliteClanStore(new SqliteD1Database().d1);
  const discord = {} as ClanDiscordApi;
  let id = 0;
  const service = new ClanService(
    store,
    discord,
    { getTier: async () => "free" },
    "bot-1",
    () => 1_000_000_000,
    () => `request-${++id}`,
  );
  const input = {
    guildId: "guild-1",
    requesterId: "member-1",
    name: "Alpha",
    tag: "A",
    description: "Alpha Clan",
    focus: "DayZ",
    recruitmentState: "closed" as const,
    eligibility: { isBot: false, roleIds: [], accountCreatedAtMs: 0, guildJoinedAtMs: 0 },
  };
  await service.submitRequest(input);
  await assert.rejects(
    service.submitRequest({ ...input, name: "Beta", tag: "B" }),
    (error: unknown) => error instanceof ClanDomainError && error.code === "invalid-transition",
  );
});

test("ClanService refuses to provision when the requester joined another Clan", async () => {
  const harness = await createClanHarness();
  const request = await harness.submit("member-1", "Alpha", "A");
  const otherRequest = terminalRequest("request-other", "guild-1", "member-2", "Other", "O");
  await harness.store.createRequest(otherRequest);
  await harness.store.createClan(clanRecord("clan-other", otherRequest));
  await harness.store.createMembership({
    clanId: "clan-other",
    guildId: "guild-1",
    userId: "member-1",
    rank: "member",
    joinedAtMs: 10,
    leftAtMs: null,
  });

  await assert.rejects(
    harness.approve(request),
    (error: unknown) => error instanceof ClanDomainError && error.code === "existing-membership",
  );
  const created = await harness.store.readClanByRequest(request.id);
  assert.notEqual(created?.lifecycleState, "active");
  assert.deepEqual(await harness.store.listActiveMemberships(created!.id), []);
});

test("ClanService prevents Officers from issuing Officer invitations", async () => {
  const harness = await createClanHarness();
  const request = await harness.submit("owner-1", "Alpha", "A");
  const clan = await harness.approve(request);
  await harness.store.createMembership({
    clanId: clan.id,
    guildId: clan.guildId,
    userId: "officer-1",
    rank: "officer",
    joinedAtMs: 20,
    leftAtMs: null,
  });

  await assert.rejects(
    harness.service.createInvitation({
      guildId: clan.guildId,
      clanId: clan.id,
      actorUserId: "officer-1",
      inviteeId: "member-2",
      intendedRank: "officer",
    }),
    (error: unknown) => error instanceof ClanDomainError && error.code === "authority",
  );
});

test("ClanService enforces a Guild member ceiling below the plan allowance", async () => {
  const harness = await createClanHarness();
  await harness.store.upsertConfig({
    ...defaultClanManagementConfig("guild-1", 1),
    localMembersMax: 1,
  });
  const request = await harness.submit("owner-1", "Alpha", "A");
  const clan = await harness.approve(request);
  const invitation = await harness.service.createInvitation({
    guildId: clan.guildId,
    clanId: clan.id,
    actorUserId: "owner-1",
    inviteeId: "member-2",
  });

  await assert.rejects(
    harness.service.acceptInvitation(clan.guildId, invitation.id, "member-2"),
    (error: unknown) => error instanceof ClanDomainError && error.code === "limit",
  );
  assert.equal(await harness.store.readActiveMembership(clan.guildId, "member-2"), null);
});

test("ClanService resumes a claimed invitation without removing a successful membership role", async () => {
  const { createSqliteClanStore } = await import("./support/sqlite/runtime/sqlite-clan-store");
  const base = createSqliteClanStore(new SqliteD1Database().d1);
  let failCompletion = true;
  const store: ClanStore = {
    ...base,
    async updateInvitation(invitation) {
      if (invitation.status === "accepted" && failCompletion) {
        failCompletion = false;
        throw new Error("temporary D1 failure");
      }
      await base.updateInvitation(invitation);
    },
  };
  let removedRoles = 0;
  const harness = await createClanHarness({
    store,
    discordOverrides: {
      async removeMemberRole() {
        removedRoles += 1;
      },
    },
  });
  const request = await harness.submit("owner-1", "Alpha", "A");
  const clan = await harness.approve(request);
  const invitation = await harness.service.createInvitation({
    guildId: clan.guildId,
    clanId: clan.id,
    actorUserId: "owner-1",
    inviteeId: "member-2",
  });

  await assert.rejects(
    harness.service.acceptInvitation(clan.guildId, invitation.id, "member-2"),
    (error: unknown) => error instanceof ClanJoinRecoveryError && error.retryable,
  );
  assert.equal((await store.readActiveMembership(clan.guildId, "member-2"))?.clanId, clan.id);
  assert.equal(removedRoles, 0);

  const recovered = await harness.service.acceptInvitation(clan.guildId, invitation.id, "member-2");
  assert.equal(recovered.clanId, clan.id);
  assert.equal((await store.readInvitation(clan.guildId, invitation.id))?.status, "accepted");
});

test("ClanService creates and completes a private review ticket around Clan approval", async () => {
  const harness = await createClanHarness({
    discordOverrides: {
      async createRequestReviewTicket({ request, config, botUserId }) {
        assert.equal(request.status, "pending");
        assert.deepEqual(config.reviewerRoleIds, ["review-role"]);
        assert.equal(botUserId, "bot-1");
        return { channelId: "review-channel-1", messageId: "review-message-1" };
      },
      async updateRequestReviewTicket() {},
    },
  });
  await harness.store.upsertConfig({
    ...defaultClanManagementConfig("guild-1", 1),
    reviewerRoleIds: ["review-role"],
    requestReviewCategoryId: "review-category",
  });

  const request = await harness.submit("owner-1", "Alpha", "A");
  const opened = await harness.store.readRequest("guild-1", request.id);
  assert.equal(opened?.reviewChannelId, "review-channel-1");
  assert.equal(opened?.reviewMessageId, "review-message-1");
  assert.equal(opened?.reviewTicketState, "open");

  await harness.approve(request);
  const approved = await harness.store.readRequest("guild-1", request.id);
  assert.equal(approved?.status, "approved");
  assert.equal(approved?.reviewTicketState, "closed");
});

test("ClanService publishes a configurable request panel without accepting its message id", async () => {
  const harness = await createClanHarness({
    discordOverrides: {
      async upsertRequestPanel({ config }) {
        assert.equal(config.requestPanelTitle, "Start a squad");
        assert.equal(config.requestPanelMessageId, null);
        return { messageId: "panel-message-1" };
      },
    },
  });
  await harness.store.upsertConfig({
    ...defaultClanManagementConfig("guild-1", 1),
    reviewerRoleIds: ["review-role"],
    requestPanelChannelId: "panel-channel",
    requestReviewCategoryId: "review-category",
    requestPanelTitle: "Start a squad",
  });

  const published = await harness.service.publishRequestPanel("guild-1", "admin-1");
  assert.equal(published.requestPanelMessageId, "panel-message-1");
  assert.equal(
    (await harness.store.readConfig("guild-1"))?.requestPanelMessageId,
    "panel-message-1",
  );
});

test("ClanService denies cross-guild request review without mutation", async () => {
  const harness = await createClanHarness();
  const request = await harness.submit("owner-1", "Alpha", "A");

  await assert.rejects(
    harness.service.reviewRequest({
      guildId: "guild-2",
      requestId: request.id,
      reviewerId: "admin-2",
      reviewerRoleIds: [],
      isGuildAdmin: true,
      expectedRevision: request.revision,
      decision: "approve",
    }),
    (error: unknown) => error instanceof ClanDomainError && error.code === "not-found",
  );
  assert.equal((await harness.store.readRequest("guild-1", request.id))?.status, "pending");
});

test("ClanService archives Discord permissions and expires due invitations", async () => {
  let nowMs = 1_000_000_000;
  let archived = 0;
  const harness = await createClanHarness({
    now: () => nowMs,
    discordOverrides: {
      async setClanArchivedPermissions(input) {
        if (input.archived) archived += 1;
      },
    },
  });
  const request = await harness.submit("owner-1", "Alpha", "A");
  const clan = await harness.approve(request);
  const invitation = await harness.service.createInvitation({
    guildId: clan.guildId,
    clanId: clan.id,
    actorUserId: "owner-1",
    inviteeId: "member-2",
  });
  nowMs += 8 * 24 * 60 * 60 * 1000;

  const result = await harness.service.processScheduledLifecycle({ limit: 10 });
  assert.equal(result.expired, 1);
  assert.equal(
    (await harness.store.readInvitation(clan.guildId, invitation.id))?.status,
    "expired",
  );
  await harness.service.archiveClan(clan.guildId, clan.id, "admin-1", "Policy");
  assert.equal(archived, 1);
});

async function createClanHarness(options?: {
  store?: ClanStore;
  now?: () => number;
  discordOverrides?: Partial<ClanDiscordApi>;
}) {
  const { createSqliteClanStore } = await import("./support/sqlite/runtime/sqlite-clan-store");
  const store =
    options?.store ?? createSqliteClanStore(new SqliteD1Database() as unknown as D1Database);
  let id = 0;
  const discord: ClanDiscordApi = {
    async createCategory() {
      return { id: "category-1" };
    },
    async createRole() {
      return { id: `role-${++id}` };
    },
    async createTextChannel() {
      return { id: `text-${id}` };
    },
    async createVoiceChannel() {
      return { id: `voice-${id}` };
    },
    async addMemberRole() {},
    async removeMemberRole() {},
    async deleteChannel() {},
    async deleteRole() {},
    async setClanArchivedPermissions() {},
    ...options?.discordOverrides,
  };
  const now = options?.now ?? (() => 1_000_000_000);
  const service = new ClanService(
    store,
    discord,
    { getTier: async () => "free" },
    "bot-1",
    now,
    () => `id-${++id}`,
  );
  return {
    store,
    service,
    submit: (requesterId: string, name: string, tag: string) =>
      service.submitRequest({
        guildId: "guild-1",
        requesterId,
        name,
        tag,
        description: `${name} Clan`,
        focus: "DayZ",
        recruitmentState: "applications-open",
        eligibility: { isBot: false, roleIds: [], accountCreatedAtMs: 0, guildJoinedAtMs: 0 },
      }),
    approve: (request: ClanRequest) =>
      service.reviewRequest({
        guildId: request.guildId,
        requestId: request.id,
        reviewerId: "admin-1",
        reviewerRoleIds: [],
        isGuildAdmin: true,
        expectedRevision: request.revision,
        decision: "approve",
      }) as Promise<Clan>,
  };
}

function terminalRequest(
  id: string,
  guildId: string,
  requesterId: string,
  name: string,
  tag: string,
): ClanRequest {
  return {
    id,
    guildId,
    requesterId,
    name,
    normalizedName: name.toLowerCase(),
    tag,
    normalizedTag: tag.toLowerCase(),
    description: name,
    focus: "DayZ",
    recruitmentState: "closed",
    proposedOfficerIds: [],
    status: "approved",
    revision: 2,
    reviewerId: "admin",
    reviewReason: null,
    clanId: "clan-other",
    createdAtMs: 1,
    updatedAtMs: 1,
    terminalAtMs: 1,
    retentionExpiresAtMs: 2,
  };
}

function clanRecord(id: string, request: ClanRequest): Clan {
  return {
    id,
    guildId: request.guildId,
    requestId: request.id,
    name: request.name,
    normalizedName: request.normalizedName,
    tag: request.tag,
    normalizedTag: request.normalizedTag,
    description: request.description,
    focus: request.focus,
    icon: null,
    recruitmentState: "closed",
    lifecycleState: "active",
    roleId: "role-other",
    textChannelId: "text-other",
    voiceChannelId: "voice-other",
    boardProjectionId: null,
    boardProjectionChannelId: null,
    operation: null,
    degradedReason: null,
    sensitiveManagementFrozen: false,
    clanLfgLeadershipOnly: false,
    latestActivityAtMs: 1,
    latestActivityType: "management",
    inactivityWarnedAtMs: null,
    deletionDueAtMs: null,
    createdAtMs: 1,
    updatedAtMs: 1,
    permanentlyDeletedAtMs: null,
  };
}
