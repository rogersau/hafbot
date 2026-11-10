import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import type {
  GatewaySocket,
  GatewaySocketFactory,
  GatewaySocketHandlers,
} from "../src/node/gateway-socket";
import {
  createPostgresGatewaySupervisor,
  type PostgresGatewaySupervisorOptions,
} from "../src/node/postgres-gateway-supervisor";
import type { GatewaySnapshot } from "../src/runtime/contracts";
import {
  createPostgresDatabaseCapabilityFromEnvironment,
  type PostgresDatabaseCapability,
} from "../src/runtime/postgres/postgres-capability";
import {
  createPostgresGatewayStateStore,
  GatewayLeaseLostError,
  type PostgresGatewayStateStore,
} from "../src/runtime/postgres/postgres-gateway-store";
import { createPostgresJobQueue } from "../src/runtime/postgres/postgres-job-queue";
import {
  createPostgresLeaseStore,
  type PostgresLease,
  type PostgresLeaseStore,
} from "../src/runtime/postgres/postgres-lease-store";
import {
  applyPostgresMigrations,
  readPostgresMigrations,
} from "../src/runtime/postgres/postgres-migrations";

const postgresUrl = process.env.TEST_POSTGRES_URL;
const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;

test("Gateway cursor regression: scheduled heartbeat cannot commit a failed pending dispatch", async (t) => {
  const entered = deferred();
  const release = deferred();
  const heartbeatWritten = deferred();
  const leadershipLost = deferred();
  const sockets: FakeGatewaySocket[] = [];
  let stored = committedSnapshot();
  const store: PostgresGatewayStateStore = {
    read: async () => ({
      ...stored,
      lastHeartbeatAtMs: null,
      lastHeartbeatAckAtMs: null,
      fencingGeneration: 1,
      updatedAtMs: 0,
    }),
    async write(_identityId, _lease, snapshot, input) {
      // This permissive fake also detects speculative progress in the supervisor.
      stored = { ...snapshot };
      if (input?.lastHeartbeatAtMs !== undefined) heartbeatWritten.resolve();
      return true;
    },
    async dispatch() {
      entered.resolve();
      await release.promise;
      throw new Error("enqueue failed");
    },
    clearResumeState: async () => {},
    cleanupMessageAuditContext: async () => 0,
  };
  const createSupervisor = () =>
    createPostgresGatewaySupervisor({
      store,
      leases: {
        acquire: async (name: string, ownerId: string) => ({
          name,
          ownerId,
          leaseToken: "test-lease",
          fencingGeneration: 1,
          leaseExpiresAt: new Date(Date.now() + 120_000),
        }),
        renew: async () => null,
        release: async () => true,
      } as never,
      listIdentities: async () => [
        { identityId: "standard", botUserId: "bot-1", token: "fake-token" },
      ],
      leaseMs: 120_000,
      tickIntervalMs: 60_000,
      socketFactory: createFakeSocketFactory(sockets),
      random: () => 0.5,
      onError: () => leadershipLost.resolve(),
    });
  const first = createSupervisor();
  const replacement = createSupervisor();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await first.start();
    sockets[0]!.emit({ op: 10, d: { heartbeat_interval: 10_000 } });
    await flushMessages();
    assert.equal(readSentOpcode(sockets[0]!, 0), 6);
    sockets[0]!.emit({ op: 0, t: "MESSAGE_CREATE", s: 2, d: { id: "pending" } });
    await withWatchdog(entered.promise);
    t.mock.timers.tick(5_000);
    await withWatchdog(heartbeatWritten.promise);
    await flushMessages();
    assert.deepEqual(JSON.parse(sockets[0]!.sent[1]!), { op: 1, d: 2 });
    assert.equal(stored.lastSequence, 1);
    assert.equal(first.status().identities[0]?.lastSequence, 1);
    release.resolve();
    await withWatchdog(leadershipLost.promise);
    assert.equal(first.status().identities[0]?.leadership, "standby");
    await first.stop();
    assert.equal(first.status().identities.length, 0);
    assert.equal(stored.lastSequence, 1, "a failed dispatch must retain committed cursor 1");
    await replacement.start();
    sockets[1]!.emit({ op: 10, d: { heartbeat_interval: 10_000 } });
    await flushMessages();
    assert.deepEqual(JSON.parse(sockets[1]!.sent[0]!), {
      op: 6,
      d: { token: "fake-token", session_id: "session-1", seq: 1 },
    });
  } finally {
    release.resolve();
    await first.stop();
    await replacement.stop();
    t.mock.timers.reset();
  }
});

