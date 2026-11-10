/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import {
  createDefaultMentionProtectionConfig,
  moderateMentionProtectionMessage,
  type MentionProtectionMessageDependencies,
} from "../src/services/mention-protection/message-handler";
import type {
  DiscordMessageCreate,
  MentionProtectionActionOutcome,
  MentionProtectionBreach,
  MentionProtectionClaimInput,
  MentionProtectionConfig,
  TimedRoleAssignment,
} from "../src/types";

test("Mass Mention responds to five distinct explicit user mentions but not role or everyone mentions", async () => {
  const effects = createEffects();
  const config = createDefaultMentionProtectionConfig("guild-1", 1_000);
  config.spamEnabled = true;

  const result = await moderateMentionProtectionMessage(
    createMessage({
      content: "<@u1> <@u2> <@u3> <@u4> <@u5> <@&role-1> @everyone",
      mentions: ["u1", "u2", "u3", "u4", "u5"].map((id) => ({ id })),
      mention_roles: ["role-1"],
      mention_everyone: true,
    }),
    createDependencies(config, effects),
  );

  assert.deepEqual(result, {
    status: "responded",
    breaches: [{ protection: "spam", condition: "mass-mention", stage: "initial" }],
    actions: [
      { action: "reply", status: "succeeded" },
      { action: "delete", status: "succeeded" },
      { action: "audit", status: "succeeded" },
    ],
  });
  assert.equal(effects.warningMessages.length, 1);
  assert.equal(effects.deletedMessageIds.has("message-1"), true);
  assert.equal(effects.auditEvents.length, 1);
});

test("Free runs Admin Mention Protection without Mention Spam or member restrictions", async () => {
  const effects = createEffects();
  const config = createDefaultMentionProtectionConfig("guild-1", 1_000);
  config.adminEnabled = true;
  config.spamEnabled = true;
  config.protectedAdminRoleIds = ["admin-role"];
  config.adminRepeatResponse.restriction = { type: "timeout", durationMs: 600_000 };
  let burstWrites = 0;
  const dependencies = createDependencies(config, effects, { stage: "repeat", tier: "free" });
  dependencies.recordBurstMessage = async () => {
    burstWrites += 1;
    return 5;
  };

  const result = await moderateMentionProtectionMessage(
    createMessage({
      content: "<@&admin-role> <@u1> <@u2> <@u3> <@u4> <@u5>",
      mention_roles: ["admin-role"],
      mentions: ["u1", "u2", "u3", "u4", "u5"].map((id) => ({ id })),
    }),
    dependencies,
  );

  assert.deepEqual(result, {
    status: "responded",
    breaches: [{ protection: "admin", condition: "admin-mention", stage: "repeat" }],
    actions: [
      { action: "reply", status: "succeeded" },
      { action: "delete", status: "succeeded" },
      { action: "audit", status: "succeeded" },
    ],
  });
  assert.equal(burstWrites, 0);
  assert.deepEqual(effects.timeouts, []);
  assert.deepEqual(effects.timedRoleAssignments, []);
});

test("retained Admin repeat timeout resumes on paid plans", async () => {
  const config = createDefaultMentionProtectionConfig("guild-1", 1_000);
  config.adminEnabled = true;
  config.protectedAdminRoleIds = ["admin-role"];
  config.adminRepeatResponse.restriction = { type: "timeout", durationMs: 600_000 };
  for (const tier of ["premium", "premium_plus"] as const) {
    const effects = createEffects();
    await moderateMentionProtectionMessage(
      createMessage({ content: "<@&admin-role>", mention_roles: ["admin-role"] }),
      createDependencies(config, effects, { stage: "repeat", tier }),
    );
    assert.deepEqual(effects.timeouts, [
      { guildId: "guild-1", userId: "user-1", untilMs: Date.parse("2026-07-13T00:10:01Z") },
    ]);
  }
});

