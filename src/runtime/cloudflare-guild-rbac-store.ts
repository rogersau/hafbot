import { eq } from "drizzle-orm";
import { guildRbacSettings } from "../db/app-schema";
import type { GuildRbacStore } from "./contracts";
import { createD1DrizzleDatabase } from "./drizzle-db";

type GuildRbacRow = typeof guildRbacSettings.$inferSelect;
type GuildRbacInsert = typeof guildRbacSettings.$inferInsert;

const guildRbacStoreCache = new WeakMap<D1Database, GuildRbacStore>();

export function createCloudflareGuildRbacStore(database: D1Database): GuildRbacStore {
  const cached = guildRbacStoreCache.get(database);
  if (cached) {
    return cached;
  }

  const db = createD1DrizzleDatabase(database);
  const store: GuildRbacStore = {
    async readManageServerAdminEnabled(guildId) {
      const row = await db
        .select()
        .from(guildRbacSettings)
        .where(eq(guildRbacSettings.guildId, guildId))
        .limit(1)
        .get();
      return row?.manageServerAdminEnabled ?? true;
    },
    async setManageServerAdminEnabled(guildId, enabled) {
      await db
        .insert(guildRbacSettings)
        .values({ guildId, manageServerAdminEnabled: enabled })
        .onConflictDoUpdate({
          target: guildRbacSettings.guildId,
          set: { manageServerAdminEnabled: enabled },
        })
        .run();
    },
    async readGuildAdminRoleId(guildId: string): Promise<string | null> {
      const row = await db
        .select()
        .from(guildRbacSettings)
        .where(eq(guildRbacSettings.guildId, guildId))
        .limit(1)
        .get();

      return rowToAdminRoleId(row);
    },

    async listGuildAdminRoleAssignments() {
      return (await db.select().from(guildRbacSettings).all()).flatMap((row) =>
        row.guildAdminRoleId ? [{ guildId: row.guildId, roleId: row.guildAdminRoleId }] : [],
      );
    },

    async upsertGuildAdminRoleId(guildId: string, roleId: string | null): Promise<void> {
      const values = adminRoleIdToRow(guildId, roleId);
      await db
        .insert(guildRbacSettings)
        .values(values)
        .onConflictDoUpdate({
          target: guildRbacSettings.guildId,
          set: { guildAdminRoleId: values.guildAdminRoleId },
        })
        .run();
    },
  };

  guildRbacStoreCache.set(database, store);
  return store;
}

function rowToAdminRoleId(row: GuildRbacRow | undefined): string | null {
  return row?.guildAdminRoleId ?? null;
}

function adminRoleIdToRow(guildId: string, roleId: string | null): GuildRbacInsert {
  return { guildId, guildAdminRoleId: roleId };
}
