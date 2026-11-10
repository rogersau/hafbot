/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createCloudflareEventStore } from "../src/runtime/cloudflare-event-store";
import {
  EventTeamBulkService,
  type EventTeamBulkStore,
} from "../src/services/event-team-bulk-service";
import type {
  EventRecord,
  EventSignup,
  EventTeamAuditRecord,
  EventTeamDeliveryOutboxRecord,
  EventTeamRosterSnapshot,
  EventTemplate,
  EventLifecycleHistoryRecord,
  EventTeam,
  EventTeamMembership,
  EventTeamProposal,
} from "../src/types";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("createCloudflareEventStore persists templates, events, signups, reminders, and lifecycle queries", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareEventStore(database as unknown as D1Database);
  const template = createTemplate();
  const event = createEvent();
  const signup: EventSignup = {
    guildId: "guild-1",
    eventId: "event-1",
    userId: "user-1",
    groupId: "team-red",
    status: "confirmed",
    createdAtMs: 300,
    updatedAtMs: 300,
  };

  await store.createTemplate(template);
  await store.createEvent(event);
  await store.upsertSignup(signup);

  assert.deepEqual(await store.readTemplate("guild-1", "template-1"), template);
  assert.deepEqual(await store.listTemplates("guild-1"), [template]);
  assert.deepEqual(await store.readEvent("guild-1", "event-1"), event);
  assert.deepEqual(await store.listEvents("guild-1"), [event]);
  assert.deepEqual(await store.listSignups("guild-1", "event-1"), [signup]);
  assert.deepEqual(await store.listUserSignups("guild-1", "event-1", "user-1"), [signup]);
  assert.deepEqual(await store.listDueReminders(600, 10), [
    { event, reminder: event.reminders[0] },
  ]);
  assert.deepEqual(await store.listDueLifecycleEvents(1_000, 10), [event]);

  await store.updateReminderSentAt({
    guildId: "guild-1",
    eventId: "event-1",
    reminderId: "reminder-1",
    sentAtMs: 500,
  });
  assert.deepEqual(await store.listDueReminders(600, 10), []);

  const updated = {
    ...(await store.readEvent("guild-1", "event-1"))!,
    status: "ended" as const,
    endedAtMs: 1_000,
    updatedAtMs: 1_000,
  };
  await store.upsertEvent(updated);
  assert.deepEqual(await store.readEvent("guild-1", "event-1"), updated);

  await store.deleteSignup({
    guildId: "guild-1",
    eventId: "event-1",
    userId: "user-1",
    groupId: "team-red",
  });
  assert.deepEqual(await store.listSignups("guild-1", "event-1"), []);
  assert.equal(database.execCalls, 0);
});

test("createCloudflareEventStore round-trips team Event configuration", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareEventStore(database as unknown as D1Database);
  const event = {
    ...createEvent(),
    participationMode: "team" as const,
    requiredTeamSize: 5,
  };

  await store.createEvent(event);

  const saved = await store.readEvent("guild-1", "event-1");
  assert.deepEqual(
    {
      participationMode: saved?.participationMode,
      requiredTeamSize: saved?.requiredTeamSize,
    },
    { participationMode: "team", requiredTeamSize: 5 },
  );
});

test("createCloudflareEventStore atomically advances Event Team rate-limit windows", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareEventStore(database as unknown as D1Database);
  const first = await store.consumeEventTeamRateLimit!({
    guildId: "guild-1",
    eventId: "event-1",
    action: "team_invite",
    scopeType: "user",
    scopeId: "captain-1",
    limit: 2,
    windowMs: 1_000,
    nowMs: 100,
  });
  const second = await store.consumeEventTeamRateLimit!({
    guildId: "guild-1",
    eventId: "event-1",
    action: "team_invite",
    scopeType: "user",
    scopeId: "captain-1",
    limit: 2,
    windowMs: 1_000,
    nowMs: 200,
  });
  const blocked = await store.consumeEventTeamRateLimit!({
    guildId: "guild-1",
    eventId: "event-1",
    action: "team_invite",
    scopeType: "user",
    scopeId: "captain-1",
    limit: 2,
    windowMs: 1_000,
    nowMs: 300,
  });
  const reset = await store.consumeEventTeamRateLimit!({
    guildId: "guild-1",
    eventId: "event-1",
    action: "team_invite",
    scopeType: "user",
    scopeId: "captain-1",
    limit: 2,
    windowMs: 1_000,
    nowMs: 1_101,
  });
  assert.deepEqual(first, { allowed: true, remaining: 1, retryAfterMs: 1_000 });
  assert.deepEqual(second, { allowed: true, remaining: 0, retryAfterMs: 900 });
  assert.deepEqual(blocked, { allowed: false, remaining: 0, retryAfterMs: 800 });
  assert.deepEqual(reset, { allowed: true, remaining: 1, retryAfterMs: 1_000 });
});

