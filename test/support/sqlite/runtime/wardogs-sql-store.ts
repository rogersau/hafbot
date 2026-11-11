import type { WardogsStore } from "../../../../src/wardogs/store";
import type { Target } from "../../../../src/wardogs/model";

// These fixed statements are valid in both SQLite and PostgreSQL. Adapters bind
// parameters natively; no application SQL translation or runtime DDL is used.
export interface WardogsSql {
  rows(sql: string, values: (string | number | null)[]): Promise<{ data: string }[]>;
}
export function createWardogsSqlStore(db: WardogsSql): WardogsStore {
  return {
    async list(guildId) {
      return (
        await db.rows("SELECT data FROM wardogs_targets WHERE guild_id = ? ORDER BY id", [guildId])
      ).map((row) => JSON.parse(row.data) as Target);
    },
    async read(guildId, id) {
      const rows = await db.rows("SELECT data FROM wardogs_targets WHERE guild_id = ? AND id = ?", [
        guildId,
        id,
      ]);
      return rows[0] ? (JSON.parse(rows[0].data) as Target) : null;
    },
    async create(target) {
      // Unique Guild slots enforce the five-target limit under concurrent creates.
      for (let slot = 0; slot < 5; slot++) {
        const rows = await db.rows(
          `INSERT INTO wardogs_targets (id, guild_id, slot, generation, data)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING data`,
          [target.id, target.guildId, slot, target.generation, JSON.stringify(target)],
        );
        if (rows.length) return true;
      }
      return false;
    },
    async save(target, expectedGeneration) {
      const rows = await db.rows(
        `UPDATE wardogs_targets SET generation = ?, data = ?
        WHERE id = ? AND guild_id = ? AND generation = ? RETURNING data`,
        [target.generation, JSON.stringify(target), target.id, target.guildId, expectedGeneration],
      );
      return rows.length === 1;
    },
    async claim(origin, token, nowMs, leaseMs, spacingMs) {
      const rows = await db.rows(
        `INSERT INTO wardogs_budgets (origin, token, lease_until_ms, next_at_ms, data)
        VALUES (?, ?, ?, ?, '') ON CONFLICT(origin) DO UPDATE SET
        token = excluded.token, lease_until_ms = excluded.lease_until_ms, next_at_ms = excluded.next_at_ms
        WHERE wardogs_budgets.lease_until_ms <= ? AND wardogs_budgets.next_at_ms <= ? RETURNING data`,
        [origin, token, nowMs + leaseMs, nowMs + spacingMs, nowMs, nowMs],
      );
      return rows.length === 1;
    },
    async release(origin, token, cooldownUntilMs) {
      await db.rows(
        `UPDATE wardogs_budgets SET lease_until_ms = 0,
        next_at_ms = CASE WHEN next_at_ms > ? THEN next_at_ms ELSE ? END
        WHERE origin = ? AND token = ? RETURNING data`,
        [cooldownUntilMs, cooldownUntilMs, origin, token],
      );
    },
  };
}
