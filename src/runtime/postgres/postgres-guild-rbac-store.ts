import type { GuildRbacStore } from "../contracts";
import type { PostgresDatabaseCapability } from "./postgres-capability";

interface GuildRbacRow extends Record<string, unknown> {
  guild_id: string;
  guild_admin_role_id: string | null;
}

export function createPostgresGuildRbacStore(database: PostgresDatabaseCapability): GuildRbacStore {
  return {
    async readManageServerAdminEnabled(guildId) {
      const rows = await database.query<{ manage_server_admin_enabled: boolean }>(
        "SELECT manage_server_admin_enabled FROM guild_rbac_settings WHERE guild_id = $1",
        [guildId],
      );
      return rows[0]?.manage_server_admin_enabled ?? true;
    },
    async setManageServerAdminEnabled(guildId, enabled) {
      await database.execute(
        `INSERT INTO guild_rbac_settings (guild_id, manage_server_admin_enabled)
        VALUES ($1, $2) ON CONFLICT (guild_id) DO UPDATE SET manage_server_admin_enabled = EXCLUDED.manage_server_admin_enabled`,
        [guildId, enabled],
      );
    },
    async readGuildAdminRoleId(guildId) {
      const rows = await database.query<GuildRbacRow>(
        `SELECT guild_id, guild_admin_role_id
         FROM guild_rbac_settings
         WHERE guild_id = $1`,
        [guildId],
      );
      return rows[0]?.guild_admin_role_id ?? null;
    },

    async listGuildAdminRoleAssignments() {
      const rows = await database.query<GuildRbacRow>(
        `SELECT guild_id, guild_admin_role_id
         FROM guild_rbac_settings
         WHERE guild_admin_role_id IS NOT NULL
         ORDER BY guild_id`,
      );
      return rows.map((row) => ({ guildId: row.guild_id, roleId: row.guild_admin_role_id! }));
    },

    async upsertGuildAdminRoleId(guildId, roleId) {
      await database.execute(
        `INSERT INTO guild_rbac_settings (guild_id, guild_admin_role_id)
         VALUES ($1, $2)
         ON CONFLICT (guild_id) DO UPDATE
         SET guild_admin_role_id = EXCLUDED.guild_admin_role_id`,
        [guildId, roleId],
      );
    },
  };
}