test("createCloudflareEventStore round-trips team Event Template configuration", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareEventStore(database as unknown as D1Database);
  const template = {
    ...createTemplate(),
    participationMode: "team" as const,
    requiredTeamSize: 5,
  };

  await store.createTemplate(template);

  const saved = await store.readTemplate("guild-1", "template-1");
  assert.deepEqual(
    {
      participationMode: saved?.participationMode,
      requiredTeamSize: saved?.requiredTeamSize,
    },
    { participationMode: "team", requiredTeamSize: 5 },
  );
});

test("createCloudflareEventStore rejects Event Team membership from another Signup Group", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareEventStore(database as unknown as D1Database);
  const team = {
    guildId: "guild-1",
    eventId: "event-1",
    id: "team-1",
    groupId: "open",
    name: "Night Owls",
    normalizedName: "night owls",
    captainUserId: "captain-1",
    openToRequests: false,
    status: "active" as const,
    createdByUserId: "captain-1",
    createdAtMs: 100,
    updatedAtMs: 100,
    disbandedAtMs: null,
  };
  await store.createEvent({
    ...createEvent(),
    participationMode: "team",
    requiredTeamSize: 2,
  });
  await store.upsertSignup({
    guildId: "guild-1",
    eventId: "event-1",
    userId: "captain-1",
    groupId: "open",
    status: "confirmed",
    createdAtMs: 90,
    updatedAtMs: 90,
  });
  await store.upsertSignup({
    guildId: "guild-1",
    eventId: "event-1",
    userId: "member-1",
    groupId: "other",
    status: "confirmed",
    createdAtMs: 90,
    updatedAtMs: 90,
  });
  await store.createEventTeamWithCaptain({
    team,
    membership: {
      guildId: "guild-1",
      eventId: "event-1",
      id: "membership-1",
      teamId: "team-1",
      groupId: "open",
      userId: "captain-1",
      joinedAtMs: 100,
      leftAtMs: null,
    },
  });

  await assert.rejects(
    store.addEventTeamMembership({
      guildId: "guild-1",
      eventId: "event-1",
      id: "membership-2",
      teamId: "team-1",
      groupId: "other",
      userId: "member-1",
      joinedAtMs: 200,
      leftAtMs: null,
    }),
    /incompatible Event Team membership/,
  );
});

