import assert from "node:assert/strict";
import test from "node:test";
import { EVENT_RECURRENCE_DAY_MS } from "../src/event-recurrence";
import { createCloudflareEventStore } from "../src/runtime/cloudflare-event-store";
import { EventsService, type EventsDiscordApi } from "../src/services/events-service";
import { SqliteD1Database } from "./support/sqlite-d1-database";
import { createEventsAdminRoutes } from "../src/runtime/admin-routes/events";
import { dispatchAdminRoute } from "../src/runtime/admin-route-registry";
import { ALL_FEATURES_ENABLED } from "../src/runtime/features";
import type { RuntimeStores } from "../src/runtime/app-types";
import { allowAllAdminAccess } from "./helpers/admin-api";
import { DiscordApiError } from "../src/discord/client";
import { GuildResourceValidator } from "../src/discord/guild-resource-validator";
import { testChannel, testRole } from "./helpers/guild-resource-validator";

function fixture(guildResources?: GuildResourceValidator) {
  const database = new SqliteD1Database();
  const store = createCloudflareEventStore(database.d1);
  let paid = true;
  let posts = 0;
  const removedRoles: string[] = [];
  const discord: EventsDiscordApi = {
    createChannelMessage: async (channelId, body) => ({
      id: String(500 + posts++),
      channel_id: channelId,
      content: body.content ?? "",
    }),
    editChannelMessage: async (channelId, messageId, body) => ({
      id: messageId,
      channel_id: channelId,
      content: body.content ?? "",
    }),
    createThread: async () => ({ id: "600" }),
    addThreadMember: async () => {},
    removeThreadMember: async () => {},
    addGuildMemberRole: async () => {},
    removeGuildMemberRole: async (_guild, user) => {
      removedRoles.push(user);
    },
  };
  const entitlements = {
    readGuildEntitlement: async (guildId: string) => ({
      guildId,
      tier: paid ? ("premium" as const) : ("free" as const),
      updatedAtMs: 0,
    }),
  };
  const service = new EventsService(
    store,
    discord,
    undefined,
    entitlements,
    undefined,
    guildResources,
  );
  async function source(team = false) {
    const startsAtMs = Date.now() + EVENT_RECURRENCE_DAY_MS;
    const event = await service.createEvent({
      guildId: "100",
      templateId: null,
      title: "Weekly scrim",
      description: "Bring a team.",
      channelId: "200",
      startsAtMs,
      endsAtMs: startsAtMs + 3_600_000,
      signupCutoffAtMs: startsAtMs - 60_000,
      signupMode: "single_choice",
      participationMode: team ? "team" : "individual",
      requiredTeamSize: team ? 2 : null,
      threadEnabled: false,
      waitlistedMembersJoinThread: false,
      groups: [
        {
          id: "open",
          label: "Open",
          emoji: null,
          capacity: 10,
          waitlistEnabled: true,
          allowedRoleIds: [],
          blockedRoleIds: [],
          grantRoleId: "300",
        },
      ],
      reminders: [
        {
          id: "before",
          offsetMinutes: 30,
          audience: "signed_up",
          signupGroupIds: [],
          message: "Get ready",
          sentAtMs: Date.now(),
        },
      ],
    });
    return service.publishEvent({ guildId: "100", eventId: event.id, actorUserId: "800" });
  }
  return {
    database,
    store,
    discord,
    service,
    source,
    removedRoles,
    entitlements,
    posts: () => posts,
    setPaid: (next: boolean) => {
      paid = next;
    },
    reconstruct: () =>
      new EventsService(store, discord, undefined, entitlements, undefined, guildResources),
  };
}

