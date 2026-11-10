/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import {
  EventConfigError,
  EventTeamRateLimitError,
  EventsService,
} from "../src/services/events-service";
import type {
  EventRecord,
  EventReminder,
  EventSignup,
  EventTeam,
  EventTeamAuditRecord,
  EventTeamDeliveryOutboxRecord,
  EventTeamInvitationBlock,
  EventTeamMembership,
  EventTeamProposal,
  EventTeamRosterSnapshot,
  EventTemplate,
  EventLifecycleHistoryRecord,
} from "../src/types";
import type {
  EventLifecycleTransitionCommitInput,
  EventTeamDisbandCommitInput,
  EventTeamMutationCommitInput,
} from "../src/runtime/contracts/event-store";
import { GuildResourceValidationError } from "../src/discord/guild-resource-validator";
import {
  createStaticGuildResourceValidator,
  testChannel,
} from "./helpers/guild-resource-validator";

test("EventsService creates a team Event with an exact roster size", async () => {
  const service = new EventsService(createStore(), createDiscordStub());

  const event = await service.createEvent({
    guildId: "guild-1",
    templateId: null,
    title: "Friday Scrim",
    description: "Bring the main roster.",
    channelId: "event-channel-1",
    startsAtMs: Date.now() + 60 * 60 * 1000,
    endsAtMs: Date.now() + 2 * 60 * 60 * 1000,
    signupCutoffAtMs: null,
    signupMode: "single_choice",
    participationMode: "team",
    requiredTeamSize: 5,
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
  });

  assert.deepEqual(
    {
      participationMode: event.participationMode,
      requiredTeamSize: event.requiredTeamSize,
    },
    { participationMode: "team", requiredTeamSize: 5 },
  );
});

test("Event Team creation enforces adjustable per-event abuse limits", async () => {
  const store = createStore();
  const service = new EventsService(store, createDiscordStub(), undefined, undefined, {
    eventTeamRateLimits: { team_create: { maxAttempts: 1, windowMs: 60_000 } },
  });
  const event = await service.createEvent({
    ...createEvent(),
    participationMode: "team",
    requiredTeamSize: 2,
    signupMode: "single_choice",
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
  });
  await store.upsertEvent({ ...event, status: "scheduled" });
  await service.signup({
    guildId: event.guildId,
    eventId: event.id,
    userId: "captain-1",
    memberRoleIds: [],
    groupId: "open",
  });
  await service.createEventTeam({
    guildId: event.guildId,
    eventId: event.id,
    userId: "captain-1",
    groupId: "open",
    name: "First Team",
  });
  await service.signup({
    guildId: event.guildId,
    eventId: event.id,
    userId: "captain-2",
    memberRoleIds: [],
    groupId: "open",
  });
  await assert.rejects(
    service.createEventTeam({
      guildId: event.guildId,
      eventId: event.id,
      userId: "captain-2",
      groupId: "open",
      name: "Second Team",
    }),
    (error: unknown) => error instanceof EventTeamRateLimitError && error.action === "team_create",
  );
});

test("EventsService rejects a team Event whose roster size is outside 2 to 50", async () => {
  const service = new EventsService(createStore(), createDiscordStub());

  await assert.rejects(
    service.createEvent({
      ...createEvent(),
      participationMode: "team",
      requiredTeamSize: 1,
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
    }),
    new EventConfigError("Event Team size must be between 2 and 50."),
  );
});

test("EventsService requires single-choice Signup Groups for a team Event", async () => {
  const service = new EventsService(createStore(), createDiscordStub());

  await assert.rejects(
    service.createEvent({
      ...createEvent(),
      signupMode: "multi_choice",
      participationMode: "team",
      requiredTeamSize: 5,
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
    }),
    new EventConfigError("Team Events require single-choice Signup Groups."),
  );
});

test("EventsService creates a team Event Template with its required roster size", async () => {
  const service = new EventsService(createStore(), createDiscordStub());

  const template = await service.createTemplate({
    guildId: "guild-1",
    id: "template-1",
    name: "Five-stack",
    description: "Standard competitive roster",
    signupMode: "single_choice",
    participationMode: "team",
    requiredTeamSize: 5,
    threadEnabled: true,
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
  });

  assert.deepEqual(
    {
      participationMode: template.participationMode,
      requiredTeamSize: template.requiredTeamSize,
    },
    { participationMode: "team", requiredTeamSize: 5 },
  );
});

test("EventsService rejects a team Event Template without a required roster size", async () => {
  const service = new EventsService(createStore(), createDiscordStub());

  await assert.rejects(
    service.createTemplate({
      guildId: "guild-1",
      id: "template-1",
      name: "Five-stack",
      description: "Standard competitive roster",
      signupMode: "single_choice",
      participationMode: "team",
      requiredTeamSize: null,
      threadEnabled: true,
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
    }),
    new EventConfigError("Event Team size must be between 2 and 50."),
  );
});

test("EventsService requires single-choice Signup Groups for a team Event Template", async () => {
  const service = new EventsService(createStore(), createDiscordStub());

  await assert.rejects(
    service.createTemplate({
      guildId: "guild-1",
      id: "template-1",
      name: "Five-stack",
      description: "Standard competitive roster",
      signupMode: "multi_choice",
      participationMode: "team",
      requiredTeamSize: 5,
      threadEnabled: true,
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
    }),
    new EventConfigError("Team Events require single-choice Signup Groups."),
  );
});

test("EventsService derives an unassigned pool from team Event signups", async () => {
  const store = createStore();
  await store.upsertEvent(
    createEvent({
      status: "scheduled",
      participationMode: "team",
      requiredTeamSize: 5,
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
    }),
  );
  const service = new EventsService(store, createDiscordStub());
  await service.organizerSignup({
    guildId: "guild-1",
    eventId: "event-1",
    userId: "user-1",
    groupId: "open",
  });

  const pool = await service.listUnassignedParticipants({
    guildId: "guild-1",
    eventId: "event-1",
    groupId: "open",
  });

  assert.deepEqual(
    pool.map(({ userId, groupId, status }) => ({ userId, groupId, status })),
    [{ userId: "user-1", groupId: "open", status: "confirmed" }],
  );
});