test("proposal acceptance creates signup before membership and rejects a raced stale proposal atomically", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareEventStore(database.d1);
  const event = createTeamEvent();
  const team = createTeam();
  const captainSignup = createSignup("captain-1");
  await store.createEvent(event);
  await store.upsertSignup(captainSignup);
  await store.createEventTeamWithCaptain({
    team,
    membership: createMembership("membership-captain", "captain-1"),
  });

  const acceptedSignup = createSignup("member-1", 200);
  const pending = createProposal("proposal-1", "member-1");
  await store.createEventTeamProposal!(pending);
  await store.acceptEventTeamProposalAtomic!({
    proposal: { ...pending, status: "accepted", updatedAtMs: 300, resolvedAtMs: 300 },
    membership: createMembership("membership-member-1", "member-1", 300),
    signup: acceptedSignup,
    cancelProposalIds: [],
    audit: createAudit("audit-accept", "proposal.accepted"),
    deliveries: [
      createDelivery("canonical:event-1", "canonical_refresh", 300),
      createDelivery("proposal.accepted:proposal-1", "notification", 300),
    ],
  });
  assert.deepEqual(await store.listUserSignups(event.guildId, event.id, "member-1"), [
    acceptedSignup,
  ]);
  assert.equal(
    (await store.readEventTeamProposal!(event.guildId, event.id, pending.id))?.status,
    "accepted",
  );
  assert.equal(
    (await store.listEventTeamAudit!({ guildId: event.guildId, eventId: event.id })).length,
    1,
  );
  assert.equal(
    (await store.listEventTeamDeliveries!({ guildId: event.guildId, eventId: event.id })).length,
    2,
  );

  const stale = createProposal("proposal-2", "member-2", 400);
  await store.createEventTeamProposal!(stale);
  const originalBatch = database.d1.batch.bind(database.d1);
  database.d1.batch = (statements) => {
    database.execRaw(
      "UPDATE event_team_proposals SET status = 'withdrawn', updated_at_ms = 401, resolved_at_ms = 401 WHERE proposal_id = 'proposal-2'",
    );
    database.d1.batch = originalBatch;
    return originalBatch(statements);
  };
  await assert.rejects(
    store.acceptEventTeamProposalAtomic!({
      proposal: { ...stale, status: "accepted", updatedAtMs: 500, resolvedAtMs: 500 },
      membership: createMembership("membership-member-2", "member-2", 500),
      signup: createSignup("member-2", 500),
      cancelProposalIds: [],
    }),
    /no longer pending at the expected version/,
  );
  assert.deepEqual(await store.listUserSignups(event.guildId, event.id, "member-2"), []);
  assert.equal(
    (await store.listActiveEventTeamMemberships(event.guildId, event.id)).some(
      (membership) => membership.userId === "member-2",
    ),
    false,
  );
});

test("migrated database prevents deleting or moving a signup required by active membership", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareEventStore(database.d1);
  await store.createEvent(createTeamEvent());
  await store.upsertSignup(createSignup("captain-1"));
  await store.createEventTeamWithCaptain({
    team: createTeam(),
    membership: createMembership("membership-captain", "captain-1"),
  });

  await assert.rejects(
    store.deleteSignup({
      guildId: "guild-1",
      eventId: "event-1",
      userId: "captain-1",
      groupId: "team-red",
    }),
    (error: unknown) =>
      error instanceof Error &&
      /Active Event Team membership requires its compatible signup/.test(
        error.cause instanceof Error ? error.cause.message : error.message,
      ),
  );
  await assert.rejects(
    store.upsertSignup({ ...createSignup("captain-1"), groupId: "other" }),
    (error: unknown) =>
      error instanceof Error &&
      /Active Event Team membership requires its compatible signup/.test(
        error.cause instanceof Error ? error.cause.message : error.message,
      ),
  );

  const team = {
    ...createTeam(),
    status: "disbanded" as const,
    openToRequests: false,
    updatedAtMs: 300,
    disbandedAtMs: 300,
  };
  await store.commitEventTeamDisband!({
    team,
    membershipIds: ["membership-captain"],
    leftAtMs: 300,
    cancelPendingProposals: true,
    deleteSignup: createSignup("captain-1"),
    audit: createAudit("audit-signup-removal", "member.signup_removed_by_admin"),
    deliveries: [createDelivery("canonical:event-1", "canonical_refresh", 300)],
  });
  assert.deepEqual(await store.listUserSignups("guild-1", "event-1", "captain-1"), []);
  assert.deepEqual(await store.listActiveEventTeamMemberships("guild-1", "event-1"), []);
});

