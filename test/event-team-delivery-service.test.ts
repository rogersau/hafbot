import assert from "node:assert/strict";
import test from "node:test";

import { DiscordApiError } from "../src/discord/client";
import {
  EventTeamDeliveryService,
  type EventTeamDeliveryDiscord,
  type EventTeamDeliveryStore,
} from "../src/services/event-team-delivery-service";
import type {
  EventRecord,
  EventSignup,
  EventTeam,
  EventTeamDeliveryOutboxRecord,
  EventTeamMembership,
} from "../src/types";

test("delivers a notification once and records success", async () => {
  const store = new MemoryDeliveryStore([delivery("notification", { recipientUserId: "user-1" })]);
  const dms: unknown[] = [];
  const service = new EventTeamDeliveryService({
    store,
    discord: discord({ sendUserDm: async (_userId, body) => dms.push(body) }),
  });

  assert.deepEqual(await service.processDue(1_000), {
    listed: 1,
    claimed: 1,
    skipped: 0,
    delivered: 1,
    retried: 0,
    failed: 0,
  });
  assert.equal(dms.length, 1);
  assert.deepEqual(dms[0], {
    content:
      "You have an update about an Event Team. Open the Event Team controls in Discord to review it.",
    allowed_mentions: { parse: [] },
  });
  assert.equal(store.records[0]?.status, "delivered");
  assert.equal(store.records[0]?.attemptCount, 1);
});

test("transient delivery failures retry with bounded exponential backoff", async () => {
  const store = new MemoryDeliveryStore([
    delivery("notification", { recipientUserId: "user-1" }, 3),
  ]);
  let attempts = 0;
  const service = new EventTeamDeliveryService({
    store,
    retryBaseDelayMs: 100,
    retryMaxDelayMs: 250,
    discord: discord({
      sendUserDm: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("temporary gateway timeout");
      },
    }),
  });

  assert.equal((await service.processDue(1_000)).retried, 1);
  assert.equal(store.records[0]?.nextAttemptAtMs, 1_100);
  assert.equal((await service.processDue(1_100)).retried, 1);
  assert.equal(store.records[0]?.nextAttemptAtMs, 1_300);
  assert.equal((await service.processDue(1_300)).delivered, 1);
  assert.equal(store.records[0]?.status, "delivered");
});

test("DM forbidden is terminal and keeps a diagnosed failure", async () => {
  const store = new MemoryDeliveryStore([delivery("notification", { recipientUserId: "user-1" })]);
  const service = new EventTeamDeliveryService({
    store,
    discord: discord({
      sendUserDm: async () => {
        throw new DiscordApiError("Cannot send messages to this user", 403, "DMs closed");
      },
    }),
  });

  assert.equal((await service.processDue(2_000)).failed, 1);
  assert.equal(store.records[0]?.status, "failed");
  assert.equal(store.records[0]?.terminalFailureReason, "discord_forbidden");
  assert.equal(store.records[0]?.attemptCount, 1);
});

test("canonical refresh projects current event, signup, and roster state", async () => {
  const store = new MemoryDeliveryStore([delivery("canonical_refresh")]);
  store.event.messageId = "canonical-message";
  store.signups = [signup("assigned", "open"), signup("unassigned", "open")];
  store.teams = [team("team-1")];
  store.memberships = [membership("assigned", "team-1")];
  const edits: Array<{ channelId: string; messageId: string; body: unknown }> = [];
  const service = new EventTeamDeliveryService({
    store,
    discord: discord({
      editChannelMessage: async (channelId, messageId, body) =>
        edits.push({ channelId, messageId, body }),
    }),
  });

  assert.equal((await service.processDue(3_000)).delivered, 1);
  assert.equal(edits.length, 1);
  assert.equal(edits[0]?.channelId, "channel-1");
  assert.equal(edits[0]?.messageId, "canonical-message");
  const body = edits[0]?.body as {
    embeds?: Array<{ fields?: Array<{ name: string; value: string }> }>;
  };
  const teamField = body.embeds?.[0]?.fields?.find((field) => field.name === "Event Teams");
  assert.equal(teamField?.value, "0 ready · 1 incomplete\n1 assigned · 1 unassigned\nCapacity: 2");
});

test("a replay that loses the atomic claim does not duplicate the delivered effect", async () => {
  const store = new MemoryDeliveryStore([delivery("notification", { recipientUserId: "user-1" })]);
  const dms: unknown[] = [];
  const service = new EventTeamDeliveryService({
    store,
    discord: discord({ sendUserDm: async () => dms.push(true) }),
  });
  assert.equal((await service.processDue(4_000)).delivered, 1);
  store.replayDue = true;
  assert.equal((await service.processDue(4_000)).skipped, 1);
  assert.equal(dms.length, 1);
});