test("EventsService accepts a captain-approved join request and cancels competing proposals", async () => {
  const store = createStore();
  await store.upsertEvent(
    createEvent({
      status: "scheduled",
      participationMode: "team",
      requiredTeamSize: 3,
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
    }),
  );
  const service = new EventsService(store, createDiscordStub());
  for (const userId of ["captain-1", "member-1"])
    await service.organizerSignup({
      guildId: "guild-1",
      eventId: "event-1",
      userId,
      groupId: "open",
    });
  const team = await service.createEventTeam({
    guildId: "guild-1",
    eventId: "event-1",
    userId: "captain-1",
    groupId: "open",
    name: "Night Owls",
  });
  await service.captainOpenEventTeamRequests({
    guildId: "guild-1",
    eventId: "event-1",
    teamId: team.id,
    captainUserId: "captain-1",
  });
  const request = await service.createEventTeamJoinRequest({
    guildId: "guild-1",
    eventId: "event-1",
    teamId: team.id,
    userId: "member-1",
  });
  await service.acceptEventTeamJoinRequest({
    guildId: "guild-1",
    eventId: "event-1",
    proposalId: request.id,
    captainUserId: "captain-1",
  });
  assert.deepEqual(
    (await store.listActiveEventTeamMemberships("guild-1", "event-1")).map((item) => item.userId),
    ["captain-1", "member-1"],
  );
  assert.equal(
    (
      await service.listEventTeamProposals({
        guildId: "guild-1",
        eventId: "event-1",
        status: "accepted",
      })
    ).length,
    1,
  );
});

test("EventsService permanently blocks a declined same-team invitation", async () => {
  const store = createStore();
  await store.upsertEvent(
    createEvent({
      status: "scheduled",
      participationMode: "team",
      requiredTeamSize: 2,
      groups: [
        {
          id: "open",
          label: "Open",
          emoji: null,
          capacity: null,
          waitlistEnabled: false,
          allowedRoleIds: [],
          blockedRoleIds: [],
          grantRoleId: null,
        },
      ],
    }),
  );
  const service = new EventsService(store, createDiscordStub());
  await service.organizerSignup({
    guildId: "guild-1",
    eventId: "event-1",
    userId: "captain-1",
    groupId: "open",
  });
  const team = await service.createEventTeam({
    guildId: "guild-1",
    eventId: "event-1",
    userId: "captain-1",
    groupId: "open",
    name: "Night Owls",
  });
  const invitation = await service.inviteEventTeamMember({
    guildId: "guild-1",
    eventId: "event-1",
    teamId: team.id,
    captainUserId: "captain-1",
    userId: "member-1",
  });
  await service.declineEventTeamInvitation({
    guildId: "guild-1",
    eventId: "event-1",
    proposalId: invitation.id,
    userId: "member-1",
  });
  await assert.rejects(
    () =>
      service.inviteEventTeamMember({
        guildId: "guild-1",
        eventId: "event-1",
        teamId: team.id,
        captainUserId: "captain-1",
        userId: "member-1",
      }),
    EventConfigError,
  );
});

test("EventsService lets an unassigned participant create an Event Team", async () => {
  const store = createStore();
  await store.upsertEvent(
    createEvent({
      status: "scheduled",
      participationMode: "team",
      requiredTeamSize: 5,
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
    }),
  );
  const service = new EventsService(store, createDiscordStub());
  await service.organizerSignup({
    guildId: "guild-1",
    eventId: "event-1",
    userId: "user-1",
    groupId: "open",
  });

  const team = await service.createEventTeam({
    guildId: "guild-1",
    eventId: "event-1",
    userId: "user-1",
    groupId: "open",
    name: "  Night   Owls ",
  });
  const pool = await service.listUnassignedParticipants({
    guildId: "guild-1",
    eventId: "event-1",
    groupId: "open",
  });

  assert.deepEqual(
    {
      name: team.name,
      captainUserId: team.captainUserId,
      groupId: team.groupId,
      poolUserIds: pool.map((participant) => participant.userId),
    },
    {
      name: "Night Owls",
      captainUserId: "user-1",
      groupId: "open",
      poolUserIds: [],
    },
  );
});

test("EventsService derives Event Team readiness from roster and signup state", async () => {
  const store = createStore();
  await store.upsertEvent(
    createEvent({
      status: "scheduled",
      participationMode: "team",
      requiredTeamSize: 2,
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
    }),
  );
  const service = new EventsService(store, createDiscordStub());
  await service.organizerSignup({
    guildId: "guild-1",
    eventId: "event-1",
    userId: "captain-1",
    groupId: "open",
  });
  const team = await service.createEventTeam({
    guildId: "guild-1",
    eventId: "event-1",
    userId: "captain-1",
    groupId: "open",
    name: "Night Owls",
  });

  const summary = await service.getEventTeamReadiness({
    guildId: "guild-1",
    eventId: "event-1",
    teamId: team.id,
  });

  assert.deepEqual(summary, {
    teamId: team.id,
    rosterCount: 1,
    confirmedCount: 1,
    openPlaces: 1,
    ready: false,
    reasons: ["roster_incomplete"],
  });
});

test("EventsService marks a full confirmed Event Team ready", async () => {
  const store = createStore();
  await store.upsertEvent(
    createEvent({
      status: "scheduled",
      participationMode: "team",
      requiredTeamSize: 2,
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
    }),
  );
  const service = new EventsService(store, createDiscordStub());
  for (const userId of ["captain-1", "member-1"]) {
    await service.organizerSignup({
      guildId: "guild-1",
      eventId: "event-1",
      userId,
      groupId: "open",
    });
  }
  const team = await service.createEventTeam({
    guildId: "guild-1",
    eventId: "event-1",
    userId: "captain-1",
    groupId: "open",
    name: "Night Owls",
  });

  await service.organizerAddEventTeamMember({
    guildId: "guild-1",
    eventId: "event-1",
    teamId: team.id,
    userId: "member-1",
  });

  assert.deepEqual(
    await service.getEventTeamReadiness({
      guildId: "guild-1",
      eventId: "event-1",
      teamId: team.id,
    }),
    {
      teamId: team.id,
      rosterCount: 2,
      confirmedCount: 2,
      openPlaces: 0,
      ready: true,
      reasons: [],
    },
  );
});

