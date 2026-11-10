import { randomUUID } from "node:crypto";

import type {
  GuildServiceSuspension,
  GuildServiceSuspensionAuditEvent,
  GuildServiceSuspensionStore,
} from "../contracts";
import type { PostgresDatabaseCapability } from "./postgres-capability";
import { readPostgresSafeInteger } from "./postgres-values";

interface SuspensionRow extends Record<string, unknown> {
  guild_id: string;
  reason: string;
  created_at_ms: string | number;
  created_by_user_id: string;
  removed_at_ms: string | number | null;
  removed_by_user_id: string | null;
}

interface SuspensionAuditRow extends Record<string, unknown> {
  id: string;
  guild_id: string;
  action: "suspended" | "restored";
  reason: string | null;
  actor_user_id: string;
  occurred_at_ms: string | number;
}

export function createPostgresGuildServiceSuspensionStore(
  database: PostgresDatabaseCapability,
): GuildServiceSuspensionStore {
  return {
    async readActiveSuspension(guildId) {
      const rows = await database.query<SuspensionRow>(
        `SELECT * FROM guild_service_suspensions
         WHERE guild_id = $1 AND removed_at_ms IS NULL`,
        [guildId],
      );
      return rows[0] ? rowToSuspension(rows[0]) : null;
    },

    async listSuspensions(input = {}) {
      const filters: string[] = [];
      const values: string[] = [];
      if (input.activeOnly) filters.push("removed_at_ms IS NULL");
      const query = input.query?.trim();
      if (query) {
        values.push(`%${query}%`);
        filters.push(`guild_id ILIKE $${values.length}`);
      }
      const rows = await database.query<SuspensionRow>(
        `SELECT * FROM guild_service_suspensions
         ${filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : ""}
         ORDER BY created_at_ms DESC`,
        values,
      );
      return rows.map(rowToSuspension);
    },

    async suspendGuild(input) {
      await database.transaction(async (transaction) => {
        await transaction.execute(
          `INSERT INTO guild_service_suspensions (
             guild_id, reason, created_at_ms, created_by_user_id,
             removed_at_ms, removed_by_user_id
           ) VALUES ($1, $2, $3, $4, NULL, NULL)
           ON CONFLICT (guild_id) DO UPDATE SET
             reason = EXCLUDED.reason,
             created_at_ms = EXCLUDED.created_at_ms,
             created_by_user_id = EXCLUDED.created_by_user_id,
             removed_at_ms = NULL,
             removed_by_user_id = NULL`,
          [input.guildId, input.reason, input.occurredAtMs, input.actorUserId],
        );
        await transaction.execute(
          `INSERT INTO guild_service_suspension_audit (
             id, guild_id, action, reason, actor_user_id, occurred_at_ms
           ) VALUES ($1, $2, 'suspended', $3, $4, $5)`,
          [randomUUID(), input.guildId, input.reason, input.actorUserId, input.occurredAtMs],
        );
      });
    },

    async restoreGuild(input) {
      await database.transaction(async (transaction) => {
        await transaction.execute(
          `UPDATE guild_service_suspensions
           SET removed_at_ms = $2, removed_by_user_id = $3
           WHERE guild_id = $1`,
          [input.guildId, input.occurredAtMs, input.actorUserId],
        );
        await transaction.execute(
          `INSERT INTO guild_service_suspension_audit (
             id, guild_id, action, reason, actor_user_id, occurred_at_ms
           ) VALUES ($1, $2, 'restored', NULL, $3, $4)`,
          [randomUUID(), input.guildId, input.actorUserId, input.occurredAtMs],
        );
      });
    },

    async listAuditEvents(guildId) {
      const rows = await database.query<SuspensionAuditRow>(
        `SELECT * FROM guild_service_suspension_audit
         WHERE guild_id = $1
         ORDER BY occurred_at_ms`,
        [guildId],
      );
      return rows.map(rowToAuditEvent);
    },
  };
}

function rowToSuspension(row: SuspensionRow): GuildServiceSuspension {
  return {
    guildId: row.guild_id,
    reason: row.reason,
    createdAtMs: readPostgresSafeInteger(
      row.created_at_ms,
      "guild_service_suspensions.created_at_ms",
    ),
    createdByUserId: row.created_by_user_id,
    removedAtMs:
      row.removed_at_ms === null
        ? null
        : readPostgresSafeInteger(row.removed_at_ms, "guild_service_suspensions.removed_at_ms"),
    removedByUserId: row.removed_by_user_id,
  };
}

function rowToAuditEvent(row: SuspensionAuditRow): GuildServiceSuspensionAuditEvent {
  return {
    id: row.id,
    guildId: row.guild_id,
    action: row.action,
    reason: row.reason,
    actorUserId: row.actor_user_id,
    occurredAtMs: readPostgresSafeInteger(
      row.occurred_at_ms,
      "guild_service_suspension_audit.occurred_at_ms",
    ),
  };
}