test("recurring Events copy saved settings by value, wait for canonical cleanup, and start with fresh participant state", async (t) => {
  const f = fixture();
  t.after(() => f.database.close());
  const source = await f.source(true);
  await f.service.signup({
    guildId: "100",
    eventId: source.id,
    userId: "801",
    memberRoleIds: [],
    groupId: "open",
  });
  await f.service.createEventTeam({
    guildId: "100",
    eventId: source.id,
    groupId: "open",
    userId: "801",
    name: "Source team",
  });
  const nextStart = source.startsAtMs + 7 * EVENT_RECURRENCE_DAY_MS;
  const series = await f.service.startRecurrence({
    guildId: "100",
    eventId: source.id,
    frequency: "weekly",
    untilAtMs: nextStart,
    actorUserId: "800",
  });
  await f.service.updateEvent({ ...source, eventId: source.id, title: "Changed later" });
  assert.equal(await f.service.processDueRecurrences(source.endsAtMs! - 1), 0);
  assert.equal(await f.service.processDueRecurrences(source.endsAtMs!), 0);
  await f.service.processDueLifecycle(source.endsAtMs!);
  assert.deepEqual(f.removedRoles, ["801"]);
  assert.equal(await f.service.processDueRecurrences(source.endsAtMs!), 1);
  const events = await f.store.listEvents("100");
  const occurrence = events.find((event) => event.id !== source.id)!;
  assert.equal(occurrence.title, "Weekly scrim");
  assert.equal(occurrence.startsAtMs, nextStart);
  assert.equal(occurrence.endsAtMs, nextStart + 3_600_000);
  assert.equal(occurrence.signupCutoffAtMs, nextStart - 60_000);
  assert.equal(occurrence.reminders[0].sentAtMs, null);
  assert.deepEqual(await f.store.listSignups("100", occurrence.id), []);
  assert.deepEqual(await f.store.listEventTeams("100", occurrence.id), []);
  assert.deepEqual(await f.store.listActiveEventTeamMemberships("100", occurrence.id), []);
  assert.equal((await f.service.listRecurrences("100"))[0].status, "completed");
  assert.equal((await f.service.listRecurrences("100"))[0].id, series.id);
  assert.equal(await f.service.processDueRecurrences(nextStart + 10 * EVENT_RECURRENCE_DAY_MS), 0);
  assert.equal(f.posts(), 2);
});

for (const failedCleanup of ["role", "thread"] as const) {
  test(`recurrence blocks publication for review when previous ${failedCleanup} cleanup fails`, async (t) => {
    const f = fixture();
    t.after(() => f.database.close());
    let source = await f.source();
    if (failedCleanup === "thread") {
      source = { ...source, threadId: "600", threadEnabled: true };
      await f.store.upsertEvent(source);
    }
    await f.service.signup({
      guildId: "100",
      eventId: source.id,
      userId: "801",
      memberRoleIds: [],
      groupId: "open",
    });
    await f.service.startRecurrence({
      guildId: "100",
      eventId: source.id,
      frequency: "weekly",
      untilAtMs: null,
      actorUserId: "800",
    });
    if (failedCleanup === "role")
      f.discord.removeGuildMemberRole = async () => {
        throw new Error("Discord role removal failed");
      };
    else
      f.discord.removeThreadMember = async () => {
        throw new Error("Discord thread removal failed");
      };
    await f.service.processDueLifecycle(source.endsAtMs!);
    assert.equal((await f.store.readEvent("100", source.id))?.status, "ended");
    assert.equal(await f.reconstruct().processDueRecurrences(source.endsAtMs!), 0);
    const [series] = await f.service.listRecurrences("100");
    assert.equal(series.status, "failed");
    assert.match(series.failureReason!, /access cleanup could not be confirmed/);
    assert.equal(series.pendingEventId, null);
    assert.equal((await f.store.listEvents("100")).length, 1);
    assert.equal(f.posts(), 1);
    f.discord.removeGuildMemberRole = async () => {};
    f.discord.removeThreadMember = async () => {};
    assert.equal(
      await f.reconstruct().processDueRecurrences(source.endsAtMs! + 60_000),
      0,
      "a failed series stays blocked after restart until staff review",
    );
  });
}

for (const absent of [
  { name: "departed Guild member", operation: "role", code: 10007 },
  { name: "deleted account", operation: "role", code: 10013 },
  { name: "already absent role", operation: "role", code: 10011 },
  { name: "already absent thread membership", operation: "thread", code: 10007 },
  { name: "deleted thread", operation: "thread", code: 10003 },
] as const) {
  test(`recurrence reconciles a ${absent.name} and publishes the next occurrence`, async (t) => {
    const f = fixture();
    t.after(() => f.database.close());
    const source = { ...(await f.source()), threadId: "600", threadEnabled: true };
    await f.store.upsertEvent(source);
    await f.service.signup({
      guildId: "100",
      eventId: source.id,
      userId: "801",
      memberRoleIds: [],
      groupId: "open",
    });
    await f.service.startRecurrence({
      guildId: "100",
      eventId: source.id,
      frequency: "weekly",
      untilAtMs: null,
      actorUserId: "800",
    });
    let threadRemovals = 0;
    f.discord.removeThreadMember = async () => {
      threadRemovals++;
      if (absent.operation === "thread")
        throw new DiscordApiError("Already absent", 404, JSON.stringify({ code: absent.code }));
    };
    if (absent.operation === "role")
      f.discord.removeGuildMemberRole = async () => {
        throw new DiscordApiError("Already absent", 404, JSON.stringify({ code: absent.code }));
      };
    await f.service.processDueLifecycle(source.endsAtMs!);
    assert.equal(await f.reconstruct().processDueRecurrences(source.endsAtMs!), 1);
    assert.equal((await f.service.listRecurrences("100"))[0].status, "active");
    assert.equal(f.posts(), 2);
    if ((absent.code === 10007 && absent.operation === "role") || absent.code === 10013)
      assert.equal(threadRemovals, 0, "a departed account has no remaining Guild thread access");
    else assert.ok(threadRemovals > 0, "an absent role must not skip thread cleanup");
  });
}

