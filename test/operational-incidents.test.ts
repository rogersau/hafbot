import assert from "node:assert/strict";
import test from "node:test";
import { createSqliteOperationalIncidentStore } from "./support/sqlite/runtime/sqlite-operational-incident-store";
import { SqliteD1Database } from "./support/sqlite-d1-database";
import { OperationalIncidentService } from "../src/operations/incidents";

const key = {
  feature: "player-count" as const,
  resourceKind: "server",
  resourceId: "server_1",
  condition: "offline",
};

function failure(service: OperationalIncidentService, observationId: string, now: number) {
  return service.observeFailure({
    guildId: "guild_1",
    key,
    observationId,
    summaryCode: "player_count_server_offline",
    safeArgs: {
      serverId: "server_1",
      consecutiveFailureCount: 3,
      lastSuccessfulFetchAtMs: null,
      providerErrorCategory: "provider_unavailable",
    },
    remediationCode: "refresh_player_count_server",
    observedAtMs: now,
  });
}

test("operational incidents deduplicate observations and preserve history across recovery", async (t) => {
  const database = new SqliteD1Database();
  t.after(() => database.close());
  const service = new OperationalIncidentService(createSqliteOperationalIncidentStore(database.d1));
  const first = await failure(service, "attempt-1", 100);
  const duplicate = await failure(service, "attempt-1", 200);
  assert.equal(duplicate.occurrenceCount, 1);
  assert.equal(first.id, duplicate.id);

  const second = await failure(service, "attempt-2", 300);
  assert.equal(second.occurrenceCount, 2);
  assert.equal((await service.list({ guildId: "guild_1" })).length, 1);

  const resolved = await service.observeHealthy({ guildId: "guild_1", key, observedAtMs: 400 });
  assert.equal(resolved?.status, "resolved");
  assert.equal((await service.list({ guildId: "guild_1" })).length, 0);
  assert.equal((await service.list({ guildId: "guild_1", status: "resolved" })).length, 1);

  const reopened = await failure(service, "attempt-3", 500);
  assert.equal(reopened.status, "open");
  assert.equal(reopened.openSinceMs, 500);
  assert.equal(reopened.firstSeenAtMs, 100);
});

test("incident definitions reject arbitrary or secret-bearing safe arguments", async (t) => {
  const database = new SqliteD1Database();
  t.after(() => database.close());
  const service = new OperationalIncidentService(createSqliteOperationalIncidentStore(database.d1));
  await assert.rejects(
    service.observeFailure({
      guildId: "guild_1",
      key: {
        feature: "webhooks",
        resourceKind: "destination",
        resourceId: "destination_1",
        condition: "delivery-failing",
      },
      summaryCode: "webhook_destination_delivery_failing",
      safeArgs: {
        publicId: "proxy_1",
        destinationId: "destination_1",
        failureReasonCode: "provider_rejected",
        consecutiveFailureCount: 3,
        lastStatusFamily: "4xx",
        token: "should-not-be-accepted",
      } as never,
      remediationCode: "review_webhook_destination",
    }),
  );
});

test("durable incident history survives service reconstruction and duplicate failure after resolution", async (t) => {
  const database = new SqliteD1Database();
  t.after(() => database.close());
  const store = createSqliteOperationalIncidentStore(database.d1);
  const first = await failure(new OperationalIncidentService(store), "failure-1", 100);
  const recovered = new OperationalIncidentService(store);
  await recovered.observeHealthy({
    guildId: "guild_1",
    key,
    observationId: "healthy-1",
    observedAtMs: 200,
  });
  const duplicate = await failure(recovered, "failure-1", 300);
  assert.equal(duplicate.status, "resolved");
  assert.equal(duplicate.occurrenceCount, 1);
  assert.equal(duplicate.version, 2);
  const reopened = await failure(recovered, "failure-2", 400);
  assert.equal(reopened.id, first.id);
  assert.equal(reopened.status, "open");
  assert.equal(reopened.firstSeenAtMs, 100);
  assert.equal(reopened.openSinceMs, 400);
  assert.equal(reopened.occurrenceCount, 2);
  assert.equal(reopened.version, 3);
  assert.deepEqual(
    (await recovered.listEvents("guild_1", first.id)).map((event) => event.eventType),
    ["reopened", "resolved", "opened"],
  );
});

test("failed incident history checkpoint leaves committed failure and replay counts another occurrence", async (t) => {
  const database = new SqliteD1Database();
  t.after(() => database.close());
  database.execRaw(`CREATE TRIGGER fail_incident_history BEFORE INSERT ON operational_incident_events
    BEGIN SELECT RAISE(ABORT, 'history unavailable'); END;`);
  const store = createSqliteOperationalIncidentStore(database.d1);
  const service = new OperationalIncidentService(store);
  await assert.rejects(failure(service, "failure-1", 100));
  const [committed] = await service.list({ guildId: "guild_1" });
  assert.equal(committed.status, "open");
  assert.equal(committed.occurrenceCount, 1);
  assert.equal((await service.listEvents("guild_1", committed.id)).length, 0);

  database.execRaw("DROP TRIGGER fail_incident_history");
  const recovered = new OperationalIncidentService(store);
  const replayed = await failure(recovered, "failure-1", 200);
  assert.equal(replayed.id, committed.id);
  assert.equal(replayed.occurrenceCount, 2);
  assert.equal(replayed.version, 2);
  assert.deepEqual(
    (await recovered.listEvents("guild_1", committed.id)).map((event) => event.eventType),
    ["observed"],
  );
});

test("failed resolution history checkpoint leaves resolved state and healthy retry does not repair history", async (t) => {
  const database = new SqliteD1Database();
  t.after(() => database.close());
  const store = createSqliteOperationalIncidentStore(database.d1);
  const service = new OperationalIncidentService(store);
  const first = await failure(service, "failure-1", 100);
  database.execRaw(`CREATE TRIGGER fail_incident_history BEFORE INSERT ON operational_incident_events
    BEGIN SELECT RAISE(ABORT, 'history unavailable'); END;`);
  await assert.rejects(
    service.observeHealthy({
      guildId: "guild_1",
      key,
      observationId: "healthy-1",
      observedAtMs: 200,
    }),
  );
  database.execRaw("DROP TRIGGER fail_incident_history");
  const recovered = new OperationalIncidentService(store);
  const resolved = await recovered.observeHealthy({
    guildId: "guild_1",
    key,
    observationId: "healthy-1",
    observedAtMs: 300,
  });
  assert.equal(resolved?.status, "resolved");
  assert.equal(resolved?.resolvedAtMs, 200);
  assert.equal(resolved?.version, 2);
  assert.deepEqual(
    (await recovered.listEvents("guild_1", first.id)).map((event) => event.eventType),
    ["opened"],
  );
});
