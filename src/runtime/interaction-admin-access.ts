import type { DiscordInteraction, RuntimeStores } from "./app-types";
import { resolveGuildAdminAccess, hasAutomaticHafAdminPermission } from "./guild-admin-access";

export const INTERACTION_ADMIN_DENIAL_MESSAGE =
  "You need Administrator, the configured HAF admin role, or Manage Server when the owner allows it to use this command.";

export async function hasInteractionAdminAccess(
  interaction: DiscordInteraction,
  stores: Pick<RuntimeStores, "guildRbac">,
): Promise<boolean> {
  const guildId = interaction.guild_id;
  const userId = interaction.member?.user?.id ?? interaction.user?.id;
  if (!guildId) {
    return false;
  }

  if (
    await hasAutomaticHafAdminPermission(
      guildId,
      interaction.member?.permissions ?? "",
      stores.guildRbac,
    )
  )
    return true;
  if (!userId) return false;
  const access = await resolveGuildAdminAccess({
    guildId,
    userId,
    store: stores.guildRbac,
    suppliedRoleIds: getInteractionMemberRoles(interaction),
  });
  return access.ok;
}

function getInteractionMemberRoles(interaction: DiscordInteraction): string[] {
  if (!Array.isArray(interaction.member?.roles)) {
    return [];
  }

  return interaction.member.roles.filter((roleId): roleId is string => typeof roleId === "string");
}
