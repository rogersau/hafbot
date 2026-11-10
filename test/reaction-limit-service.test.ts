/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { moderateReactionLimitAdd } from "../src/services/reaction-limits/reaction-limit-service";
import type { ReactionLimitConfig } from "../src/types";

test("Reaction Limits still enforces bot reactions and role escalation without a breach DM", async () => {
  const events: string[] = [];
  await moderateReactionLimitAdd(
    {
      channel_id: "channel-1",
      message_id: "message-1",
      guild_id: "guild-1",
      emoji: { id: null, name: "😈", animated: false },
      user_id: "other-bot",
      member: { user: { id: "other-bot", bot: true } },
    },
    {
      readConfig: async () => ({
        ...baseConfig,
        maxReactionsPerUserPerMessage: 1,
        breachThreshold: 1,
        breachRoleId: "role-1",
        breachDmText: "Reaction limit breached.",
      }),
      readGuildEntitlement: async () => ({ guildId: "guild-1", tier: "free", updatedAtMs: 0 }),
      incrementReactionCounters: async () => ({ totalReactions: 2, userReactions: 2 }),
      removeReaction: async () => {
        events.push("remove");
      },
      incrementBreachCounter: async () => 1,
      resetBreachCounter: async () => {},
      assignRole: async () => {
        events.push("assign");
      },
      sendDm: async () => {
        events.push("dm");
      },
      logRoleAssignment: async () => {
        events.push("audit");
      },
    },
  );
  assert.deepEqual(events, ["remove", "assign", "audit"]);
});

test("moderateReactionLimitAdd removes reactions that push a message over the configured total limit", async () => {
  const removed: string[] = [];

  await moderateReactionLimitAdd(
    {
      channel_id: "channel-1",
      message_id: "message-1",
      guild_id: "guild-1",
      emoji: { id: null, name: "✅", animated: false },
      user_id: "user-1",
    },
    {
      readConfig: async () => ({ ...baseConfig, maxReactionsPerMessage: 2 }),
      readGuildEntitlement: async () => ({ guildId: "guild-1", tier: "premium", updatedAtMs: 0 }),
      incrementReactionCounters: async () => ({ totalReactions: 3, userReactions: 1 }),
      removeReaction: async () => {
        removed.push("reaction");
      },
      incrementBreachCounter: async () => 1,
      resetBreachCounter: async () => {},
      assignRole: async () => {},
      sendDm: async () => {},
      logRoleAssignment: async () => {},
    },
  );

  assert.deepEqual(removed, ["reaction"]);
});

test("moderateReactionLimitAdd tracks per-user breaches and assigns the configured role at threshold", async () => {
  const events: string[] = [];
  const roleAssignmentLogs: unknown[] = [];

  await moderateReactionLimitAdd(
    {
      channel_id: "channel-1",
      message_id: "message-1",
      guild_id: "guild-1",
      emoji: { id: null, name: "✅", animated: false },
      user_id: "user-1",
    },
    {
      readConfig: async () => ({
        ...baseConfig,
        maxReactionsPerUserPerMessage: 1,
        breachThreshold: 2,
        breachRoleId: "role-1",
        breachRoleDurationMs: 60_000,
        breachDmText: "Reaction limit breached.",
      }),
      readGuildEntitlement: async () => ({ guildId: "guild-1", tier: "premium", updatedAtMs: 0 }),
      incrementReactionCounters: async () => ({ totalReactions: 2, userReactions: 2 }),
      removeReaction: async () => {
        events.push("remove");
      },
      incrementBreachCounter: async () => {
        events.push("increment");
        return 2;
      },
      resetBreachCounter: async () => {
        events.push("reset");
      },
      assignRole: async (input) => {
        events.push(`assign:${input.roleId}:${input.durationMs}`);
      },
      sendDm: async (_userId, message) => {
        events.push(`dm:${message}`);
      },
      logRoleAssignment: async (input) => {
        events.push(`log:${input.roleId}`);
        roleAssignmentLogs.push(input);
      },
    },
  );

  assert.deepEqual(events, [
    "remove",
    "increment",
    "dm:Reaction limit breached.",
    "assign:role-1:60000",
    "reset",
    "log:role-1",
  ]);
  assert.deepEqual(roleAssignmentLogs, [
    {
      guildId: "guild-1",
      userId: "user-1",
      roleId: "role-1",
      reaction: {
        channel_id: "channel-1",
        message_id: "message-1",
        guild_id: "guild-1",
        emoji: { id: null, name: "✅", animated: false },
        user_id: "user-1",
      },
      breachCount: 2,
      breachThreshold: 2,
      userReactions: 2,
      maxReactionsPerUserPerMessage: 1,
    },
  ]);
});

