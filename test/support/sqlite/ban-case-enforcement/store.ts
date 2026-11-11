import type { WardogsSql } from "../runtime/wardogs-sql-store";
import {
  EnforcementError,
  terminal,
  type Intent,
  type Operation,
  type Projection,
} from "../../../../src/ban-case-enforcement/model";

// Fixed SQL shared by native D1 and PostgreSQL bindings, including CAS claims.
export interface EnforcementSql extends WardogsSql {
  batch(statements: { sql: string; values: (string | number | null)[] }[]): Promise<void>;
}
export function createEnforcementStore(db: EnforcementSql) {
  const decode = <T>(rows: { data: string }[]) =>
    rows[0] ? (JSON.parse(rows[0].data) as T) : null;
  return {
    async prepare(intent: Intent) {
      await db.rows(
        "INSERT INTO ban_case_confirmations(id, guild_id, actor_id, expires_at_ms, data) VALUES (?, ?, ?, ?, ?) RETURNING data",
        [intent.id, intent.guildId, intent.actorId, intent.expiresAtMs, JSON.stringify(intent)],
      );
      return intent;
    },
    async confirmation(id: string, guildId: string, actorId: string) {
      return decode<Intent>(
        await db.rows(
          "SELECT data FROM ban_case_confirmations WHERE id = ? AND guild_id = ? AND actor_id = ?",
          [id, guildId, actorId],
        ),
      );
    },
    async confirm(operation: Operation) {
      const projection: Projection = {
        id: operation.id,
        token: "",
        nextAtMs: 0,
        notificationRevision: 0,
        messageId: null,
      };
      // Lock/consume this confirmation and publish the operation/outbox in one transaction.
      // Every suppressed confirmation retains its receipt even after the operation finishes.
      await db.batch([
        {
          sql: `UPDATE ban_case_confirmations SET operation_id = operation_id
            WHERE id = ? AND guild_id = ? AND actor_id = ? RETURNING data`,
          values: [operation.id, operation.guildId, operation.actorId],
        },
        {
          sql: `INSERT INTO ban_case_operations
            (id, guild_id, physical_target, subject, action, active, revision, next_at_ms, data)
            SELECT ?, ?, ?, ?, ?, 1, ?, ?, ? FROM ban_case_confirmations
            WHERE id = ? AND guild_id = ? AND actor_id = ? AND operation_id IS NULL AND expires_at_ms > ?
            ON CONFLICT DO NOTHING RETURNING data`,
          values: [
            operation.id,
            operation.guildId,
            operation.physicalTarget,
            operation.subject,
            operation.action,
            operation.revision,
            operation.nextAtMs,
            JSON.stringify(operation),
            operation.id,
            operation.guildId,
            operation.actorId,
            operation.confirmedAtMs,
          ],
        },
        {
          sql: `UPDATE ban_case_confirmations SET operation_id = (
            SELECT id FROM ban_case_operations WHERE guild_id = ? AND action = ?
            AND (id = ? OR (physical_target = ? AND subject = ? AND active = 1))
            ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END LIMIT 1)
            WHERE id = ? AND guild_id = ? AND actor_id = ? AND operation_id IS NULL
            AND expires_at_ms > ? RETURNING data`,
          values: [
            operation.guildId,
            operation.action,
            operation.id,
            operation.physicalTarget,
            operation.subject,
            operation.id,
            operation.id,
            operation.guildId,
            operation.actorId,
            operation.confirmedAtMs,
          ],
        },
        {
          sql: `INSERT INTO ban_case_operation_projections(id, token, next_at_ms, delivered_revision, data)
            SELECT id, '', 0, 0, ? FROM ban_case_operations WHERE id = ?
            ON CONFLICT DO NOTHING RETURNING data`,
          values: [JSON.stringify(projection), operation.id],
        },
      ]);
      const accepted = decode<Operation>(
        await db.rows(
          `SELECT o.data FROM ban_case_operations o JOIN ban_case_confirmations c ON c.operation_id = o.id
          WHERE c.id = ? AND c.guild_id = ? AND c.actor_id = ?`,
          [operation.id, operation.guildId, operation.actorId],
        ),
      );
      if (accepted) return accepted;
      throw new EnforcementError(
        "Unresolved work already exists for this target and subject. Settle it before requesting the opposite action.",
      );
    },
    async read(id: string) {
      return decode<Operation>(
        await db.rows("SELECT data FROM ban_case_operations WHERE id = ?", [id]),
      );
    },
    async list(guildId: string) {
      return (
        await db.rows(
          "SELECT data FROM ban_case_operations WHERE guild_id = ? ORDER BY next_at_ms DESC LIMIT 100",
          [guildId],
        )
      ).map((row) => JSON.parse(row.data) as Operation);
    },
    async due(now: number) {
      return (
        await db.rows(
          "SELECT data FROM ban_case_operations WHERE active = 1 AND next_at_ms <= ? ORDER BY next_at_ms LIMIT 25",
          [now],
        )
      ).map((row) => JSON.parse(row.data) as Operation);
    },
    async save(operation: Operation, expected: number) {
      const next = { ...operation, revision: expected + 1 };
      const rows = await db.rows(
        `UPDATE ban_case_operations SET active = ?, revision = ?, next_at_ms = ?, data = ?
        WHERE id = ? AND revision = ? RETURNING data`,
        [
          terminal(next.state) ? 0 : 1,
          next.revision,
          next.nextAtMs,
          JSON.stringify(next),
          next.id,
          expected,
        ],
      );
      return decode<Operation>(rows);
    },
    async notifications(now: number) {
      return (
        await db.rows(
          `SELECT o.data FROM ban_case_operations o JOIN ban_case_operation_projections p ON p.id = o.id
        WHERE p.delivered_revision < o.revision AND p.next_at_ms <= ? ORDER BY p.next_at_ms LIMIT 25`,
          [now],
        )
      ).map((row) => JSON.parse(row.data) as Operation);
    },
    async projection(id: string) {
      return decode<Projection>(
        await db.rows("SELECT data FROM ban_case_operation_projections WHERE id = ?", [id]),
      );
    },
    async saveProjection(projection: Projection, expectedToken: string) {
      const next = { ...projection, token: crypto.randomUUID() };
      return decode<Projection>(
        await db.rows(
          `UPDATE ban_case_operation_projections SET token = ?, next_at_ms = ?, delivered_revision = ?, data = ?
        WHERE id = ? AND token = ? RETURNING data`,
          [
            next.token,
            next.nextAtMs,
            next.notificationRevision,
            JSON.stringify(next),
            next.id,
            expectedToken,
          ],
        ),
      );
    },
  };
}
export type EnforcementStore = ReturnType<typeof createEnforcementStore>;
