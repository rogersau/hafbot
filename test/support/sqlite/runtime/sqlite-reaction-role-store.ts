import type { ReactionRoleStore } from "../../../../src/runtime/contracts/reaction-role-store";
import {
  panelColumns,
  parsePanel,
  restrictedRoleSources,
  parseRestrictedRoleIds,
  type PanelRow,
} from "../../../../src/runtime/reaction-role-records";
export function createSqliteReactionRoleStore(
  database: D1Database,
  staffRoles?: { guildId?: string; roleIds: readonly (string | undefined)[] },
): ReactionRoleStore {
  async function listPanels(guildId: string) {
    const rows = await database
      .prepare(
        `SELECT ${panelColumns} FROM reaction_role_panels WHERE guild_id = ? ORDER BY sort_order, id`,
      )
      .bind(guildId)
      .all<PanelRow>();
    return rows.results.map(parsePanel);
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
        .prepare(`INSERT INTO reaction_role_panels
        (${panelColumns}, sort_order)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT MAX(sort_order) + 1 FROM reaction_role_panels WHERE guild_id = ?), 0)
        WHERE EXISTS (SELECT 1 FROM reaction_role_leases WHERE guild_id = ? AND token = ? AND expires_at_ms > ?)
        ON CONFLICT(guild_id, id) DO UPDATE SET id = excluded.id, bot_user_id = excluded.bot_user_id,
          channel_id = excluded.channel_id, message_id = excluded.message_id, title = excluded.title,
          description = excluded.description, options_json = excluded.options_json,
          published_options_json = excluded.published_options_json, activated_at_ms = excluded.activated_at_ms,
          enabled = excluded.enabled, updated_at_ms = excluded.updated_at_ms,
          mode = excluded.mode, required_role_ids_json = excluded.required_role_ids_json,
          blocked_role_ids_json = excluded.blocked_role_ids_json
        RETURNING guild_id`)
        .bind(
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
        )
        .first<{ guild_id: string }>();
      return row !== null;
    },
    async deletePanel(guildId, lease, panelId) {
      const panel =
        panelId === undefined
          ? (await listPanels(guildId))[0]
          : (await listPanels(guildId)).find((entry) => entry.id === panelId);
      if (!panel) return false;
      const row = await database
        .prepare(`DELETE FROM reaction_role_panels WHERE guild_id = ? AND id = ?
        AND EXISTS (SELECT 1 FROM reaction_role_leases WHERE guild_id = ? AND token = ? AND expires_at_ms > ?)
        RETURNING guild_id`)
        .bind(guildId, panel.id, guildId, lease.token, lease.nowMs)
        .first<{ guild_id: string }>();
      return row !== null;
    },
    async readRestrictedRoleIds(guildId) {
      const rows = await database
        .prepare(
          restrictedRoleSources
            .map(
              ([table, column, json]) =>
                `SELECT ${column} AS value, ${json === "ticket" ? 2 : json ? 1 : 0} AS is_json FROM ${table} WHERE guild_id = ?`,
            )
            .join(" UNION ALL "),
        )
        .bind(...restrictedRoleSources.map(() => guildId))
        .all<{ value: string | null; is_json: number }>();
      return parseRestrictedRoleIds(rows.results, guildId, staffRoles);
    },
    async isRoleSuspended(guildId, userId, roleId) {
      const rows = await database
        .prepare(
          "SELECT suspended_role_ids_json, removed_role_ids_json, pending_suspension_role_ids_json FROM timed_roles WHERE guild_id = ? AND user_id = ?",
        )
        .bind(guildId, userId)
        .all<{
          suspended_role_ids_json: string;
          removed_role_ids_json: string;
          pending_suspension_role_ids_json: string;
        }>();
      return rows.results.some((row) =>
        Object.values(row).some((json) => {
          const ids: unknown = JSON.parse(json);
          if (!Array.isArray(ids)) throw new Error("Invalid timed-role suspension snapshot.");
          return ids.includes(roleId);
        }),
      );
    },
    async claimLease(guildId, token, nowMs) {
      await database
        .prepare(`INSERT INTO reaction_role_leases (guild_id, token, expires_at_ms)
        VALUES (?, ?, ?) ON CONFLICT(guild_id) DO UPDATE SET token = excluded.token, expires_at_ms = excluded.expires_at_ms
        WHERE reaction_role_leases.expires_at_ms <= ? OR reaction_role_leases.token = ?`)
        .bind(guildId, token, nowMs + 120_000, nowMs, token)
        .run();
      const row = await database
        .prepare("SELECT token FROM reaction_role_leases WHERE guild_id = ?")
        .bind(guildId)
        .first<{ token: string }>();
      return row?.token === token;
    },
    async releaseLease(guildId, token) {
      await database
        .prepare("DELETE FROM reaction_role_leases WHERE guild_id = ? AND token = ?")
        .bind(guildId, token)
        .run();
    },
    async renewLease(guildId, token, nowMs) {
      const row = await database
        .prepare(`UPDATE reaction_role_leases SET expires_at_ms = ?
        WHERE guild_id = ? AND token = ? AND expires_at_ms > ? RETURNING token`)
        .bind(nowMs + 120_000, guildId, token, nowMs)
        .first<{ token: string }>();
      return row !== null;
    },
  };
}
