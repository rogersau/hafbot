import type { KnownGuildRecord, KnownGuildStore } from "../contracts";
import type { PostgresDatabaseCapability, PostgresValue } from "./postgres-capability";
import { readPostgresSafeInteger } from "./postgres-values";

interface KnownGuildRow extends Record<string, unknown> {
  guild_id: string;
  name: string;
  member_count: number;
  owner_id: string;
  icon: string | null;
  installed_at_ms: string | number;
  removed_at_ms: string | number | null;
}

export function createPostgresKnownGuildStore(
  database: PostgresDatabaseCapability,
): KnownGuildStore {
  return {
    async readKnownGuild(guildId) {
      const rows = await database.query<KnownGuildRow>(
        "SELECT * FROM known_guilds WHERE guild_id = $1",
        [guildId],
      );
      return rows[0] ? rowToRecord(rows[0]) : null;
    },

    async insertKnownGuild(record) {
      const changes = await database.execute(
        `INSERT INTO known_guilds (
           guild_id, name, member_count, owner_id, icon, installed_at_ms, removed_at_ms
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT DO NOTHING`,
        recordValues(record),
      );
      return changes === 1;
    },

    async upsertKnownGuild(record) {
      await database.execute(
        `INSERT INTO known_guilds (
           guild_id, name, member_count, owner_id, icon, installed_at_ms, removed_at_ms
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (guild_id) DO UPDATE SET
           name = EXCLUDED.name,
           member_count = EXCLUDED.member_count,
           owner_id = EXCLUDED.owner_id,
           icon = EXCLUDED.icon,
           removed_at_ms = EXCLUDED.removed_at_ms`,
        recordValues(record),
      );
    },

    async setRemoved(guildId, removedAtMs) {
      await database.execute("UPDATE known_guilds SET removed_at_ms = $2 WHERE guild_id = $1", [
        guildId,
        removedAtMs,
      ]);
    },

    async clearRemoved(guildId) {
      await database.execute("UPDATE known_guilds SET removed_at_ms = NULL WHERE guild_id = $1", [
        guildId,
      ]);
    },

    async updateMetadata(guildId, fields) {
      const updates: string[] = [];
      const values: PostgresValue[] = [guildId];
      const add = (column: string, value: PostgresValue) => {
        values.push(value);
        updates.push(`${column} = $${values.length}`);
      };
      if (fields.name !== undefined) add("name", fields.name);
      if (fields.memberCount !== undefined) add("member_count", fields.memberCount);
      if (fields.icon !== undefined) add("icon", fields.icon);
      if (updates.length === 0) return;
      await database.execute(
        `UPDATE known_guilds SET ${updates.join(", ")} WHERE guild_id = $1`,
        values,
      );
    },
  };
}

function recordValues(record: KnownGuildRecord): PostgresValue[] {
  return [
    record.guildId,
    record.name,
    record.memberCount,
    record.ownerId,
    record.icon,
    record.installedAtMs,
    record.removedAtMs,
  ];
}

function rowToRecord(row: KnownGuildRow): KnownGuildRecord {
  return {
    guildId: row.guild_id,
    name: row.name,
    memberCount: row.member_count,
    ownerId: row.owner_id,
    icon: row.icon,
    installedAtMs: readPostgresSafeInteger(row.installed_at_ms, "known_guilds.installed_at_ms"),
    removedAtMs:
      row.removed_at_ms === null
        ? null
        : readPostgresSafeInteger(row.removed_at_ms, "known_guilds.removed_at_ms"),
  };
}