test("a repeat Mention Spam Protection breach applies the configured Discord timeout", async () => {
  const effects = createEffects();
  const config = createDefaultMentionProtectionConfig("guild-1", 1_000);
  config.spamEnabled = true;

  const result = await moderateMentionProtectionMessage(
    createMessage({
      content: "<@u1> <@u2> <@u3> <@u4> <@u5>",
      mentions: ["u1", "u2", "u3", "u4", "u5"].map((id) => ({ id })),
    }),
    createDependencies(config, effects, { stage: "repeat" }),
  );

  assert.deepEqual(result.actions, [
    { action: "reply", status: "succeeded" },
    { action: "delete", status: "succeeded" },
    { action: "timeout", status: "succeeded" },
    { action: "audit", status: "succeeded" },
  ]);
  assert.deepEqual(effects.timeouts, [
    { guildId: "guild-1", userId: "user-1", untilMs: Date.parse("2026-07-13T01:00:01Z") },
  ]);
});

test("a pre-existing non-HAF Timed Role is already satisfied without creating an expiry", async () => {
  const effects = createEffects();
  const config = createDefaultMentionProtectionConfig("guild-1", 1_000);
  config.spamEnabled = true;
  config.spamRepeatResponse.restriction = {
    type: "timed-role",
    roleId: "restricted-role",
    durationMs: 30 * 60 * 1_000,
  };

  const result = await moderateMentionProtectionMessage(
    createMessage({
      content: "<@u1> <@u2> <@u3> <@u4> <@u5>",
      mentions: ["u1", "u2", "u3", "u4", "u5"].map((id) => ({ id })),
    }),
    createDependencies(config, effects, {
      stage: "repeat",
      existingMemberRoles: ["restricted-role"],
    }),
  );

  assert.deepEqual(result.actions, [
    { action: "reply", status: "succeeded" },
    { action: "delete", status: "succeeded" },
    { action: "timed-role:restricted-role", status: "already-satisfied" },
    { action: "audit", status: "succeeded" },
  ]);
  assert.deepEqual(effects.timedRoleAssignments, []);
});

test("a shorter HAF-owned Timed Role is extended without reassigning the Discord role", async () => {
  const effects = createEffects();
  const config = createDefaultMentionProtectionConfig("guild-1", 1_000);
  config.spamEnabled = true;
  config.spamRepeatResponse.restriction = {
    type: "timed-role",
    roleId: "restricted-role",
    durationMs: 30 * 60_000,
  };

  await moderateMentionProtectionMessage(
    createMessage({
      content: "<@u1> <@u2> <@u3> <@u4> <@u5>",
      mentions: ["u1", "u2", "u3", "u4", "u5"].map((id) => ({ id })),
    }),
    createDependencies(config, effects, {
      stage: "repeat",
      existingTimedRole: {
        guildId: "guild-1",
        userId: "user-1",
        roleId: "restricted-role",
        durationInput: "5m",
        expiresAtMs: Date.parse("2026-07-13T00:05:00.000Z"),
      },
    }),
  );

  assert.deepEqual(effects.timedRoleAssignments, [
    {
      guildId: "guild-1",
      userId: "user-1",
      roleId: "restricted-role",
      expiresAtMs: Date.parse("2026-07-13T00:30:01.000Z"),
    },
  ]);
});

test("an edit after premium reactivation ignores a message created before reactivation", async () => {
  const effects = createEffects();
  const config = createDefaultMentionProtectionConfig("guild-1", 1_000);
  config.spamEnabled = true;

  const result = await moderateMentionProtectionMessage(
    createMessage({
      timestamp: "2026-07-12T23:59:00.000Z",
      edited_timestamp: "2026-07-13T00:00:01.000Z",
      content: "<@u1> <@u2> <@u3> <@u4> <@u5>",
      mentions: ["u1", "u2", "u3", "u4", "u5"].map((id) => ({ id })),
    }),
    createDependencies(config, effects, {
      entitlementUpdatedAtMs: Date.parse("2026-07-13T00:00:00.000Z"),
    }),
  );

  assert.deepEqual(result, { status: "ignored", reason: "pre-reactivation-edit" });
  assert.equal(effects.warningMessages.length, 0);
  assert.equal(effects.deletedMessageIds.size, 0);
});

