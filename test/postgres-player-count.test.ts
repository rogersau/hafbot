import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresDatabaseCapabilityFromEnvironment } from "../src/runtime/postgres/postgres-capability";
import { initializePostgresSchema } from "../src/runtime/postgres/postgres-schema";
import { createPostgresPlayerCountStore } from "../src/runtime/postgres/postgres-player-count-store";
import type { PlayerCountServer } from "../src/types/player-count";
const postgresUrl = process.env.TEST_POSTGRES_URL;
test(
  "Portable Player Count preserves nullable WARDOGS snapshots and fences stale success/failure writes",
  { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
  async () => {
    assert.ok(postgresUrl);
    assert.match(new URL(postgresUrl).pathname, /_test$/);
    const database = createPostgresDatabaseCapabilityFromEnvironment({
      DATABASE_URL: postgresUrl,
      NODE_ENV: "test",
    });
    try {
      await initializePostgresSchema(database);
      const store = createPostgresPlayerCountStore(database);
      const server: PlayerCountServer = {
        id: crypto.randomUUID(),
        guildId: crypto.randomUUID(),
        name: "Synthetic",
        provider: "wardogs-rcon",
        providerServerId: "synthetic-target",
        channelId: null,
        alertChannelId: null,
        refreshIntervalMinutes: 5,
        displayFormat: "{count}/{max} Q:{queue}",
        offlineFormat: "Offline",
        failureThreshold: 3,
        renameOffsetMinutes: 0,
        lastRenamedAtMs: null,
        lastPlayerCount: null,
        lastMaxSlots: null,
        lastQueueSize: null,
        lastFetchedAtMs: null,
        steamHost: null,
        steamPort: null,
        consecutiveFailureCount: 0,
        lastErrorMessage: null,
        lastErrorAtMs: null,
        createdAtMs: 1,
        updatedAtMs: 1,
      };
      await store.upsertPlayerCountServer(server);
      assert.equal(
        await store.updatePlayerCountSnapshot({
          guildId: server.guildId,
          id: server.id,
          lastPlayerCount: 65,
          lastMaxSlots: 60,
          lastQueueSize: null,
          lastFetchedAtMs: 2,
          expectedUpdatedAtMs: 1,
        }),
        true,
      );
      const observed = (await store.readPlayerCountServer(server.id))!;
      assert.equal(observed.lastQueueSize, null);
      assert.equal(observed.lastPlayerCount, 65);
      assert.equal(observed.provider, "wardogs-rcon");
      await store.upsertPlayerCountServer({
        ...observed,
        providerServerId: "replacement",
        lastFetchedAtMs: null,
        lastPlayerCount: null,
        lastMaxSlots: null,
      });
      assert.equal(
        await store.updatePlayerCountSnapshot({
          guildId: server.guildId,
          id: server.id,
          lastPlayerCount: 100,
          lastMaxSlots: 100,
          lastQueueSize: 0,
          lastFetchedAtMs: 3,
          expectedUpdatedAtMs: observed.updatedAtMs,
        }),
        false,
      );
      assert.equal(
        await store.incrementPlayerCountFailure({
          guildId: server.guildId,
          id: server.id,
          errorMessage: "Old failure",
          errorAtMs: 3,
          expectedUpdatedAtMs: observed.updatedAtMs,
        }),
        null,
      );
      const final = (await store.readPlayerCountServer(server.id))!;
      assert.equal(final.lastFetchedAtMs, null);
      assert.equal(final.consecutiveFailureCount, 0);
      assert.equal(final.providerServerId, "replacement");
      await store.setPlayerCountServerEnabled?.(server.guildId, server.id, false);
      assert.equal((await store.readPlayerCountServer(server.id))?.enabled, false);
      await store.upsertPlayerCountServer(final);
      assert.equal((await store.readPlayerCountServer(server.id))?.enabled, false);
      await store.setPlayerCountServerEnabled?.(server.guildId, server.id, true);
      assert.notEqual((await store.readPlayerCountServer(server.id))?.enabled, false);
      await store.deletePlayerCountServer(server.guildId, server.id);
    } finally {
      await database.close();
    }
  },
);
