import { and, desc, eq, sql } from "drizzle-orm";
import { playerCountServers } from "../db/app-schema";
import type { PlayerCountServer } from "../../../../src/types/player-count";
import type { PlayerCountStore } from "../../../../src/runtime/contracts/player-count-store";
import { createD1DrizzleDatabase } from "./drizzle-db";

type PlayerCountServerRow = typeof playerCountServers.$inferSelect;
type PlayerCountServerInsert = typeof playerCountServers.$inferInsert;

const playerCountStoreCache = new WeakMap<D1Database, PlayerCountStore>();

export function createSqlitePlayerCountStore(database: D1Database): PlayerCountStore {
  const cached = playerCountStoreCache.get(database);
  if (cached) {
    return cached;
  }

  const db = createD1DrizzleDatabase(database);
  const store: PlayerCountStore = {
    async setPlayerCountServerEnabled(
      guildId: string,
      id: string,
      enabled: boolean,
    ): Promise<boolean> {
      const result = await db
        .update(playerCountServers)
        .set({
          enabled: enabled ? 1 : 0,
          updatedAtMs: sql`CASE WHEN ${playerCountServers.updatedAtMs} >= ${Date.now()} THEN ${playerCountServers.updatedAtMs} + 1 ELSE ${Date.now()} END`,
        })
        .where(and(eq(playerCountServers.guildId, guildId), eq(playerCountServers.id, id)))
        .run();
      return (result.meta.changes ?? 0) > 0;
    },

    async listPlayerCountServers(guildId: string): Promise<PlayerCountServer[]> {
      const rows = await db
        .select()
        .from(playerCountServers)
        .where(eq(playerCountServers.guildId, guildId))
        .orderBy(desc(playerCountServers.createdAtMs))
        .all();

      return rows.map(rowToServer);
    },

    async listAllPlayerCountServers(): Promise<PlayerCountServer[]> {
      const rows = await db
        .select()
        .from(playerCountServers)
        .orderBy(desc(playerCountServers.createdAtMs))
        .all();

      return rows.map(rowToServer);
    },

    async readPlayerCountServer(id: string): Promise<PlayerCountServer | null> {
      const row = await db
        .select()
        .from(playerCountServers)
        .where(eq(playerCountServers.id, id))
        .limit(1)
        .get();

      return row ? rowToServer(row) : null;
    },

    async upsertPlayerCountServer(server: PlayerCountServer): Promise<void> {
      const values = serverToRow(server);
      await db
        .insert(playerCountServers)
        .values(values)
        .onConflictDoUpdate({
          target: playerCountServers.id,
          set: {
            name: values.name,
            provider: values.provider,
            providerServerId: values.providerServerId,
            channelId: values.channelId,
            alertChannelId: values.alertChannelId,
            refreshIntervalMinutes: values.refreshIntervalMinutes,
            displayFormat: values.displayFormat,
            offlineFormat: values.offlineFormat,
            failureThreshold: values.failureThreshold,
            renameOffsetMinutes: values.renameOffsetMinutes,
            lastRenamedAtMs: values.lastRenamedAtMs,
            lastPlayerCount: values.lastPlayerCount,
            lastMaxSlots: values.lastMaxSlots,
            lastQueueSize: values.lastQueueSize,
            lastFetchedAtMs: values.lastFetchedAtMs,
            consecutiveFailureCount: values.consecutiveFailureCount,
            lastErrorMessage: values.lastErrorMessage,
            lastErrorAtMs: values.lastErrorAtMs,
            steamHost: values.steamHost,
            steamPort: values.steamPort,
            updatedAtMs: sql`CASE WHEN ${playerCountServers.updatedAtMs} >= ${values.updatedAtMs} THEN ${playerCountServers.updatedAtMs} + 1 ELSE ${values.updatedAtMs} END`,
          },
        })
        .run();
    },

    async deletePlayerCountServer(guildId: string, id: string): Promise<boolean> {
      const result = await db
        .delete(playerCountServers)
        .where(and(eq(playerCountServers.guildId, guildId), eq(playerCountServers.id, id)))
        .run();
      return (result.meta.changes ?? 0) > 0;
    },

    async updatePlayerCountSnapshot(body) {
      const result = await db
        .update(playerCountServers)
        .set({
          lastPlayerCount: body.lastPlayerCount,
          lastMaxSlots: body.lastMaxSlots,
          lastQueueSize: body.lastQueueSize,
          lastFetchedAtMs: body.lastFetchedAtMs,
          consecutiveFailureCount: 0,
          lastErrorMessage: null,
          lastErrorAtMs: null,
          updatedAtMs: sql`CASE WHEN ${playerCountServers.updatedAtMs} >= ${Date.now()} THEN ${playerCountServers.updatedAtMs} + 1 ELSE ${Date.now()} END`,
        })
        .where(
          and(
            eq(playerCountServers.guildId, body.guildId),
            eq(playerCountServers.id, body.id),
            body.expectedUpdatedAtMs === undefined
              ? undefined
              : eq(playerCountServers.updatedAtMs, body.expectedUpdatedAtMs),
          ),
        )
        .run();
      return (result.meta.changes ?? 0) > 0;
    },

    async updateLastRenamedAt(body: { id: string; lastRenamedAtMs: number }): Promise<void> {
      await db
        .update(playerCountServers)
        .set({
          lastRenamedAtMs: body.lastRenamedAtMs,
          updatedAtMs: sql`CASE WHEN ${playerCountServers.updatedAtMs} >= ${Date.now()} THEN ${playerCountServers.updatedAtMs} + 1 ELSE ${Date.now()} END`,
        })
        .where(eq(playerCountServers.id, body.id))
        .run();
    },

    async incrementPlayerCountFailure(body) {
      const current = await store.readPlayerCountServer(body.id);
      if (!current || current.guildId !== body.guildId) return null;
      const consecutiveFailureCount = current.consecutiveFailureCount + 1;
      const result = await db
        .update(playerCountServers)
        .set({
          consecutiveFailureCount,
          lastErrorMessage: body.errorMessage,
          lastErrorAtMs: body.errorAtMs,
          updatedAtMs: sql`CASE WHEN ${playerCountServers.updatedAtMs} >= ${Date.now()} THEN ${playerCountServers.updatedAtMs} + 1 ELSE ${Date.now()} END`,
        })
        .where(
          and(
            eq(playerCountServers.guildId, body.guildId),
            eq(playerCountServers.id, body.id),
            body.expectedUpdatedAtMs === undefined
              ? undefined
              : eq(playerCountServers.updatedAtMs, body.expectedUpdatedAtMs),
          ),
        )
        .run();
      if ((result.meta.changes ?? 0) === 0) return null;
      return { consecutiveFailureCount };
    },

    async resetPlayerCountFailure(guildId: string, id: string): Promise<boolean> {
      const result = await db
        .update(playerCountServers)
        .set({
          consecutiveFailureCount: 0,
          lastErrorMessage: null,
          lastErrorAtMs: null,
          updatedAtMs: sql`CASE WHEN ${playerCountServers.updatedAtMs} >= ${Date.now()} THEN ${playerCountServers.updatedAtMs} + 1 ELSE ${Date.now()} END`,
        })
        .where(and(eq(playerCountServers.guildId, guildId), eq(playerCountServers.id, id)))
        .run();
      return (result.meta.changes ?? 0) > 0;
    },
  };

  playerCountStoreCache.set(database, store);
  return store;
}

