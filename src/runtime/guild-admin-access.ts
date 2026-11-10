import { ADMINISTRATOR_PERMISSION, MANAGE_GUILD_PERMISSION } from "../discord-interactions";

export interface GuildAdminRoleStore {
  readManageServerAdminEnabled(guildId: string): Promise<boolean>;
  readGuildAdminRoleId(guildId: string): Promise<string | null>;
}

export type GuildMemberRolesFetcher = (guildId: string, userId: string) => Promise<string[] | null>;

export type GuildAdminAccessResult =
  | { ok: true; reason: "role-match" }
  | { ok: false; reason: "no-admin-role-configured" | "role-missing" | "not-a-member" };

export async function resolveGuildAdminAccess(options: {
  guildId: string;
  userId: string;
  store: Pick<GuildAdminRoleStore, "readGuildAdminRoleId">;
  suppliedRoleIds?: readonly string[] | null;
  fetchMemberRoleIds?: GuildMemberRolesFetcher;
}): Promise<GuildAdminAccessResult> {
  const adminRoleId = await options.store.readGuildAdminRoleId(options.guildId);
  if (!adminRoleId) {
    return { ok: false, reason: "no-admin-role-configured" };
  }

  const suppliedRoles = normalizeRoleIds(options.suppliedRoleIds);
  if (suppliedRoles?.has(adminRoleId)) {
    return { ok: true, reason: "role-match" };
  }

  if (!options.fetchMemberRoleIds) {
    return { ok: false, reason: "role-missing" };
  }

  const fetchedRoleIds = await options.fetchMemberRoleIds(options.guildId, options.userId);
  if (fetchedRoleIds === null) {
    return { ok: false, reason: "not-a-member" };
  }

  return fetchedRoleIds.includes(adminRoleId)
    ? { ok: true, reason: "role-match" }
    : { ok: false, reason: "role-missing" };
}

function normalizeRoleIds(roleIds: readonly string[] | null | undefined): Set<string> | null {
  if (!roleIds) return null;
  return new Set(roleIds.filter((roleId) => roleId.length > 0));
}

// HAF administration policy only. Billing eligibility and Discord feature permissions
// deliberately continue to use their own policies.
export function hasDiscordAdministrator(permissions: string): boolean {
  try {
    return (BigInt(permissions) & ADMINISTRATOR_PERMISSION) !== 0n;
  } catch {
    return false;
  }
}

export async function hasAutomaticHafAdminPermission(
  guildId: string,
  permissions: string,
  store: Pick<GuildAdminRoleStore, "readManageServerAdminEnabled">,
): Promise<boolean> {
  if (hasDiscordAdministrator(permissions)) return true;
  let manager = false;
  try {
    manager = (BigInt(permissions) & MANAGE_GUILD_PERMISSION) !== 0n;
  } catch {
    return false;
  }
  return manager && (await store.readManageServerAdminEnabled(guildId));
}