test("channel metadata failure fails open without moderation actions", async () => {
  const effects = createEffects();
  const config = createDefaultMentionProtectionConfig("guild-1", 1_000);
  config.spamEnabled = true;
  const dependencies = createDependencies(config, effects);
  dependencies.resolveChannelParent = async () => {
    throw new Error("Discord unavailable");
  };

  const result = await moderateMentionProtectionMessage(
    createMessage({
      content: "<@u1> <@u2> <@u3> <@u4> <@u5>",
      mentions: ["u1", "u2", "u3", "u4", "u5"].map((id) => ({ id })),
    }),
    dependencies,
  );

  assert.deepEqual(result, { status: "ignored", reason: "channel-metadata-unavailable" });
  assert.equal(effects.warningMessages.length, 0);
  assert.equal(effects.deletedMessageIds.size, 0);
});

test("missing mentioned-member data fails open for Admin protection while Spam still responds", async () => {
  const effects = createEffects();
  const config = createDefaultMentionProtectionConfig("guild-1", 1_000);
  config.adminEnabled = true;
  config.spamEnabled = true;
  config.protectedAdminRoleIds = ["admin-role"];
  const dependencies = createDependencies(config, effects);
  dependencies.fetchGuildMember = async () => {
    throw new Error("member unavailable");
  };

  const result = await moderateMentionProtectionMessage(
    createMessage({
      content: "<@u1> <@u2> <@u3> <@u4> <@u5>",
      mentions: ["u1", "u2", "u3", "u4", "u5"].map((id) => ({ id })),
    }),
    dependencies,
  );

  assert.deepEqual(result.breaches, [
    { protection: "spam", condition: "mass-mention", stage: "initial" },
  ]);
});

test("one message breaching both protections produces one composed response", async () => {
  const effects = createEffects();
  const config = createDefaultMentionProtectionConfig("guild-1", 1_000);
  config.adminEnabled = true;
  config.spamEnabled = true;
  config.protectedAdminRoleIds = ["admin-role"];

  const result = await moderateMentionProtectionMessage(
    createMessage({
      content: "<@u1> <@u2> <@u3> <@u4> <@u5>",
      mentions: [
        { id: "u1", member: { roles: ["admin-role"] } },
        ...["u2", "u3", "u4", "u5"].map((id) => ({ id })),
      ],
    }),
    createDependencies(config, effects),
  );

  assert.deepEqual(result.breaches, [
    { protection: "admin", condition: "admin-mention", stage: "initial" },
    { protection: "spam", condition: "mass-mention", stage: "initial" },
  ]);
  assert.equal(effects.warningMessages.length, 1);
  assert.equal(effects.deletedMessageIds.size, 1);
  assert.equal(effects.auditEvents.length, 1);
});

test("ordinary text channels use their own scope instead of their category parent", async () => {
  const effects = createEffects();
  const config = createDefaultMentionProtectionConfig("guild-1", 1_000);
  config.spamEnabled = true;
  config.channelMode = "include";
  config.channelIds = ["channel-1"];
  const dependencies = createDependencies(config, effects);
  dependencies.resolveChannelParent = async () => ({ parentId: "category-1", type: 0 });

  const result = await moderateMentionProtectionMessage(
    createMessage({
      content: "<@u1> <@u2> <@u3> <@u4> <@u5>",
      mentions: ["u1", "u2", "u3", "u4", "u5"].map((id) => ({ id })),
    }),
    dependencies,
  );

  assert.equal(result.status, "responded");
});

