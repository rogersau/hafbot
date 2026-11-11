import { DISCORD_API, DiscordApiError, discordGetJson, discordRequest } from "./client";

export interface DiscordGuildMember {
  user?: {
    id?: string;
    bot?: boolean;
  };
  roles?: string[];
  communication_disabled_until?: string | null;
}

export async function applyGuildMemberTimeout(
  guildId: string,
  userId: string,
  untilMs: number,
  botToken: string,
): Promise<DiscordGuildMember> {
  const response = await discordRequest(
    `${DISCORD_API}/guilds/${guildId}/members/${userId}`,
    "PATCH",
    botToken,
    {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ communication_disabled_until: new Date(untilMs).toISOString() }),
    },
  );
  return response.json() as Promise<DiscordGuildMember>;
}

export async function fetchGuildMember(
  guildId: string,
  userId: string,
  botToken: string,
): Promise<DiscordGuildMember | null> {
  try {
    return await discordGetJson<DiscordGuildMember>(
      `${DISCORD_API}/guilds/${guildId}/members/${userId}`,
      botToken,
    );
  } catch (error) {
    if (error instanceof DiscordApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

export async function guildMemberHasRole(
  guildId: string,
  userId: string,
  roleId: string,
  botToken: string,
): Promise<boolean> {
  const member = await fetchGuildMember(guildId, userId, botToken);
  return Array.isArray(member?.roles) && member.roles.includes(roleId);
}

export async function guildMemberHasAnyRole(
  guildId: string,
  userId: string,
  roleIds: readonly string[],
  botToken: string,
): Promise<Set<string>> {
  const member = await fetchGuildMember(guildId, userId, botToken);
  const memberRoles = new Set(Array.isArray(member?.roles) ? member.roles : []);
  return new Set(roleIds.filter((roleId) => memberRoles.has(roleId)));
}

export async function addGuildMemberRole(
  guildId: string,
  userId: string,
  roleId: string,
  botToken: string,
): Promise<void> {
  await mutateGuildMemberRole("PUT", guildId, userId, roleId, botToken);
}

export async function removeGuildMemberRole(
  guildId: string,
  userId: string,
  roleId: string,
  botToken: string,
): Promise<void> {
  await mutateGuildMemberRole("DELETE", guildId, userId, roleId, botToken);
}

async function mutateGuildMemberRole(
  method: "PUT" | "DELETE",
  guildId: string,
  userId: string,
  roleId: string,
  botToken: string,
): Promise<void> {
  const response = await discordRequest(
    `${DISCORD_API}/guilds/${guildId}/members/${userId}/roles/${roleId}`,
    method,
    botToken,
    {
      headers: {
        "Content-Type": "application/json",
      },
    },
  );

  response.body?.cancel();
}
