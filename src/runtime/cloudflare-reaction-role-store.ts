import {
  reactionRoleOptionSchema,
  reactionRoleSettingsSchema,
  type ReactionRolePanel,
} from "../reaction-roles";
import { z } from "zod";
import type { ReactionRoleStore } from "./contracts/reaction-role-store";
import { parseTicketPanelStorage } from "../tickets";

// These roles confer staff authority or are owned by another access workflow.
// Keep their existing source of truth; never copy them into panel configuration.
const restrictedRoleSources = [
  ["guild_rbac_settings", "guild_admin_role_id", false],
  ["evidence_vault_configs", "access_role_id", false],
  ["evidence_vault_configs", "access_role_ids_json", true],
  ["image_rules_configs", "mod_role_ids_json", true],
  ["bot_defense_configs", "mod_role_ids_json", true],
  ["ban_case_configs", "mod_role_ids_json", true],
  ["mention_protection_configs", "protected_admin_role_ids_json", true],
  ["clan_management_configs", "reviewer_role_ids_json", true],
  ["clan_management_configs", "staff_access_role_ids_json", true],
  ["suggestions_configs", "mod_role_ids_json", true],
  ["member_verification_configs", "verified_role_id", false],
  ["platform_link_configs", "linked_role_id", false],
  ["steam_link_configs", "steam_linked_role_id", false],
  ["reaction_limit_configs", "breach_role_id", false],
  ["timed_roles", "role_id", false],
  ["timed_role_config_rules", "role_id", false],
  ["clans", "role_id", false],
  ["commerce_offerings", "discord_role_id", false],
  ["ticket_panels", "ticket_types_json", "ticket"],
  ["ticket_instances", "support_role_id", false],
] as const;

interface PanelRow {
  guild_id: string;
  id: string;
  bot_user_id: string;
  channel_id: string;
  message_id: string | null;
  title: string;
  description: string;
  options_json: string;
  published_options_json: string;
  activated_at_ms: number | null;
  enabled: number;
  updated_at_ms: number;
  mode: string;
  required_role_ids_json: string;
  blocked_role_ids_json: string;
}

const panelColumns =
  "guild_id, id, bot_user_id, channel_id, message_id, title, description, options_json, published_options_json, activated_at_ms, enabled, updated_at_ms, mode, required_role_ids_json, blocked_role_ids_json";

function parsePanel(row: PanelRow): ReactionRolePanel {
  return {
    ...reactionRoleSettingsSchema.parse({
      channelId: row.channel_id,
      title: row.title,
      description: row.description,
      options: JSON.parse(row.options_json),
      mode: row.mode,
      requiredRoleIds: JSON.parse(row.required_role_ids_json),
      blockedRoleIds: JSON.parse(row.blocked_role_ids_json),
    }),
    guildId: row.guild_id,
    id: row.id,
    botUserId: row.bot_user_id,
    messageId: row.message_id,
    enabled: Number(row.enabled) !== 0,
    publishedOptions: z
      .array(reactionRoleOptionSchema)
      .parse(JSON.parse(row.published_options_json)),
    activatedAtMs: row.activated_at_ms === null ? null : Number(row.activated_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

export function createCloudflareReactionRoleStore(
  database: D1Database,
  staffRoles?: { guildId?: string; roleIds: readonly (string | undefined)[] },
): ReactionRoleStore {
  async function listPanels(guildId: string) {
    const rows = await database
      .prepare(`SELECT ${panelColumns}, 0 AS legacy_order FROM reaction_role_panels WHERE guild_id = ?
      UNION ALL SELECT ${panelColumns}, 1 AS legacy_order FROM reaction_role_additional_panels WHERE guild_id = ?
      ORDER BY legacy_order, id`)
      .bind(guildId, guildId)
      .all<PanelRow>();
    return rows.results.map(parsePanel);
  }
  async function panelTable(guildId: string, panelId: string) {
    const legacy = await database
      .prepare("SELECT id FROM reaction_role_panels WHERE guild_id = ?")
      .bind(guildId)
      .first<{ id: string }>();
    if (legacy?.id === panelId) return "reaction_role_panels";
    const additional = await database
      .prepare("SELECT id FROM reaction_role_additional_panels WHERE guild_id = ? LIMIT 1")
      .bind(guildId)
      .first<{ id: string }>();
    return !legacy && !additional ? "reaction_role_panels" : "reaction_role_additional_panels";
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
      const table = await panelTable(panel.guildId, panel.id);
      const row = await database
        .prepare(`INSERT INTO ${table}
        (${panelColumns})
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM reaction_role_leases WHERE guild_id = ? AND token = ? AND expires_at_ms > ?)
        ON CONFLICT(${table === "reaction_role_panels" ? "guild_id" : "guild_id, id"}) DO UPDATE SET id = excluded.id, bot_user_id = excluded.bot_user_id,
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
      const table = await panelTable(guildId, panel.id);
      const row = await database
        .prepare(`DELETE FROM ${table} WHERE guild_id = ? AND id = ?
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
      const ids = new Set<string>(
        staffRoles?.guildId === guildId
          ? staffRoles.roleIds.flatMap((id) => (id?.trim() ? [id.trim()] : []))
          : [],
      );
      for (const row of rows.results) {
        if (row.value === null || (!row.value && Number(row.is_json) !== 2)) continue;
        const values: unknown =
          Number(row.is_json) === 2
            ? parseTicketPanelStorage(row.value).ticketTypes.map((entry) => entry.supportRoleId)
            : Number(row.is_json) !== 0
              ? JSON.parse(row.value)
              : [row.value];
        if (!Array.isArray(values) || values.some((value) => typeof value !== "string"))
          throw new Error("Invalid protected role configuration.");
        for (const id of values) ids.add(id);
      }
      return ids;
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