for (const rollback of [true, false]) {
  test(
    `Gateway cursor regression: real PostgreSQL ${rollback ? "rollback cannot advance" : "delayed metadata cannot regress"} committed progress`,
    { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
    async () => {
      assert.ok(postgresUrl);
      assertSafeTestDatabase(postgresUrl);
      const database = createTestDatabase(postgresUrl);
      const entered = deferred();
      const release = deferred();
      const pending: Promise<unknown>[] = [];
      try {
        await resetAndMigrate(database);
        const jobs = createPostgresJobQueue(database);
        const leases = createPostgresLeaseStore(database);
        const store = createPostgresGatewayStateStore(database, {
          ...jobs,
          async enqueue(input, transaction) {
            entered.resolve();
            await release.promise;
            if (rollback) throw new Error("enqueue failed");
            return jobs.enqueue(input, transaction);
          },
        });
        const nowMs = Date.now();
        const lease = await leases.acquire(
          "gateway:standard",
          "cursor-test",
          120_000,
          new Date(nowMs),
        );
        assert.ok(lease);
        await seedCommittedSession(store, lease, nowMs);
        const acceptance = store.dispatch({
          identityId: "standard",
          botUserId: "bot-1",
          lease,
          sessionId: "session-1",
          sequence: 2,
          type: "MESSAGE_CREATE",
          data: { id: "pending", guild_id: "guild-1", author: { id: "author-1" } },
          nowMs,
        });
        const outcome = acceptance.then(
          () => null,
          (error: unknown) => error,
        );
        pending.push(outcome);
        await withWatchdog(entered.promise);
        const metadata = store.write(
          "standard",
          lease,
          {
            ...committedSnapshot(),
            lastSequence: rollback ? 2 : 1,
          },
          { nowMs, lastHeartbeatAtMs: nowMs },
        );
        pending.push(metadata);
        await waitForDatabaseLock(database);
        release.resolve();
        if (rollback) assert.match(String(await outcome), /enqueue failed/);
        else assert.equal(await outcome, null);
        assert.equal(await metadata, true);
        assert.equal((await store.read("standard"))?.lastSequence, rollback ? 1 : 2);
        assert.equal(
          (await jobs.claim({ ownerId: "inspect", queueNames: ["gateway-events"] })).length,
          rollback ? 0 : 1,
        );
        const context = await database.query<{ count: number }>(
          "SELECT COUNT(*)::INTEGER AS count FROM gateway_message_audit_context WHERE message_id = 'pending'",
        );
        assert.equal(context[0]?.count, rollback ? 0 : 1);
      } finally {
        release.resolve();
        await Promise.allSettled(pending);
        await database.close();
      }
    },
  );
}

for (const rollback of [false, true]) {
  test(
    `Gateway cursor regression: takeover waits for pending dispatch ${rollback ? "rollback" : "commit"} and resumes its committed cursor`,
    { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
    async () => {
      assert.ok(postgresUrl);
      assertSafeTestDatabase(postgresUrl);
      const database = createTestDatabase(postgresUrl);
      const entered = deferred();
      const release = deferred();
      const pending: Promise<unknown>[] = [];
      let replacement: ReturnType<typeof createPostgresGatewaySupervisor> | undefined;
      try {
        await resetAndMigrate(database);
        const jobs = createPostgresJobQueue(database);
        const leases = createPostgresLeaseStore(database);
        const store = createPostgresGatewayStateStore(database, {
          ...jobs,
          async enqueue(input, transaction) {
            entered.resolve();
            await release.promise;
            if (rollback) throw new Error("enqueue failed");
            return jobs.enqueue(input, transaction);
          },
        });
        const nowMs = Date.now();
        const lease = await leases.acquire(
          "gateway:standard",
          "old-owner",
          120_000,
          new Date(nowMs),
        );
        assert.ok(lease);
        await seedCommittedSession(store, lease, nowMs);
        const input = {
          identityId: "standard",
          botUserId: "bot-1",
          lease,
          sessionId: "session-1",
          sequence: 2,
          type: "MESSAGE_CREATE",
          data: { id: "takeover-message", guild_id: "guild-1", author: { id: "author-1" } },
          nowMs,
        };
        const outcome = store.dispatch(input).then(
          () => null,
          (error: unknown) => error,
        );
        pending.push(outcome);
        await withWatchdog(entered.promise);
        const sockets: FakeGatewaySocket[] = [];
        const errors: unknown[] = [];
        replacement = fixtureSupervisor(store, leases, sockets, {
          now: () => nowMs + 120_001,
          onError: (error) => errors.push(error),
        });
        const starting = replacement.start();
        pending.push(starting);
        await waitForDatabaseLock(database);
        assert.equal(sockets.length, 0);
        // The dispatch owns the lease lock. Release it before awaiting takeover.
        release.resolve();
        if (rollback) assert.match(String(await outcome), /enqueue failed/);
        else assert.equal(await outcome, null);
        await starting;
        sockets[0]!.emit({ op: 10, d: { heartbeat_interval: 45_000 } });
        await waitFor(() => sockets[0]!.sent.length === 1);
        assert.deepEqual(JSON.parse(sockets[0]!.sent[0]!), {
          op: 6,
          d: { token: "fake-token", session_id: "session-1", seq: rollback ? 1 : 2 },
        });
        assert.equal(replacement.status().identities[0]?.fencingGeneration, 2);
        assert.deepEqual(errors, []);

        const committed = await store.read("standard");
        await assert.rejects(store.dispatch({ ...input, sequence: 3 }), GatewayLeaseLostError);
        await assert.rejects(
          store.clearResumeState("standard", lease, nowMs),
          GatewayLeaseLostError,
        );
        assert.equal(
          await store.write(
            "standard",
            lease,
            {
              ...committedSnapshot(),
              sessionId: "stale-session",
              lastSequence: 99,
            },
            { nowMs },
          ),
          false,
        );
        assert.deepEqual(await store.read("standard"), committed);
        assert.equal(
          (
            await jobs.claim({
              ownerId: "inspect",
              queueNames: ["gateway-events"],
              now: new Date(nowMs + 120_002),
            })
          ).length,
          rollback ? 0 : 1,
        );
      } finally {
        release.resolve();
        await Promise.allSettled(pending);
        await replacement?.stop();
        await database.close();
      }
    },
  );
}

test(
  "Gateway cursor regression: RESUMED and unhandled dispatches commit progress; READY atomically replaces the session despite delayed metadata",
  { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
  async () => {
    assert.ok(postgresUrl);
    assertSafeTestDatabase(postgresUrl);
    const database = createTestDatabase(postgresUrl);
    const entered = deferred();
    const release = deferred();
    const unhandledEntered = deferred();
    const unhandledRelease = deferred();
    let supervisor: ReturnType<typeof createPostgresGatewaySupervisor> | undefined;
    try {
      await resetAndMigrate(database);
      const jobs = createPostgresJobQueue(database);
      const leases = createPostgresLeaseStore(database);
      const store = createPostgresGatewayStateStore(database, jobs);
      const lease = await leases.acquire("gateway:standard", "seed", 120_000);
      assert.ok(lease);
      await seedCommittedSession(store, lease, Date.now());
      await leases.release(lease);
      const sockets: FakeGatewaySocket[] = [];
      const errors: unknown[] = [];
      supervisor = fixtureSupervisor(
        {
          ...store,
          async dispatch(input) {
            if (input.type === "UNHANDLED_TEST_EVENT") {
              unhandledEntered.resolve();
              await unhandledRelease.promise;
            }
            if (input.type === "READY") {
              entered.resolve();
              await release.promise;
            }
            return store.dispatch(input);
          },
        },
        leases,
        sockets,
        { onError: (error) => errors.push(error) },
      );
      await supervisor.start();
      sockets[0]!.emit({ op: 10, d: { heartbeat_interval: 45_000 } });
      await waitFor(() => sockets[0]!.sent.length === 1);
      sockets[0]!.emit({ op: 0, t: "RESUMED", s: 2, d: {} });
      await waitFor(async () => (await store.read("standard"))?.status === "ready");
      assert.deepEqual(await readResumeTuple(store), ["session-1", "wss://resume.example.test", 2]);
      sockets[0]!.emit({ op: 0, t: "UNHANDLED_TEST_EVENT", s: 3, d: {} });
      await withWatchdog(unhandledEntered.promise);
      assert.equal(supervisor.status().identities[0]?.lastSequence, 2);
      assert.deepEqual(await readResumeTuple(store), ["session-1", "wss://resume.example.test", 2]);
      unhandledRelease.resolve();
      await waitFor(() => supervisor!.status().identities[0]?.lastSequence === 3);
      assert.deepEqual(await readResumeTuple(store), ["session-1", "wss://resume.example.test", 3]);
      const olderMetadata = { ...supervisor.status().identities[0]! };
      sockets[0]!.emit({
        op: 0,
        t: "READY",
        s: 0,
        d: { session_id: "session-2", resume_gateway_url: "wss://new-resume.example.test" },
      });
      await withWatchdog(entered.promise);
      assert.deepEqual(await readResumeTuple(store), ["session-1", "wss://resume.example.test", 3]);
      assert.equal(supervisor.status().identities[0]?.sessionId, "session-1");
      release.resolve();
      await waitFor(() => supervisor!.status().identities[0]?.sessionId === "session-2");
      assert.deepEqual(await readResumeTuple(store), [
        "session-2",
        "wss://new-resume.example.test",
        0,
      ]);
      const currentLease = await leases.read("gateway:standard");
      assert.ok(currentLease);
      assert.equal(await store.write("standard", currentLease, olderMetadata), true);
      assert.deepEqual(await readResumeTuple(store), [
        "session-2",
        "wss://new-resume.example.test",
        0,
      ]);
      assert.deepEqual(await jobs.stats(), []);
      assert.deepEqual(errors, []);
      sockets[0]!.emit({
        op: 0,
        t: "READY",
        d: {
          session_id: "session-without-sequence",
          resume_gateway_url: "wss://invalid-resume.example.test",
        },
      });
      await waitFor(() => supervisor!.status().identities[0]?.leadership === "standby");
      assert.deepEqual(await readResumeTuple(store), [
        "session-2",
        "wss://new-resume.example.test",
        0,
      ]);
      assert.match(String(errors[0]), /READY requires a session and its sequence/);
    } finally {
      release.resolve();
      unhandledRelease.resolve();
      await supervisor?.stop();
      await database.close();
    }
  },
);

for (const trigger of ["invalid session", "non-resumable close"] as const) {
  test(
    `Gateway cursor regression: ${trigger} clears durable progress before replacement IDENTIFY and resists delayed metadata`,
    { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
    async (t) => {
      assert.ok(postgresUrl);
      assertSafeTestDatabase(postgresUrl);
      const database = createTestDatabase(postgresUrl);
      const entered = deferred();
      const release = deferred();
      let supervisor: ReturnType<typeof createPostgresGatewaySupervisor> | undefined;
      try {
        await resetAndMigrate(database);
        const jobs = createPostgresJobQueue(database);
        const leases = createPostgresLeaseStore(database);
        const store = createPostgresGatewayStateStore(database, jobs);
        const seedLease = await leases.acquire("gateway:standard", "seed", 120_000);
        assert.ok(seedLease);
        await seedCommittedSession(store, seedLease, Date.now());
        await leases.release(seedLease);
        let nowMs = Date.now();
        const sockets: FakeGatewaySocket[] = [];
        const errors: unknown[] = [];
        t.mock.timers.enable({ apis: ["setInterval"] });
        supervisor = fixtureSupervisor(
          {
            ...store,
            async clearResumeState(...args) {
              entered.resolve();
              await release.promise;
              await store.clearResumeState(...args);
            },
          },
          leases,
          sockets,
          { tickIntervalMs: 1_000, now: () => nowMs, onError: (error) => errors.push(error) },
        );
        await supervisor.start();
        sockets[0]!.emit({ op: 10, d: { heartbeat_interval: 45_000 } });
        await waitFor(() => sockets[0]!.sent.length === 1);
        if (trigger === "invalid session") sockets[0]!.emit({ op: 9, d: false });
        else sockets[0]!.close(4007);
        await withWatchdog(entered.promise);
        nowMs += 1_000;
        t.mock.timers.tick(1_000);
        await flushMessages();
        assert.equal(sockets.length, 1);
        assert.deepEqual(await readResumeTuple(store), [
          "session-1",
          "wss://resume.example.test",
          1,
        ]);
        release.resolve();
        await waitFor(async () => (await store.read("standard"))?.status === "backoff");
        assert.deepEqual(await readResumeTuple(store), [null, null, null]);
        const currentLease = await leases.read("gateway:standard");
        assert.ok(currentLease);
        await store.write("standard", currentLease, committedSnapshot(), { nowMs });
        assert.deepEqual(await readResumeTuple(store), [null, null, null]);
        nowMs += 60_000;
        t.mock.timers.tick(1_000);
        await waitFor(() => sockets.length === 2);
        sockets[1]!.emit({ op: 10, d: { heartbeat_interval: 45_000 } });
        await waitFor(() => sockets[1]!.sent.length === 1);
        assert.equal(readSentOpcode(sockets[1]!, 0), 2);
        assert.equal(supervisor.status().identities[0]?.lastSequence, null);
        assert.deepEqual(await jobs.stats(), []);
        assert.deepEqual(errors, []);
      } finally {
        release.resolve();
        await supervisor?.stop();
        t.mock.timers.reset();
        await database.close();
      }
    },
  );
}

for (const fencedReset of [false, true]) {
  test(`Gateway cursor regression: a late HELLO cannot send on a closed socket and ${fencedReset ? "a fenced reset loses leadership" : "replacement waits for reset"}`, async (t) => {
    const entered = deferred();
    const release = deferred();
    const sockets: FakeGatewaySocket[] = [];
    const errors: unknown[] = [];
    let stored = committedSnapshot();
    let writes = 0;
    let nowMs = Date.now();
    const lease: PostgresLease = {
      name: "gateway:standard",
      ownerId: "late-hello",
      leaseToken: "late-hello-token",
      fencingGeneration: 1,
      leaseExpiresAt: new Date(nowMs + 120_000),
    };
    const store: PostgresGatewayStateStore = {
      read: async () => ({
        ...stored,
        lastHeartbeatAtMs: null,
        lastHeartbeatAckAtMs: null,
        fencingGeneration: 1,
        updatedAtMs: nowMs,
      }),
      async write() {
        writes += 1;
        if (writes === 2) {
          entered.resolve();
          await release.promise;
        }
        return true;
      },
      async clearResumeState() {
        if (fencedReset) throw new GatewayLeaseLostError("standard");
        stored = { ...stored, sessionId: null, resumeGatewayUrl: null, lastSequence: null };
      },
      dispatch: async () => null,
      cleanupMessageAuditContext: async () => 0,
    };
    const supervisor = fixtureSupervisor(
      store,
      {
        acquire: async () => lease,
        renew: async () => lease,
        release: async () => true,
        read: async () => lease,
      },
      sockets,
      { tickIntervalMs: 1_000, now: () => nowMs, onError: (error) => errors.push(error) },
    );
    t.mock.timers.enable({ apis: ["setInterval"] });
    try {
      await supervisor.start();
      sockets[0]!.emit({ op: 10, d: { heartbeat_interval: 45_000 } });
      await withWatchdog(entered.promise);
      sockets[0]!.close(4007);
      nowMs += 1_000;
      t.mock.timers.tick(1_000);
      await flushMessages();
      assert.equal(sockets.length, 1);
      release.resolve();
      if (fencedReset) {
        await waitFor(() => supervisor.status().identities[0]?.leadership === "standby");
        assert.deepEqual(await readResumeTuple(store), [
          "session-1",
          "wss://resume.example.test",
          1,
        ]);
        assert.ok(errors[0] instanceof GatewayLeaseLostError);
      } else {
        await waitFor(() => supervisor.status().identities[0]?.status === "backoff");
        assert.deepEqual(await readResumeTuple(store), [null, null, null]);
        nowMs += 60_000;
        t.mock.timers.tick(1_000);
        await waitFor(() => sockets.length === 2);
        sockets[1]!.emit({ op: 10, d: { heartbeat_interval: 45_000 } });
        await waitFor(() => sockets[1]!.sent.length === 1);
        assert.equal(readSentOpcode(sockets[1]!, 0), 2);
        assert.deepEqual(errors, []);
      }
      assert.deepEqual(sockets[0]!.sent, []);
    } finally {
      release.resolve();
      await supervisor.stop();
      t.mock.timers.reset();
    }
  });
}

function fixtureSupervisor(
  store: PostgresGatewayStateStore,
  leases: PostgresLeaseStore,
  sockets: FakeGatewaySocket[],
  input: Partial<PostgresGatewaySupervisorOptions> = {},
) {
  return createPostgresGatewaySupervisor({
    store,
    leases,
    listIdentities: async () => [
      { identityId: "standard", botUserId: "bot-1", token: "fake-token" },
    ],
    leaseMs: 120_000,
    tickIntervalMs: 60_000,
    random: () => 0.5,
    socketFactory: createFakeSocketFactory(sockets),
    ...input,
  });
}

async function readResumeTuple(store: PostgresGatewayStateStore) {
  const snapshot = await store.read("standard");
  assert.ok(snapshot);
  return [snapshot.sessionId, snapshot.resumeGatewayUrl, snapshot.lastSequence];
}

function committedSnapshot(): GatewaySnapshot {
  return {
    status: "ready",
    sessionId: "session-1",
    resumeGatewayUrl: "wss://resume.example.test",
    lastSequence: 1,
    backoffAttempt: 0,
    lastError: null,
    heartbeatIntervalMs: 10_000,
  };
}

async function seedCommittedSession(
  store: PostgresGatewayStateStore,
  lease: PostgresLease,
  nowMs: number,
): Promise<void> {
  assert.equal(await store.write("standard", lease, committedSnapshot(), { nowMs }), true);
  assert.deepEqual(await readResumeTuple(store), [null, null, null]);
  await store.dispatch({
    identityId: "standard",
    botUserId: "bot-1",
    lease,
    sessionId: "session-1",
    sequence: 1,
    ready: { sessionId: "session-1", resumeGatewayUrl: "wss://resume.example.test" },
    type: "READY",
    data: { session_id: "session-1", resume_gateway_url: "wss://resume.example.test" },
    nowMs,
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function withWatchdog<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = realSetTimeout(() => reject(new Error("Gateway test watchdog expired")), 5_000);
      }),
    ]);
  } finally {
    realClearTimeout(timer);
  }
}

async function flushMessages(): Promise<void> {
  await new Promise<void>((resolveFlush) => setImmediate(resolveFlush));
}

async function waitForDatabaseLock(database: PostgresDatabaseCapability, count = 1): Promise<void> {
  await waitFor(async () => {
    const rows = await database.query<{ count: number }>(
      `SELECT COUNT(*)::INTEGER AS count FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND (query LIKE '%gateway_sessions%' OR query LIKE '%scheduler_leases%')`,
    );
    return (rows[0]?.count ?? 0) >= count;
  });
}

test("PostgreSQL Gateway requires renewal timing safely inside its lease", () => {
  assert.throws(
    () =>
      createPostgresGatewaySupervisor({
        store: {} as never,
        leases: {} as never,
        listIdentities: async () => [],
        leaseMs: 1_000,
        tickIntervalMs: 501,
      }),
    /no more than half of leaseMs/,
  );
});

test("PostgreSQL Gateway fences a stale leader before Discord IDENTIFY", async () => {
  const sockets: FakeGatewaySocket[] = [];
  const errors: unknown[] = [];
  let writes = 0;
  const supervisor = createPostgresGatewaySupervisor({
    store: {
      read: async () => null,
      write: async () => {
        writes += 1;
        return writes === 1;
      },
    } as never,
    leases: {
      acquire: async (name: string, ownerId: string) => ({
        name,
        ownerId,
        leaseToken: "stale-leader-token",
        fencingGeneration: 1,
        leaseExpiresAt: new Date(Date.now() + 120_000),
      }),
      renew: async () => null,
      release: async () => true,
    } as never,
    listIdentities: async () => [
      { identityId: "standard", botUserId: "bot-1", token: "secret-bot-token" },
    ],
    leaseMs: 120_000,
    tickIntervalMs: 60_000,
    identityRefreshMs: 60_000,
    socketFactory: createFakeSocketFactory(sockets),
    onError: (error) => errors.push(error),
  });

  await supervisor.start();
  assert.equal(sockets.length, 1);
  sockets[0]!.emit({ op: 10, d: { heartbeat_interval: 45_000 } });
  await waitFor(() => sockets[0]!.terminated);

  assert.equal(sockets[0]!.sent.length, 0);
  assert.equal(supervisor.status().identities[0]?.leadership, "standby");
  assert.equal(errors.length > 0, true);
  await supervisor.stop();
});

test(
  "PostgreSQL Gateway store atomically enriches and enqueues fenced dispatches",
  { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
  async () => {
    assert.ok(postgresUrl);
    assertSafeTestDatabase(postgresUrl);
    const database = createTestDatabase(postgresUrl);
    try {
      await resetAndMigrate(database);
      const jobs = createPostgresJobQueue(database);
      const leases = createPostgresLeaseStore(database);
      const store = createPostgresGatewayStateStore(database, jobs);
      const nowMs = Date.parse("2026-08-20T00:00:00.000Z");
      const lease = await leases.acquire(
        "gateway:standard",
        "gateway-store-test",
        1_000,
        new Date(nowMs),
      );
      assert.ok(lease);
      assert.equal(
        await store.write(
          "standard",
          lease,
          {
            status: "ready",
            sessionId: "session-1",
            resumeGatewayUrl: "wss://resume.example.test",
            lastSequence: 0,
            backoffAttempt: 0,
            lastError: null,
            heartbeatIntervalMs: 45_000,
          },
          { nowMs },
        ),
        true,
      );

      await store.dispatch({
        identityId: "standard",
        botUserId: "bot-1",
        lease,
        sessionId: "session-1",
        sequence: 0,
        ready: { sessionId: "session-1", resumeGatewayUrl: "wss://resume.example.test" },
        type: "READY",
        data: {},
        nowMs,
      });

      const created = await store.dispatch({
        identityId: "standard",
        botUserId: "bot-1",
        lease,
        sessionId: "session-1",
        sequence: 1,
        type: "MESSAGE_CREATE",
        data: {
          id: "message-1",
          guild_id: "guild-1",
          author: { id: "author-1", username: "Author" },
        },
        nowMs,
      });
      assert.ok(created);
      assert.equal((await store.read("standard"))?.lastSequence, 1);
      const duplicate = await store.dispatch({
        identityId: "standard",
        botUserId: "bot-1",
        lease,
        sessionId: "session-1",
        sequence: 1,
        type: "MESSAGE_CREATE",
        data: {
          id: "message-1",
          guild_id: "guild-1",
          author: { id: "author-1", username: "Author" },
        },
        nowMs,
      });
      assert.equal(duplicate?.eventKey, created.eventKey);
      assert.equal((await jobs.stats())[0]?.queued, 1);
      await store.dispatch({
        identityId: "standard",
        botUserId: "bot-1",
        lease,
        sessionId: "session-1",
        sequence: 2,
        type: "MESSAGE_DELETE",
        data: { id: "message-1", guild_id: "guild-1" },
        nowMs: nowMs + 1,
      });
      await store.dispatch({
        identityId: "standard",
        botUserId: "bot-1",
        lease,
        sessionId: "session-1",
        sequence: 3,
        type: "GUILD_MEMBER_UPDATE",
        data: {
          guild_id: "guild-1",
          user: { id: "member-1" },
          roles: ["role-1"],
          nick: "One",
        },
        nowMs: nowMs + 2,
      });
      const memberUpdate = await store.dispatch({
        identityId: "standard",
        botUserId: "bot-1",
        lease,
        sessionId: "session-1",
        sequence: 4,
        type: "GUILD_MEMBER_UPDATE",
        data: {
          guild_id: "guild-1",
          user: { id: "member-1" },
          roles: ["role-2"],
          nick: "Two",
        },
        nowMs: nowMs + 3,
      });
      assert.deepEqual(memberUpdate?.previousRoleIds, ["role-1"]);
      assert.equal(memberUpdate?.previousNick, "One");

      await store.dispatch({
        identityId: "standard",
        botUserId: "bot-1",
        lease,
        sessionId: "session-1",
        sequence: 5,
        type: "VOICE_STATE_UPDATE",
        data: { guild_id: "guild-1", user_id: "member-1", channel_id: "voice-1" },
        nowMs: nowMs + 4,
      });
      const voiceMove = await store.dispatch({
        identityId: "standard",
        botUserId: "bot-1",
        lease,
        sessionId: "session-1",
        sequence: 6,
        type: "VOICE_STATE_UPDATE",
        data: { guild_id: "guild-1", user_id: "member-1", channel_id: "voice-2" },
        nowMs: nowMs + 5,
      });
      assert.equal(voiceMove?.emptiedVoiceChannelId, "voice-1");

      const claimed = await jobs.claim({
        ownerId: "gateway-job-test",
        queueNames: ["gateway-events"],
        limit: 10,
        now: new Date(nowMs + 10),
      });
      assert.equal(claimed.length, 6);
      const deleteJob = claimed.find(
        (job) => (job.payload as { type?: string }).type === "MESSAGE_DELETE",
      );
      assert.ok(deleteJob);
      assert.deepEqual((deleteJob.payload as { data?: unknown }).data, {
        id: "message-1",
        guild_id: "guild-1",
        author: { id: "author-1", username: "Author" },
      });

      const replacement = await leases.acquire(
        "gateway:standard",
        "replacement",
        1_000,
        new Date(nowMs + 1_001),
      );
      assert.ok(replacement);
      await assert.rejects(
        store.dispatch({
          identityId: "standard",
          botUserId: "bot-1",
          lease,
          sessionId: "session-1",
          sequence: 7,
          type: "MESSAGE_CREATE",
          data: { id: "stale", guild_id: "guild-1", author: { id: "author-1" } },
          nowMs: nowMs + 1_002,
        }),
        GatewayLeaseLostError,
      );
    } finally {
      await database.close();
    }
  },
);

test(
  "PostgreSQL Gateway supervisor has one leader, resumes on takeover, and closes on lost fencing",
  { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
  async () => {
    assert.ok(postgresUrl);
    assertSafeTestDatabase(postgresUrl);
    const database = createTestDatabase(postgresUrl);
    try {
      await resetAndMigrate(database);
      const jobs = createPostgresJobQueue(database);
      const leases = createPostgresLeaseStore(database);
      const store = createPostgresGatewayStateStore(database, jobs);
      const socketsOne: FakeGatewaySocket[] = [];
      const socketsTwo: FakeGatewaySocket[] = [];
      const errors: unknown[] = [];
      const identities = async () => [
        { identityId: "standard", botUserId: "bot-1", token: "secret-bot-token" },
      ];
      const first = createPostgresGatewaySupervisor({
        store,
        leases,
        listIdentities: identities,
        ownerId: "gateway-instance-1",
        leaseMs: 500,
        tickIntervalMs: 100,
        identityRefreshMs: 60_000,
        random: () => 0.5,
        socketFactory: createFakeSocketFactory(socketsOne),
        onError: (error) => errors.push(error),
      });
      const second = createPostgresGatewaySupervisor({
        store,
        leases,
        listIdentities: identities,
        ownerId: "gateway-instance-2",
        leaseMs: 500,
        tickIntervalMs: 100,
        identityRefreshMs: 60_000,
        random: () => 0.5,
        socketFactory: createFakeSocketFactory(socketsTwo),
        onError: (error) => errors.push(error),
      });
      await first.start();
      await second.start();
      assert.equal(socketsOne.length, 1);
      assert.equal(socketsTwo.length, 0);
      assert.equal(first.status().identities[0]?.leadership, "leader");
      assert.equal(second.status().identities[0]?.leadership, "standby");

      socketsOne[0]!.emit({ op: 10, d: { heartbeat_interval: 10_000 } });
      await waitFor(() => socketsOne[0]!.sent.length === 1);
      assert.equal(readSentOpcode(socketsOne[0]!, 0), 2);
      socketsOne[0]!.emit({
        op: 0,
        t: "READY",
        s: 1,
        d: { session_id: "session-1", resume_gateway_url: "wss://resume.example.test" },
      });
      await waitFor(async () => (await store.read("standard"))?.status === "ready");
      socketsOne[0]!.emit({
        op: 0,
        t: "MESSAGE_CREATE",
        s: 2,
        d: {
          id: "gateway-message-1",
          guild_id: "guild-1",
          author: { id: "author-1" },
        },
      });
      await waitFor(async () =>
        (await jobs.stats()).some(
          (entry) => entry.queueName === "gateway-events" && entry.queued === 1,
        ),
      );
      socketsOne[0]!.emit({ op: 1, d: null });
      await waitFor(() => socketsOne[0]!.sent.length === 2);
      assert.equal(readSentOpcode(socketsOne[0]!, 1), 1);
      socketsOne[0]!.emit({ op: 11, d: null });
      await waitFor(() => first.status().identities[0]?.heartbeatAwaitingAck === false);

      await first.stop();
      assert.equal(socketsOne[0]!.terminated, true);
      await waitFor(() => socketsTwo.length === 1);
      assert.match(socketsTwo[0]!.url, /^wss:\/\/resume\.example\.test/);
      socketsTwo[0]!.emit({ op: 10, d: { heartbeat_interval: 10_000 } });
      await waitFor(() => socketsTwo[0]!.sent.length === 1);
      assert.equal(readSentOpcode(socketsTwo[0]!, 0), 6);

      await database.execute("DELETE FROM scheduler_leases WHERE name = $1", ["gateway:standard"]);
      await waitFor(() => socketsTwo[0]!.terminated);
      assert.equal(second.status().identities[0]?.leadership, "standby");
      await second.stop();
      assert.equal(errors.length > 0, true);
    } finally {
      await database.close();
    }
  },
);

class FakeGatewaySocket implements GatewaySocket {
  readyState = 1;
  readonly sent: string[] = [];
  terminated = false;

  constructor(
    readonly url: string,
    private readonly handlers: GatewaySocketHandlers,
  ) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = "closed"): void {
    this.readyState = 3;
    this.handlers.close(code, reason);
  }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.readyState = 3;
    this.handlers.close(1006, "terminated");
  }

  emit(payload: unknown): void {
    this.handlers.message(JSON.stringify(payload));
  }
}

function createFakeSocketFactory(sockets: FakeGatewaySocket[]): GatewaySocketFactory {
  return (url, handlers) => {
    const socket = new FakeGatewaySocket(url, handlers);
    sockets.push(socket);
    queueMicrotask(() => handlers.open());
    return socket;
  };
}

function readSentOpcode(socket: FakeGatewaySocket, index: number): number | undefined {
  return (JSON.parse(socket.sent[index]!) as { op?: number }).op;
}

function createTestDatabase(url: string): PostgresDatabaseCapability {
  return createPostgresDatabaseCapabilityFromEnvironment({
    DATABASE_URL: url,
    NODE_ENV: "test",
    PG_POOL_MAX: "8",
  });
}

async function resetAndMigrate(database: PostgresDatabaseCapability): Promise<void> {
  await database.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await applyPostgresMigrations(
    database,
    await readPostgresMigrations(resolve("migrations/postgres")),
  );
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Gateway test condition.");
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

function assertSafeTestDatabase(value: string): void {
  const url = new URL(value);
  const databaseName = url.pathname.slice(1);
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (!local || !databaseName.endsWith("_test")) {
    throw new Error("PostgreSQL integration tests require a local database ending in _test.");
  }
}
