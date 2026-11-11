/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createSqlitePlayerCountStore } from "./support/sqlite/runtime/sqlite-player-count-store";
import type { PlayerCountServer } from "../src/types/player-count";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("createSqlitePlayerCountStore creates and reads Player Count servers from the unified database", async () => {
  const database = new SqliteD1Database();
  const store = createSqlitePlayerCountStore(database as unknown as D1Database);
  const server = createServer({ id: "server-1", guildId: "guild-1", createdAtMs: 100 });

  await store.upsertPlayerCountServer(server);

  assert.deepEqual(await store.readPlayerCountServer(server.id), server);
  assert.equal(database.execCalls, 0);
});

test("createSqlitePlayerCountStore lists Player Count servers by Guild and globally newest first", async () => {
  const database = new SqliteD1Database();
  const store = createSqlitePlayerCountStore(database as unknown as D1Database);
  const olderGuildServer = createServer({ id: "server-1", guildId: "guild-1", createdAtMs: 100 });
  const newerGuildServer = createServer({ id: "server-2", guildId: "guild-1", createdAtMs: 300 });
  const otherGuildServer = createServer({ id: "server-3", guildId: "guild-2", createdAtMs: 200 });

  await store.upsertPlayerCountServer(olderGuildServer);
  await store.upsertPlayerCountServer(newerGuildServer);
  await store.upsertPlayerCountServer(otherGuildServer);

  assert.deepEqual(await store.listPlayerCountServers("guild-1"), [
    newerGuildServer,
    olderGuildServer,
  ]);
  assert.deepEqual(await store.listAllPlayerCountServers(), [
    newerGuildServer,
    otherGuildServer,
    olderGuildServer,
  ]);
});

test("createSqlitePlayerCountStore updates and deletes Player Count servers within their Guild", async () => {
  const database = new SqliteD1Database();
  const store = createSqlitePlayerCountStore(database as unknown as D1Database);
  const original = createServer({ id: "server-1", guildId: "guild-1", createdAtMs: 100 });
  const updated = {
    ...original,
    name: "EU PvE",
    providerServerId: "bm-2",
    channelId: "voice-2",
    displayFormat: "Online {count}/{max}",
    offlineFormat: "Server offline",
    renameOffsetMinutes: 15,
    steamHost: "127.0.0.1",
    steamPort: 27015,
    updatedAtMs: 250,
  } satisfies PlayerCountServer;

  await store.upsertPlayerCountServer(original);
  await store.upsertPlayerCountServer(updated);

  assert.deepEqual(await store.readPlayerCountServer(original.id), updated);

  assert.equal(await store.deletePlayerCountServer("guild-2", original.id), false);
  assert.deepEqual(await store.readPlayerCountServer(original.id), updated);

  assert.equal(await store.deletePlayerCountServer("guild-1", original.id), true);

  assert.equal(await store.readPlayerCountServer(original.id), null);
  assert.deepEqual(await store.listPlayerCountServers("guild-1"), []);
});

test("createSqlitePlayerCountStore preserves latest Player Count snapshot updates", async () => {
  const database = new SqliteD1Database();
  const store = createSqlitePlayerCountStore(database as unknown as D1Database);
  const server = createServer({ id: "server-1", guildId: "guild-1", createdAtMs: 100 });
  const restoreDateNow = stubDateNow(999);

  try {
    await store.upsertPlayerCountServer(server);
    const snapshot = {
      guildId: server.guildId,
      id: server.id,
      lastPlayerCount: 42,
      lastMaxSlots: 80,
      lastQueueSize: 3,
      lastFetchedAtMs: 300,
    };
    assert.equal(await store.updatePlayerCountSnapshot({ ...snapshot, guildId: "guild-2" }), false);
    assert.deepEqual(await store.readPlayerCountServer(server.id), server);
    assert.equal(await store.updatePlayerCountSnapshot(snapshot), true);
    await store.updateLastRenamedAt({ id: server.id, lastRenamedAtMs: 400 });

    assert.deepEqual(await store.readPlayerCountServer(server.id), {
      ...server,
      lastRenamedAtMs: 400,
      lastPlayerCount: 42,
      lastMaxSlots: 80,
      lastQueueSize: 3,
      lastFetchedAtMs: 300,
      updatedAtMs: 1000,
    });
  } finally {
    restoreDateNow();
  }
});

test("createSqlitePlayerCountStore persists failure tracking state", async () => {
  const database = new SqliteD1Database();
  const store = createSqlitePlayerCountStore(database as unknown as D1Database);
  const server = createServer({ id: "server-1", guildId: "guild-1", createdAtMs: 100 });
  const restoreDateNow = stubDateNow(500);

  try {
    await store.upsertPlayerCountServer(server);
    assert.equal(
      await store.incrementPlayerCountFailure({
        guildId: "guild-2",
        id: server.id,
        errorMessage: "Foreign failure",
        errorAtMs: 400,
      }),
      null,
    );
    assert.deepEqual(await store.readPlayerCountServer(server.id), server);
    const first = await store.incrementPlayerCountFailure({
      guildId: server.guildId,
      id: server.id,
      errorMessage: "Steam Web API error 500",
      errorAtMs: 500,
    });
    assert.ok(first);
    assert.equal(first.consecutiveFailureCount, 1);

    const read = await store.readPlayerCountServer(server.id);
    assert.equal(read?.consecutiveFailureCount, 1);
    assert.equal(read?.lastErrorMessage, "Steam Web API error 500");
    assert.equal(read?.lastErrorAtMs, 500);
    assert.equal(read?.updatedAtMs, 500);

    const second = await store.incrementPlayerCountFailure({
      guildId: server.guildId,
      id: server.id,
      errorMessage: "Steam Web API error 502",
      errorAtMs: 600,
    });
    assert.ok(second);
    assert.equal(second.consecutiveFailureCount, 2);

    assert.equal(await store.resetPlayerCountFailure("guild-2", server.id), false);
    assert.equal(await store.resetPlayerCountFailure(server.guildId, server.id), true);

    const cleared = await store.readPlayerCountServer(server.id);
    assert.equal(cleared?.consecutiveFailureCount, 0);
    assert.equal(cleared?.lastErrorMessage, null);
    assert.equal(cleared?.lastErrorAtMs, null);
  } finally {
    restoreDateNow();
  }
});

function createServer(overrides: Partial<PlayerCountServer> = {}): PlayerCountServer {
  return {
    id: "server-1",
    guildId: "guild-1",
    refreshIntervalMinutes: 10,
    name: "Main PvP",
    provider: "steam-web",
    providerServerId: "bm-1",
    channelId: "voice-1",
    alertChannelId: null,
    displayFormat: "Players {count}/{max}",
    offlineFormat: "Offline",
    failureThreshold: 3,
    renameOffsetMinutes: 0,
    lastRenamedAtMs: null,
    lastPlayerCount: null,
    lastMaxSlots: null,
    lastQueueSize: null,
    lastFetchedAtMs: null,
    consecutiveFailureCount: 0,
    lastErrorMessage: null,
    lastErrorAtMs: null,
    steamHost: null,
    steamPort: null,
    createdAtMs: 100,
    updatedAtMs: 200,
    ...overrides,
  };
}

function stubDateNow(nowMs: number): () => void {
  const originalDateNow = Date.now;
  Date.now = () => nowMs;
  return () => {
    Date.now = originalDateNow;
  };
}