test("EventsService promotes the longest-standing member when an Event Team captain leaves", async () => {
  const store = createStore();
  await store.upsertEvent(
    createEvent({
      status: "scheduled",
      participationMode: "team",
      requiredTeamSize: 2,
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
    }),
  );
  const service = new EventsService(store, createDiscordStub());
  for (const userId of ["captain-1", "member-1"]) {
    await service.organizerSignup({
      guildId: "guild-1",
      eventId: "event-1",
      userId,
      groupId: "open",
    });
  }
  const team = await service.createEventTeam({
    guildId: "guild-1",
    eventId: "event-1",
    userId: "captain-1",
    groupId: "open",
    name: "Night Owls",
  });
  await service.organizerAddEventTeamMember({
    guildId: "guild-1",
    eventId: "event-1",
    teamId: team.id,
    userId: "member-1",
  });

  const updated = await service.leaveEventTeam({
    guildId: "guild-1",
    eventId: "event-1",
    userId: "captain-1",
  });
  const pool = await service.listUnassignedParticipants({
    guildId: "guild-1",
    eventId: "event-1",
    groupId: "open",
  });

  assert.deepEqual(
    {
      captainUserId: updated.captainUserId,
      status: updated.status,
      poolUserIds: pool.map((participant) => participant.userId),
    },
    {
      captainUserId: "member-1",
      status: "active",
      poolUserIds: ["captain-1"],
    },
  );
});

test("EventsService disbands an Event Team when its final member leaves", async () => {
  const store = createStore();
  await store.upsertEvent(
    createEvent({
      status: "scheduled",
      participationMode: "team",
      requiredTeamSize: 2,
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
    }),
  );
  const service = new EventsService(store, createDiscordStub());
  await service.organizerSignup({
    guildId: "guild-1",
    eventId: "event-1",
    userId: "captain-1",
    groupId: "open",
  });
  await service.createEventTeam({
    guildId: "guild-1",
    eventId: "event-1",
    userId: "captain-1",
    groupId: "open",
    name: "Night Owls",
  });
  await service.captainOpenEventTeamRequests({
    guildId: "guild-1",
    eventId: "event-1",
    teamId: store.eventTeams[0]!.id,
    captainUserId: "captain-1",
  });

  const updated = await service.leaveEventTeam({
    guildId: "guild-1",
    eventId: "event-1",
    userId: "captain-1",
  });
  const pool = await service.listUnassignedParticipants({
    guildId: "guild-1",
    eventId: "event-1",
    groupId: "open",
  });

  assert.deepEqual(
    {
      status: updated.status,
      openToRequests: updated.openToRequests,
      disbanded: updated.disbandedAtMs !== null,
      atomicDisbands: store.atomicDisbandCommits,
      poolUserIds: pool.map((participant) => participant.userId),
    },
    {
      status: "disbanded",
      openToRequests: false,
      disbanded: true,
      atomicDisbands: 1,
      poolUserIds: ["captain-1"],
    },
  );
});

test("EventsService atomically removes a rostered signup for an organizer", async () => {
  const store = createStore();
  await store.upsertEvent(
    createEvent({
      status: "scheduled",
      participationMode: "team",
      requiredTeamSize: 2,
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
    }),
  );
  const service = new EventsService(store, createDiscordStub());
  await service.organizerSignup({
    guildId: "guild-1",
    eventId: "event-1",
    userId: "captain-1",
    groupId: "open",
  });
  await service.createEventTeam({
    guildId: "guild-1",
    eventId: "event-1",
    userId: "captain-1",
    groupId: "open",
    name: "Night Owls",
  });

  await service.organizerRemoveSignup({
    guildId: "guild-1",
    eventId: "event-1",
    userId: "captain-1",
    groupId: "open",
  });

  assert.deepEqual(await store.listUserSignups("guild-1", "event-1", "captain-1"), []);
  assert.deepEqual(await store.listActiveEventTeamMemberships("guild-1", "event-1"), []);
  assert.equal(store.eventTeams[0]?.status, "disbanded");
  assert.equal(store.atomicDisbandCommits, 1);
});

test("EventsService clears Event Team membership when a participant leaves the Event", async () => {
  const store = createStore();
  await store.upsertEvent(
    createEvent({
      status: "scheduled",
      participationMode: "team",
      requiredTeamSize: 2,
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
    }),
  );
  const service = new EventsService(store, createDiscordStub());
  await service.organizerSignup({
    guildId: "guild-1",
    eventId: "event-1",
    userId: "captain-1",
    groupId: "open",
  });
  await service.createEventTeam({
    guildId: "guild-1",
    eventId: "event-1",
    userId: "captain-1",
    groupId: "open",
    name: "Night Owls",
  });

  await service.leaveEvent({
    guildId: "guild-1",
    eventId: "event-1",
    userId: "captain-1",
  });
  await service.organizerSignup({
    guildId: "guild-1",
    eventId: "event-1",
    userId: "captain-1",
    groupId: "open",
  });

  const replacement = await service.createEventTeam({
    guildId: "guild-1",
    eventId: "event-1",
    userId: "captain-1",
    groupId: "open",
    name: "Early Birds",
  });
  assert.equal(replacement.name, "Early Birds");
});

test("EventsService prevents an Event Team member from switching Signup Groups", async () => {
  const store = createStore();
  await store.upsertEvent(
    createEvent({
      status: "scheduled",
      participationMode: "team",
      requiredTeamSize: 2,
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
        {
          id: "pro",
          label: "Pro",
          emoji: null,
          capacity: 20,
          waitlistEnabled: true,
          allowedRoleIds: [],
          blockedRoleIds: [],
          grantRoleId: null,
        },
      ],
    }),
  );
  const service = new EventsService(store, createDiscordStub());
  await service.organizerSignup({
    guildId: "guild-1",
    eventId: "event-1",
    userId: "captain-1",
    groupId: "open",
  });
  await service.createEventTeam({
    guildId: "guild-1",
    eventId: "event-1",
    userId: "captain-1",
    groupId: "open",
    name: "Night Owls",
  });

  await assert.rejects(
    service.signup({
      guildId: "guild-1",
      eventId: "event-1",
      userId: "captain-1",
      memberRoleIds: [],
      groupId: "pro",
    }),
    new EventConfigError("Leave your Event Team before changing Signup Groups."),
  );
});

