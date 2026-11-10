import { randomUUID } from "node:crypto";

import type { WorkspaceStore } from "../workspace-store";
import { WorkspaceGuildAlreadyLinkedError } from "../workspace-store";
import type {
  WorkspaceEntitlement,
  WorkspaceGuildAuditEvent,
  WorkspaceGuildLink,
} from "../workspace-types";
import type { PostgresDatabaseCapability, PostgresExecutor } from "./postgres-capability";
import { isPostgresUniqueViolation, readPostgresSafeInteger } from "./postgres-values";

interface WorkspaceIdRow extends Record<string, unknown> {
  workspaceId: string;
}

interface WorkspaceGuildRow extends WorkspaceIdRow {
  guildId: string;
  linkedByUserId: string;
  linkedAtMs: string | number;
}

interface WorkspaceAuditRow extends Record<string, unknown> {
  id: string;
  workspaceId: string;
  guildId: string;
  action: "linked" | "unlinked";
  actorUserId: string;
  occurredAtMs: string | number;
  previousWorkspaceId: string | null;
}

interface WorkspaceEntitlementRow extends Record<string, unknown> {
  workspaceId: string;
  plan: string;
  status: string;
  enabledFlagsJson: string;
  updatedAtMs: string | number;
}

export function createPostgresWorkspaceStore(database: PostgresDatabaseCapability): WorkspaceStore {
  return {
    async linkGuildToWorkspace(input) {
      try {
        await database.transaction(async (transaction) => {
          const existing = await readWorkspaceForGuild(transaction, input.guildId);
          if (existing && existing !== input.workspaceId) {
            throw new WorkspaceGuildAlreadyLinkedError();
          }
          await transaction.execute(
            `INSERT INTO "WorkspaceGuild" (
               "workspaceId", "guildId", "linkedByUserId", "linkedAtMs"
             ) VALUES ($1, $2, $3, $4)
             ON CONFLICT ("workspaceId", "guildId") DO UPDATE SET
               "linkedByUserId" = EXCLUDED."linkedByUserId",
               "linkedAtMs" = EXCLUDED."linkedAtMs"`,
            [input.workspaceId, input.guildId, input.linkedByUserId, input.linkedAtMs],
          );
          await transaction.execute(
            `INSERT INTO "WorkspaceGuildAuditEvent" (
               "id", "workspaceId", "guildId", "action", "actorUserId",
               "occurredAtMs", "previousWorkspaceId"
             ) VALUES ($1, $2, $3, 'linked', $4, $5, $6)`,
            [
              randomUUID(),
              input.workspaceId,
              input.guildId,
              input.linkedByUserId,
              input.linkedAtMs,
              existing,
            ],
          );
        });
      } catch (error) {
        if (error instanceof WorkspaceGuildAlreadyLinkedError) throw error;
        if (isPostgresUniqueViolation(error)) {
          const current = await readWorkspaceForGuild(database, input.guildId);
          if (current && current !== input.workspaceId) {
            throw new WorkspaceGuildAlreadyLinkedError();
          }
        }
        throw error;
      }
    },

    async unlinkGuildFromWorkspace(input) {
      await database.execute(
        `WITH deleted AS (
           DELETE FROM "WorkspaceGuild"
           WHERE "workspaceId" = $1 AND "guildId" = $2
           RETURNING "workspaceId", "guildId"
         )
         INSERT INTO "WorkspaceGuildAuditEvent" (
           "id", "workspaceId", "guildId", "action", "actorUserId",
           "occurredAtMs", "previousWorkspaceId"
         )
         SELECT $3, "workspaceId", "guildId", 'unlinked', $4, $5, "workspaceId"
         FROM deleted`,
        [
          input.workspaceId,
          input.guildId,
          randomUUID(),
          input.unlinkedByUserId,
          input.unlinkedAtMs,
        ],
      );
    },

    async listGuildsForWorkspace(workspaceId) {
      const rows = await database.query<WorkspaceGuildRow>(
        `SELECT "workspaceId", "guildId", "linkedByUserId", "linkedAtMs"
         FROM "WorkspaceGuild"
         WHERE "workspaceId" = $1
         ORDER BY "linkedAtMs"`,
        [workspaceId],
      );
      return rows.map(rowToWorkspaceGuildLink);
    },

    async listWorkspaceGuildAuditEvents(workspaceId, limit = 100) {
      const boundedLimit = Math.min(Math.max(limit, 1), 500);
      const rows = await database.query<WorkspaceAuditRow>(
        `SELECT "id", "workspaceId", "guildId", "action", "actorUserId",
                "occurredAtMs", "previousWorkspaceId"
         FROM "WorkspaceGuildAuditEvent"
         WHERE "workspaceId" = $1
         ORDER BY "occurredAtMs" DESC
         LIMIT $2`,
        [workspaceId, boundedLimit],
      );
      return rows.map(rowToWorkspaceAuditEvent);
    },

    async isGuildLinkedToWorkspace(workspaceId, guildId) {
      return (await readWorkspaceForGuild(database, guildId)) === workspaceId;
    },

    readWorkspaceIdForGuild(guildId) {
      return readWorkspaceForGuild(database, guildId);
    },

    async readEntitlement(workspaceId) {
      const rows = await database.query<WorkspaceEntitlementRow>(
        `SELECT "workspaceId", "plan", "status", "enabledFlagsJson", "updatedAtMs"
         FROM "WorkspaceEntitlement"
         WHERE "workspaceId" = $1`,
        [workspaceId],
      );
      return rows[0] ? rowToWorkspaceEntitlement(rows[0]) : defaultEntitlement(workspaceId);
    },

    async upsertEntitlement(entitlement) {
      await database.execute(
        `INSERT INTO "WorkspaceEntitlement" (
           "workspaceId", "plan", "status", "enabledFlagsJson", "updatedAtMs"
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT ("workspaceId") DO UPDATE SET
           "plan" = EXCLUDED."plan",
           "status" = EXCLUDED."status",
           "enabledFlagsJson" = EXCLUDED."enabledFlagsJson",
           "updatedAtMs" = EXCLUDED."updatedAtMs"`,
        [
          entitlement.workspaceId,
          entitlement.plan,
          entitlement.status,
          JSON.stringify(entitlement.enabledFlags),
          entitlement.updatedAtMs,
        ],
      );
    },
  };
}

