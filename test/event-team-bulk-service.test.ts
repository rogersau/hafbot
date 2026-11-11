import assert from "node:assert/strict";
import test from "node:test";

import {
  EventTeamBulkService,
  EventTeamBulkStalePreviewError,
  type EventTeamBulkStore,
} from "../src/services/event-team-bulk-service";
import type { EventRecord, EventSignup, EventTeam, EventTeamMembership } from "../src/types";

test("bulk preview isolates one group, fills partial teams, and prioritizes confirmed signups", async () => {
  const store = new BulkStore();
  store.signups = [
    signup("confirmed-1", "open", "confirmed", 1),
    signup("waitlisted-1", "open", "waitlisted", 2),
    signup("confirmed-2", "open", "confirmed", 3),
    signup("other-group-member", "open", "confirmed", 4),
    signup("other-group", "closed", "confirmed", 5),
  ];
  store.teams = [
    team("existing", "open", "captain"),
    team("closed-team", "closed", "closed-captain"),
  ];
  store.memberships = [
    membership("existing-member", "existing", "open", 1),
    membership("other-group-member", "closed-team", "closed", 1),
  ];

  const preview = await new EventTeamBulkService(store).preview({
    guildId: "guild-1",
    eventId: "event-1",
    groupId: "open",
    fillPartialTeams: true,
  });

  assert.equal(preview.proposals.length, 1);
  assert.deepEqual(preview.proposals[0], {
    existingTeamId: "existing",
    groupId: "open",
    name: "Existing",
    captainUserId: "captain",
    memberUserIds: ["existing-member", "confirmed-1", "confirmed-2"],
    addUserIds: ["confirmed-1", "confirmed-2"],
    incomplete: false,
  });
  assert.deepEqual(preview.unassignedUserIds, ["waitlisted-1"]);
  assert.ok(preview.revision.length > 0);
  assert.equal(preview.groupId, "open");
});

test("bulk preview leaves a short remainder unassigned unless incomplete teams are requested", async () => {
  const store = new BulkStore();
  store.signups = [
    signup("a", "open", "confirmed", 1),
    signup("b", "open", "confirmed", 2),
    signup("c", "open", "confirmed", 3),
    signup("d", "open", "confirmed", 4),
  ];
  const service = new EventTeamBulkService(store);

  const completeOnly = await service.preview({
    guildId: "guild-1",
    eventId: "event-1",
    groupId: "open",
  });
  assert.equal(completeOnly.proposals.length, 1);
  assert.deepEqual(completeOnly.unassignedUserIds, ["d"]);

  const withIncomplete = await service.preview({
    guildId: "guild-1",
    eventId: "event-1",
    groupId: "open",
    includeIncomplete: true,
  });
  assert.equal(withIncomplete.proposals.length, 2);
  assert.deepEqual(withIncomplete.proposals[1].memberUserIds, ["d"]);
  assert.deepEqual(withIncomplete.unassignedUserIds, []);
});

test("shuffle previews are deterministic and name/captain proposals are safe", async () => {
  const store = new BulkStore();
  store.teams = [team("team-1", "open", "existing-captain", "Team 1")];
  store.memberships = [
    membership("existing-1", "team-1", "open", 1),
    membership("existing-2", "team-1", "open", 2),
    membership("existing-3", "team-1", "open", 3),
  ];
  store.signups = [
    signup("u1", "open", "confirmed", 1),
    signup("u2", "open", "confirmed", 2),
    signup("u3", "open", "confirmed", 3),
  ];
  const service = new EventTeamBulkService(store);
  const input = {
    guildId: "guild-1",
    eventId: "event-1",
    groupId: "open",
    strategy: "shuffle" as const,
    seed: "stable-seed",
    namePrefix: "<Team>",
  };
  const first = await service.preview(input);
  const second = await service.preview(input);
  assert.deepEqual(first.proposals, second.proposals);
  assert.equal(first.proposals[0].name, "Team 2");
  assert.equal(first.proposals[0].captainUserId, "u1");
  assert.match(first.proposals[0].name, /^[A-Za-z0-9 _-]+$/);
});