test("EventsService locks participation mode after the first signup", async () => {
  const store = createStore();
  const existing = createEvent({
    status: "scheduled",
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
  });
  await store.upsertEvent(existing);
  const service = new EventsService(store, createDiscordStub());
  await service.organizerSignup({
    guildId: "guild-1",
    eventId: "event-1",
    userId: "user-1",
    groupId: "open",
  });

  await assert.rejects(
    service.updateEvent({
      ...existing,
      eventId: existing.id,
      participationMode: "team",
      requiredTeamSize: 5,
    }),
    new EventConfigError(
      "Participation mode and Event Team size cannot change after roster activity.",
    ),
  );
});
test("EventsService publishes an event to one canonical Discord message", async () => {
  const store = createStore();
  const createdMessages: Array<{ channelId: string; body: unknown }> = [];
  const service = new EventsService(store, {
    ...createDiscordStub(),
    async createChannelMessage(channelId, body) {
      createdMessages.push({ channelId, body });
      return { id: "message-1", channel_id: channelId, content: "" };
    },
  });

  const event = await service.createEvent({
    guildId: "guild-1",
    templateId: null,
    title: "Friday Scrim",
    description: "Bring the main roster.",
    channelId: "event-channel-1",
    startsAtMs: Date.now() + 60 * 60 * 1000,
    endsAtMs: Date.now() + 2 * 60 * 60 * 1000,
    signupCutoffAtMs: null,
    signupMode: "single_choice",
    threadEnabled: false,
    waitlistedMembersJoinThread: false,
    groups: [
      {
        id: "team-red",
        label: "Team Red",
        emoji: "🔴",
        capacity: 1,
        waitlistEnabled: true,
        allowedRoleIds: [],
        blockedRoleIds: [],
        grantRoleId: null,
      },
    ],
    reminders: [],
  });

  const published = await service.publishEvent({
    guildId: "guild-1",
    eventId: event.id,
    actorUserId: "admin-1",
  });

  assert.equal(published.status, "scheduled");
  assert.equal(published.messageId, "message-1");
  assert.equal(createdMessages.length, 1);
  assert.equal(createdMessages[0]?.channelId, "event-channel-1");
  assert.deepEqual(await store.readEvent("guild-1", event.id), published);
});

test("EventsService signs members into capacity and promotes the waitlist", async () => {
  const store = createStore();
  const editedMessages: Array<{ channelId: string; messageId: string; body: unknown }> = [];
  const rolesAdded: Array<{ guildId: string; userId: string; roleId: string }> = [];
  const rolesRemoved: Array<{ guildId: string; userId: string; roleId: string }> = [];
  const service = new EventsService(store, {
    ...createDiscordStub(),
    async editChannelMessage(channelId, messageId, body) {
      editedMessages.push({ channelId, messageId, body });
      return { id: messageId, channel_id: channelId, content: "" };
    },
    async addGuildMemberRole(guildId, userId, roleId) {
      rolesAdded.push({ guildId, userId, roleId });
    },
    async removeGuildMemberRole(guildId, userId, roleId) {
      rolesRemoved.push({ guildId, userId, roleId });
    },
  });
  await store.upsertEvent({
    ...createEvent(),
    messageId: "message-1",
    status: "scheduled",
    groups: [
      {
        id: "team-red",
        label: "Team Red",
        emoji: "🔴",
        capacity: 1,
        waitlistEnabled: true,
        allowedRoleIds: [],
        blockedRoleIds: [],
        grantRoleId: "role-red",
      },
    ],
  });

  const first = await service.signup({
    guildId: "guild-1",
    eventId: "event-1",
    userId: "user-1",
    memberRoleIds: [],
    groupId: "team-red",
  });
  const second = await service.signup({
    guildId: "guild-1",
    eventId: "event-1",
    userId: "user-2",
    memberRoleIds: [],
    groupId: "team-red",
  });

  assert.equal(first.status, "confirmed");
  assert.equal(second.status, "waitlisted");
  assert.deepEqual(rolesAdded, [{ guildId: "guild-1", userId: "user-1", roleId: "role-red" }]);

  await service.leaveEvent({
    guildId: "guild-1",
    eventId: "event-1",
    userId: "user-1",
  });

  const signups = await store.listSignups("guild-1", "event-1");
  assert.deepEqual(
    signups.map(({ userId, groupId, status }) => ({ userId, groupId, status })),
    [{ userId: "user-2", groupId: "team-red", status: "confirmed" }],
  );
  assert.deepEqual(rolesRemoved, [{ guildId: "guild-1", userId: "user-1", roleId: "role-red" }]);
  assert.deepEqual(rolesAdded, [
    { guildId: "guild-1", userId: "user-1", roleId: "role-red" },
    { guildId: "guild-1", userId: "user-2", roleId: "role-red" },
  ]);
  assert.equal(editedMessages.length, 3);
});

test("EventsService keeps a confirmed signup when Discord role cleanup fails", async () => {
  const store = createStore();
  const service = new EventsService(store, {
    ...createDiscordStub(),
    async editChannelMessage(channelId, messageId) {
      return { id: messageId, channel_id: channelId, content: "" };
    },
    async removeGuildMemberRole() {
      throw new Error("Discord rate limited");
    },
  });
  await store.upsertEvent({
    ...createEvent(),
    messageId: "message-1",
    status: "scheduled",
    groups: [
      {
        id: "team-red",
        label: "Team Red",
        emoji: "🔴",
        capacity: 1,
        waitlistEnabled: true,
        allowedRoleIds: [],
        blockedRoleIds: [],
        grantRoleId: "role-red",
      },
    ],
  });
  await service.signup({
    guildId: "guild-1",
    eventId: "event-1",
    userId: "user-1",
    memberRoleIds: [],
    groupId: "team-red",
  });

  await assert.rejects(
    service.leaveEvent({ guildId: "guild-1", eventId: "event-1", userId: "user-1" }),
    /Discord rate limited/,
  );

  const signups = await store.listSignups("guild-1", "event-1");
  assert.deepEqual(
    signups.map(({ userId, status }) => ({ userId, status })),
    [{ userId: "user-1", status: "confirmed" }],
  );
});

