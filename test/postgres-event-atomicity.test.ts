import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresEventStore } from "../src/runtime/postgres/postgres-event-store";
import {
  EventTeamBulkService,
  EventTeamBulkStalePreviewError,
} from "../src/services/event-team-bulk-service";
import type {
  EventLifecycleHistoryRecord,
  EventRecord,
  EventSignup,
  EventTeam,
  EventTeamAuditRecord,
  EventTeamDeliveryOutboxRecord,
  EventTeamMembership,
  EventTeamProposal,
  EventTeamRosterSnapshot,
} from "../src/types";
import { withFreshPostgres } from "./support/postgres";

test("PostgreSQL Event Team creation, membership, and disband roll back late audit and outbox failures and retry coherently", async () => {
  await withFreshPostgres(async (database) => {
    const store = createPostgresEventStore(database);
    const guildId = "guild-p04-team";
    const eventId = "event-p04-team";
    const event = createTeamEvent(guildId, eventId, { requiredTeamSize: 4 });
    await store.createEvent(event);
    for (const userId of ["captain-1", "member-1", "member-2"])
      await store.upsertSignup(createSignup(guildId, eventId, userId));

    const baselineVersion = await store.readEventTeamStateVersion(guildId, eventId);
    const duplicateAudit = createAudit(guildId, eventId, {
      id: "audit-preexisting",
      action: "team.preexisting",
    });
    await store.appendEventTeamAudit(duplicateAudit);

    const team = createTeam(guildId, eventId);
    const captainMembership = createMembership(guildId, eventId, {
      id: "membership-captain",
      teamId: team.id,
      userId: "captain-1",
    });
    await assert.rejects(
      store.commitEventTeamMutation({
        mutation: { kind: "create_team", team, membership: captainMembership },
        audit: { ...duplicateAudit, action: "team.created" },
        deliveries: [
          createDelivery(guildId, eventId, "canonical:event-p04-team", "canonical_refresh"),
        ],
      }),
      matchesError(/duplicate key|event_team_audit_records_pkey/i),
    );
    assert.deepEqual(await store.listEventTeams(guildId, eventId), []);
    assert.deepEqual(await store.listActiveEventTeamMemberships(guildId, eventId), []);
    assert.equal((await store.listSignups(guildId, eventId)).length, 3);
    assert.equal(await store.readEventTeamStateVersion(guildId, eventId), baselineVersion);
    assert.equal((await store.listEventTeamAudit({ guildId, eventId })).length, 1);
    assert.deepEqual(await store.listEventTeamDeliveries({ guildId, eventId }), []);

    await store.commitEventTeamMutation({
      mutation: { kind: "create_team", team, membership: captainMembership },
      audit: createAudit(guildId, eventId, { id: "audit-create", action: "team.created" }),
      deliveries: [
        createDelivery(guildId, eventId, "canonical:event-p04-team", "canonical_refresh"),
      ],
    });
    assert.deepEqual(
      (await store.listEventTeams(guildId, eventId)).map((saved) => saved.id),
      [team.id],
    );
    assert.deepEqual(
      (await store.listActiveEventTeamMemberships(guildId, eventId)).map(
        (membership) => membership.userId,
      ),
      ["captain-1"],
    );
    const afterCreateVersion = baselineVersion + 1;
    assert.equal(await store.readEventTeamStateVersion(guildId, eventId), afterCreateVersion);
    assert.equal((await store.listEventTeamAudit({ guildId, eventId })).length, 2);
    assert.equal((await store.listEventTeamDeliveries({ guildId, eventId })).length, 1);

    const memberOneMembership = createMembership(guildId, eventId, {
      id: "membership-member-1",
      teamId: team.id,
      userId: "member-1",
      joinedAtMs: 700,
    });
    await assert.rejects(
      store.commitEventTeamMutation({
        mutation: { kind: "add_membership", membership: memberOneMembership },
        audit: createAudit(guildId, eventId, {
          id: "audit-add-member-rollback",
          action: "member.added",
        }),
        deliveries: [
          {
            ...createDelivery(guildId, eventId, "member.added:member-1", "notification", 700),
            kind: "unsupported" as EventTeamDeliveryOutboxRecord["kind"],
          },
        ],
      }),
      matchesError(/event_team_delivery_outbox_kind_check|violates check constraint/i),
    );
    assert.deepEqual(
      (await store.listActiveEventTeamMemberships(guildId, eventId)).map(
        (membership) => membership.userId,
      ),
      ["captain-1"],
    );
    assert.equal(await store.readEventTeamStateVersion(guildId, eventId), afterCreateVersion);
    assert.equal((await store.listEventTeamAudit({ guildId, eventId })).length, 2);
    assert.equal((await store.listEventTeamDeliveries({ guildId, eventId })).length, 1);

    await store.commitEventTeamMutation({
      mutation: { kind: "add_membership", membership: memberOneMembership },
      audit: createAudit(guildId, eventId, { id: "audit-add-member", action: "member.added" }),
      deliveries: [createDelivery(guildId, eventId, "member.added:member-1", "notification", 700)],
    });
    assert.deepEqual(
      (await store.listActiveEventTeamMemberships(guildId, eventId)).map(
        (membership) => membership.userId,
      ),
      ["captain-1", "member-1"],
    );
    const afterAddVersion = afterCreateVersion + 1;
    assert.equal(await store.readEventTeamStateVersion(guildId, eventId), afterAddVersion);
    assert.equal((await store.listEventTeamAudit({ guildId, eventId })).length, 3);
    assert.equal((await store.listEventTeamDeliveries({ guildId, eventId })).length, 2);

    const pending = createProposal(guildId, eventId, {
      id: "proposal-p04-team",
      teamId: team.id,
      requesterUserId: "member-2",
      targetUserId: "captain-1",
    });
    await store.createEventTeamProposal(pending);
    const activeMemberships = await store.listActiveEventTeamMemberships(guildId, eventId);
    const memberOneSignup = (await store.listUserSignups(guildId, eventId, "member-1"))[0]!;
    const disbandedTeam = {
      ...team,
      status: "disbanded" as const,
      openToRequests: false,
      updatedAtMs: 900,
      disbandedAtMs: 900,
    };
    await assert.rejects(
      store.commitEventTeamDisband({
        team: disbandedTeam,
        membershipIds: activeMemberships.map((membership) => membership.id),
        leftAtMs: 900,
        cancelPendingProposals: true,
        deleteSignup: memberOneSignup,
        audit: createAudit(guildId, eventId, { id: "audit-create", action: "team.disbanded" }),
        deliveries: [
          createDelivery(
            guildId,
            eventId,
            "canonical:event-p04-team:disband",
            "canonical_refresh",
            900,
          ),
        ],
      }),
      matchesError(/duplicate key|event_team_audit_records_pkey/i),
    );
    assert.equal((await store.listEventTeams(guildId, eventId))[0]?.status, "active");
    assert.deepEqual(
      (await store.listActiveEventTeamMemberships(guildId, eventId)).map(
        (membership) => membership.userId,
      ),
      ["captain-1", "member-1"],
    );
    assert.equal(
      (await store.readEventTeamProposal(guildId, eventId, pending.id))?.status,
      "pending",
    );
    assert.equal((await store.listUserSignups(guildId, eventId, "member-1")).length, 1);
    assert.equal(await store.readEventTeamStateVersion(guildId, eventId), afterAddVersion);
    assert.equal((await store.listEventTeamAudit({ guildId, eventId })).length, 3);
    assert.equal((await store.listEventTeamDeliveries({ guildId, eventId })).length, 2);

    await store.commitEventTeamDisband({
      team: disbandedTeam,
      membershipIds: activeMemberships.map((membership) => membership.id),
      leftAtMs: 900,
      cancelPendingProposals: true,
      deleteSignup: memberOneSignup,
      audit: createAudit(guildId, eventId, { id: "audit-disband", action: "team.disbanded" }),
      deliveries: [
        createDelivery(
          guildId,
          eventId,
          "canonical:event-p04-team:disband",
          "canonical_refresh",
          900,
        ),
        createDelivery(guildId, eventId, "team.disbanded:captain-1", "notification", 900),
      ],
    });
    const savedTeam = (await store.listEventTeams(guildId, eventId))[0]!;
    assert.equal(savedTeam.status, "disbanded");
    assert.equal(savedTeam.disbandedAtMs, 900);
    assert.deepEqual(await store.listActiveEventTeamMemberships(guildId, eventId), []);
    const cancelled = (await store.readEventTeamProposal(guildId, eventId, pending.id))!;
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.resolvedAtMs, 900);
    assert.deepEqual(await store.listUserSignups(guildId, eventId, "member-1"), []);
    assert.equal((await store.listUserSignups(guildId, eventId, "captain-1")).length, 1);
    assert.equal(await store.readEventTeamStateVersion(guildId, eventId), afterAddVersion + 1);
    assert.equal((await store.listEventTeamAudit({ guildId, eventId })).length, 4);
    assert.equal((await store.listEventTeamDeliveries({ guildId, eventId })).length, 4);
  });
});