test("commit revalidates the revision and delegates one atomic operation", async () => {
  const store = new BulkStore();
  store.signups = [signup("u1", "open", "confirmed", 1), signup("u2", "open", "confirmed", 2)];
  const service = new EventTeamBulkService(store);
  const preview = await service.preview({
    guildId: "guild-1",
    eventId: "event-1",
    groupId: "open",
  });

  store.signups[0] = { ...store.signups[0], updatedAtMs: 99 };
  await assert.rejects(
    () => service.commit(preview),
    (error: unknown) => error instanceof EventTeamBulkStalePreviewError,
  );
  assert.equal(store.commitCalls, 0);

  store.signups[0] = signup("u1", "open", "confirmed", 1);
  const fresh = await service.preview({ guildId: "guild-1", eventId: "event-1", groupId: "open" });
  await service.commit(fresh);
  assert.equal(store.commitCalls, 1);
  assert.equal(store.partialResults.length, 0);
});

test("atomic dependency failure does not expose or record a partial result", async () => {
  const store = new BulkStore();
  store.signups = [signup("u1", "open", "confirmed", 1), signup("u2", "open", "confirmed", 2)];
  store.failCommit = true;
  const service = new EventTeamBulkService(store);
  const preview = await service.preview({
    guildId: "guild-1",
    eventId: "event-1",
    groupId: "open",
  });

  await assert.rejects(() => service.commit(preview), /atomic bulk commit failed/);
  assert.equal(store.commitCalls, 1);
  assert.deepEqual(store.partialResults, []);
});

function signup(
  userId: string,
  groupId: string,
  status: EventSignup["status"],
  createdAtMs: number,
): EventSignup {
  return {
    guildId: "guild-1",
    eventId: "event-1",
    userId,
    groupId,
    status,
    createdAtMs,
    updatedAtMs: createdAtMs,
  };
}

function team(id: string, groupId: string, captainUserId: string, name = "Existing"): EventTeam {
  return {
    guildId: "guild-1",
    eventId: "event-1",
    id,
    groupId,
    name,
    normalizedName: name.toLowerCase(),
    captainUserId,
    openToRequests: false,
    status: "active",
    createdByUserId: captainUserId,
    createdAtMs: 1,
    updatedAtMs: 1,
    disbandedAtMs: null,
  };
}

function membership(
  userId: string,
  teamId: string,
  groupId: string,
  joinedAtMs: number,
): EventTeamMembership {
  return {
    guildId: "guild-1",
    eventId: "event-1",
    id: `membership-${userId}`,
    teamId,
    groupId,
    userId,
    joinedAtMs,
    leftAtMs: null,
  };
}

class BulkStore implements EventTeamBulkStore {
  event: EventRecord = {
    guildId: "guild-1",
    id: "event-1",
    templateId: null,
    title: "Event",
    description: "",
    status: "scheduled",
    channelId: "channel",
    messageId: null,
    threadId: null,
    startsAtMs: 1,
    endsAtMs: null,
    signupCutoffAtMs: 1,
    signupMode: "single_choice",
    participationMode: "team",
    requiredTeamSize: 3,
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
      {
        id: "closed",
        label: "Closed",
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
    publishedAtMs: null,
    cancelledAtMs: null,
    endedAtMs: null,
    archivedAtMs: null,
  };
  signups: EventSignup[] = [];
  teams: EventTeam[] = [];
  memberships: EventTeamMembership[] = [];
  commitCalls = 0;
  failCommit = false;
  partialResults: unknown[] = [];

  async readEvent(): Promise<EventRecord | null> {
    return this.event;
  }
  async listSignups(): Promise<EventSignup[]> {
    return this.signups;
  }
  async listEventTeams(): Promise<EventTeam[]> {
    return this.teams;
  }
  async listActiveEventTeamMemberships(): Promise<EventTeamMembership[]> {
    return this.memberships;
  }
  async commitEventTeamBulkFormation(): Promise<unknown> {
    this.commitCalls += 1;
    if (this.failCommit) throw new Error("atomic bulk commit failed");
    return { committed: true };
  }
}