test("EventsService lets organizers manage signup rosters", async () => {
  const store = createStore();
  const rolesAdded: Array<{ guildId: string; userId: string; roleId: string }> = [];
  const rolesRemoved: Array<{ guildId: string; userId: string; roleId: string }> = [];
  const service = new EventsService(store, {
    ...createDiscordStub(),
    async addGuildMemberRole(guildId, userId, roleId) {
      rolesAdded.push({ guildId, userId, roleId });
    },
    async removeGuildMemberRole(guildId, userId, roleId) {
      rolesRemoved.push({ guildId, userId, roleId });
    },
  });
  await store.upsertEvent({
    ...createEvent(),
    status: "scheduled",
    groups: [
      {
        id: "team-red",
        label: "Team Red",
        emoji: null,
        capacity: 1,
        waitlistEnabled: true,
        allowedRoleIds: ["role-eligible"],
        blockedRoleIds: [],
        grantRoleId: "role-red",
      },
    ],
  });

  const confirmed = await service.organizerSignup({
    guildId: "guild-1",
    eventId: "event-1",
    userId: "user-1",
    groupId: "team-red",
  });
  const waitlisted = await service.organizerSignup({
    guildId: "guild-1",
    eventId: "event-1",
    userId: "user-2",
    groupId: "team-red",
  });

  assert.equal(confirmed.status, "confirmed");
  assert.equal(waitlisted.status, "waitlisted");
  assert.deepEqual(rolesAdded, [{ guildId: "guild-1", userId: "user-1", roleId: "role-red" }]);

  await service.organizerRemoveSignup({
    guildId: "guild-1",
    eventId: "event-1",
    userId: "user-1",
    groupId: "team-red",
  });

  const signups = await store.listSignups("guild-1", "event-1");
  assert.deepEqual(
    signups.map(({ userId, status }) => ({ userId, status })),
    [{ userId: "user-2", status: "confirmed" }],
  );
  assert.deepEqual(rolesRemoved, [{ guildId: "guild-1", userId: "user-1", roleId: "role-red" }]);
  assert.deepEqual(rolesAdded, [
    { guildId: "guild-1", userId: "user-1", roleId: "role-red" },
    { guildId: "guild-1", userId: "user-2", roleId: "role-red" },
  ]);
});

test("EventsService captures an immutable roster snapshot when a Team Event goes live", async () => {
  const store = createStore();
  const event = createEvent({
    status: "scheduled",
    startsAtMs: 100,
    participationMode: "team",
    requiredTeamSize: 2,
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
  });
  await store.upsertEvent(event);
  await store.organizerSeedTeam();
  const service = new EventsService(store, createDiscordStub());
  await service.processDueLifecycle(100);
  assert.equal((await store.readEvent("guild-1", "event-1"))?.status, "live");
  assert.equal(store.rosterSnapshots.length, 1);
  const first = store.rosterSnapshots[0]!;
  assert.deepEqual(
    first.members.map((member) => member.userId),
    ["captain-1"],
  );
  await service.processDueLifecycle(100);
  assert.equal(store.rosterSnapshots.length, 1);
  assert.equal(store.lifecycleHistory.length, 1);
  assert.equal(store.atomicLifecycleCommits, 1);
});

test("EventsService blocks signup interactions while a guild is Free", async () => {
  const store = createStore();
  await store.upsertEvent({ ...createEvent(), status: "scheduled" });
  const service = new EventsService(store, createDiscordStub(), undefined, {
    async readGuildEntitlement(guildId) {
      return { guildId, tier: "free", updatedAtMs: Date.now() };
    },
  });

  await assert.rejects(
    service.signup({
      guildId: "guild-1",
      eventId: "event-1",
      userId: "user-1",
      memberRoleIds: [],
      groupId: "team-red",
    }),
    (error: unknown) =>
      error instanceof EventConfigError && error.message === "Events requires a paid plan.",
  );
  assert.deepEqual(store.signups, []);
});

test("EventsService blocks Event Team creation while a guild is Free", async () => {
  const store = createStore();
  await store.upsertEvent(
    createEvent({
      status: "scheduled",
      participationMode: "team",
      requiredTeamSize: 2,
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
    }),
  );
  const service = new EventsService(store, createDiscordStub(), undefined, {
    async readGuildEntitlement(guildId) {
      return { guildId, tier: "free", updatedAtMs: Date.now() };
    },
  });
  await service.organizerSignup({
    guildId: "guild-1",
    eventId: "event-1",
    userId: "user-1",
    groupId: "open",
  });

  await assert.rejects(
    service.createEventTeam({
      guildId: "guild-1",
      eventId: "event-1",
      userId: "user-1",
      groupId: "open",
      name: "Night Owls",
    }),
    (error: unknown) =>
      error instanceof EventConfigError && error.message === "Events requires a paid plan.",
  );
});

test("EventsService consumes reminders missed during a downgrade without sending them", async () => {
  const nowMs = 20_000;
  const event = createEvent({
    status: "scheduled",
    startsAtMs: 10_000,
    reminders: [
      {
        id: "reminder-1",
        offsetMinutes: 0,
        audience: "channel_public",
        signupGroupIds: [],
        message: "Starts now",
        sentAtMs: null,
      },
    ],
  });
  const store = createStore();
  store.dueReminders = [{ event, reminder: event.reminders[0]! }];
  let messages = 0;
  const service = new EventsService(
    store,
    {
      ...createDiscordStub(),
      async createChannelMessage() {
        messages += 1;
        return { id: "message-1", channel_id: event.channelId, content: "" };
      },
    },
    undefined,
    {
      async readGuildEntitlement(guildId) {
        return { guildId, tier: "premium", updatedAtMs: 15_000 };
      },
    },
  );

  assert.equal(await service.processDueReminders(nowMs), 0);
  assert.equal(messages, 0);
  assert.deepEqual(store.consumedReminderIds, ["reminder-1"]);
});