test("PostgreSQL Event Team writes enforce active-member and name uniqueness without rejecting independent valid writes", async () => {
  await withFreshPostgres(async (database) => {
    const store = createPostgresEventStore(database);
    const guildId = "guild-p04-team-race";
    const eventId = "event-p04-team-race";
    await store.createEvent(createTeamEvent(guildId, eventId, { requiredTeamSize: 4 }));
    for (const userId of ["captain-a", "captain-b", "captain-c", "captain-d", "member-x"])
      await store.upsertSignup(createSignup(guildId, eventId, userId));
    const baselineVersion = await store.readEventTeamStateVersion(guildId, eventId);

    const sameNameTeams = [
      createTeam(guildId, eventId, {
        id: "team-name-a",
        name: "Night Owls",
        normalizedName: "night owls",
        captainUserId: "captain-a",
        createdByUserId: "captain-a",
      }),
      createTeam(guildId, eventId, {
        id: "team-name-b",
        name: "night owls",
        normalizedName: "night owls",
        captainUserId: "captain-b",
        createdByUserId: "captain-b",
      }),
    ];
    const sameNameResults = await Promise.allSettled(
      sameNameTeams.map((team, index) =>
        store.commitEventTeamMutation({
          mutation: {
            kind: "create_team",
            team,
            membership: createMembership(guildId, eventId, {
              id: `membership-name-${index}`,
              teamId: team.id,
              userId: team.captainUserId,
            }),
          },
          audit: createAudit(guildId, eventId, {
            id: `audit-name-${index}`,
            action: "team.created",
            targetId: team.id,
          }),
          deliveries: [
            createDelivery(
              guildId,
              eventId,
              `canonical:event-p04-team-race:${index}`,
              "canonical_refresh",
            ),
          ],
        }),
      ),
    );
    assert.equal(sameNameResults.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(sameNameResults.filter((result) => result.status === "rejected").length, 1);
    assert.equal((await store.listEventTeams(guildId, eventId)).length, 1);
    assert.equal((await store.listActiveEventTeamMemberships(guildId, eventId)).length, 1);
    assert.equal(await store.readEventTeamStateVersion(guildId, eventId), baselineVersion + 1);

    const independentTeams = [
      createTeam(guildId, eventId, {
        id: "team-alpha",
        name: "Alpha",
        normalizedName: "alpha",
        captainUserId: "captain-c",
        createdByUserId: "captain-c",
      }),
      createTeam(guildId, eventId, {
        id: "team-beta",
        name: "Beta",
        normalizedName: "beta",
        captainUserId: "captain-d",
        createdByUserId: "captain-d",
      }),
    ];
    const independentResults = await Promise.allSettled(
      independentTeams.map((team, index) =>
        store.commitEventTeamMutation({
          mutation: {
            kind: "create_team",
            team,
            membership: createMembership(guildId, eventId, {
              id: `membership-independent-${index}`,
              teamId: team.id,
              userId: team.captainUserId,
            }),
          },
          audit: createAudit(guildId, eventId, {
            id: `audit-independent-${index}`,
            action: "team.created",
            targetId: team.id,
          }),
          deliveries: [],
        }),
      ),
    );
    assert.deepEqual(
      independentResults.map((result) => result.status),
      ["fulfilled", "fulfilled"],
    );
    assert.equal((await store.listEventTeams(guildId, eventId)).length, 3);
    assert.equal((await store.listActiveEventTeamMemberships(guildId, eventId)).length, 3);
    const afterIndependentVersion = baselineVersion + 3;
    assert.equal(await store.readEventTeamStateVersion(guildId, eventId), afterIndependentVersion);

    const alpha = (await store.listEventTeams(guildId, eventId)).find(
      (team) => team.id === "team-alpha",
    )!;
    const beta = (await store.listEventTeams(guildId, eventId)).find(
      (team) => team.id === "team-beta",
    )!;
    const sameUserResults = await Promise.allSettled([
      store.commitEventTeamMutation({
        mutation: {
          kind: "add_membership",
          membership: createMembership(guildId, eventId, {
            id: "membership-member-x-alpha",
            teamId: alpha.id,
            userId: "member-x",
            joinedAtMs: 800,
          }),
        },
        audit: createAudit(guildId, eventId, {
          id: "audit-member-x-alpha",
          action: "member.added",
          targetId: alpha.id,
        }),
        deliveries: [],
      }),
      store.commitEventTeamMutation({
        mutation: {
          kind: "add_membership",
          membership: createMembership(guildId, eventId, {
            id: "membership-member-x-beta",
            teamId: beta.id,
            userId: "member-x",
            joinedAtMs: 801,
          }),
        },
        audit: createAudit(guildId, eventId, {
          id: "audit-member-x-beta",
          action: "member.added",
          targetId: beta.id,
        }),
        deliveries: [],
      }),
    ]);
    assert.equal(sameUserResults.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(sameUserResults.filter((result) => result.status === "rejected").length, 1);
    assert.equal(
      (await store.listActiveEventTeamMemberships(guildId, eventId)).filter(
        (membership) => membership.userId === "member-x",
      ).length,
      1,
    );
    assert.equal(
      await store.readEventTeamStateVersion(guildId, eventId),
      afterIndependentVersion + 1,
    );
  });
});

test("PostgreSQL proposal acceptance admits one competing winner and rolls back a late outbox failure", async () => {
  await withFreshPostgres(async (database) => {
    const store = createPostgresEventStore(database);
    const guildId = "guild-p04-proposal";
    const eventId = "event-p04-proposal";
    const event = createTeamEvent(guildId, eventId, { requiredTeamSize: 4 });
    await store.createEvent(event);
    for (const userId of ["captain-1", "member-1", "member-2", "member-3", "member-4"])
      await store.upsertSignup(createSignup(guildId, eventId, userId));
    const team = createTeam(guildId, eventId);
    await store.commitEventTeamMutation({
      mutation: {
        kind: "create_team",
        team,
        membership: createMembership(guildId, eventId, {
          id: "membership-proposal-captain",
          teamId: team.id,
          userId: "captain-1",
        }),
      },
      audit: createAudit(guildId, eventId, {
        id: "audit-proposal-captain",
        action: "team.created",
      }),
      deliveries: [],
    });

    const first = createProposal(guildId, eventId, {
      id: "proposal-first",
      teamId: team.id,
      requesterUserId: "member-1",
      targetUserId: "captain-1",
    });
    const competing = createProposal(guildId, eventId, {
      id: "proposal-competing",
      teamId: team.id,
      requesterUserId: "member-2",
      targetUserId: "captain-1",
      createdAtMs: 210,
      updatedAtMs: 210,
    });
    await store.createEventTeamProposal(first);
    await store.createEventTeamProposal(competing);
    const beforeFirstVersion = await store.readEventTeamStateVersion(guildId, eventId);
    const firstSignup = (await store.listUserSignups(guildId, eventId, "member-1"))[0]!;
    await store.acceptEventTeamProposalAtomic({
      proposal: { ...first, status: "accepted", updatedAtMs: 300, resolvedAtMs: 300 },
      membership: createMembership(guildId, eventId, {
        id: "membership-member-1",
        teamId: team.id,
        userId: "member-1",
        joinedAtMs: 300,
      }),
      signup: firstSignup,
      cancelProposalIds: [competing.id],
      audit: createAudit(guildId, eventId, {
        id: "audit-accept-first",
        action: "proposal.accepted",
        targetType: "proposal",
        targetId: first.id,
      }),
      deliveries: [
        createDelivery(guildId, eventId, "proposal.accepted:proposal-first", "notification", 300),
      ],
    });
    const acceptedFirst = (await store.readEventTeamProposal(guildId, eventId, first.id))!;
    assert.equal(acceptedFirst.status, "accepted");
    assert.equal(acceptedFirst.resolvedAtMs, 300);
    const cancelledCompeting = (await store.readEventTeamProposal(guildId, eventId, competing.id))!;
    assert.equal(cancelledCompeting.status, "cancelled");
    assert.equal(cancelledCompeting.resolvedAtMs, 300);
    const memberOneMemberships = (
      await store.listActiveEventTeamMemberships(guildId, eventId)
    ).filter((membership) => membership.userId === "member-1");
    assert.equal(memberOneMemberships.length, 1);
    assert.equal(memberOneMemberships[0]!.teamId, team.id);
    assert.equal(memberOneMemberships[0]!.groupId, team.groupId);
    assert.deepEqual(await store.listUserSignups(guildId, eventId, "member-1"), [firstSignup]);
    assert.equal((await store.listEventTeamAudit({ guildId, eventId })).length, 2);
    assert.equal((await store.listEventTeamDeliveries({ guildId, eventId })).length, 1);
    assert.equal(await store.readEventTeamStateVersion(guildId, eventId), beforeFirstVersion + 1);

    const raced = createProposal(guildId, eventId, {
      id: "proposal-raced",
      teamId: team.id,
      requesterUserId: "member-3",
      targetUserId: "captain-1",
      createdAtMs: 400,
      updatedAtMs: 400,
    });
    await store.createEventTeamProposal(raced);
    const memberThreeSignup = (await store.listUserSignups(guildId, eventId, "member-3"))[0]!;
    const beforeRaceVersion = await store.readEventTeamStateVersion(guildId, eventId);
    const raceInput = {
      proposal: { ...raced, status: "accepted" as const, updatedAtMs: 500, resolvedAtMs: 500 },
      membership: createMembership(guildId, eventId, {
        id: "membership-member-3",
        teamId: team.id,
        userId: "member-3",
        joinedAtMs: 500,
      }),
      signup: memberThreeSignup,
      cancelProposalIds: [],
      audit: createAudit(guildId, eventId, {
        id: "audit-accept-raced",
        action: "proposal.accepted",
        targetType: "proposal",
        targetId: raced.id,
      }),
      deliveries: [
        createDelivery(guildId, eventId, "proposal.accepted:proposal-raced", "notification", 500),
      ],
    };
    const raceResults = await Promise.allSettled([
      store.acceptEventTeamProposalAtomic(raceInput),
      store.acceptEventTeamProposalAtomic(raceInput),
    ]);
    assert.equal(raceResults.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(raceResults.filter((result) => result.status === "rejected").length, 1);
    const acceptedRaced = (await store.readEventTeamProposal(guildId, eventId, raced.id))!;
    assert.equal(acceptedRaced.status, "accepted");
    assert.equal(acceptedRaced.updatedAtMs, 500);
    assert.equal(
      (await store.listActiveEventTeamMemberships(guildId, eventId)).filter(
        (membership) => membership.userId === "member-3",
      ).length,
      1,
    );
    assert.deepEqual(await store.listUserSignups(guildId, eventId, "member-3"), [
      memberThreeSignup,
    ]);
    assert.equal((await store.listEventTeamAudit({ guildId, eventId })).length, 3);
    assert.equal((await store.listEventTeamDeliveries({ guildId, eventId })).length, 2);
    assert.equal(await store.readEventTeamStateVersion(guildId, eventId), beforeRaceVersion + 1);

    const rollbackProposal = createProposal(guildId, eventId, {
      id: "proposal-rollback",
      teamId: team.id,
      requesterUserId: "member-4",
      targetUserId: "captain-1",
      createdAtMs: 600,
      updatedAtMs: 600,
    });
    await store.createEventTeamProposal(rollbackProposal);
    const memberFourSignup = (await store.listUserSignups(guildId, eventId, "member-4"))[0]!;
    const beforeRollbackVersion = await store.readEventTeamStateVersion(guildId, eventId);
    const auditCountBeforeRollback = (await store.listEventTeamAudit({ guildId, eventId })).length;
    const deliveryCountBeforeRollback = (await store.listEventTeamDeliveries({ guildId, eventId }))
      .length;
    await assert.rejects(
      store.acceptEventTeamProposalAtomic({
        proposal: {
          ...rollbackProposal,
          status: "accepted",
          updatedAtMs: 700,
          resolvedAtMs: 700,
        },
        membership: createMembership(guildId, eventId, {
          id: "membership-member-4",
          teamId: team.id,
          userId: "member-4",
          joinedAtMs: 700,
        }),
        signup: memberFourSignup,
        cancelProposalIds: [],
        audit: createAudit(guildId, eventId, {
          id: "audit-accept-rollback-failed",
          action: "proposal.accepted",
          targetType: "proposal",
          targetId: rollbackProposal.id,
        }),
        deliveries: [
          {
            ...createDelivery(
              guildId,
              eventId,
              "proposal.accepted:proposal-rollback",
              "notification",
              700,
            ),
            kind: "unsupported" as EventTeamDeliveryOutboxRecord["kind"],
          },
        ],
      }),
      matchesError(/event_team_delivery_outbox_kind_check|violates check constraint/i),
    );
    const stillPending = (await store.readEventTeamProposal(
      guildId,
      eventId,
      rollbackProposal.id,
    ))!;
    assert.equal(stillPending.status, "pending");
    assert.equal(stillPending.updatedAtMs, rollbackProposal.updatedAtMs);
    assert.equal(stillPending.resolvedAtMs, null);
    assert.equal(
      (await store.listActiveEventTeamMemberships(guildId, eventId)).some(
        (membership) => membership.userId === "member-4",
      ),
      false,
    );
    assert.deepEqual(await store.listUserSignups(guildId, eventId, "member-4"), [memberFourSignup]);
    assert.equal(await store.readEventTeamStateVersion(guildId, eventId), beforeRollbackVersion);
    assert.equal(
      (await store.listEventTeamAudit({ guildId, eventId })).length,
      auditCountBeforeRollback,
    );
    assert.equal(
      (await store.listEventTeamDeliveries({ guildId, eventId })).length,
      deliveryCountBeforeRollback,
    );

    await store.acceptEventTeamProposalAtomic({
      proposal: { ...rollbackProposal, status: "accepted", updatedAtMs: 700, resolvedAtMs: 700 },
      membership: createMembership(guildId, eventId, {
        id: "membership-member-4",
        teamId: team.id,
        userId: "member-4",
        joinedAtMs: 700,
      }),
      signup: memberFourSignup,
      cancelProposalIds: [],
      audit: createAudit(guildId, eventId, {
        id: "audit-accept-rollback",
        action: "proposal.accepted",
        targetType: "proposal",
        targetId: rollbackProposal.id,
      }),
      deliveries: [
        createDelivery(
          guildId,
          eventId,
          "proposal.accepted:proposal-rollback",
          "notification",
          700,
        ),
      ],
    });
    assert.equal(
      (await store.readEventTeamProposal(guildId, eventId, rollbackProposal.id))?.status,
      "accepted",
    );
    assert.equal(
      (await store.listActiveEventTeamMemberships(guildId, eventId)).filter(
        (membership) => membership.userId === "member-4",
      ).length,
      1,
    );
    assert.equal(
      (await store.listEventTeamAudit({ guildId, eventId })).length,
      auditCountBeforeRollback + 1,
    );
    assert.equal(
      (await store.listEventTeamDeliveries({ guildId, eventId })).length,
      deliveryCountBeforeRollback + 1,
    );
    assert.equal(
      await store.readEventTeamStateVersion(guildId, eventId),
      beforeRollbackVersion + 1,
    );
  });
});

test("PostgreSQL lifecycle transitions fence competing and stale versions while committing history and snapshots atomically", async () => {
  await withFreshPostgres(async (database) => {
    const store = createPostgresEventStore(database);
    const guildId = "guild-p04-lifecycle";
    const eventId = "event-p04-lifecycle";
    const event = createTeamEvent(guildId, eventId, { requiredTeamSize: 2 });
    await store.createEvent(event);
    await store.upsertSignup(createSignup(guildId, eventId, "captain-1"));
    const team = createTeam(guildId, eventId);
    const captainMembership = createMembership(guildId, eventId, {
      id: "membership-lifecycle-captain",
      teamId: team.id,
      userId: "captain-1",
    });
    await store.commitEventTeamMutation({
      mutation: { kind: "create_team", team, membership: captainMembership },
      audit: createAudit(guildId, eventId, { id: "audit-lifecycle", action: "team.created" }),
      deliveries: [],
    });
    const stateVersion = await store.readEventTeamStateVersion(guildId, eventId);
    const seededHistory = createHistory(guildId, eventId, {
      id: "history-seeded",
      fromStatus: null,
      toStatus: "scheduled",
      occurredAtMs: 900,
    });
    await store.appendEventLifecycleHistory(seededHistory);
    const liveSnapshot = createSnapshot(guildId, eventId, {
      teamId: team.id,
      requiredTeamSize: 2,
      members: [
        {
          membershipId: captainMembership.id,
          userId: "captain-1",
          groupId: team.groupId,
          signupStatus: "confirmed",
        },
      ],
      capturedAtMs: 1_100,
    });

    await assert.rejects(
      store.commitEventLifecycleTransition({
        event: { ...event, status: "live", updatedAtMs: 1_000 },
        history: {
          ...seededHistory,
          fromStatus: "scheduled",
          toStatus: "live",
          occurredAtMs: 1_000,
        },
        snapshots: [liveSnapshot],
        expectedStatus: "scheduled",
        expectedStateVersion: stateVersion,
      }),
      matchesError(/duplicate key|event_lifecycle_history_pkey/i),
    );
    assert.equal((await store.readEvent(guildId, eventId))?.status, "scheduled");
    assert.deepEqual(
      (await store.listEventLifecycleHistory(guildId, eventId)).map((history) => history.id),
      [seededHistory.id],
    );
    assert.deepEqual(await store.listEventTeamRosterSnapshots(guildId, eventId), []);
    assert.equal(await store.readEventTeamStateVersion(guildId, eventId), stateVersion);

    await database.execute(`
      CREATE FUNCTION haf_test_fail_event_team_roster_snapshot() RETURNS trigger
          LANGUAGE plpgsql
          AS $$
      BEGIN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'forced Event Team roster snapshot failure';
      END;
      $$;
    `);
    await database.execute(`
      CREATE TRIGGER haf_test_fail_event_team_roster_snapshot
          BEFORE INSERT ON public.event_team_roster_snapshots
          FOR EACH ROW
          WHEN (NEW.guild_id = '${guildId}' AND NEW.team_id = 'team-snapshot-fail')
          EXECUTE FUNCTION haf_test_fail_event_team_roster_snapshot();
    `);
    try {
      await assert.rejects(
        store.commitEventLifecycleTransition({
          event: { ...event, status: "live", updatedAtMs: 1_050 },
          history: createHistory(guildId, eventId, {
            id: "history-snapshot-fail",
            fromStatus: "scheduled",
            toStatus: "live",
            occurredAtMs: 1_050,
          }),
          snapshots: [
            createSnapshot(guildId, eventId, {
              teamId: "team-snapshot-fail",
              requiredTeamSize: 2,
              members: [],
              capturedAtMs: 1_050,
            }),
          ],
          expectedStatus: "scheduled",
          expectedStateVersion: stateVersion,
        }),
        matchesError(/forced Event Team roster snapshot failure/),
      );
    } finally {
      await database.execute(
        "DROP TRIGGER IF EXISTS haf_test_fail_event_team_roster_snapshot ON public.event_team_roster_snapshots",
      );
      await database.execute("DROP FUNCTION IF EXISTS haf_test_fail_event_team_roster_snapshot()");
    }
    assert.equal((await store.readEvent(guildId, eventId))?.status, "scheduled");
    assert.deepEqual(
      (await store.listEventLifecycleHistory(guildId, eventId)).map((history) => history.id),
      [seededHistory.id],
    );
    assert.deepEqual(await store.listEventTeamRosterSnapshots(guildId, eventId), []);
    assert.equal(await store.readEventTeamStateVersion(guildId, eventId), stateVersion);

    await store.commitEventLifecycleTransition({
      event: { ...event, status: "live", updatedAtMs: 1_200, publishedAtMs: 1_200 },
      history: createHistory(guildId, eventId, {
        id: "history-live",
        fromStatus: "scheduled",
        toStatus: "live",
        occurredAtMs: 1_200,
      }),
      snapshots: [liveSnapshot],
      expectedStatus: "scheduled",
      expectedStateVersion: stateVersion,
    });
    const liveEvent = (await store.readEvent(guildId, eventId))!;
    assert.equal(liveEvent.status, "live");
    assert.equal(liveEvent.updatedAtMs, 1_200);
    assert.deepEqual(
      (await store.listEventLifecycleHistory(guildId, eventId)).map((history) => history.id),
      [seededHistory.id, "history-live"],
    );
    assert.deepEqual(await store.listEventTeamRosterSnapshots(guildId, eventId), [liveSnapshot]);
    assert.equal(await store.readEventTeamStateVersion(guildId, eventId), stateVersion);

    await assert.rejects(
      store.commitEventLifecycleTransition({
        event: { ...event, status: "cancelled", cancelledAtMs: 1_300, updatedAtMs: 1_300 },
        history: createHistory(guildId, eventId, {
          id: "history-stale-cancel",
          fromStatus: "scheduled",
          toStatus: "cancelled",
          occurredAtMs: 1_300,
        }),
        snapshots: [],
        expectedStatus: "scheduled",
        expectedStateVersion: stateVersion,
      }),
      matchesError(/lifecycle state or Team roster changed concurrently/),
    );
    assert.equal((await store.readEvent(guildId, eventId))?.status, "live");
    assert.deepEqual(
      (await store.listEventLifecycleHistory(guildId, eventId)).map((history) => history.id),
      [seededHistory.id, "history-live"],
    );
    assert.deepEqual(await store.listEventTeamRosterSnapshots(guildId, eventId), [liveSnapshot]);

    const competingEvent = createTeamEvent(guildId, "event-p04-lifecycle-race");
    await store.createEvent(competingEvent);
    const competingVersion = await store.readEventTeamStateVersion(guildId, competingEvent.id);
    const competingResults = await Promise.allSettled([
      store.commitEventLifecycleTransition({
        event: { ...competingEvent, status: "live", updatedAtMs: 2_000 },
        history: createHistory(guildId, competingEvent.id, {
          id: "history-competing-live",
          fromStatus: "scheduled",
          toStatus: "live",
          occurredAtMs: 2_000,
        }),
        snapshots: [
          createSnapshot(guildId, competingEvent.id, {
            teamId: "team-competing",
            requiredTeamSize: 2,
            members: [],
            capturedAtMs: 2_000,
          }),
        ],
        expectedStatus: "scheduled",
        expectedStateVersion: competingVersion,
      }),
      store.commitEventLifecycleTransition({
        event: {
          ...competingEvent,
          status: "cancelled",
          cancelledAtMs: 2_001,
          updatedAtMs: 2_001,
        },
        history: createHistory(guildId, competingEvent.id, {
          id: "history-competing-cancelled",
          fromStatus: "scheduled",
          toStatus: "cancelled",
          occurredAtMs: 2_001,
        }),
        snapshots: [],
        expectedStatus: "scheduled",
        expectedStateVersion: competingVersion,
      }),
    ]);
    assert.equal(competingResults.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(competingResults.filter((result) => result.status === "rejected").length, 1);
    const competingStatus = (await store.readEvent(guildId, competingEvent.id))!.status;
    assert.ok(competingStatus === "live" || competingStatus === "cancelled");
    const competingHistory = await store.listEventLifecycleHistory(guildId, competingEvent.id);
    assert.equal(competingHistory.length, 1);
    assert.equal(competingHistory[0]!.toStatus, competingStatus);
    const competingSnapshots = await store.listEventTeamRosterSnapshots(guildId, competingEvent.id);
    assert.equal(competingSnapshots.length, competingStatus === "live" ? 1 : 0);
    assert.equal(
      await store.readEventTeamStateVersion(guildId, competingEvent.id),
      competingVersion,
    );
  });
});

test("PostgreSQL bulk formation admits one concurrent writer and rejects stale or terminal previews without partial writes", async () => {
  await withFreshPostgres(async (database) => {
    const store = createPostgresEventStore(database);
    const service = new EventTeamBulkService(store);
    const guildId = "guild-p04-bulk";
    const eventId = "event-p04-bulk";
    await store.createEvent(createTeamEvent(guildId, eventId, { requiredTeamSize: 2 }));
    for (const userId of ["member-1", "member-2", "member-3", "member-4"])
      await store.upsertSignup(createSignup(guildId, eventId, userId));
    const versionBeforeCommit = await store.readEventTeamStateVersion(guildId, eventId);
    const preview = await service.preview({ guildId, eventId, groupId: "team-red" });
    assert.equal(preview.proposals.length, 2);

    const results = await Promise.allSettled([
      service.commit(preview, "admin-1"),
      service.commit(preview, "admin-1"),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const teams = await store.listEventTeams(guildId, eventId);
    assert.equal(teams.length, 2);
    const memberships = await store.listActiveEventTeamMemberships(guildId, eventId);
    assert.equal(memberships.length, 4);
    for (const savedTeam of teams)
      assert.equal(
        memberships.filter((membership) => membership.teamId === savedTeam.id).length,
        2,
      );
    assert.equal(await store.readEventTeamStateVersion(guildId, eventId), versionBeforeCommit + 1);
    const audits = await store.listEventTeamAudit({ guildId, eventId });
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.action, "bulk.committed");
    const deliveries = await store.listEventTeamDeliveries({ guildId, eventId });
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]!.dedupeKey, `canonical:${eventId}`);

    const auditCount = audits.length;
    const deliveryCount = deliveries.length;
    await assert.rejects(
      service.commit(preview, "admin-1"),
      (error: unknown) => error instanceof EventTeamBulkStalePreviewError,
    );
    assert.equal((await store.listEventTeams(guildId, eventId)).length, 2);
    assert.equal((await store.listActiveEventTeamMemberships(guildId, eventId)).length, 4);
    assert.equal((await store.listEventTeamAudit({ guildId, eventId })).length, auditCount);
    assert.equal((await store.listEventTeamDeliveries({ guildId, eventId })).length, deliveryCount);
    assert.equal(await store.readEventTeamStateVersion(guildId, eventId), versionBeforeCommit + 1);

    const directEventId = "event-p04-bulk-direct-race";
    await store.createEvent(createTeamEvent(guildId, directEventId, { requiredTeamSize: 2 }));
    await store.upsertSignup(createSignup(guildId, directEventId, "direct-member-1"));
    await store.upsertSignup(createSignup(guildId, directEventId, "direct-member-2", 210));
    const directPreview = await service.preview({
      guildId,
      eventId: directEventId,
      groupId: "team-red",
    });
    const directVersion = await store.readEventTeamStateVersion(guildId, directEventId);
    const directResults = await Promise.allSettled([
      store.commitEventTeamBulkFormation({
        preview: directPreview,
        expectedRevision: directPreview.revision,
        actorUserId: "admin-1",
      }),
      store.commitEventTeamBulkFormation({
        preview: directPreview,
        expectedRevision: directPreview.revision,
        actorUserId: "admin-1",
      }),
    ]);
    assert.equal(directResults.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(directResults.filter((result) => result.status === "rejected").length, 1);
    assert.equal((await store.listEventTeams(guildId, directEventId)).length, 1);
    assert.equal((await store.listActiveEventTeamMemberships(guildId, directEventId)).length, 2);
    assert.equal(await store.readEventTeamStateVersion(guildId, directEventId), directVersion + 1);
    assert.equal((await store.listEventTeamAudit({ guildId, eventId: directEventId })).length, 1);
    assert.equal(
      (await store.listEventTeamDeliveries({ guildId, eventId: directEventId })).length,
      1,
    );

    const stateEventId = "event-p04-bulk-state";
    await store.createEvent(createTeamEvent(guildId, stateEventId, { requiredTeamSize: 2 }));
    await store.upsertSignup(createSignup(guildId, stateEventId, "state-member-1"));
    await store.upsertSignup(createSignup(guildId, stateEventId, "state-member-2", 210));
    const statePreview = await service.preview({
      guildId,
      eventId: stateEventId,
      groupId: "team-red",
    });
    const stateVersionBeforeChange = await store.readEventTeamStateVersion(guildId, stateEventId);
    await store.upsertSignup(createSignup(guildId, stateEventId, "state-member-3", 300));
    assert.equal(
      await store.readEventTeamStateVersion(guildId, stateEventId),
      stateVersionBeforeChange + 1,
    );
    await assert.rejects(
      service.commit(statePreview, "admin-1"),
      (error: unknown) => error instanceof EventTeamBulkStalePreviewError,
    );
    await assert.rejects(
      store.commitEventTeamBulkFormation({
        preview: statePreview,
        expectedRevision: statePreview.revision,
        actorUserId: "admin-1",
      }),
      (error: unknown) => error instanceof Error && /stale/i.test(error.message),
    );
    assert.deepEqual(await store.listEventTeams(guildId, stateEventId), []);
    assert.deepEqual(await store.listActiveEventTeamMemberships(guildId, stateEventId), []);
    assert.deepEqual(await store.listEventTeamAudit({ guildId, eventId: stateEventId }), []);
    assert.deepEqual(await store.listEventTeamDeliveries({ guildId, eventId: stateEventId }), []);
    assert.equal(
      await store.readEventTeamStateVersion(guildId, stateEventId),
      stateVersionBeforeChange + 1,
    );

    const terminalEventId = "event-p04-bulk-terminal";
    await store.createEvent(
      createTeamEvent(guildId, terminalEventId, {
        requiredTeamSize: 2,
        status: "ended",
        endedAtMs: 2_000,
      }),
    );
    await store.upsertSignup(createSignup(guildId, terminalEventId, "terminal-member-1"));
    await store.upsertSignup(createSignup(guildId, terminalEventId, "terminal-member-2", 210));
    const terminalPreview = await service.preview({
      guildId,
      eventId: terminalEventId,
      groupId: "team-red",
    });
    const terminalVersion = await store.readEventTeamStateVersion(guildId, terminalEventId);
    await assert.rejects(
      service.commit(terminalPreview, "admin-1"),
      matchesError(/terminal Event/i),
    );
    assert.deepEqual(await store.listEventTeams(guildId, terminalEventId), []);
    assert.deepEqual(await store.listActiveEventTeamMemberships(guildId, terminalEventId), []);
    assert.deepEqual(await store.listEventTeamAudit({ guildId, eventId: terminalEventId }), []);
    assert.deepEqual(
      await store.listEventTeamDeliveries({ guildId, eventId: terminalEventId }),
      [],
    );
    assert.equal(await store.readEventTeamStateVersion(guildId, terminalEventId), terminalVersion);
  });
});

test("PostgreSQL Event lookups and writes stay Guild-scoped for identical IDs", async () => {
  await withFreshPostgres(async (database) => {
    const store = createPostgresEventStore(database);
    const guildA = "guild-p04-tenant-a";
    const guildB = "guild-p04-tenant-b";
    const eventId = "event-shared";
    const teamId = "team-shared";
    const proposalId = "proposal-shared";

    for (const guildId of [guildA, guildB]) {
      await store.createEvent(
        createTeamEvent(guildId, eventId, { requiredTeamSize: 2, title: `Event ${guildId}` }),
      );
      await store.upsertSignup(createSignup(guildId, eventId, "captain-shared"));
      await store.upsertSignup(createSignup(guildId, eventId, "member-shared"));
      await store.commitEventTeamMutation({
        mutation: {
          kind: "create_team",
          team: createTeam(guildId, eventId, {
            id: teamId,
            name: `Shared ${guildId}`,
            normalizedName: "shared",
            captainUserId: "captain-shared",
            createdByUserId: "captain-shared",
          }),
          membership: createMembership(guildId, eventId, {
            id: "membership-captain-shared",
            teamId,
            userId: "captain-shared",
          }),
        },
        audit: createAudit(guildId, eventId, {
          id: "audit-shared",
          action: "team.created",
          targetId: teamId,
        }),
        deliveries: [createDelivery(guildId, eventId, `canonical:${eventId}`, "canonical_refresh")],
      });
      await store.createEventTeamProposal(
        createProposal(guildId, eventId, {
          id: proposalId,
          teamId,
          requesterUserId: "member-shared",
          targetUserId: "captain-shared",
        }),
      );
    }

    assert.equal(await store.readEventTeamStateVersion(guildA, eventId), 4);
    assert.equal(await store.readEventTeamStateVersion(guildB, eventId), 4);
    await store.commitEventTeamMutation({
      mutation: {
        kind: "add_membership",
        membership: createMembership(guildA, eventId, {
          id: "membership-member-shared",
          teamId,
          userId: "member-shared",
          joinedAtMs: 900,
        }),
      },
      audit: createAudit(guildA, eventId, {
        id: "audit-member-shared",
        action: "member.added",
        targetId: teamId,
      }),
      deliveries: [
        createDelivery(guildA, eventId, "member.added:member-shared", "notification", 900),
      ],
    });
    const proposalA = (await store.readEventTeamProposal(guildA, eventId, proposalId))!;
    await store.updateEventTeamProposal({
      ...proposalA,
      status: "declined",
      updatedAtMs: 950,
      resolvedAtMs: 950,
    });

    const teamA = (await store.listEventTeams(guildA, eventId))[0]!;
    const teamB = (await store.listEventTeams(guildB, eventId))[0]!;
    assert.equal(teamA.name, `Shared ${guildA}`);
    assert.equal(teamB.name, `Shared ${guildB}`);
    assert.equal((await store.listActiveEventTeamMemberships(guildA, eventId)).length, 2);
    assert.equal((await store.listActiveEventTeamMemberships(guildB, eventId)).length, 1);
    assert.equal(
      (await store.readEventTeamProposal(guildA, eventId, proposalId))?.status,
      "declined",
    );
    assert.equal(
      (await store.readEventTeamProposal(guildB, eventId, proposalId))?.status,
      "pending",
    );
    assert.equal((await store.listEventTeamAudit({ guildId: guildA, eventId })).length, 2);
    assert.equal((await store.listEventTeamAudit({ guildId: guildB, eventId })).length, 1);
    assert.equal((await store.listEventTeamDeliveries({ guildId: guildA, eventId })).length, 2);
    assert.equal((await store.listEventTeamDeliveries({ guildId: guildB, eventId })).length, 1);
    assert.equal(await store.readEventTeamStateVersion(guildA, eventId), 5);
    assert.equal(await store.readEventTeamStateVersion(guildB, eventId), 4);

    assert.equal(await store.readEvent("guild-p04-tenant-missing", eventId), null);
    assert.deepEqual(await store.listEventTeams("guild-p04-tenant-missing", eventId), []);
    assert.equal(
      await store.readEventTeamProposal("guild-p04-tenant-missing", eventId, proposalId),
      null,
    );
    assert.deepEqual(
      await store.listEventTeamAudit({ guildId: "guild-p04-tenant-missing", eventId }),
      [],
    );
    assert.deepEqual(
      await store.listEventTeamDeliveries({ guildId: "guild-p04-tenant-missing", eventId }),
      [],
    );
  });
});

function matchesError(pattern: RegExp): (error: unknown) => boolean {
  const search = (error: unknown): boolean => {
    if (!(error instanceof Error)) return false;
    if (pattern.test(error.message)) return true;
    return search(error.cause);
  };
  return search;
}

function createTeamEvent(
  guildId: string,
  eventId: string,
  overrides: Partial<EventRecord> = {},
): EventRecord {
  const startsAtMs = 1_000_000;
  return {
    guildId,
    id: eventId,
    templateId: null,
    title: `Event ${eventId}`,
    description: "Team practice.",
    status: "scheduled",
    channelId: "channel-1",
    messageId: null,
    threadId: null,
    startsAtMs,
    endsAtMs: startsAtMs + 3_600_000,
    signupCutoffAtMs: startsAtMs,
    signupMode: "single_choice",
    participationMode: "team",
    requiredTeamSize: 2,
    threadEnabled: false,
    waitlistedMembersJoinThread: false,
    groups: [
      {
        id: "team-red",
        label: "Team Red",
        emoji: null,
        capacity: null,
        waitlistEnabled: false,
        allowedRoleIds: [],
        blockedRoleIds: [],
        grantRoleId: null,
      },
    ],
    reminders: [],
    createdAtMs: 500,
    updatedAtMs: 500,
    publishedAtMs: null,
    cancelledAtMs: null,
    endedAtMs: null,
    archivedAtMs: null,
    ...overrides,
  };
}

function createSignup(
  guildId: string,
  eventId: string,
  userId: string,
  createdAtMs = 100,
): EventSignup {
  return {
    guildId,
    eventId,
    userId,
    groupId: "team-red",
    status: "confirmed",
    createdAtMs,
    updatedAtMs: createdAtMs,
  };
}

function createTeam(
  guildId: string,
  eventId: string,
  overrides: Partial<EventTeam> = {},
): EventTeam {
  return {
    guildId,
    eventId,
    id: "team-1",
    groupId: "team-red",
    name: "Night Owls",
    normalizedName: "night owls",
    captainUserId: "captain-1",
    openToRequests: false,
    status: "active",
    createdByUserId: "captain-1",
    createdAtMs: 600,
    updatedAtMs: 600,
    disbandedAtMs: null,
    ...overrides,
  };
}

function createMembership(
  guildId: string,
  eventId: string,
  input: {
    id: string;
    teamId: string;
    userId: string;
    groupId?: string;
    joinedAtMs?: number;
    leftAtMs?: number | null;
  },
): EventTeamMembership {
  return {
    guildId,
    eventId,
    id: input.id,
    teamId: input.teamId,
    groupId: input.groupId ?? "team-red",
    userId: input.userId,
    joinedAtMs: input.joinedAtMs ?? 600,
    leftAtMs: input.leftAtMs ?? null,
  };
}

function createProposal(
  guildId: string,
  eventId: string,
  input: {
    id: string;
    teamId: string;
    requesterUserId: string;
    targetUserId: string;
    kind?: EventTeamProposal["kind"];
    status?: EventTeamProposal["status"];
    createdAtMs?: number;
    updatedAtMs?: number;
  },
): EventTeamProposal {
  return {
    guildId,
    eventId,
    id: input.id,
    teamId: input.teamId,
    kind: input.kind ?? "join_request",
    requesterUserId: input.requesterUserId,
    targetUserId: input.targetUserId,
    status: input.status ?? "pending",
    createdAtMs: input.createdAtMs ?? 200,
    updatedAtMs: input.updatedAtMs ?? input.createdAtMs ?? 200,
    resolvedAtMs: null,
  };
}

function createAudit(
  guildId: string,
  eventId: string,
  overrides: Partial<EventTeamAuditRecord> & { id: string; action: string },
): EventTeamAuditRecord {
  return {
    guildId,
    eventId,
    actorUserId: "captain-1",
    targetType: "team",
    targetId: "team-1",
    prior: null,
    result: null,
    occurredAtMs: 700,
    ...overrides,
  };
}

function createDelivery(
  guildId: string,
  eventId: string,
  dedupeKey: string,
  kind: EventTeamDeliveryOutboxRecord["kind"],
  nowMs = 700,
): EventTeamDeliveryOutboxRecord {
  return {
    guildId,
    eventId,
    id: `delivery-${kind}-${dedupeKey}-${nowMs}`,
    kind,
    dedupeKey,
    payload: {},
    status: "pending",
    attemptCount: 0,
    maxAttempts: 5,
    lastError: null,
    terminalFailureReason: null,
    nextAttemptAtMs: nowMs,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    deliveredAtMs: null,
  };
}

function createHistory(
  guildId: string,
  eventId: string,
  input: {
    id: string;
    fromStatus: EventLifecycleHistoryRecord["fromStatus"];
    toStatus: EventLifecycleHistoryRecord["toStatus"];
    occurredAtMs: number;
  },
): EventLifecycleHistoryRecord {
  return {
    guildId,
    eventId,
    id: input.id,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    occurredAtMs: input.occurredAtMs,
    retentionExpiresAtMs: input.occurredAtMs + 365 * 24 * 60 * 60 * 1000,
  };
}

function createSnapshot(
  guildId: string,
  eventId: string,
  input: {
    teamId: string;
    requiredTeamSize: number;
    members: EventTeamRosterSnapshot["members"];
    capturedAtMs: number;
  },
): EventTeamRosterSnapshot {
  return {
    guildId,
    eventId,
    teamId: input.teamId,
    requiredTeamSize: input.requiredTeamSize,
    members: input.members,
    capturedAtMs: input.capturedAtMs,
  };
}