test("bulk commit rejects terminal Events and concurrent full-revision changes at its transaction boundary", async () => {
  const terminalDatabase = new SqliteD1Database();
  const terminalStore = createCloudflareEventStore(terminalDatabase.d1);
  await terminalStore.createEvent({ ...createTeamEvent(), status: "ended", endedAtMs: 900 });
  await terminalStore.upsertSignup(createSignup("member-1"));
  await terminalStore.upsertSignup(createSignup("member-2", 101));
  const terminalPreview = await new EventTeamBulkService(
    terminalStore as EventTeamBulkStore,
  ).preview({
    guildId: "guild-1",
    eventId: "event-1",
    groupId: "team-red",
  });
  await assert.rejects(
    terminalStore.commitEventTeamBulkFormation!({
      preview: terminalPreview,
      expectedRevision: terminalPreview.revision,
      actorUserId: "admin-1",
    }),
    /terminal Event/,
  );

  const database = new SqliteD1Database();
  const store = createCloudflareEventStore(database.d1);
  await store.createEvent(createTeamEvent());
  await store.upsertSignup(createSignup("member-1"));
  await store.upsertSignup(createSignup("member-2", 101));
  const preview = await new EventTeamBulkService(store as EventTeamBulkStore).preview({
    guildId: "guild-1",
    eventId: "event-1",
    groupId: "team-red",
  });
  const originalBatch = database.d1.batch.bind(database.d1);
  database.d1.batch = (statements) => {
    database.execRaw(
      "INSERT INTO event_signups (guild_id, event_id, user_id, group_id, status, created_at_ms, updated_at_ms) VALUES ('guild-1', 'event-1', 'member-3', 'team-red', 'confirmed', 102, 102); UPDATE event_team_state_versions SET version = version + 1 WHERE guild_id = 'guild-1' AND event_id = 'event-1'",
    );
    database.d1.batch = originalBatch;
    return originalBatch(statements);
  };
  await assert.rejects(
    store.commitEventTeamBulkFormation!({
      preview,
      expectedRevision: preview.revision,
      actorUserId: "admin-1",
    }),
    /bulk state is stale or terminal/,
  );
  assert.deepEqual(await store.listEventTeams("guild-1", "event-1"), []);
  assert.deepEqual(await store.listActiveEventTeamMemberships("guild-1", "event-1"), []);
});

test("atomic Team mutation and disband batches roll back authoritative state with audit and outbox", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareEventStore(database.d1);
  const event = createTeamEvent();
  const team = { ...createTeam(), openToRequests: true };
  const captain = createMembership("membership-captain", "captain-1");
  await store.createEvent(event);
  await store.upsertSignup(createSignup("captain-1"));

  const duplicateAudit = createAudit("audit-duplicate", "team.created");
  await store.appendEventTeamAudit!(duplicateAudit);
  await assert.rejects(
    store.commitEventTeamMutation!({
      mutation: { kind: "create_team", team, membership: captain },
      audit: duplicateAudit,
      deliveries: [createDelivery("canonical:event-1", "canonical_refresh")],
    }),
  );
  assert.deepEqual(await store.listEventTeams(event.guildId, event.id), []);

  await store.commitEventTeamMutation!({
    mutation: { kind: "create_team", team, membership: captain },
    audit: createAudit("audit-create", "team.created"),
    deliveries: [createDelivery("canonical:event-1", "canonical_refresh")],
  });
  const pending = createProposal("proposal-1", "member-1");
  await store.createEventTeamProposal!(pending);
  const disbanded = {
    ...team,
    status: "disbanded" as const,
    openToRequests: false,
    updatedAtMs: 500,
    disbandedAtMs: 500,
  };
  await assert.rejects(
    store.commitEventTeamDisband!({
      team: disbanded,
      membershipIds: [captain.id],
      leftAtMs: 500,
      cancelPendingProposals: true,
      audit: duplicateAudit,
      deliveries: [createDelivery("canonical:event-1", "canonical_refresh", 500)],
    }),
  );
  assert.equal((await store.listEventTeams(event.guildId, event.id))[0]?.status, "active");
  assert.equal((await store.listActiveEventTeamMemberships(event.guildId, event.id)).length, 1);
  assert.equal(
    (await store.readEventTeamProposal!(event.guildId, event.id, pending.id))?.status,
    "pending",
  );

  await store.commitEventTeamDisband!({
    team: disbanded,
    membershipIds: [captain.id],
    leftAtMs: 500,
    cancelPendingProposals: true,
    audit: createAudit("audit-disband", "team.disbanded"),
    deliveries: [
      createDelivery("canonical:event-1", "canonical_refresh", 500),
      createDelivery("team.disbanded:captain-1", "notification", 500),
    ],
  });
  assert.equal((await store.listEventTeams(event.guildId, event.id))[0]?.openToRequests, false);
  assert.deepEqual(await store.listActiveEventTeamMemberships(event.guildId, event.id), []);
  assert.equal(
    (await store.readEventTeamProposal!(event.guildId, event.id, pending.id))?.status,
    "cancelled",
  );
  assert.equal(
    (await store.listEventTeamAudit!({ guildId: event.guildId, eventId: event.id })).length,
    3,
  );
  assert.equal(
    (await store.listEventTeamDeliveries!({ guildId: event.guildId, eventId: event.id })).length,
    2,
  );
});

