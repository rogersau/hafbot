import type { PostgresDatabaseCapability } from "./postgres-capability";
import type { ReactionRoleStore } from "../contracts/reaction-role-store";
import {
  panelColumns,
  parsePanel,
  restrictedRoleSources,
  parseRestrictedRoleIds,
  type PanelRow,
} from "../reaction-role-records";
export function createPostgresReactionRoleStore(
  database: PostgresDatabaseCapability,
  staffRoles?: { guildId?: string; roleIds: readonly (string | undefined)[] },
): ReactionRoleStore {
  async function listPanels(guildId: string) {
    const rows = await database.query<PanelRow>(
      `SELECT ${panelColumns} FROM reaction_role_panels WHERE guild_id = $1 ORDER BY sort_order, id`,
      [guildId],
    );
    return rows.map(parsePanel);
  }
  return {
    listPanels,
    async readPanel(guildId, panelId) {
      const panels = await listPanels(guildId);
      return (
        (panelId === undefined ? panels[0] : panels.find((panel) => panel.id === panelId)) ?? null
      );
    },
    async readPanelByMessage(guildId, channelId, messageId) {
      return (
        (await listPanels(guildId)).find(
          (panel) => panel.channelId === channelId && panel.messageId === messageId,
        ) ?? null
      );
    },
    async savePanel(panel, lease) {
      const row = await database
        .query<{ guild_id: string }>(
          `INSERT INTO reaction_role_panels
        (${panelColumns}, sort_order)
        SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, COALESCE((SELECT MAX(sort_order) + 1 FROM reaction_role_panels WHERE guild_id = $16), 0)
        WHERE EXISTS (SELECT 1 FROM reaction_role_leases WHERE guild_id = $17 AND token = $18 AND expires_at_ms > $19)
        ON CONFLICT(guild_id, id) DO UPDATE SET id = excluded.id, bot_user_id = excluded.bot_user_id,
          channel_id = excluded.channel_id, message_id = excluded.message_id, title = excluded.title,
          description = excluded.description, options_json = excluded.options_json,
          published_options_json = excluded.published_options_json, activated_at_ms = excluded.activated_at_ms,
          enabled = excluded.enabled, updated_at_ms = excluded.updated_at_ms,
          mode = excluded.mode, required_role_ids_json = excluded.required_role_ids_json,
          blocked_role_ids_json = excluded.blocked_role_ids_json
        RETURNING guild_id`,
          [
            panel.guildId,
            panel.id,
            panel.botUserId,
            panel.channelId,
            panel.messageId,
            panel.title,
            panel.description,
            JSON.stringify(panel.options),
            JSON.stringify(panel.publishedOptions),
            panel.activatedAtMs,
            panel.enabled ? 1 : 0,
            panel.updatedAtMs,
            panel.mode ?? "multiple",
            JSON.stringify(panel.requiredRoleIds ?? []),
            JSON.stringify(panel.blockedRoleIds ?? []),
            panel.guildId,
            panel.guildId,
            lease.token,
            lease.nowMs,
          ],
        )
        .then((rows) => rows[0] ?? null);
      return row !== null;
    },
    async deletePanel(guildId, lease, panelId) {
      const panel =
        panelId === undefined
          ? (await listPanels(guildId))[0]
          : (await listPanels(guildId)).find((entry) => entry.id === panelId);
      if (!panel) return false;
      const row = await database
        .query<{ guild_id: string }>(
          `DELETE FROM reaction_role_panels WHERE guild_id = $1 AND id = $2
        AND EXISTS (SELECT 1 FROM reaction_role_leases WHERE guild_id = $3 AND token = $4 AND expires_at_ms > $5)
        RETURNING guild_id`,
          [guildId, panel.id, guildId, lease.token, lease.nowMs],
        )
        .then((rows) => rows[0] ?? null);
      return row !== null;
    },
    async readRestrictedRoleIds(guildId) {
      const rows = await database.query<{ value: string | null; is_json: number }>(
        restrictedRoleSources
          .map(
            ([table, column, json], index) =>
              `SELECT ${column} AS value, ${json === "ticket" ? 2 : json ? 1 : 0} AS is_json FROM ${table} WHERE guild_id = $${index + 1}`,
          )
          .join(" UNION ALL "),
        restrictedRoleSources.map(() => guildId),
      );
      return parseRestrictedRoleIds(rows, guildId, staffRoles);
    },
    async isRoleSuspended(guildId, userId, roleId) {
      const rows = await database.query<{
        suspended_role_ids_json: string;
        removed_role_ids_json: string;
        pending_suspension_role_ids_json: string;
      }>(
        "SELECT suspended_role_ids_json, removed_role_ids_json, pending_suspension_role_ids_json FROM timed_roles WHERE guild_id = $1 AND user_id = $2",
        [guildId, userId],
      );
      return rows.some((row) =>
        Object.values(row).some((json) => {
          const ids: unknown = JSON.parse(json);
          if (!Array.isArray(ids)) throw new Error("Invalid timed-role suspension snapshot.");
          return ids.includes(roleId);
        }),
      );
    },
    async claimLease(guildId, token, nowMs) {
      await database.execute(
        `INSERT INTO reaction_role_leases (guild_id, token, expires_at_ms)
        VALUES ($1, $2, $3) ON CONFLICT(guild_id) DO UPDATE SET token = excluded.token, expires_at_ms = excluded.expires_at_ms
        WHERE reaction_role_leases.expires_at_ms <= $4 OR reaction_role_leases.token = $5`,
        [guildId, token, nowMs + 120_000, nowMs, token],
      );
      const row = await database
        .query<{ token: string }>("SELECT token FROM reaction_role_leases WHERE guild_id = $1", [
          guildId,
        ])
        .then((rows) => rows[0] ?? null);
      return row?.token === token;
    },
    async releaseLease(guildId, token) {
      await database.execute(
        "DELETE FROM reaction_role_leases WHERE guild_id = $1 AND token = $2",
        [guildId, token],
      );
    },
    async renewLease(guildId, token, nowMs) {
      const row = await database
        .query<{ token: string }>(
          `UPDATE reaction_role_leases SET expires_at_ms = $1
        WHERE guild_id = $2 AND token = $3 AND expires_at_ms > $4 RETURNING token`,
          [nowMs + 120_000, guildId, token, nowMs],
        )
        .then((rows) => rows[0] ?? null);
      return row !== null;
    },
  };
}
