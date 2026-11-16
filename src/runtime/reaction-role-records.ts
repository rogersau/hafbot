import {
  reactionRoleOptionSchema,
  reactionRoleSettingsSchema,
  type ReactionRolePanel,
} from "../reaction-roles";
import { z } from "zod";
import { parseTicketPanelStorage } from "../tickets";

// These roles confer staff authority or are owned by another access workflow.
// Keep their existing source of truth; never copy them into panel configuration.
export const restrictedRoleSources = [
  ["guild_rbac_settings", "guild_admin_role_id", false],
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
  ["reaction_limit_configs", "breach_role_id", false],
  ["timed_roles", "role_id", false],
  ["timed_role_config_rules", "role_id", false],
  ["clans", "role_id", false],
  ["commerce_offerings", "discord_role_id", false],
  ["ticket_panels", "ticket_types_json", "ticket"],
  ["ticket_instances", "support_role_id", false],
] as const;

export type PanelRow = {
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
};

export const panelColumns =
  "guild_id, id, bot_user_id, channel_id, message_id, title, description, options_json, published_options_json, activated_at_ms, enabled, updated_at_ms, mode, required_role_ids_json, blocked_role_ids_json";

export function parsePanel(row: PanelRow): ReactionRolePanel {
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

export function parseRestrictedRoleIds(
  rows: Array<{ value: string | null; is_json: number | string }>,
  guildId: string,
  staffRoles?: { guildId?: string; roleIds: readonly (string | undefined)[] },
): Set<string> {
  const ids = new Set<string>(
    staffRoles?.guildId === guildId
      ? staffRoles.roleIds.flatMap((id) => (id?.trim() ? [id.trim()] : []))
      : [],
  );
  for (const row of rows) {
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
}
