import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresEventStore } from "../src/runtime/postgres/postgres-event-store";
import { createPostgresDatabaseCapabilityFromEnvironment } from "../src/runtime/postgres/postgres-capability";
import { initializePostgresSchema } from "../src/runtime/postgres/postgres-schema";
import { EventsService, type EventsDiscordApi } from "../src/services/events-service";

const postgresUrl = process.env.TEST_POSTGRES_URL;
test(
  "PostgreSQL recurring Event cursors fence concurrent publishers and retain occurrence ownership",
  { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
  async () => {
    assert.ok(postgresUrl);
    const url = new URL(postgresUrl);
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || !url.pathname.endsWith("_test"))
      throw new Error("A local PostgreSQL database ending in _test is required.");
    const database = createPostgresDatabaseCapabilityFromEnvironment({
      DATABASE_URL: postgresUrl,
      NODE_ENV: "test",
      PG_POOL_MAX: "4",
    });
    try {
      await database.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
      await initializePostgresSchema(database);
      const store = createPostgresEventStore(database);
      const discord: EventsDiscordApi = {
        createChannelMessage: async (channelId) => ({
          id: "500",
          channel_id: channelId,
          content: "",
        }),
        editChannelMessage: async (channelId, id) => ({ id, channel_id: channelId, content: "" }),
        createThread: async () => ({ id: "600" }),
        addThreadMember: async () => {},
        removeThreadMember: async () => {},
        addGuildMemberRole: async () => {},
        removeGuildMemberRole: async () => {},
      };
      const service = new EventsService(store, discord);
      const start = Date.now() + 86_400_000;
      const source = await service.createEvent({
        guildId: "100",
        templateId: null,
        title: "Daily game",
        description: "Bring friends",
        channelId: "200",
        startsAtMs: start,
        endsAtMs: start + 3_600_000,
        signupCutoffAtMs: start,
        signupMode: "single_choice",
        threadEnabled: false,
        waitlistedMembersJoinThread: false,
        groups: [
          {
            id: "all",
            label: "All",
            emoji: null,
            capacity: null,
            waitlistEnabled: false,
            allowedRoleIds: [],
            blockedRoleIds: [],
            grantRoleId: null,
          },
        ],
        reminders: [],
      });
      await service.publishEvent({ guildId: "100", eventId: source.id, actorUserId: "800" });
      const series = await service.startRecurrence({
        guildId: "100",
        eventId: source.id,
        frequency: "daily",
        untilAtMs: null,
        actorUserId: "800",
      });
      const recurrence = store.recurrence!;
      const record = (await recurrence.read("100", series.id))!;
      assert.equal((await recurrence.readForEvent("100", source.id))?.id, series.id);
      assert.equal(await recurrence.readForEvent("101", source.id), null);
      assert.deepEqual(await recurrence.listDue(source.endsAtMs! - 1, 10), []);
      assert.equal((await recurrence.listDue(source.endsAtMs!, 10)).length, 1);
      const now = Date.now();
      const claims = await Promise.all([
        recurrence.claim(record, { token: "first", nowMs: now }),
        recurrence.claim(record, { token: "second", nowMs: now }),
      ]);
      assert.equal(claims.filter(Boolean).length, 1);
      const token = claims[0] ? "first" : "second";
      const lease = { token, nowMs: now };
      assert.equal(
        await recurrence.prepareOccurrence(record, series.nextStartsAtMs, "next-event", lease),
        true,
      );
      const pending = (await recurrence.read("100", series.id))!;
      const draft = await service.createEvent(
        {
          ...source,
          startsAtMs: series.nextStartsAtMs,
          endsAtMs: series.nextStartsAtMs + 3_600_000,
          signupCutoffAtMs: series.nextStartsAtMs,
        },
        "next-event",
      );
      assert.equal(await recurrence.linkOccurrence("100", series.id, draft.id, lease), true);
      assert.equal((await recurrence.readForEvent("100", draft.id))?.id, series.id);
      assert.equal(await recurrence.markPublicationAttempted(pending, lease), true);
      await recurrence.release("100", series.id, token);
      assert.equal(
        await recurrence.finish(pending, series.nextStartsAtMs + 86_400_000, false, lease),
        false,
      );
      assert.equal(await recurrence.fail(pending, "stale publisher", lease), false);
      assert.equal((await recurrence.read("100", series.id))?.status, "active");
      assert.equal((await recurrence.stop("100", series.id, now + 1))?.status, "stopped");
      // Old image updates do not clear the new ownership column.
      await store.upsertEvent({ ...draft, title: "Edited occurrence" });
      assert.equal((await recurrence.readForEvent("100", draft.id))?.id, series.id);
    } finally {
      await database.close();
    }
  },
);
