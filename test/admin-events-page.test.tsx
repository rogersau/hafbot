/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Tests compile via tsconfig.tests.json; admin React is excluded from the runtime test build.
import test from "node:test";
import { renderToString } from "react-dom/server";

import type { EventRecord, EventSignup } from "../src/types";
import {
  AdminEventsPage,
  formatDatetimeInput,
  parseLocalDatetime,
} from "../src/admin/components/admin-events-page";

function buildEvent(): EventRecord {
  const startsAtMs = new Date(2026, 6, 10, 19, 30).getTime();
  return {
    guildId: "guild-1",
    id: "event-1",
    templateId: null,
    title: "Friday night raid",
    description: "Bring your best build.",
    status: "scheduled",
    channelId: "channel-1",
    messageId: "message-1",
    threadId: null,
    startsAtMs,
    endsAtMs: startsAtMs + 2 * 60 * 60 * 1000,
    signupCutoffAtMs: startsAtMs,
    signupMode: "single_choice",
    participationMode: "individual",
    requiredTeamSize: null,
    threadEnabled: true,
    waitlistedMembersJoinThread: false,
    groups: [
      {
        id: "group-1",
        label: "Alpha squad",
        emoji: null,
        capacity: 4,
        waitlistEnabled: true,
        allowedRoleIds: [],
        blockedRoleIds: [],
        grantRoleId: null,
      },
    ],
    reminders: [],
    createdAtMs: startsAtMs - 1000,
    updatedAtMs: startsAtMs - 1000,
    publishedAtMs: startsAtMs - 1000,
    cancelledAtMs: null,
    endedAtMs: null,
    archivedAtMs: null,
  };
}

test("Event datetime inputs preserve the organizer's local wall-clock time", () => {
  const instant = new Date(2026, 6, 10, 19, 30).getTime();
  const input = formatDatetimeInput(instant);

  assert.equal(input, "2026-07-10T19:30");
  assert.equal(parseLocalDatetime(input), instant);
});

test("AdminEventsPage labels the local timezone and renders a compact message preview", () => {
  const event = buildEvent();
  const html = renderToString(
    <AdminEventsPage
      selectedWorkspaceId="workspace-1"
      selectedGuildId="guild-1"
      initialData={{
        guildId: "guild-1",
        templates: [],
        events: [
          {
            event,
            signups: [],
            teams: [],
            memberships: [],
            proposals: [],
            readiness: [],
            audit: [],
            snapshots: [],
            deliveries: [],
            integrityWarnings: [],
            expiredProposalCount: 0,
          },
        ],
      }}
    />,
  );

  assert.match(html, /Times shown in/);
  assert.doesNotMatch(html, /Start time \(UTC\)/);
  assert.match(html, /Message preview/);
  assert.match(html, /Friday night raid/);
  assert.match(html, /Alpha squad/);
  assert.match(html, /Leave event/);
  assert.match(html, /data-testid="event-discord-preview"/);
});

test("AdminEventsPage exposes team participation and required Event Team size", () => {
  const event = {
    ...buildEvent(),
    participationMode: "team" as const,
    requiredTeamSize: 6,
  };
  const team = {
    guildId: "guild-1",
    eventId: "event-1",
    id: "team-1",
    groupId: "group-1",
    name: "Night Owls",
    normalizedName: "night owls",
    captainUserId: "123456789012345678",
    openToRequests: false,
    status: "active" as const,
    createdByUserId: "123456789012345678",
    createdAtMs: event.createdAtMs,
    updatedAtMs: event.updatedAtMs,
    disbandedAtMs: null,
  };
  const html = renderToString(
    <AdminEventsPage
      selectedWorkspaceId="workspace-1"
      selectedGuildId="guild-1"
      initialData={{
        guildId: "guild-1",
        templates: [],
        events: [
          {
            event,
            signups: [],
            teams: [team],
            memberships: [],
            proposals: [
              {
                guildId: event.guildId,
                eventId: event.id,
                id: "proposal-1",
                teamId: team.id,
                kind: "invitation",
                requesterUserId: team.captainUserId,
                targetUserId: "223456789012345678",
                status: "pending",
                createdAtMs: event.createdAtMs,
                updatedAtMs: event.updatedAtMs,
                resolvedAtMs: null,
              },
            ],
            audit: [
              {
                guildId: event.guildId,
                eventId: event.id,
                id: "audit-1",
                actorUserId: "admin-1",
                action: "member.assigned",
                targetType: "member",
                targetId: "223456789012345678",
                prior: null,
                result: { teamId: team.id },
                occurredAtMs: event.updatedAtMs,
              },
            ],
            snapshots: [],
            deliveries: [
              {
                guildId: event.guildId,
                eventId: event.id,
                id: "delivery-1",
                kind: "notification",
                dedupeKey: "invite-1",
                payload: {},
                status: "failed",
                attemptCount: 5,
                maxAttempts: 5,
                lastError: "Discord unavailable",
                terminalFailureReason: "dm_forbidden",
                nextAttemptAtMs: event.updatedAtMs,
                createdAtMs: event.createdAtMs,
                updatedAtMs: event.updatedAtMs,
                deliveredAtMs: null,
              },
            ],
            integrityWarnings: ["Event Team captain is not an active member."],
            expiredProposalCount: 1,
            readiness: [
              {
                teamId: team.id,
                rosterCount: 0,
                confirmedCount: 0,
                openPlaces: 5,
                ready: false,
                reasons: ["roster_incomplete"],
              },
            ],
          },
        ],
      }}
    />,
  );

  assert.match(html, /Participation mode/);
  assert.match(html, /Required Event Team size/);
  assert.match(html, /does not divide evenly into Event Teams of 6/);
  assert.match(html, /Night Owls/);
  assert.match(html, /Unassigned pool/);
  assert.match(html, /Pending proposals/);
  assert.match(html, /Invitation/);
  assert.match(html, /Export CSV/);
  assert.match(html, /Delivery warnings/);
  assert.match(html, /Audit history/);
  assert.match(html, /Event Team captain is not an active member/);
  assert.match(html, /Expired proposals/);
  assert.match(html, /Bulk formation/);
  assert.match(html, /Generate preview/);
});

test("Events roster renders searchable responsive administration controls and capacity summary", () => {
  const event = buildEvent();
  const signup: EventSignup = {
    guildId: event.guildId,
    eventId: event.id,
    userId: "123456789012345678",
    groupId: "group-1",
    status: "confirmed",
    createdAtMs: Date.now() - 5 * 60 * 1000,
    updatedAtMs: Date.now() - 5 * 60 * 1000,
  };
  const html = renderToString(
    <AdminEventsPage
      selectedWorkspaceId="workspace-1"
      selectedGuildId="guild-1"
      initialData={{
        guildId: "guild-1",
        templates: [],
        events: [
          {
            event,
            signups: [signup],
            teams: [],
            memberships: [],
            proposals: [],
            readiness: [],
            audit: [],
            snapshots: [],
            deliveries: [],
            integrityWarnings: [],
            expiredProposalCount: 0,
          },
        ],
      }}
    />,
  );

  assert.match(html, /Search Discord user IDs/);
  assert.match(html, /Filter by Signup Group/);
  assert.match(html, /Total confirmed:/);
  assert.match(html, /Groups at capacity:/);
  assert.match(html, /Discord user ID/);
  assert.match(html, /Copy ID/);
  assert.match(html, /ago/);
});