test("lifecycle transition rolls back live state when history or snapshots cannot commit", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareEventStore(database.d1);
  const event = createTeamEvent();
  await store.createEvent(event);
  const history: EventLifecycleHistoryRecord = {
    guildId: event.guildId,
    eventId: event.id,
    id: "history-live",
    fromStatus: "scheduled",
    toStatus: "live",
    occurredAtMs: 1_000,
    retentionExpiresAtMs: 2_000,
  };
  await store.appendEventLifecycleHistory!(history);
  const snapshot: EventTeamRosterSnapshot = {
    guildId: event.guildId,
    eventId: event.id,
    teamId: "team-1",
    requiredTeamSize: 2,
    members: [],
    capturedAtMs: 1_000,
  };
  await assert.rejects(
    store.commitEventLifecycleTransition!({
      event: { ...event, status: "live", updatedAtMs: 1_000 },
      history,
      snapshots: [snapshot],
      expectedStatus: "scheduled",
      expectedStateVersion: await store.readEventTeamStateVersion!(event.guildId, event.id),
    }),
  );
  assert.equal((await store.readEvent(event.guildId, event.id))?.status, "scheduled");
  assert.equal(await store.readEventTeamRosterSnapshot!(event.guildId, event.id, "team-1"), null);

  const expectedStateVersion = await store.readEventTeamStateVersion!(event.guildId, event.id);
  const originalBatch = database.d1.batch.bind(database.d1);
  database.d1.batch = (statements) => {
    database.execRaw(
      "INSERT INTO event_signups (guild_id, event_id, user_id, group_id, status, created_at_ms, updated_at_ms) VALUES ('guild-1', 'event-1', 'raced-user', 'team-red', 'confirmed', 999, 999); UPDATE event_team_state_versions SET version = version + 1 WHERE guild_id = 'guild-1' AND event_id = 'event-1'",
    );
    database.d1.batch = originalBatch;
    return originalBatch(statements);
  };
  await assert.rejects(
    store.commitEventLifecycleTransition!({
      event: { ...event, status: "live", updatedAtMs: 1_100 },
      history: { ...history, id: "history-raced", occurredAtMs: 1_100 },
      snapshots: [],
      expectedStatus: "scheduled",
      expectedStateVersion,
    }),
    /lifecycle state or Team roster changed concurrently/,
  );
  assert.equal((await store.readEvent(event.guildId, event.id))?.status, "scheduled");
});