test("partial message updates fetch structured mention data before detection", async () => {
  const effects = createEffects();
  const config = createDefaultMentionProtectionConfig("guild-1", 1_000);
  config.spamEnabled = true;
  const dependencies = createDependencies(config, effects);
  dependencies.fetchMessage = async () =>
    createMessage({
      id: "message-2",
      content: "<@u1> <@u2> <@u3> <@u4> <@u5>",
      mentions: ["u1", "u2", "u3", "u4", "u5"].map((id) => ({ id })),
      edited_timestamp: "2026-07-13T00:00:01.000Z",
    });

  const result = await moderateMentionProtectionMessage(
    {
      id: "message-2",
      channel_id: "channel-1",
      guild_id: "guild-1",
      content: "<@u1> <@u2> <@u3> <@u4> <@u5>",
      author: { id: "user-1" },
      edited_timestamp: "2026-07-13T00:00:01.000Z",
    },
    dependencies,
  );

  assert.equal(result.status, "responded");
});

test("a later second-protection breach can strengthen an earlier timeout", async () => {
  const effects = createEffects();
  const config = createDefaultMentionProtectionConfig("guild-1", 1_000);
  config.adminEnabled = true;
  config.spamEnabled = true;
  config.protectedAdminRoleIds = ["admin-role"];
  config.massMentionThreshold = 50;
  config.adminInitialResponse.restriction = { type: "timeout", durationMs: 10 * 60_000 };
  config.spamInitialResponse.restriction = { type: "timeout", durationMs: 60 * 60_000 };
  const dependencies = createDependencies(config, effects);
  const message = createMessage({
    content: "<@u1> <@u2> <@u3> <@u4> <@u5>",
    mentions: [
      { id: "u1", member: { roles: ["admin-role"] } },
      ...["u2", "u3", "u4", "u5"].map((id) => ({ id })),
    ],
  });

  await moderateMentionProtectionMessage(message, dependencies);
  config.massMentionThreshold = 5;
  await moderateMentionProtectionMessage(
    { ...message, edited_timestamp: "2026-07-13T00:00:02.000Z" },
    dependencies,
  );

  assert.equal(effects.timeouts.length, 2);
  assert.equal(effects.timeouts[1]?.untilMs, Date.parse("2026-07-13T01:00:01.000Z"));
});

test("a leased action defers queue acknowledgement after independent actions run", async () => {
  const effects = createEffects();
  const config = createDefaultMentionProtectionConfig("guild-1", 1_000);
  config.spamEnabled = true;
  const dependencies = createDependencies(config, effects);
  const claimAction = dependencies.claimAction;
  dependencies.claimAction = async (guildId, messageId, action) =>
    action === "reply" ? "deferred" : claimAction(guildId, messageId, action);

  await assert.rejects(
    moderateMentionProtectionMessage(
      createMessage({
        content: "<@u1> <@u2> <@u3> <@u4> <@u5>",
        mentions: ["u1", "u2", "u3", "u4", "u5"].map((id) => ({ id })),
      }),
      dependencies,
    ),
    /deferred for retry/,
  );
  assert.equal(effects.deletedMessageIds.has("message-1"), true);
});

interface Effects {
  warningMessages: string[];
  deletedMessageIds: Set<string>;
  auditEvents: string[];
  breaches: Map<string, MentionProtectionBreach[]>;
  actionOutcomes: Map<string, MentionProtectionActionOutcome>;
  timeouts: Array<{ guildId: string; userId: string; untilMs: number }>;
  timedRoleAssignments: Array<{
    guildId: string;
    userId: string;
    roleId: string;
    expiresAtMs: number;
  }>;
}

function createEffects(): Effects {
  return {
    warningMessages: [],
    deletedMessageIds: new Set(),
    auditEvents: [],
    breaches: new Map(),
    actionOutcomes: new Map(),
    timeouts: [],
    timedRoleAssignments: [],
  };
}

function createMessage(overrides: Partial<DiscordMessageCreate> = {}): DiscordMessageCreate {
  return {
    id: "message-1",
    channel_id: "channel-1",
    guild_id: "guild-1",
    content: "hello",
    timestamp: "2026-07-13T00:00:00.000Z",
    type: 0,
    author: { id: "user-1", username: "member" },
    member: { roles: [] },
    mentions: [],
    mention_roles: [],
    mention_everyone: false,
    ...overrides,
  };
}