test("emits content-free aggregate operational metrics for each delivery sweep", async () => {
  const store = new MemoryDeliveryStore([delivery("notification", { recipientUserId: "user-1" })]);
  const observed: unknown[] = [];
  const service = new EventTeamDeliveryService({
    store,
    discord: discord(),
    observeMetrics: (metrics) => {
      observed.push(metrics);
    },
  });

  const result = await service.processDue(5_000);

  assert.deepEqual(observed, [
    {
      listed: 1,
      claimed: 1,
      skipped: 0,
      delivered: 1,
      retried: 0,
      failed: 0,
    },
  ]);
  assert.deepEqual(observed[0], result);
  assert.doesNotMatch(JSON.stringify(observed), /guild-1|event-1|Night Owls|user-1/);
});

function discord(overrides: Partial<EventTeamDeliveryDiscord> = {}): EventTeamDeliveryDiscord {
  return {
    sendUserDm: async () => undefined,
    editChannelMessage: async () => undefined,
    ...overrides,
  };
}

function delivery(
  kind: EventTeamDeliveryOutboxRecord["kind"],
  payload?: unknown,
  maxAttempts = 5,
): EventTeamDeliveryOutboxRecord {
  return {
    guildId: "guild-1",
    eventId: "event-1",
    id: `delivery-${kind}`,
    kind,
    dedupeKey: `${kind}:1`,
    payload,
    status: "pending",
    attemptCount: 0,
    maxAttempts,
    lastError: null,
    terminalFailureReason: null,
    nextAttemptAtMs: 0,
    createdAtMs: 0,
    updatedAtMs: 0,
    deliveredAtMs: null,
  };
}

function signup(userId: string, groupId: string): EventSignup {
  return {
    guildId: "guild-1",
    eventId: "event-1",
    userId,
    groupId,
    status: "confirmed",
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function team(id: string): EventTeam {
  return {
    guildId: "guild-1",
    eventId: "event-1",
    id,
    groupId: "open",
    name: "Night Owls",
    normalizedName: "night owls",
    captainUserId: "captain",
    openToRequests: true,
    status: "active",
    createdByUserId: "captain",
    createdAtMs: 1,
    updatedAtMs: 1,
    disbandedAtMs: null,
  };
}

function membership(userId: string, teamId: string): EventTeamMembership {
  return {
    guildId: "guild-1",
    eventId: "event-1",
    id: `membership-${userId}`,
    teamId,
    groupId: "open",
    userId,
    joinedAtMs: 1,
    leftAtMs: null,
  };
}

class MemoryDeliveryStore implements EventTeamDeliveryStore {
  event: EventRecord = {
    guildId: "guild-1",
    id: "event-1",
    templateId: null,
    title: "Event",
    description: "Description",
    status: "live",
    channelId: "channel-1",
    messageId: null,
    threadId: null,
    startsAtMs: 1,
    endsAtMs: null,
    signupCutoffAtMs: 2,
    signupMode: "single_choice",
    participationMode: "team",
    requiredTeamSize: 2,
    threadEnabled: false,
    waitlistedMembersJoinThread: false,
    groups: [
      {
        id: "open",
        label: "Open",
        emoji: null,
        capacity: 20,
        waitlistEnabled: true,
        allowedRoleIds: [],
        blockedRoleIds: [],
        grantRoleId: null,
      },
    ],
    reminders: [],
    createdAtMs: 1,
    updatedAtMs: 1,
    publishedAtMs: 1,
    cancelledAtMs: null,
    endedAtMs: null,
    archivedAtMs: null,
  };
  signups: EventSignup[] = [];
  teams: EventTeam[] = [];
  memberships: EventTeamMembership[] = [];
  replayDue = false;

  constructor(public records: EventTeamDeliveryOutboxRecord[]) {}

  async listDueEventTeamDeliveries({ nowMs }: { nowMs: number; limit: number }) {
    return this.records.filter(
      (record) =>
        (this.replayDue || record.status === "pending") && record.nextAttemptAtMs <= nowMs,
    );
  }

  async claimEventTeamDelivery({
    record,
    nowMs,
  }: Parameters<EventTeamDeliveryStore["claimEventTeamDelivery"]>[0]) {
    const current = this.records.find((candidate) => candidate.id === record.id);
    if (!current || current.status !== "pending" || current.nextAttemptAtMs > nowMs) return null;
    if (this.replayDue) return null;
    current.status = "processing";
    return { ...current };
  }

  async updateEventTeamDelivery(record: EventTeamDeliveryOutboxRecord) {
    const index = this.records.findIndex((candidate) => candidate.id === record.id);
    this.records[index] = { ...record };
  }

  async readEvent() {
    return this.event;
  }
  async listSignups() {
    return this.signups;
  }
  async listEventTeams() {
    return this.teams;
  }
  async listActiveEventTeamMemberships() {
    return this.memberships;
  }
}