for (const failure of [
  { status: 403, details: '{"code":10007}' },
  { status: 404, details: '{"code":10004}' },
  { status: 404, details: '{"message":"Not found"}' },
  { status: 404, details: "not JSON" },
  { status: 429, details: '{"code":0}' },
  { status: 500, details: '{"code":10007}' },
]) {
  test(`recurrence does not treat ${failure.status} ${failure.details} as confirmed absence`, async (t) => {
    const f = fixture();
    t.after(() => f.database.close());
    const source = await f.source();
    await f.service.signup({
      guildId: "100",
      eventId: source.id,
      userId: "801",
      memberRoleIds: [],
      groupId: "open",
    });
    await f.service.startRecurrence({
      guildId: "100",
      eventId: source.id,
      frequency: "weekly",
      untilAtMs: null,
      actorUserId: "800",
    });
    f.discord.removeGuildMemberRole = async () => {
      throw new DiscordApiError("Cannot confirm cleanup", failure.status, failure.details);
    };
    await f.service.processDueLifecycle(source.endsAtMs!);
    assert.equal(await f.reconstruct().processDueRecurrences(source.endsAtMs!), 0);
    assert.equal((await f.service.listRecurrences("100"))[0].status, "failed");
    assert.equal(f.posts(), 1);
  });
}

test("recurrence accepts a verified deleted thread after cleaning its role, while preserving resource validation", async (t) => {
  let deleted = false;
  const resources = new GuildResourceValidator({
    list: async () => ({ channels: [testChannel("200", 0, "100")], roles: [testRole("300")] }),
    fetchChannel: async () => {
      if (deleted) throw new DiscordApiError("Unknown channel", 404, '{"code":10003}');
      return testChannel("600", 11, "100", "200");
    },
  });
  const f = fixture(resources);
  t.after(() => f.database.close());
  const source = { ...(await f.source()), threadId: "600", threadEnabled: true };
  await f.store.upsertEvent(source);
  await f.service.signup({
    guildId: "100",
    eventId: source.id,
    userId: "801",
    memberRoleIds: [],
    groupId: "open",
  });
  await f.service.startRecurrence({
    guildId: "100",
    eventId: source.id,
    frequency: "weekly",
    untilAtMs: null,
    actorUserId: "800",
  });
  deleted = true;
  await f.service.processDueLifecycle(source.endsAtMs!);
  assert.equal(await f.reconstruct().processDueRecurrences(source.endsAtMs!), 1);
  assert.ok(
    f.removedRoles.includes("801"),
    "a missing thread must not bypass the signup role cleanup",
  );
});

for (const failure of [
  "foreign thread",
  "permission",
  "unknown member on channel lookup",
] as const) {
  test(`recurrence retains the cleanup gate after a ${failure} validation failure`, async (t) => {
    let failed = false;
    const resources = new GuildResourceValidator({
      list: async () => ({ channels: [testChannel("200", 0, "100")], roles: [testRole("300")] }),
      fetchChannel: async () => {
        if (failed && failure === "permission")
          throw new DiscordApiError("Missing access", 403, '{"code":50001}');
        if (failed && failure === "unknown member on channel lookup")
          throw new DiscordApiError("Cannot confirm channel", 404, '{"code":10007}');
        return testChannel("600", 11, failed ? "101" : "100", "200");
      },
    });
    const f = fixture(resources);
    t.after(() => f.database.close());
    const source = { ...(await f.source()), threadId: "600", threadEnabled: true };
    await f.store.upsertEvent(source);
    await f.service.signup({
      guildId: "100",
      eventId: source.id,
      userId: "801",
      memberRoleIds: [],
      groupId: "open",
    });
    await f.service.startRecurrence({
      guildId: "100",
      eventId: source.id,
      frequency: "weekly",
      untilAtMs: null,
      actorUserId: "800",
    });
    failed = true;
    await f.service.processDueLifecycle(source.endsAtMs!);
    assert.equal(await f.reconstruct().processDueRecurrences(source.endsAtMs!), 0);
    assert.equal((await f.service.listRecurrences("100"))[0].status, "failed");
    assert.equal(f.posts(), 1);
  });
}