function rowToServer(row: PlayerCountServerRow): PlayerCountServer {
  return {
    id: row.id,
    ...(row.enabled === 0 ? { enabled: false } : {}),
    guildId: row.guildId,
    name: row.name,
    provider: row.provider as PlayerCountServer["provider"],
    providerServerId: row.providerServerId,
    channelId: row.channelId,
    alertChannelId: row.alertChannelId,
    refreshIntervalMinutes: row.refreshIntervalMinutes,
    displayFormat: row.displayFormat,
    offlineFormat: row.offlineFormat,
    failureThreshold: row.failureThreshold,
    renameOffsetMinutes: row.renameOffsetMinutes,
    lastRenamedAtMs: row.lastRenamedAtMs,
    lastPlayerCount: row.lastPlayerCount,
    lastMaxSlots: row.lastMaxSlots,
    lastQueueSize: row.lastQueueSize,
    lastFetchedAtMs: row.lastFetchedAtMs,
    consecutiveFailureCount: row.consecutiveFailureCount,
    lastErrorMessage: row.lastErrorMessage,
    lastErrorAtMs: row.lastErrorAtMs,
    steamHost: row.steamHost,
    steamPort: row.steamPort,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

function serverToRow(server: PlayerCountServer): PlayerCountServerInsert {
  return {
    id: server.id,
    enabled: server.enabled === false ? 0 : 1,
    guildId: server.guildId,
    name: server.name,
    provider: server.provider,
    providerServerId: server.providerServerId,
    channelId: server.channelId,
    alertChannelId: server.alertChannelId,
    refreshIntervalMinutes: server.refreshIntervalMinutes,
    displayFormat: server.displayFormat,
    offlineFormat: server.offlineFormat,
    failureThreshold: server.failureThreshold,
    renameOffsetMinutes: server.renameOffsetMinutes,
    lastRenamedAtMs: server.lastRenamedAtMs,
    lastPlayerCount: server.lastPlayerCount,
    lastMaxSlots: server.lastMaxSlots,
    lastQueueSize: server.lastQueueSize,
    lastFetchedAtMs: server.lastFetchedAtMs,
    consecutiveFailureCount: server.consecutiveFailureCount,
    lastErrorMessage: server.lastErrorMessage,
    lastErrorAtMs: server.lastErrorAtMs,
    steamHost: server.steamHost,
    steamPort: server.steamPort,
    createdAtMs: server.createdAtMs,
    updatedAtMs: server.updatedAtMs,
  };
}
