/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import {
  createGatewayEventOperationRunner,
  createGatewayEventOperationStore,
  deriveGatewayEventKey,
  deriveGatewayOperationNonce,
} from "../src/runtime/gateway-event-idempotency";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("Gateway Event operations allow one concurrent lease and suppress completed duplicates", async () => {
  const database = new SqliteD1Database();
  const store = createGatewayEventOperationStore(database as unknown as D1Database);

  const first = await store.claim("event-1", "audit-post", 1_000, 500);
  const concurrent = await store.claim("event-1", "audit-post", 1_100, 500);

  assert.equal(first.status, "acquired");
  assert.equal(concurrent.status, "busy");
  if (first.status !== "acquired") throw new Error("expected lease");
  await store.complete(first.leaseToken, "event-1", "audit-post", 1_200, "posted");

  assert.deepEqual(await store.claim("event-1", "audit-post", 2_000, 500), {
    status: "completed",
    outcomeCode: "posted",
    outcomeJson: null,
  });
});

test("Gateway Event operation results survive a replay without repeating the mutation", async () => {
  const database = new SqliteD1Database();
  const store = createGatewayEventOperationStore(database as unknown as D1Database);
  const runner = createGatewayEventOperationRunner({ eventKey: "event-result", store });
  let mutations = 0;

  const first = await runner.runResult("counter", async () => ({ count: ++mutations }));
  const replay = await runner.runResult("counter", async () => ({ count: ++mutations }));

  assert.deepEqual(first, { count: 1 });
  assert.deepEqual(replay, { count: 1 });
  assert.equal(mutations, 1);
});

test("Gateway Event operations reclaim expired leases and reject stale completion", async () => {
  const database = new SqliteD1Database();
  const store = createGatewayEventOperationStore(database as unknown as D1Database);
  const abandoned = await store.claim("event-2", "role-grant", 1_000, 100);
  const reclaimed = await store.claim("event-2", "role-grant", 1_101, 100);

  assert.equal(abandoned.status, "acquired");
  assert.equal(reclaimed.status, "reclaimed");
  if (abandoned.status !== "acquired" || reclaimed.status !== "reclaimed") {
    throw new Error("expected leases");
  }
  assert.equal(
    await store.complete(abandoned.leaseToken, "event-2", "role-grant", 1_150, "stale"),
    false,
  );
  assert.equal(
    await store.complete(reclaimed.leaseToken, "event-2", "role-grant", 1_160, "granted"),
    true,
  );
});

test("Gateway Event receipt cleanup retains in-flight and recent operations", async () => {
  const database = new SqliteD1Database();
  const store = createGatewayEventOperationStore(database as unknown as D1Database);
  const old = await store.claim("old", "audit", 100, 100);
  const recent = await store.claim("recent", "audit", 900, 100);
  await store.claim("active", "audit", 1_000, 10_000);
  if (old.status !== "acquired" || recent.status !== "acquired") throw new Error("expected leases");
  await store.complete(old.leaseToken, "old", "audit", 200, "done");
  await store.complete(recent.leaseToken, "recent", "audit", 950, "done");

  assert.equal(await store.cleanupCompletedBefore(500), 1);
  assert.equal(await store.read("old", "audit"), null);
  assert.equal((await store.read("recent", "audit"))?.state, "completed");
  assert.equal((await store.read("active", "audit"))?.state, "processing");
});

test("Gateway Event cleanup retains old reaction results while their operation is processing", async () => {
  const database = new SqliteD1Database();
  const store = createGatewayEventOperationStore(database as unknown as D1Database);
  database
    .prepare(
      `INSERT INTO gateway_reaction_limit_mutations
       (event_key, mutation_kind, result_one, result_two, created_at_ms)
       VALUES (?, 'counters', 2, 2, 100)`,
    )
    .bind("event-in-flight")
    .run();
  const claim = await store.claim(
    "event-in-flight",
    "reaction-add:reaction-limit:counters",
    100,
    10_000,
  );
  assert.equal(claim.status, "acquired");

  await store.cleanupCompletedBefore(500);
  assert.ok(
    await database
      .prepare("SELECT event_key FROM gateway_reaction_limit_mutations WHERE event_key = ?")
      .bind("event-in-flight")
      .first(),
  );
});

test("Gateway Event cleanup removes old reaction results before their completed owner", async () => {
  const database = new SqliteD1Database();
  const store = createGatewayEventOperationStore(database as unknown as D1Database);
  database
    .prepare(
      `INSERT INTO gateway_reaction_limit_mutations
       (event_key, mutation_kind, result_one, result_two, created_at_ms)
       VALUES (?, 'timed-role-expiry', 60000, NULL, 100)`,
    )
    .bind("event-completed")
    .run();
  const claim = await store.claim(
    "event-completed",
    "reaction-add:reaction-limit:timed-role",
    100,
    100,
  );
  if (claim.status !== "acquired") throw new Error("expected lease");
  await store.complete(
    claim.leaseToken,
    "event-completed",
    "reaction-add:reaction-limit:timed-role",
    200,
    "completed",
  );

  assert.equal(await store.cleanupCompletedBefore(500), 2);
  assert.equal(
    await database
      .prepare("SELECT event_key FROM gateway_reaction_limit_mutations WHERE event_key = ?")
      .bind("event-completed")
      .first(),
    null,
  );
  assert.equal(await store.read("event-completed", "reaction-add:reaction-limit:timed-role"), null);
});

