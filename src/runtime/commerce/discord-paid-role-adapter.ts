import type {
  PaidRoleDiscordAdapter,
  PaidRoleRolePreflight,
} from "../../commerce/paid-role-entitlement";
import {
  addGuildMemberRole,
  DiscordApiError,
  fetchGuildMember,
  guildMemberHasRole,
  listGuildRoles,
  removeGuildMemberRole,
} from "../../discord";

const ADMINISTRATOR = 1n << 3n;
const MANAGE_ROLES = 1n << 28n;

export class DiscordPaidRoleAdapter implements PaidRoleDiscordAdapter {
  constructor(
    private readonly botUserId: string,
    private readonly botToken: string,
  ) {}

  hasRole(input: {
    guildId: string;
    discordUserId: string;
    discordRoleId: string;
  }): Promise<boolean> {
    return guildMemberHasRole(
      input.guildId,
      input.discordUserId,
      input.discordRoleId,
      this.botToken,
    );
  }

  async readMemberState(guildId: string, discordUserId: string): Promise<"present" | "left"> {
    return (await fetchGuildMember(guildId, discordUserId, this.botToken)) ? "present" : "left";
  }

  async preflightRole(input: {
    guildId: string;
    discordRoleId: string;
    discordUserId?: string;
    action: "assign" | "remove";
  }): Promise<PaidRoleRolePreflight> {
    let resources;
    try {
      resources = await Promise.all([
        listGuildRoles(input.guildId, this.botToken),
        fetchGuildMember(input.guildId, this.botUserId, this.botToken),
        input.action === "assign" && input.discordUserId
          ? fetchGuildMember(input.guildId, input.discordUserId, this.botToken)
          : Promise.resolve(null),
      ]);
    } catch (error) {
      if (error instanceof DiscordApiError && error.status === 404) {
        return { ok: false, code: "permission" };
      }
      throw error;
    }
    const [roles, botMember, targetMember] = resources;
    if (!botMember) return { ok: false, code: "permission" };
    if (input.action === "assign" && input.discordUserId && !targetMember) {
      return { ok: false, code: "member_missing" };
    }
    const targetRole = roles.find((role) => role.id === input.discordRoleId);
    if (!targetRole || targetRole.managed) return { ok: false, code: "role_missing" };

    const botRoleIds = new Set(botMember.roles ?? []);
    const effectivePermissions = roles
      .filter((role) => role.id === input.guildId || botRoleIds.has(role.id))
      .reduce((permissions, role) => permissions | parsePermissions(role.permissions), 0n);
    if (
      (effectivePermissions & ADMINISTRATOR) === 0n &&
      (effectivePermissions & MANAGE_ROLES) === 0n
    ) {
      return { ok: false, code: "permission" };
    }
    const highestBotRole = roles
      .filter((role) => botRoleIds.has(role.id))
      .reduce((position, role) => Math.max(position, role.position), 0);
    if (highestBotRole <= targetRole.position) return { ok: false, code: "hierarchy" };
    return { ok: true };
  }

  addRole(input: { guildId: string; discordUserId: string; discordRoleId: string }): Promise<void> {
    return addGuildMemberRole(
      input.guildId,
      input.discordUserId,
      input.discordRoleId,
      this.botToken,
    );
  }

  removeRole(input: {
    guildId: string;
    discordUserId: string;
    discordRoleId: string;
  }): Promise<void> {
    return removeGuildMemberRole(
      input.guildId,
      input.discordUserId,
      input.discordRoleId,
      this.botToken,
    );
  }
}

function parsePermissions(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}
