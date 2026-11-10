/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { buildEventMessage, parseEventCustomId } from "../src/events";
import { extractCommandInvocation } from "../src/discord-interactions";
import { ALL_SLASH_COMMAND_DEFINITIONS } from "../src/discord-commands";
import { handleEventsComponentInteraction } from "../src/runtime/events-interaction-handler";
import { handleApplicationCommand } from "../src/runtime/application-command-handler";
import { ALL_FEATURES_ENABLED } from "../src/runtime/features";

test("Event Team custom ids preserve opaque identifiers", () => {
  assert.deepEqual(parseEventCustomId("event:team-join:event-1:team:alpha"), {
    action: "team-join",
    eventId: "event-1",
    teamId: "team:alpha",
  });
  assert.deepEqual(parseEventCustomId("event:team-accept:event-1:proposal:1"), {
    action: "team-accept",
    eventId: "event-1",
    proposalId: "proposal:1",
  });
});

test("team Event messages expose aggregate roster state without identities", () => {
  const message = buildEventMessage(
    {
      guildId: "g",
      id: "event-1",
      templateId: null,
      title: "Scrim",
      description: "desc",
      status: "scheduled",
      channelId: "c",
      messageId: null,
      threadId: null,
      startsAtMs: 1_000,
      endsAtMs: null,
      signupCutoffAtMs: 500,
      signupMode: "single_choice",
      participationMode: "team",
      requiredTeamSize: 5,
      threadEnabled: false,
      waitlistedMembersJoinThread: false,
      groups: [],
      reminders: [],
      createdAtMs: 0,
      updatedAtMs: 0,
      publishedAtMs: null,
      cancelledAtMs: null,
      endedAtMs: null,
      archivedAtMs: null,
    },
    [],
    {
      teamCount: 2,
      readyTeamCount: 1,
      incompleteTeamCount: 1,
      unassignedCount: 2,
      assignedCount: 8,
      capacity: 10,
    },
  );
  const fields = (message.embeds?.[0] as any)?.fields ?? [];
  assert.match(fields.at(-1).value, /1 ready/);
  assert.match(fields.at(-1).value, /2 unassigned/);
  assert.doesNotMatch(fields.at(-1).value, /<@/);
  assert.ok(
    (message.components as any[]).some((row) =>
      row.components.some((component: any) => component.custom_id === "event:manage:event-1"),
    ),
  );
});

test("/event join-team parses the shared current-state command", () => {
  assert.deepEqual(
    extractCommandInvocation({
      data: {
        name: "event",
        options: [
          {
            name: "join-team",
            type: 1,
            options: [
              { name: "event_id", value: "event-1" },
              { name: "team_id", value: "team-1" },
            ],
          },
        ],
      },
    } as any),
    {
      commandName: "event",
      subcommandName: "join-team",
      eventId: "event-1",
      teamId: "team-1",
      groupId: undefined,
      name: undefined,
      proposalId: undefined,
      userId: undefined,
    },
  );
});

test("the Event fallback command exposes team lifecycle subcommands", () => {
  const definition = ALL_SLASH_COMMAND_DEFINITIONS.find((command) => command.name === "event");
  assert.ok(definition);
  assert.ok(definition.options?.some((option) => option.name === "create-team"));
  assert.ok(definition.options?.some((option) => option.name === "rename-team"));
  assert.ok(definition.options?.some((option) => option.name === "view-team"));
  assert.ok(definition.options?.some((option) => option.name === "leave-team"));
  assert.ok(definition.options?.some((option) => option.name === "transfer-captain"));
});

test("Event Team join button calls the matching service operation", async () => {
  let called: unknown;
  const response = await handleEventsComponentInteraction(
    {
      type: 3,
      guild_id: "guild-1",
      member: { user: { id: "user-1" } },
      data: { custom_id: "event:team-join:event-1:team-1" },
    },
    {
      eventsService: {
        createEventTeamJoinRequest: async (input: unknown) => {
          called = input;
        },
      } as any,
    },
  );
  assert.deepEqual(called, {
    guildId: "guild-1",
    eventId: "event-1",
    teamId: "team-1",
    userId: "user-1",
  });
  assert.match(await response.text(), /join request sent/i);
});

test("Event Team management button shows proposal IDs and role-appropriate actions", async () => {
  const response = await handleEventsComponentInteraction(
    {
      type: 3,
      guild_id: "guild-1",
      member: { user: { id: "user-1" } },
      data: { custom_id: "event:manage:event-1" },
    },
    {
      eventsService: {
        getEventTeamManagementView: async () => ({
          signups: [{}],
          teams: [],
          actionableProposals: [
            {
              id: "request-1",
              teamId: "team-1",
              kind: "join_request",
              requesterUserId: "user-1",
              targetUserId: "captain-1",
            },
            {
              id: "invite-1",
              teamId: "team-2",
              kind: "invitation",
              requesterUserId: "captain-2",
              targetUserId: "user-1",
            },
          ],
        }),
      } as any,
    },
  );

  const body = (await response.json()) as any;
  assert.match(body.data.content, /join_request · Team `team-1` · Proposal `request-1`/);
  assert.match(
    body.data.content,
    /`\/event withdraw-request event_id:event-1 proposal_id:request-1`/,
  );
  assert.match(body.data.content, /invitation · Team `team-2` · Proposal `invite-1`/);
  assert.match(
    body.data.content,
    /`\/event accept event_id:event-1 proposal_id:invite-1` or `\/event decline event_id:event-1 proposal_id:invite-1`/,
  );
  assert.ok(body.data.content.length <= 2_000);
});

test("/event manage shows proposal IDs and captain actions", async () => {
  const response = await handleApplicationCommand(
    {
      type: 2,
      guild_id: "guild-1",
      member: { user: { id: "captain-1" } },
      data: {
        name: "event",
        options: [
          {
            name: "manage",
            type: 1,
            options: [{ name: "event_id", value: "event-1" }],
          },
        ],
      },
    },
    {} as any,
    "bot-token",
    ALL_FEATURES_ENABLED,
    {
      services: {
        eventsService: {
          getEventTeamManagementView: async () => ({
            membership: { teamId: "team-1" },
            teams: [],
            actionableProposals: [
              {
                id: "request-1",
                teamId: "team-1",
                kind: "join_request",
                requesterUserId: "user-1",
                targetUserId: "captain-1",
              },
            ],
          }),
        } as any,
      },
    },
  );

  const body = (await response.json()) as any;
  assert.match(body.data.content, /join_request · Team `team-1` · Proposal `request-1`/);
  assert.match(
    body.data.content,
    /`\/event accept event_id:event-1 proposal_id:request-1` or `\/event reject-request event_id:event-1 proposal_id:request-1`/,
  );
  assert.ok(body.data.content.length <= 2_000);
});