test("moderateReactionLimitAdd does not increment counters when no limits are configured", async () => {
  await assert.doesNotReject(() =>
    moderateReactionLimitAdd(
      {
        channel_id: "channel-1",
        message_id: "message-1",
        guild_id: "guild-1",
        emoji: { id: null, name: "✅", animated: false },
        user_id: "user-1",
      },
      {
        readConfig: async () => baseConfig,
        readGuildEntitlement: async () => {
          throw new Error("should not read entitlement");
        },
        incrementReactionCounters: async () => {
          throw new Error("should not increment reaction counters");
        },
        removeReaction: async () => {
          throw new Error("should not remove reaction");
        },
        incrementBreachCounter: async () => 1,
        resetBreachCounter: async () => {},
        assignRole: async () => {},
        sendDm: async () => {},
        logRoleAssignment: async () => {},
      },
    ),
  );
});

test("moderateReactionLimitAdd skips non-matching channels before counters and entitlement", async () => {
  await assert.doesNotReject(() =>
    moderateReactionLimitAdd(
      {
        channel_id: "channel-2",
        message_id: "message-1",
        guild_id: "guild-1",
        emoji: { id: null, name: "✅", animated: false },
        user_id: "user-1",
      },
      {
        readConfig: async () => ({
          ...baseConfig,
          maxReactionsPerMessage: 2,
          channelMode: "include",
          channelIds: ["channel-1"],
        }),
        readGuildEntitlement: async () => {
          throw new Error("should not read entitlement");
        },
        incrementReactionCounters: async () => {
          throw new Error("should not increment reaction counters");
        },
        removeReaction: async () => {
          throw new Error("should not remove reaction");
        },
        incrementBreachCounter: async () => 1,
        resetBreachCounter: async () => {},
        assignRole: async () => {},
        sendDm: async () => {},
        logRoleAssignment: async () => {},
      },
    ),
  );
});

test("moderateReactionLimitAdd does not read Discord reaction state when limits are disabled", async () => {
  await assert.doesNotReject(() =>
    moderateReactionLimitAdd(
      {
        channel_id: "channel-1",
        message_id: "message-1",
        guild_id: "guild-1",
        emoji: { id: null, name: "✅", animated: false },
        user_id: "user-1",
      },
      {
        readConfig: async () => ({ ...baseConfig, limitsEnabled: false }),
        readGuildEntitlement: async () => {
          throw new Error("should not read entitlement");
        },
        incrementReactionCounters: async () => {
          throw new Error("should not increment reaction counters");
        },
        removeReaction: async () => {
          throw new Error("should not remove reaction");
        },
        incrementBreachCounter: async () => 1,
        resetBreachCounter: async () => {},
        assignRole: async () => {},
        sendDm: async () => {},
        logRoleAssignment: async () => {},
      },
    ),
  );
});

const baseConfig: ReactionLimitConfig = {
  guildId: "guild-1",
  limitsEnabled: true,
  maxReactionsPerMessage: null,
  maxReactionsPerUserPerMessage: null,
  breachThreshold: null,
  breachRoleId: null,
  breachRoleDurationMs: null,
  breachDmText: null,
  channelMode: "include",
  channelIds: [],
};