test("createCloudflareEventStore persists immutable Event Team audit, snapshots, outbox, and lifecycle history", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareEventStore(database as unknown as D1Database);
  const event = createEvent();
  await store.createEvent(event);

  const audit: EventTeamAuditRecord = {
    guildId: event.guildId,
    eventId: event.id,
    id: "audit-1",
    actorUserId: "captain-1",
    action: "team.created",
    targetType: "team",
    targetId: "team-1",
    prior: null,
    result: { name: "Night Owls" },
    occurredAtMs: 400,
  };
  await store.appendEventTeamAudit!(audit);
  assert.deepEqual(await store.listEventTeamAudit!({ guildId: event.guildId, eventId: event.id }), [
    audit,
  ]);
  await assert.rejects(() => store.appendEventTeamAudit!(audit));

  const snapshot: EventTeamRosterSnapshot = {
    guildId: event.guildId,
    eventId: event.id,
    teamId: "team-1",
    requiredTeamSize: 2,
    members: [
      {
        membershipId: "membership-1",
        userId: "user-1",
        groupId: "team-red",
        signupStatus: "confirmed",
      },
    ],
    capturedAtMs: 500,
  };
  assert.deepEqual(await store.captureEventTeamRosterSnapshot!(snapshot), snapshot);
  assert.deepEqual(
    await store.captureEventTeamRosterSnapshot!({ ...snapshot, capturedAtMs: 600, members: [] }),
    snapshot,
  );
  assert.deepEqual(
    await store.readEventTeamRosterSnapshot!(event.guildId, event.id, "team-1"),
    snapshot,
  );

  const outbox: EventTeamDeliveryOutboxRecord = {
    guildId: event.guildId,
    eventId: event.id,
    id: "delivery-1",
    kind: "canonical_refresh",
    dedupeKey: "canonical:event-1",
    payload: { eventId: event.id },
    status: "pending",
    attemptCount: 0,
    maxAttempts: 2,
    lastError: null,
    terminalFailureReason: null,
    nextAttemptAtMs: 700,
    createdAtMs: 700,
    updatedAtMs: 700,
    deliveredAtMs: null,
  };
  assert.deepEqual(await store.enqueueEventTeamDelivery!(outbox), outbox);
  assert.deepEqual(
    await store.enqueueEventTeamDelivery!({
      ...outbox,
      id: "delivery-2",
      payload: { duplicate: true },
    }),
    { ...outbox, payload: { duplicate: true } },
  );
  assert.deepEqual(
    await store.listDueEventTeamDeliveries!({
      guildId: event.guildId,
      eventId: event.id,
      nowMs: 700,
    }),
    [{ ...outbox, payload: { duplicate: true } }],
  );
  const failed = {
    ...outbox,
    status: "failed" as const,
    attemptCount: 2,
    terminalFailureReason: "gateway timeout",
    lastError: "timeout",
    updatedAtMs: 800,
  };
  await store.updateEventTeamDelivery!(failed);
  const requeued = await store.enqueueEventTeamDelivery!({
    ...outbox,
    id: "delivery-3",
    payload: { latest: true },
    nextAttemptAtMs: 900,
    updatedAtMs: 900,
  });
  assert.deepEqual(requeued, {
    ...outbox,
    payload: { latest: true },
    status: "pending",
    nextAttemptAtMs: 900,
    updatedAtMs: 900,
  });
  const claimed = await store.claimEventTeamDelivery!({
    record: requeued,
    nowMs: 900,
    leaseMs: 100,
  });
  assert.ok(claimed);
  await store.enqueueEventTeamDelivery!({
    ...outbox,
    id: "delivery-4",
    payload: { newest: true },
    nextAttemptAtMs: 950,
    updatedAtMs: 950,
  });
  await store.updateEventTeamDelivery!(
    { ...claimed, status: "delivered", updatedAtMs: 1_000, deliveredAtMs: 1_000 },
    claimed,
  );
  assert.deepEqual(
    await store.listDueEventTeamDeliveries!({
      guildId: event.guildId,
      eventId: event.id,
      nowMs: 950,
    }),
    [
      {
        ...outbox,
        payload: { newest: true },
        status: "pending",
        nextAttemptAtMs: 950,
        updatedAtMs: 950,
      },
    ],
  );

  const history: EventLifecycleHistoryRecord = {
    guildId: event.guildId,
    eventId: event.id,
    id: "history-1",
    fromStatus: "scheduled",
    toStatus: "live",
    occurredAtMs: 900,
    retentionExpiresAtMs: 10_000,
  };
  await store.appendEventLifecycleHistory!(history);
  assert.deepEqual(await store.listEventLifecycleHistory!(event.guildId, event.id), [history]);

  await store.deleteEventPermanently!({ guildId: event.guildId, eventId: event.id });
  assert.equal(await store.readEvent(event.guildId, event.id), null);
  assert.deepEqual(
    await store.listEventTeamAudit!({ guildId: event.guildId, eventId: event.id }),
    [],
  );
  assert.equal(await store.readEventTeamRosterSnapshot!(event.guildId, event.id, "team-1"), null);
  assert.deepEqual(await store.listEventLifecycleHistory!(event.guildId, event.id), []);
});