test("leaving an Event reconciles a role already absent from current Guild resources", async (t) => {
  let deleted = false;
  const resources = new GuildResourceValidator({
    list: async () => ({
      channels: [testChannel("200", 0, "100")],
      roles: deleted ? [] : [testRole("300")],
    }),
    fetchChannel: async () => testChannel("600", 11, "100", "200"),
  });
  const f = fixture(resources);
  t.after(() => f.database.close());
  const source = await f.source();
  await f.service.signup({
    guildId: "100",
    eventId: source.id,
    userId: "801",
    memberRoleIds: [],
    groupId: "open",
  });
  deleted = true;
  f.discord.removeGuildMemberRole = async () => {
    throw new Error("The absent role must not be mutated");
  };
  await f.service.leaveEvent({ guildId: "100", eventId: source.id, userId: "801" });
  assert.deepEqual(await f.store.listSignups("100", source.id), []);
});

test("recurrence endpoints enforce Guild/workspace authorization and paid access before mutation", async (t) => {
  const f = fixture();
  t.after(() => f.database.close());
  const source = await f.source();
  const stores = { events: f.store, guildEntitlements: f.entitlements } as unknown as RuntimeStores;
  const routes = createEventsAdminRoutes({
    stores,
    adminAccess: allowAllAdminAccess,
    discordBotToken: "test-token",
    services: { eventsService: f.service },
  });
  const body = {
    guildId: "100",
    workspaceId: "workspace-1",
    eventId: source.id,
    frequency: "weekly",
    untilAtMs: null,
  };
  const request = (input: object, suffix = "") =>
    new Request(`https://admin.example/admin/api/events/recurrences${suffix}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  const options = { stores, features: ALL_FEATURES_ENABLED, adminAccess: allowAllAdminAccess };
  f.setPaid(false);
  assert.equal((await dispatchAdminRoute(routes, request(body), options))?.status, 402);
  assert.deepEqual(await f.service.listRecurrences("100"), []);
  f.setPaid(true);
  assert.equal(
    (
      await dispatchAdminRoute(routes, request(body), {
        ...options,
        features: { ...ALL_FEATURES_ENABLED, events: false },
      })
    )?.status,
    404,
  );
  const denied = {
    ...options,
    adminAccess: {
      authorize: async (
        _request: Request,
        scope: { guildId?: string | null; workspaceId?: string | null },
      ) => {
        assert.equal(scope.guildId, "100");
        assert.equal(scope.workspaceId, "wrong-workspace");
        return {
          ok: false as const,
          error: { _tag: "Forbidden" as const, message: "Guild is not in this workspace." },
        };
      },
    },
  };
  assert.equal(
    (await dispatchAdminRoute(routes, request({ ...body, workspaceId: "wrong-workspace" }), denied))
      ?.status,
    403,
  );
  assert.deepEqual(await f.service.listRecurrences("100"), []);
  const response = await dispatchAdminRoute(routes, request(body), options);
  assert.equal(response?.status, 200);
  const seriesId = ((await response!.json()) as { series: { id: string } }).series.id;
  assert.equal(
    (await dispatchAdminRoute(routes, request({ guildId: "101", seriesId }, "/stop"), options))
      ?.status,
    400,
  );
  assert.equal((await f.service.listRecurrences("100"))[0].status, "active");
  assert.equal(
    (await dispatchAdminRoute(routes, request({ guildId: "100", seriesId }, "/stop"), options))
      ?.status,
    200,
  );
});

test("paid-plan dormancy preserves a series and resumes only a future occurrence after missed intervals", async (t) => {
  const f = fixture();
  t.after(() => f.database.close());
  const source = await f.source();
  await f.service.startRecurrence({
    guildId: "100",
    eventId: source.id,
    frequency: "daily",
    untilAtMs: null,
    actorUserId: "800",
  });
  await f.service.processDueLifecycle(source.endsAtMs!);
  f.setPaid(false);
  assert.equal(await f.service.processDueRecurrences(source.endsAtMs!), 0);
  assert.equal((await f.store.listEvents("100")).length, 1);
  f.setPaid(true);
  const resumeAt = source.endsAtMs! + 10 * EVENT_RECURRENCE_DAY_MS;
  assert.equal(await f.reconstruct().processDueRecurrences(resumeAt), 1);
  const next = (await f.store.listEvents("100")).find((event) => event.id !== source.id)!;
  assert.ok(next.startsAtMs > resumeAt);
  assert.ok(next.startsAtMs <= resumeAt + EVENT_RECURRENCE_DAY_MS);
  assert.equal((await f.store.listEvents("100")).length, 2);
});

test("an ambiguous publication is retained for review and never automatically posted again", async (t) => {
  const f = fixture();
  t.after(() => f.database.close());
  const source = await f.source();
  await f.service.startRecurrence({
    guildId: "100",
    eventId: source.id,
    frequency: "weekly",
    untilAtMs: null,
    actorUserId: "800",
  });
  await f.service.processDueLifecycle(source.endsAtMs!);
  let attempts = 0;
  f.discord.createChannelMessage = async () => {
    attempts++;
    throw new Error("Response lost after send");
  };
  assert.equal(await f.service.processDueRecurrences(source.endsAtMs!), 0);
  const [series] = await f.service.listRecurrences("100");
  assert.equal(series.status, "failed");
  assert.match(series.failureReason!, /staff review/);
  assert.equal((await f.store.readEvent("100", series.pendingEventId!))?.status, "draft");
  assert.equal(await f.reconstruct().processDueRecurrences(source.endsAtMs! + 120_001), 0);
  assert.equal(attempts, 1);
});

test("a restart recovers the published occurrence checkpoint without making a duplicate post", async (t) => {
  const f = fixture();
  t.after(() => f.database.close());
  const source = await f.source();
  const series = await f.service.startRecurrence({
    guildId: "100",
    eventId: source.id,
    frequency: "weekly",
    untilAtMs: null,
    actorUserId: "800",
  });
  await f.service.processDueLifecycle(source.endsAtMs!);
  const recurrence = f.store.recurrence!;
  const original = (await recurrence.read("100", series.id))!;
  const lease = { token: "crashed-run", nowMs: Date.now() };
  assert.equal(await recurrence.claim(original, lease), true);
  assert.equal(
    await recurrence.prepareOccurrence(original, series.nextStartsAtMs, "recovered-event", lease),
    true,
  );
  const pending = (await recurrence.read("100", series.id))!;
  const draft = await f.service.createEvent(
    {
      ...source,
      startsAtMs: series.nextStartsAtMs,
      endsAtMs: series.nextStartsAtMs + 3_600_000,
      signupCutoffAtMs: series.nextStartsAtMs,
    },
    pending.pendingEventId!,
  );
  assert.equal(await recurrence.linkOccurrence("100", series.id, draft.id, lease), true);
  assert.equal(await recurrence.markPublicationAttempted(pending, lease), true);
  await f.service.publishEvent({ guildId: "100", eventId: draft.id, actorUserId: "800" });
  f.database.execRaw("UPDATE event_recurrence_series SET lease_until_ms = 0");
  assert.equal(await f.reconstruct().processDueRecurrences(source.endsAtMs!), 0);
  const [saved] = await f.service.listRecurrences("100");
  assert.equal(saved.lastEventId, draft.id);
  assert.equal(saved.pendingEventId, null);
  assert.equal(saved.status, "active");
  assert.equal(f.posts(), 2);
  await assert.rejects(
    () =>
      f.service.startRecurrence({
        guildId: "100",
        eventId: draft.id,
        frequency: "daily",
        untilAtMs: null,
        actorUserId: "800",
      }),
    /already belongs/,
  );
});

test("series admission and stopping enforce scope, published state, end times, and immutable recurrence settings", async (t) => {
  const f = fixture();
  t.after(() => f.database.close());
  const source = await f.source();
  const input = {
    guildId: "100",
    eventId: source.id,
    frequency: "weekly" as const,
    untilAtMs: null,
    actorUserId: "800",
  };
  await assert.rejects(() => f.service.startRecurrence({ ...input, guildId: "101" }), /Publish/);
  await assert.rejects(
    () => f.service.startRecurrence({ ...input, untilAtMs: source.startsAtMs }),
    /final start/,
  );
  await f.store.upsertEvent({ ...source, endsAtMs: null });
  await assert.rejects(() => f.service.startRecurrence(input), /end time/);
  await f.store.upsertEvent(source);
  const series = await f.service.startRecurrence(input);
  assert.equal((await f.service.startRecurrence(input)).id, series.id);
  await assert.rejects(
    () => f.service.startRecurrence({ ...input, frequency: "daily" }),
    /already belongs/,
  );
  await assert.rejects(() => f.service.stopRecurrence("101", series.id), /missing/);
  await f.service.stopRecurrence("100", series.id);
  await f.service.processDueLifecycle(source.endsAtMs!);
  assert.equal(await f.service.processDueRecurrences(source.endsAtMs!), 0);
  assert.equal((await f.store.readEvent("100", source.id))?.status, "ended");
  assert.equal((await f.service.listRecurrences("100"))[0].status, "stopped");
});