test("Gateway Event fallback keys are deterministic and identity-scoped", () => {
  const first = deriveGatewayEventKey({
    type: "MESSAGE_CREATE",
    data: { id: "message-1", guild_id: "guild-1" },
    botIdentityId: "standard",
  });
  assert.equal(
    first,
    deriveGatewayEventKey({
      botIdentityId: "standard",
      data: { guild_id: "guild-1", id: "message-1" },
      type: "MESSAGE_CREATE",
    }),
  );
  assert.notEqual(
    first,
    deriveGatewayEventKey({
      type: "MESSAGE_CREATE",
      data: { id: "message-1", guild_id: "guild-1" },
      botIdentityId: "white-label:guild-1",
    }),
  );
  assert.equal(
    deriveGatewayEventKey({}),
    "legacy:standard:unknown:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
  );
});

test("Gateway Event operations resume after a crash between completed operation boundaries", async () => {
  const database = new SqliteD1Database();
  const store = createGatewayEventOperationStore(database as unknown as D1Database);
  const effects: string[] = [];
  const beforeCrash = createGatewayEventOperationRunner({ eventKey: "event-resume", store });

  await beforeCrash.run("first", async () => {
    effects.push("first");
  });

  const afterCrash = createGatewayEventOperationRunner({ eventKey: "event-resume", store });
  await afterCrash.run("first", async () => {
    effects.push("duplicate-first");
  });
  await afterCrash.run("second", async () => {
    effects.push("second");
  });

  assert.deepEqual(effects, ["first", "second"]);
});

test("Gateway Event operation nonces are stable, handler-scoped, and Discord-safe", () => {
  const nonce = deriveGatewayOperationNonce("v2:standard:MESSAGE_CREATE:12345678", "audit-post");
  assert.equal(
    nonce,
    deriveGatewayOperationNonce("v2:standard:MESSAGE_CREATE:12345678", "audit-post"),
  );
  assert.notEqual(
    nonce,
    deriveGatewayOperationNonce("v2:standard:MESSAGE_CREATE:12345678", "role-grant"),
  );
  assert.match(nonce, /^g:[A-Za-z0-9_-]{22}$/);
});

test("Gateway Event sequence keys ignore mutable dispatch enrichment", () => {
  const base = {
    version: 2,
    botIdentityId: "standard",
    sessionId: "session-1",
    sequence: 42,
    type: "GUILD_MEMBER_UPDATE",
    data: { guild_id: "guild-1", user: { id: "user-1" } },
  };
  const key = deriveGatewayEventKey({ ...base, previousRoleIds: ["role-1"] });
  assert.equal(key, deriveGatewayEventKey({ ...base, previousRoleIds: ["role-2"] }));
  assert.equal(key, "v2:standard:GUILD_MEMBER_UPDATE:session-1:42");
});

test("Gateway Event operation runners expose a single active concurrent lease", async () => {
  const database = new SqliteD1Database();
  const store = createGatewayEventOperationStore(database as unknown as D1Database);
  const runner = createGatewayEventOperationRunner({ eventKey: "event-concurrent", store });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = runner.run("audit", () => blocked);
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(
    runner.run("audit", async () => {}),
    /gateway_operation_busy/,
  );
  release();
  await first;
});

test("Gateway Event operation runners propagate persisted terminal receipts", async () => {
  const database = new SqliteD1Database();
  const store = createGatewayEventOperationStore(database as unknown as D1Database);
  const claim = await store.claim("event-terminal", "audit", 1_000, 100);
  assert.equal(claim.status, "acquired");
  if (claim.status !== "acquired") throw new Error("expected lease");
  await store.terminal(claim.leaseToken, "event-terminal", "audit", 1_001, "invalid_payload");

  let executed = false;
  await assert.rejects(
    createGatewayEventOperationRunner({ eventKey: "event-terminal", store }).run(
      "audit",
      async () => {
        executed = true;
      },
    ),
    /invalid_payload/,
  );
  assert.equal(executed, false);
});

test("Gateway Event operation runners renew live leases before they can be reclaimed", async () => {
  const database = new SqliteD1Database();
  const store = createGatewayEventOperationStore(database as unknown as D1Database);
  let resolveRenewal!: () => void;
  let renewalTimeout!: ReturnType<typeof setTimeout>;
  const renewalObserved = new Promise<void>((resolve) => {
    resolveRenewal = resolve;
  });
  const renewalGuard = new Promise<void>((_, reject) => {
    renewalTimeout = setTimeout(
      () => reject(new Error("Gateway Event operation did not renew its lease")),
      1_000,
    );
  });
  const renewingStore = {
    ...store,
    async renew(...args: Parameters<typeof store.renew>) {
      const renewed = await store.renew(...args);
      resolveRenewal();
      return renewed;
    },
  };
  const runner = createGatewayEventOperationRunner({
    eventKey: "event-renew",
    store: renewingStore,
    leaseDurationMs: 45,
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = runner.run("provider-call", () => blocked);
  try {
    await Promise.race([renewalObserved, renewalGuard]);
    const concurrent = await store.claim("event-renew", "provider-call", Date.now(), 45);
    assert.equal(concurrent.status, "busy");
  } finally {
    clearTimeout(renewalTimeout);
    release();
    await running;
  }
});