test("Event Team administrator overrides remain audited-capable after cutoff and preserve signups", async () => {
  const store = createStore();
  await store.upsertEvent(
    createEvent({
      status: "live",
      participationMode: "team",
      requiredTeamSize: 2,
      signupCutoffAtMs: 1,
      groups: [
        {
          id: "open",
          label: "Open",
          emoji: null,
          capacity: 10,
          waitlistEnabled: true,
          allowedRoleIds: [],
          blockedRoleIds: [],
          grantRoleId: null,
        },
      ],
    }),
  );
  await store.organizerSeedTeam();
  const teammate: EventTeamMembership = {
    guildId: "guild-1",
    eventId: "event-1",
    id: "membership-2",
    teamId: "team-1",
    groupId: "open",
    userId: "member-2",
    joinedAtMs: 2,
    leftAtMs: null,
  };
  await store.addEventTeamMembership(teammate);
  await store.upsertSignup({
    guildId: "guild-1",
    eventId: "event-1",
    userId: "captain-1",
    groupId: "open",
    status: "confirmed",
    createdAtMs: 1,
    updatedAtMs: 1,
  });
  await store.upsertSignup({
    guildId: "guild-1",
    eventId: "event-1",
    userId: "member-2",
    groupId: "open",
    status: "waitlisted",
    createdAtMs: 2,
    updatedAtMs: 2,
  });
  const service = new EventsService(store, createDiscordStub());

  const renamed = await service.organizerOverrideEventTeam({
    guildId: "guild-1",
    eventId: "event-1",
    teamId: "team-1",
    actorUserId: "admin-actor",
    confirmed: true,
    action: "rename",
    name: "  Dawn   Guard ",
  });
  assert.equal(renamed.team.name, "Dawn Guard");

  const removed = await service.organizerOverrideEventTeam({
    guildId: "guild-1",
    eventId: "event-1",
    teamId: "team-1",
    actorUserId: "admin-actor",
    confirmed: true,
    action: "remove_member",
    userId: "captain-1",
  });
  assert.equal(removed.team.captainUserId, "member-2");
  assert.equal(removed.membership?.leftAtMs !== null, true);
  assert.deepEqual(
    store.signups.map(({ userId, status }) => ({ userId, status })),
    [
      { userId: "captain-1", status: "confirmed" },
      { userId: "member-2", status: "waitlisted" },
    ],
  );
});

test("pending Event Team proposals expire authoritatively at the signup cutoff", async () => {
  const store = createStore();
  await store.upsertEvent(
    createEvent({
      status: "live",
      participationMode: "team",
      requiredTeamSize: 2,
      signupCutoffAtMs: 1,
    }),
  );
  store.eventTeamProposals.push({
    guildId: "guild-1",
    eventId: "event-1",
    id: "proposal-1",
    teamId: "team-1",
    kind: "invitation",
    requesterUserId: "captain-1",
    targetUserId: "member-2",
    status: "pending",
    createdAtMs: 1,
    updatedAtMs: 1,
    resolvedAtMs: null,
  });
  const service = new EventsService(store, createDiscordStub());

  const proposals = await service.listEventTeamProposals({
    guildId: "guild-1",
    eventId: "event-1",
  });

  assert.equal(proposals[0]?.status, "expired");
  assert.equal(store.eventTeamProposals[0]?.status, "expired");
  assert.equal(store.eventTeamProposals[0]?.resolvedAtMs !== null, true);
});

test("EventsService rejects a foreign Guild channel before event persistence", async () => {
  const store = createStore();
  let discordCalls = 0;
  const service = new EventsService(
    store,
    {
      ...createDiscordStub(),
      async createChannelMessage() {
        discordCalls += 1;
        return { id: "message", channel_id: "foreign-text", content: "" };
      },
    },
    undefined,
    undefined,
    undefined,
    createStaticGuildResourceValidator({
      guilds: {
        "guild-1": { channels: [testChannel("own-text", 0, "guild-1")], roles: [] },
        "guild-2": { channels: [testChannel("foreign-text", 0, "guild-2")], roles: [] },
      },
    }),
  );

  await assert.rejects(
    service.createEvent({
      guildId: "guild-1",
      templateId: null,
      title: "Foreign target",
      description: "Must not persist",
      channelId: "foreign-text",
      startsAtMs: Date.now() + 60_000,
      endsAtMs: null,
      signupCutoffAtMs: null,
      signupMode: "single_choice",
      threadEnabled: false,
      waitlistedMembersJoinThread: false,
      groups: [
        {
          id: "group-1",
          label: "Group",
          emoji: null,
          capacity: null,
          waitlistEnabled: false,
          allowedRoleIds: [],
          blockedRoleIds: [],
          grantRoleId: null,
        },
      ],
      reminders: [],
    }),
    GuildResourceValidationError,
  );
  assert.equal(store.events.length, 0);
  assert.equal(discordCalls, 0);
});

test("EventsService revalidates a persisted channel before publish", async () => {
  const store = createStore();
  const event = createEvent({ channelId: "foreign-text" });
  await store.upsertEvent(event);
  let discordCalls = 0;
  const service = new EventsService(
    store,
    {
      ...createDiscordStub(),
      async createChannelMessage() {
        discordCalls += 1;
        return { id: "message", channel_id: "foreign-text", content: "" };
      },
    },
    undefined,
    undefined,
    undefined,
    createStaticGuildResourceValidator({
      guilds: {
        "guild-1": { channels: [testChannel("own-text", 0, "guild-1")], roles: [] },
        "guild-2": { channels: [testChannel("foreign-text", 0, "guild-2")], roles: [] },
      },
    }),
  );

  await assert.rejects(
    service.publishEvent({ guildId: "guild-1", eventId: event.id, actorUserId: "admin" }),
    GuildResourceValidationError,
  );
  assert.equal(discordCalls, 0);
  assert.deepEqual(await store.readEvent("guild-1", event.id), event);
});

test("EventsService leaves a stale reminder retryable and makes no Discord call", async () => {
  const store = createStore();
  const event = createEvent({
    status: "scheduled",
    channelId: "foreign-text",
    reminders: [
      {
        id: "reminder-stale",
        offsetMinutes: 0,
        audience: "channel_public",
        signupGroupIds: [],
        message: "Starts now",
        sentAtMs: null,
      },
    ],
  });
  store.dueReminders = [{ event, reminder: event.reminders[0]! }];
  let discordCalls = 0;
  const service = new EventsService(
    store,
    {
      ...createDiscordStub(),
      async createChannelMessage() {
        discordCalls += 1;
        return { id: "message", channel_id: "foreign-text", content: "" };
      },
    },
    undefined,
    undefined,
    undefined,
    createStaticGuildResourceValidator({
      guilds: {
        "guild-1": { channels: [testChannel("own-text", 0, "guild-1")], roles: [] },
        "guild-2": { channels: [testChannel("foreign-text", 0, "guild-2")], roles: [] },
      },
    }),
  );

  await assert.rejects(service.processDueReminders(Date.now()), GuildResourceValidationError);
  assert.equal(discordCalls, 0);
  assert.deepEqual(store.consumedReminderIds, []);
});

function createStore(): EventStoreStub {
  return new EventStoreStub();
}

