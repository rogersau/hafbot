import assert from "node:assert/strict";
import test from "node:test";

import { createEventsAdminRoutes } from "../src/runtime/admin-routes/events";
import type { EventRecord, EventSignup, EventTeam, EventTeamMembership } from "../src/types";

test("Event roster export returns operational CSV with Event Team and readiness fields", async () => {
  const event = buildTeamEvent();
  const signups: EventSignup[] = [
    {
      guildId: event.guildId,
      eventId: event.id,
      userId: "captain-1",
      groupId: "division-1",
      status: "confirmed",
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    {
      guildId: event.guildId,
      eventId: event.id,
      userId: "pool-1",
      groupId: "division-1",
      status: "waitlisted",
      createdAtMs: 2,
      updatedAtMs: 2,
    },
  ];
  const team: EventTeam = {
    guildId: event.guildId,
    eventId: event.id,
    id: "team-1",
    groupId: "division-1",
    name: "Night Owls",
    normalizedName: "night owls",
    captainUserId: "captain-1",
    openToRequests: true,
    status: "active",
    createdByUserId: "captain-1",
    createdAtMs: 1,
    updatedAtMs: 1,
    disbandedAtMs: null,
  };
  const membership: EventTeamMembership = {
    guildId: event.guildId,
    eventId: event.id,
    id: "membership-1",
    teamId: team.id,
    groupId: team.groupId,
    userId: "captain-1",
    joinedAtMs: 1,
    leftAtMs: null,
  };
  const routes = createEventsAdminRoutes({
    stores: {
      events: {
        readEvent: async () => event,
        listSignups: async () => signups,
        listEventTeams: async () => [team],
        listActiveEventTeamMemberships: async () => [membership],
      },
    } as never,
    adminAccess: {} as never,
    discordBotToken: "token",
    services: {
      eventsService: {
        getEventTeamReadiness: async () => ({
          teamId: team.id,
          rosterCount: 1,
          confirmedCount: 1,
          openPlaces: 1,
          ready: false,
          reasons: ["roster_incomplete"],
        }),
      } as never,
    },
  });
  const route = routes.find(({ operationId }) => operationId === "eventsRosterExport.get");
  assert.ok(route);

  const response = await route.handler({
    request: new Request("https://example.com/admin/api/events/roster-export"),
    url: new URL("https://example.com/admin/api/events/roster-export"),
    params: {},
    query: { guildId: event.guildId, eventId: event.id },
    body: undefined,
  });
  const body = (await response.json()) as { filename: string; csv: string };

  assert.equal(body.filename, "raid-night-event-1-roster.csv");
  assert.equal(
    body.csv,
    [
      "signup_group,event_team,is_captain,participant_id,confirmation_state,readiness",
      '"Alpha, Division",Night Owls,true,captain-1,confirmed,incomplete',
      '"Alpha, Division",,false,pool-1,waitlisted,unassigned',
      "",
    ].join("\n"),
  );
});

test("Event Admin mutations derive the audit actor from the customer Discord session", async () => {
  let actorUserId = "";
  const event = buildTeamEvent();
  const routes = createEventsAdminRoutes({
    stores: {
      events: {
        listSignups: async () => [],
      },
    } as never,
    adminAccess: {} as never,
    discordBotToken: "token",
    readCustomerAdminSession: async () =>
      ({
        user: { id: "account-1", discordUserId: "discord-actor-1" },
      }) as never,
    services: {
      eventsService: {
        publishEvent: async (input: { actorUserId: string }) => {
          actorUserId = input.actorUserId;
          return event;
        },
      } as never,
    },
  });
  const route = routes.find(({ operationId }) => operationId === "eventsPublish.post");
  assert.ok(route);

  await route.handler({
    request: new Request("https://example.com/admin/api/events/publish", { method: "POST" }),
    url: new URL("https://example.com/admin/api/events/publish"),
    params: {},
    query: undefined,
    body: { guildId: event.guildId, eventId: event.id },
  });

  assert.equal(actorUserId, "discord-actor-1");
});

test("Event Team administrator overrides require explicit confirmation and authenticated actor", async () => {
  const event = buildTeamEvent();
  const calls: Array<Record<string, unknown>> = [];
  const routes = createEventsAdminRoutes({
    stores: { events: { listSignups: async () => [] } } as never,
    adminAccess: {} as never,
    discordBotToken: "token",
    readCustomerAdminSession: async () =>
      ({ user: { id: "account-1", discordUserId: "admin-1" } }) as never,
    services: {
      eventsService: {
        organizerOverrideEventTeam: async (input: Record<string, unknown>) => {
          calls.push(input);
          return {
            team: {
              guildId: event.guildId,
              eventId: event.id,
              id: "team-1",
              groupId: "division-1",
              name: "Renamed",
              normalizedName: "renamed",
              captainUserId: "captain-1",
              openToRequests: true,
              status: "active",
              createdByUserId: "captain-1",
              createdAtMs: 1,
              updatedAtMs: 2,
              disbandedAtMs: null,
            },
          };
        },
      } as never,
    },
  });
  const route = routes.find(({ operationId }) => operationId === "eventsTeamOverride.post");
  assert.ok(route);

  const response = await route.handler({
    request: new Request("https://example.com/admin/api/events/teams/override", { method: "POST" }),
    url: new URL("https://example.com/admin/api/events/teams/override"),
    params: {},
    query: undefined,
    body: {
      guildId: event.guildId,
      eventId: event.id,
      teamId: "team-1",
      action: "rename",
      name: "Renamed",
      confirmed: true,
    },
  });

  assert.equal(response.status, 200);
  assert.equal(calls[0]?.actorUserId, "admin-1");
  assert.equal(calls[0]?.confirmed, true);
});

function buildTeamEvent(): EventRecord {
  return {
    guildId: "guild-1",
    id: "event-1",
    templateId: null,
    title: "Raid Night",
    description: "",
    status: "scheduled",
    channelId: "channel-1",
    messageId: null,
    threadId: null,
    startsAtMs: 2,
    endsAtMs: 3,
    signupCutoffAtMs: 2,
    signupMode: "single_choice",
    participationMode: "team",
    requiredTeamSize: 2,
    threadEnabled: false,
    waitlistedMembersJoinThread: false,
    groups: [
      {
        id: "division-1",
        label: "Alpha, Division",
        emoji: null,
        capacity: 10,
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
}
