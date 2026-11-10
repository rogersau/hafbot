import { desc, eq } from "drizzle-orm";
import { workspaceEntitlement, workspaceGuild, workspaceGuildAuditEvent } from "../db/auth-schema";
import { createD1DrizzleDatabase } from "./drizzle-db";
import type {
  WorkspaceEntitlement,
  WorkspaceGuildAuditEvent,
  WorkspaceGuildLinkInput,
  WorkspaceGuildUnlinkInput,
} from "./workspace-types";
import { WorkspaceGuildAlreadyLinkedError, type WorkspaceStore } from "./workspace-store";

const workspaceStoreCache = new WeakMap<D1Database, WorkspaceStore>();

export function createCloudflareWorkspaceStore(database: D1Database): WorkspaceStore {
  const cached = workspaceStoreCache.get(database);
  if (cached) {
    return cached;
  }

  const db = createD1DrizzleDatabase(database);
  const store: WorkspaceStore = {
    async linkGuildToWorkspace(input: WorkspaceGuildLinkInput): Promise<void> {
      const existing = await db
        .select({ workspaceId: workspaceGuild.workspaceId })
        .from(workspaceGuild)
        .where(eq(workspaceGuild.guildId, input.guildId))
        .limit(1)
        .get();
      if (existing && existing.workspaceId !== input.workspaceId) {
        throw new WorkspaceGuildAlreadyLinkedError();
      }

      try {
        await db.batch([
          db
            .insert(workspaceGuild)
            .values(input)
            .onConflictDoUpdate({
              target: [workspaceGuild.workspaceId, workspaceGuild.guildId],
              set: {
                linkedByUserId: input.linkedByUserId,
                linkedAtMs: input.linkedAtMs,
              },
            }),
          db.insert(workspaceGuildAuditEvent).values({
            id: crypto.randomUUID(),
            workspaceId: input.workspaceId,
            guildId: input.guildId,
            action: "linked",
            actorUserId: input.linkedByUserId,
            occurredAtMs: input.linkedAtMs,
            previousWorkspaceId: existing?.workspaceId ?? null,
          }),
        ]);
      } catch (error) {
        const current = await db
          .select({ workspaceId: workspaceGuild.workspaceId })
          .from(workspaceGuild)
          .where(eq(workspaceGuild.guildId, input.guildId))
          .limit(1)
          .get();
        if (current && current.workspaceId !== input.workspaceId) {
          throw new WorkspaceGuildAlreadyLinkedError();
        }
        throw error;
      }
    },
    async unlinkGuildFromWorkspace(input: WorkspaceGuildUnlinkInput): Promise<void> {
      await database.batch([
        database
          .prepare(
            `INSERT INTO "WorkspaceGuildAuditEvent" (
              "id",
              "workspaceId",
              "guildId",
              "action",
              "actorUserId",
              "occurredAtMs",
              "previousWorkspaceId"
            )
            SELECT ?, "workspaceId", "guildId", 'unlinked', ?, ?, "workspaceId"
            FROM "WorkspaceGuild"
            WHERE "workspaceId" = ? AND "guildId" = ?`,
          )
          .bind(
            crypto.randomUUID(),
            input.unlinkedByUserId,
            input.unlinkedAtMs,
            input.workspaceId,
            input.guildId,
          ),
        database
          .prepare(
            `DELETE FROM "WorkspaceGuild"
             WHERE "workspaceId" = ? AND "guildId" = ?`,
          )
          .bind(input.workspaceId, input.guildId),
      ]);
    },
    async listGuildsForWorkspace(workspaceId: string) {
      return db
        .select()
        .from(workspaceGuild)
        .where(eq(workspaceGuild.workspaceId, workspaceId))
        .orderBy(workspaceGuild.linkedAtMs)
        .all();
    },
    async listWorkspaceGuildAuditEvents(workspaceId: string, limit = 100) {
      const rows = await db
        .select()
        .from(workspaceGuildAuditEvent)
        .where(eq(workspaceGuildAuditEvent.workspaceId, workspaceId))
        .orderBy(desc(workspaceGuildAuditEvent.occurredAtMs))
        .limit(Math.min(Math.max(limit, 1), 500))
        .all();
      return rows.map((row): WorkspaceGuildAuditEvent => ({
        id: row.id,
        workspaceId: row.workspaceId,
        guildId: row.guildId,
        action: row.action,
        actorUserId: row.actorUserId,
        occurredAtMs: row.occurredAtMs,
        previousWorkspaceId: row.previousWorkspaceId,
      }));
    },
    async isGuildLinkedToWorkspace(workspaceId: string, guildId: string): Promise<boolean> {
      const link = await db
        .select({ workspaceId: workspaceGuild.workspaceId })
        .from(workspaceGuild)
        .where(eq(workspaceGuild.guildId, guildId))
        .limit(1)
        .get();
      return link?.workspaceId === workspaceId;
    },
    async readWorkspaceIdForGuild(guildId: string): Promise<string | null> {
      const link = await db
        .select({ workspaceId: workspaceGuild.workspaceId })
        .from(workspaceGuild)
        .where(eq(workspaceGuild.guildId, guildId))
        .limit(1)
        .get();
      return link?.workspaceId ?? null;
    },
    async readEntitlement(workspaceId: string): Promise<WorkspaceEntitlement> {
      const entitlement = await db
        .select()
        .from(workspaceEntitlement)
        .where(eq(workspaceEntitlement.workspaceId, workspaceId))
        .limit(1)
        .get();
      if (!entitlement) {
        return {
          workspaceId,
          plan: "free",
          status: "manual",
          enabledFlags: [],
          updatedAtMs: 0,
        };
      }

      return {
        workspaceId: entitlement.workspaceId,
        plan: entitlement.plan as WorkspaceEntitlement["plan"],
        status: entitlement.status as WorkspaceEntitlement["status"],
        enabledFlags: JSON.parse(entitlement.enabledFlagsJson) as string[],
        updatedAtMs: entitlement.updatedAtMs,
      };
    },
    async upsertEntitlement(entitlement: WorkspaceEntitlement): Promise<void> {
      await db
        .insert(workspaceEntitlement)
        .values({
          workspaceId: entitlement.workspaceId,
          plan: entitlement.plan,
          status: entitlement.status,
          enabledFlagsJson: JSON.stringify(entitlement.enabledFlags),
          updatedAtMs: entitlement.updatedAtMs,
        })
        .onConflictDoUpdate({
          target: workspaceEntitlement.workspaceId,
          set: {
            plan: entitlement.plan,
            status: entitlement.status,
            enabledFlagsJson: JSON.stringify(entitlement.enabledFlags),
            updatedAtMs: entitlement.updatedAtMs,
          },
        })
        .run();
    },
  };

  workspaceStoreCache.set(database, store);
  return store;
}
