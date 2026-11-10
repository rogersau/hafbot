import { and, asc, desc, eq, isNull, like } from "drizzle-orm";
import { guildServiceSuspensionAudit, guildServiceSuspensions } from "../db/app-schema";
import type {
  GuildServiceSuspension,
  GuildServiceSuspensionAuditEvent,
  GuildServiceSuspensionStore,
} from "./contracts";
import { createD1DrizzleDatabase } from "./drizzle-db";

const storeCache = new WeakMap<D1Database, GuildServiceSuspensionStore>();

export function createCloudflareGuildServiceSuspensionStore(
  database: D1Database,
): GuildServiceSuspensionStore {
  const cached = storeCache.get(database);
  if (cached) return cached;
  const db = createD1DrizzleDatabase(database);

  const store: GuildServiceSuspensionStore = {
    async readActiveSuspension(guildId) {
      const row = await db
        .select()
        .from(guildServiceSuspensions)
        .where(
          and(
            eq(guildServiceSuspensions.guildId, guildId),
            isNull(guildServiceSuspensions.removedAtMs),
          ),
        )
        .limit(1)
        .get();
      return row ? mapSuspension(row) : null;
    },

    async listSuspensions(input = {}) {
      const query = input.query?.trim();
      const filters = [
        ...(input.activeOnly ? [isNull(guildServiceSuspensions.removedAtMs)] : []),
        ...(query ? [like(guildServiceSuspensions.guildId, `%${query}%`)] : []),
      ];
      const rows = await db
        .select()
        .from(guildServiceSuspensions)
        .where(filters.length === 0 ? undefined : and(...filters))
        .orderBy(desc(guildServiceSuspensions.createdAtMs))
        .all();
      return rows.map(mapSuspension);
    },

    async suspendGuild(input) {
      await db
        .insert(guildServiceSuspensions)
        .values({
          guildId: input.guildId,
          reason: input.reason,
          createdAtMs: input.occurredAtMs,
          createdByUserId: input.actorUserId,
          removedAtMs: null,
          removedByUserId: null,
        })
        .onConflictDoUpdate({
          target: guildServiceSuspensions.guildId,
          set: {
            reason: input.reason,
            createdAtMs: input.occurredAtMs,
            createdByUserId: input.actorUserId,
            removedAtMs: null,
            removedByUserId: null,
          },
        })
        .run();
      await writeAudit(db, {
        guildId: input.guildId,
        action: "suspended",
        reason: input.reason,
        actorUserId: input.actorUserId,
        occurredAtMs: input.occurredAtMs,
      });
    },

    async restoreGuild(input) {
      await db
        .update(guildServiceSuspensions)
        .set({ removedAtMs: input.occurredAtMs, removedByUserId: input.actorUserId })
        .where(eq(guildServiceSuspensions.guildId, input.guildId))
        .run();
      await writeAudit(db, {
        guildId: input.guildId,
        action: "restored",
        reason: null,
        actorUserId: input.actorUserId,
        occurredAtMs: input.occurredAtMs,
      });
    },

    async listAuditEvents(guildId) {
      const rows = await db
        .select()
        .from(guildServiceSuspensionAudit)
        .where(eq(guildServiceSuspensionAudit.guildId, guildId))
        .orderBy(asc(guildServiceSuspensionAudit.occurredAtMs))
        .all();
      return rows.map(mapAuditEvent);
    },
  };
  storeCache.set(database, store);
  return store;
}

type AppDb = ReturnType<typeof createD1DrizzleDatabase>;

async function writeAudit(
  db: AppDb,
  input: Omit<GuildServiceSuspensionAuditEvent, "id">,
): Promise<void> {
  await db
    .insert(guildServiceSuspensionAudit)
    .values({ id: crypto.randomUUID(), ...input })
    .run();
}

function mapSuspension(row: typeof guildServiceSuspensions.$inferSelect): GuildServiceSuspension {
  return row;
}

function mapAuditEvent(
  row: typeof guildServiceSuspensionAudit.$inferSelect,
): GuildServiceSuspensionAuditEvent {
  return {
    ...row,
    action: row.action === "restored" ? "restored" : "suspended",
  };
}