class EventStoreStub {
  templates: EventTemplate[] = [];
  events: EventRecord[] = [];
  signups: EventSignup[] = [];
  eventTeams: EventTeam[] = [];
  eventTeamMemberships: EventTeamMembership[] = [];
  eventTeamProposals: EventTeamProposal[] = [];
  eventTeamInvitationBlocks: EventTeamInvitationBlock[] = [];
  rosterSnapshots: EventTeamRosterSnapshot[] = [];
  lifecycleHistory: EventLifecycleHistoryRecord[] = [];
  eventTeamAudits: EventTeamAuditRecord[] = [];
  eventTeamDeliveries: EventTeamDeliveryOutboxRecord[] = [];
  atomicDisbandCommits = 0;
  atomicLifecycleCommits = 0;
  dueReminders: Array<{ event: EventRecord; reminder: EventReminder }> = [];
  consumedReminderIds: string[] = [];

  async organizerSeedTeam(): Promise<void> {
    this.eventTeams.push({
      guildId: "guild-1",
      eventId: "event-1",
      id: "team-1",
      groupId: "open",
      name: "Night Owls",
      normalizedName: "night owls",
      captainUserId: "captain-1",
      openToRequests: false,
      status: "active",
      createdByUserId: "captain-1",
      createdAtMs: 1,
      updatedAtMs: 1,
      disbandedAtMs: null,
    });
    this.eventTeamMemberships.push({
      guildId: "guild-1",
      eventId: "event-1",
      id: "membership-1",
      teamId: "team-1",
      groupId: "open",
      userId: "captain-1",
      joinedAtMs: 1,
      leftAtMs: null,
    });
  }

  async createTemplate(template: EventTemplate): Promise<void> {
    this.templates.push(template);
  }

  async listTemplates(guildId: string): Promise<EventTemplate[]> {
    return this.templates.filter((template) => template.guildId === guildId);
  }

  async readTemplate(guildId: string, templateId: string): Promise<EventTemplate | null> {
    return (
      this.templates.find((item) => item.guildId === guildId && item.id === templateId) ?? null
    );
  }

  async upsertTemplate(template: EventTemplate): Promise<void> {
    this.templates = this.templates.filter(
      (item) => item.guildId !== template.guildId || item.id !== template.id,
    );
    this.templates.push(template);
  }

  async createEvent(event: EventRecord): Promise<void> {
    this.events.push(event);
  }

  async upsertEvent(event: EventRecord): Promise<void> {
    this.events = this.events.filter(
      (item) => item.guildId !== event.guildId || item.id !== event.id,
    );
    this.events.push(event);
  }

  async readEvent(guildId: string, eventId: string): Promise<EventRecord | null> {
    return this.events.find((event) => event.guildId === guildId && event.id === eventId) ?? null;
  }

  async listEvents(guildId: string): Promise<EventRecord[]> {
    return this.events.filter((event) => event.guildId === guildId);
  }

  async listDueReminders(): Promise<Array<{ event: EventRecord; reminder: EventReminder }>> {
    return this.dueReminders;
  }

  async updateReminderSentAt(input: { reminderId: string }): Promise<void> {
    this.consumedReminderIds.push(input.reminderId);
  }

  async listDueLifecycleEvents(nowMs = Date.now()): Promise<EventRecord[]> {
    return this.events.filter(
      (event) =>
        (event.status === "scheduled" && event.startsAtMs <= nowMs) ||
        (event.status === "live" && event.endsAtMs !== null && event.endsAtMs <= nowMs),
    );
  }

  async upsertSignup(signup: EventSignup): Promise<void> {
    this.signups = this.signups.filter(
      (item) =>
        item.guildId !== signup.guildId ||
        item.eventId !== signup.eventId ||
        item.userId !== signup.userId ||
        item.groupId !== signup.groupId,
    );
    this.signups.push(signup);
  }

  async deleteSignup(body: {
    guildId: string;
    eventId: string;
    userId: string;
    groupId: string;
  }): Promise<void> {
    this.signups = this.signups.filter(
      (item) =>
        item.guildId !== body.guildId ||
        item.eventId !== body.eventId ||
        item.userId !== body.userId ||
        item.groupId !== body.groupId,
    );
  }

  async listSignups(guildId: string, eventId: string): Promise<EventSignup[]> {
    return this.signups
      .filter((signup) => signup.guildId === guildId && signup.eventId === eventId)
      .sort((a, b) => a.createdAtMs - b.createdAtMs);
  }

  async listUserSignups(guildId: string, eventId: string, userId: string): Promise<EventSignup[]> {
    return this.signups.filter(
      (signup) =>
        signup.guildId === guildId && signup.eventId === eventId && signup.userId === userId,
    );
  }

  async createEventTeamWithCaptain(input: {
    team: EventTeam;
    membership: EventTeamMembership;
  }): Promise<void> {
    this.eventTeams.push(input.team);
    this.eventTeamMemberships.push(input.membership);
  }

  async commitEventTeamMutation(input: EventTeamMutationCommitInput): Promise<void> {
    switch (input.mutation.kind) {
      case "create_team":
        await this.createEventTeamWithCaptain(input.mutation);
        break;
      case "add_membership":
        await this.addEventTeamMembership(input.mutation.membership);
        break;
      case "leave_membership":
        await this.leaveEventTeamMembership(input.mutation);
        break;
      case "update_team":
        await this.updateEventTeam(input.mutation.team);
        break;
      case "create_proposal":
        await this.createEventTeamProposal(input.mutation.proposal);
        break;
      case "update_proposal":
        await this.updateEventTeamProposal(input.mutation.proposal);
        break;
    }
    if (input.deleteSignup) await this.deleteSignup(input.deleteSignup);
    this.eventTeamAudits.push(input.audit);
    this.eventTeamDeliveries.push(...input.deliveries);
  }

  async commitEventTeamDisband(input: EventTeamDisbandCommitInput): Promise<void> {
    this.atomicDisbandCommits += 1;
    for (const membershipId of input.membershipIds) {
      await this.leaveEventTeamMembership({
        team: input.team,
        membershipId,
        leftAtMs: input.leftAtMs,
      });
    }
    await this.cancelEventTeamProposals({
      guildId: input.team.guildId,
      eventId: input.team.eventId,
      teamId: input.team.id,
      nowMs: input.leftAtMs,
    });
    if (input.deleteSignup) await this.deleteSignup(input.deleteSignup);
    this.eventTeamAudits.push(input.audit);
    this.eventTeamDeliveries.push(...input.deliveries);
  }

