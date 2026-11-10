import { eq } from "drizzle-orm";
import { knownGuilds } from "../db/app-schema";
import type { KnownGuildRecord, KnownGuildStore } from "./contracts";
import { createD1DrizzleDatabase } from "./drizzle-db";

type KnownGuildRow = typeof knownGuilds.$inferSelect;
type KnownGuildUpdate = Partial<Pick<KnownGuildRow, "name" | "memberIdCount" | "icon">>;

const knownGuildStoreCache = new WeakMap<D1Database, KnownGuildStore>();

export function createCloudflareKnownGuildStore(database: D1Database): KnownGuildStore {
  const cached = knownGuildStoreCache.get(database);
  if (cached) {
    return cached;
  }

  const db = createD1DrizzleDatabase(database);
  const store: KnownGuildStore = {
    async readKnownGuild(guildId: string): Promise<KnownGuildRecord | null> {
      const row = await db
        .select()
        .from(knownGuilds)
        .where(eq(knownGuilds.guildId, guildId))
        .limit(1)
        .get();

      return row ? rowToRecord(row) : null;
    },

    async insertKnownGuild(record: KnownGuildRecord): Promise<boolean> {
      const result = await db
        .insert(knownGuilds)
        .values(recordToRow(record))
        .onConflictDoNothing()
        .run();
      return (result?.meta?.changes ?? 1) === 1;
    },

    async upsertKnownGuild(record: KnownGuildRecord): Promise<void> {
      await db
        .insert(knownGuilds)
        .values(recordToRow(record))
        .onConflictDoUpdate({
          target: knownGuilds.guildId,
          set: {
            name: record.name,
            memberIdCount: record.memberCount,
            ownerId: record.ownerId,
            icon: record.icon,
            removedAtMs: record.removedAtMs,
          },
        })
        .run();
    },

    async setRemoved(guildId: string, removedAtMs: number): Promise<void> {
      await db
        .update(knownGuilds)
        .set({ removedAtMs })
        .where(eq(knownGuilds.guildId, guildId))
        .run();
    },

    async clearRemoved(guildId: string): Promise<void> {
      await db
        .update(knownGuilds)
        .set({ removedAtMs: null })
        .where(eq(knownGuilds.guildId, guildId))
        .run();
    },

    async updateMetadata(
      guildId: string,
      fields: { name?: string; memberCount?: number; icon?: string | null },
    ): Promise<void> {
      const set: KnownGuildUpdate = {};
      if (fields.name !== undefined) set.name = fields.name;
      if (fields.memberCount !== undefined) set.memberIdCount = fields.memberCount;
      if (fields.icon !== undefined) set.icon = fields.icon;
      if (Object.keys(set).length === 0) return;

      await db.update(knownGuilds).set(set).where(eq(knownGuilds.guildId, guildId)).run();
    },
  };

  knownGuildStoreCache.set(database, store);
  return store;
}

function rowToRecord(row: KnownGuildRow): KnownGuildRecord {
  return {
    guildId: row.guildId,
    name: row.name,
    memberCount: row.memberIdCount,
    ownerId: row.ownerId,
    icon: row.icon,
    installedAtMs: row.installedAtMs,
    removedAtMs: row.removedAtMs,
  };
}

function recordToRow(record: KnownGuildRecord): {
  guildId: string;
  name: string;
  memberIdCount: number;
  ownerId: string;
  icon: string | null;
  installedAtMs: number;
  removedAtMs: number | null;
} {
  return {
    guildId: record.guildId,
    name: record.name,
    memberIdCount: record.memberCount,
    ownerId: record.ownerId,
    icon: record.icon,
    installedAtMs: record.installedAtMs,
    removedAtMs: record.removedAtMs,
  };
}