function createTemplate(): EventTemplate {
  return {
    guildId: "guild-1",
    id: "template-1",
    name: "Scrim",
    description: "Standard scrim template",
    signupMode: "single_choice",
    participationMode: "individual",
    requiredTeamSize: null,
    threadEnabled: true,
    waitlistedMembersJoinThread: false,
    groups: [
      {
        id: "team-red",
        label: "Team Red",
        emoji: "🔴",
        capacity: 1,
        waitlistEnabled: true,
        allowedRoleIds: ["role-player"],
        blockedRoleIds: [],
        grantRoleId: "role-red",
      },
    ],
    reminders: [
      {
        id: "reminder-1",
        offsetMinutes: 30,
        audience: "signed_up",
        signupGroupIds: [],
        message: "Scrim soon.",
        sentAtMs: null,
      },
    ],
    createdAtMs: 100,
    updatedAtMs: 100,
  };
}

function createEvent(): EventRecord {
  return {
    guildId: "guild-1",
    id: "event-1",
    templateId: "template-1",
    title: "Friday Scrim",
    description: "Main team practice.",
    status: "scheduled",
    channelId: "channel-1",
    messageId: "message-1",
    threadId: "thread-1",
    startsAtMs: 1_000,
    endsAtMs: 2_000,
    signupCutoffAtMs: 900,
    signupMode: "single_choice",
    participationMode: "individual",
    requiredTeamSize: null,
    threadEnabled: true,
    waitlistedMembersJoinThread: false,
    groups: createTemplate().groups,
    reminders: createTemplate().reminders,
    createdAtMs: 200,
    updatedAtMs: 200,
    publishedAtMs: 250,
    cancelledAtMs: null,
    endedAtMs: null,
    archivedAtMs: null,
  };
}

function createTeamEvent(): EventRecord {
  return { ...createEvent(), participationMode: "team", requiredTeamSize: 2 };
}

function createSignup(userId: string, createdAtMs = 100): EventSignup {
  return {
    guildId: "guild-1",
    eventId: "event-1",
    userId,
    groupId: "team-red",
    status: "confirmed",
    createdAtMs,
    updatedAtMs: createdAtMs,
  };
}

function createTeam(): EventTeam {
  return {
    guildId: "guild-1",
    eventId: "event-1",
    id: "team-1",
    groupId: "team-red",
    name: "Night Owls",
    normalizedName: "night owls",
    captainUserId: "captain-1",
    openToRequests: false,
    status: "active",
    createdByUserId: "captain-1",
    createdAtMs: 100,
    updatedAtMs: 100,
    disbandedAtMs: null,
  };
}

function createMembership(id: string, userId: string, joinedAtMs = 100): EventTeamMembership {
  return {
    guildId: "guild-1",
    eventId: "event-1",
    id,
    teamId: "team-1",
    groupId: "team-red",
    userId,
    joinedAtMs,
    leftAtMs: null,
  };
}

function createProposal(id: string, userId: string, createdAtMs = 200): EventTeamProposal {
  return {
    guildId: "guild-1",
    eventId: "event-1",
    id,
    teamId: "team-1",
    kind: "join_request",
    requesterUserId: userId,
    targetUserId: "captain-1",
    status: "pending",
    createdAtMs,
    updatedAtMs: createdAtMs,
    resolvedAtMs: null,
  };
}

function createAudit(id: string, action: string): EventTeamAuditRecord {
  return {
    guildId: "guild-1",
    eventId: "event-1",
    id,
    actorUserId: "captain-1",
    action,
    targetType: "team",
    targetId: "team-1",
    prior: null,
    result: null,
    occurredAtMs: 400,
  };
}

function createDelivery(
  dedupeKey: string,
  kind: EventTeamDeliveryOutboxRecord["kind"],
  nowMs = 400,
): EventTeamDeliveryOutboxRecord {
  return {
    guildId: "guild-1",
    eventId: "event-1",
    id: `delivery-${dedupeKey}-${nowMs}`,
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