function createDependencies(
  config: MentionProtectionConfig,
  effects: Effects,
  options: {
    stage?: "initial" | "repeat";
    existingMemberRoles?: string[];
    entitlementUpdatedAtMs?: number;
    existingTimedRole?: TimedRoleAssignment;
    tier?: "free" | "premium" | "premium_plus";
  } = {},
): MentionProtectionMessageDependencies {
  return {
    now: () => Date.parse("2026-07-13T00:00:01.000Z"),
    readConfig: async () => config,
    readGuildEntitlement: async (guildId) => ({
      guildId,
      tier: options.tier ?? "premium",
      updatedAtMs: options.entitlementUpdatedAtMs ?? 1_000,
    }),
    resolveChannelParent: async () => ({ parentId: null, type: 0 }),
    fetchGuildMember: async (_guildId, userId) => ({ user: { id: userId }, roles: [] }),
    fetchMessage: async () => null,
    recordBurstMessage: async () => 1,
    claimMessageBreaches: async (input: MentionProtectionClaimInput) => {
      const key = `${input.guildId}:${input.messageId}`;
      const existing = effects.breaches.get(key) ?? [];
      const claimed = input.detections
        .filter(
          (detection) => !existing.some((breach) => breach.protection === detection.protection),
        )
        .map((detection) => ({
          guildId: input.guildId,
          messageId: input.messageId,
          userId: input.userId,
          channelId: input.channelId,
          protection: detection.protection,
          condition: detection.condition,
          stage: options.stage ?? "initial",
          responsePolicy:
            options.stage === "repeat" ? detection.repeatResponse : detection.initialResponse,
          evidence: detection.evidence,
          contentSnapshot: input.contentSnapshot,
          messageCreatedAtMs: input.messageCreatedAtMs,
          breachedAtMs: input.nowMs,
        }));
      const all = [...existing, ...claimed];
      effects.breaches.set(key, all);
      return all;
    },
    claimAction: async (guildId, messageId, action) => {
      const key = `${guildId}:${messageId}:${action}`;
      return effects.actionOutcomes.get(key)?.status === "succeeded" ? "satisfied" : "claimed";
    },
    recordActionOutcome: async (outcome) => {
      effects.actionOutcomes.set(
        `${outcome.guildId}:${outcome.messageId}:${outcome.action}`,
        outcome,
      );
    },
    createWarningReply: async (_channelId, _messageId, userId, content) => {
      effects.warningMessages.push(`${userId}:${content}`);
    },
    createWarningFallback: async (_channelId, _messageId, userId, content) => {
      effects.warningMessages.push(`${userId}:${content}`);
    },
    deleteMessage: async (_channelId, messageId) => {
      effects.deletedMessageIds.add(messageId);
    },
    readMemberTimeoutUntil: async () => null,
    applyMemberTimeout: async (guildId, userId, untilMs) => {
      effects.timeouts.push({ guildId, userId, untilMs });
    },
    readTimedRole: async () => options.existingTimedRole ?? null,
    memberHasRole: async (_guildId, _userId, roleId) =>
      options.existingMemberRoles?.includes(roleId) ?? false,
    assignTimedRole: async (assignment) => {
      effects.timedRoleAssignments.push({
        guildId: assignment.guildId,
        userId: assignment.userId,
        roleId: assignment.roleId,
        expiresAtMs: assignment.expiresAtMs,
      });
    },
    extendTimedRole: async (assignment) => {
      effects.timedRoleAssignments.push({
        guildId: assignment.guildId,
        userId: assignment.userId,
        roleId: assignment.roleId,
        expiresAtMs: assignment.expiresAtMs,
      });
    },
    postDeletionAuditEvent: async (_breaches) => {
      effects.auditEvents.push("posted");
    },
  };
}