  async commitEventLifecycleTransition(input: EventLifecycleTransitionCommitInput): Promise<void> {
    this.atomicLifecycleCommits += 1;
    await this.upsertEvent(input.event);
    this.lifecycleHistory.push(input.history);
    this.rosterSnapshots.push(...input.snapshots);
  }

  async readEventTeamStateVersion(): Promise<number> {
    return 0;
  }

  async addEventTeamMembership(membership: EventTeamMembership): Promise<void> {
    this.eventTeamMemberships.push(membership);
  }

  async leaveEventTeamMembership(input: {
    team: EventTeam;
    membershipId: string;
    leftAtMs: number;
  }): Promise<void> {
    const membership = this.eventTeamMemberships.find(
      (candidate) => candidate.id === input.membershipId,
    );
    if (membership) membership.leftAtMs = input.leftAtMs;
    const teamIndex = this.eventTeams.findIndex((candidate) => candidate.id === input.team.id);
    if (teamIndex >= 0) this.eventTeams[teamIndex] = input.team;
  }

  async listEventTeams(guildId: string, eventId: string): Promise<EventTeam[]> {
    return this.eventTeams.filter((team) => team.guildId === guildId && team.eventId === eventId);
  }

  async listActiveEventTeamMemberships(
    guildId: string,
    eventId: string,
  ): Promise<EventTeamMembership[]> {
    return this.eventTeamMemberships.filter(
      (membership) =>
        membership.guildId === guildId &&
        membership.eventId === eventId &&
        membership.leftAtMs === null,
    );
  }

  async updateEventTeam(team: EventTeam): Promise<void> {
    const index = this.eventTeams.findIndex((item) => item.id === team.id);
    if (index >= 0) this.eventTeams[index] = team;
  }

  async captureEventTeamRosterSnapshot(
    snapshot: EventTeamRosterSnapshot,
  ): Promise<EventTeamRosterSnapshot> {
    const existing = this.rosterSnapshots.find(
      (item) =>
        item.guildId === snapshot.guildId &&
        item.eventId === snapshot.eventId &&
        item.teamId === snapshot.teamId,
    );
    if (existing) return existing;
    this.rosterSnapshots.push(snapshot);
    return snapshot;
  }

  async appendEventLifecycleHistory(record: EventLifecycleHistoryRecord): Promise<void> {
    this.lifecycleHistory.push(record);
  }

  async createEventTeamProposal(proposal: EventTeamProposal): Promise<void> {
    this.eventTeamProposals.push(proposal);
  }

  async updateEventTeamProposal(proposal: EventTeamProposal): Promise<void> {
    const index = this.eventTeamProposals.findIndex((item) => item.id === proposal.id);
    if (index >= 0) this.eventTeamProposals[index] = proposal;
  }

  async readEventTeamProposal(
    guildId: string,
    eventId: string,
    proposalId: string,
  ): Promise<EventTeamProposal | null> {
    return (
      this.eventTeamProposals.find(
        (item) => item.guildId === guildId && item.eventId === eventId && item.id === proposalId,
      ) ?? null
    );
  }

  async listEventTeamProposals(input: {
    guildId: string;
    eventId: string;
    teamId?: string;
    status?: EventTeamProposal["status"];
    targetUserId?: string;
  }): Promise<EventTeamProposal[]> {
    return this.eventTeamProposals.filter(
      (item) =>
        item.guildId === input.guildId &&
        item.eventId === input.eventId &&
        (!input.teamId || item.teamId === input.teamId) &&
        (!input.status || item.status === input.status) &&
        (!input.targetUserId || item.targetUserId === input.targetUserId),
    );
  }

  async createEventTeamInvitationBlock(block: EventTeamInvitationBlock): Promise<void> {
    if (
      !this.eventTeamInvitationBlocks.some(
        (item) =>
          item.guildId === block.guildId &&
          item.eventId === block.eventId &&
          item.teamId === block.teamId &&
          item.userId === block.userId,
      )
    )
      this.eventTeamInvitationBlocks.push(block);
  }

  async hasEventTeamInvitationBlock(
    guildId: string,
    eventId: string,
    teamId: string,
    userId: string,
  ): Promise<boolean> {
    return this.eventTeamInvitationBlocks.some(
      (item) =>
        item.guildId === guildId &&
        item.eventId === eventId &&
        item.teamId === teamId &&
        item.userId === userId,
    );
  }

  async cancelEventTeamProposals(input: {
    guildId: string;
    eventId: string;
    teamId: string;
    nowMs: number;
  }): Promise<void> {
    this.eventTeamProposals = this.eventTeamProposals.map((item) =>
      item.guildId === input.guildId &&
      item.eventId === input.eventId &&
      item.teamId === input.teamId &&
      item.status === "pending"
        ? { ...item, status: "cancelled", updatedAtMs: input.nowMs, resolvedAtMs: input.nowMs }
        : item,
    );
  }
}

function createEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    guildId: "guild-1",
    id: "event-1",
    templateId: null,
    title: "Friday Scrim",
    description: "Bring the main roster.",
    status: "draft",
    channelId: "event-channel-1",
    messageId: null,
    threadId: null,
    startsAtMs: Date.now() + 60 * 60 * 1000,
    endsAtMs: Date.now() + 2 * 60 * 60 * 1000,
    signupCutoffAtMs: Date.now() + 60 * 60 * 1000,
    signupMode: "single_choice",
    participationMode: "individual",
    requiredTeamSize: null,
    threadEnabled: false,
    waitlistedMembersJoinThread: false,
    groups: [],
    reminders: [],
    createdAtMs: 100,
    updatedAtMs: 100,
    publishedAtMs: null,
    cancelledAtMs: null,
    endedAtMs: null,
    archivedAtMs: null,
    ...overrides,
  };
}

function createDiscordStub() {
  return {
    async createChannelMessage() {
      throw new Error("unexpected createChannelMessage");
    },
    async editChannelMessage() {
      throw new Error("unexpected editChannelMessage");
    },
    async createThread() {
      throw new Error("unexpected createThread");
    },
    async addThreadMember() {},
    async removeThreadMember() {},
    async addGuildMemberRole() {},
    async removeGuildMemberRole() {},
  };
}