async function readWorkspaceForGuild(
  database: PostgresExecutor,
  guildId: string,
): Promise<string | null> {
  const rows = await database.query<WorkspaceIdRow>(
    `SELECT "workspaceId" FROM "WorkspaceGuild" WHERE "guildId" = $1`,
    [guildId],
  );
  return rows[0]?.workspaceId ?? null;
}

function rowToWorkspaceGuildLink(row: WorkspaceGuildRow): WorkspaceGuildLink {
  return {
    workspaceId: row.workspaceId,
    guildId: row.guildId,
    linkedByUserId: row.linkedByUserId,
    linkedAtMs: readPostgresSafeInteger(row.linkedAtMs, "WorkspaceGuild.linkedAtMs"),
  };
}

function rowToWorkspaceAuditEvent(row: WorkspaceAuditRow): WorkspaceGuildAuditEvent {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    guildId: row.guildId,
    action: row.action,
    actorUserId: row.actorUserId,
    occurredAtMs: readPostgresSafeInteger(
      row.occurredAtMs,
      "WorkspaceGuildAuditEvent.occurredAtMs",
    ),
    previousWorkspaceId: row.previousWorkspaceId,
  };
}

function rowToWorkspaceEntitlement(row: WorkspaceEntitlementRow): WorkspaceEntitlement {
  return {
    workspaceId: row.workspaceId,
    plan: row.plan as WorkspaceEntitlement["plan"],
    status: row.status as WorkspaceEntitlement["status"],
    enabledFlags: parseStringArray(row.enabledFlagsJson),
    updatedAtMs: readPostgresSafeInteger(row.updatedAtMs, "WorkspaceEntitlement.updatedAtMs"),
  };
}

function defaultEntitlement(workspaceId: string): WorkspaceEntitlement {
  return { workspaceId, plan: "free", status: "manual", enabledFlags: [], updatedAtMs: 0 };
}

function parseStringArray(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("Workspace entitlement flags are invalid.");
  }
  return parsed;
}
