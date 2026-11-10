export interface DiscordUserResolvable {
  nick?: string | null;
  global_name?: string | null;
  username?: string | null;
  id?: string | null;
}

export interface ResolveDisplayNameOptions {
  terminalFallback?: string;
}

export interface DiscordMemberDisplayNameSource {
  nick?: string | null;
  user?: DiscordUserResolvable | null;
}

export interface DiscordMessageDisplayNameSource {
  member?: { nick?: string | null } | null;
  author?: DiscordUserResolvable | null;
}

export interface DiscordResolvedDisplayNameSource {
  users?: Record<string, DiscordUserResolvable | null | undefined>;
  members?: Record<string, { nick?: string | null } | null | undefined>;
}

export interface DiscordInteractionDisplayNameSource {
  member?: { nick?: string | null; user?: DiscordUserResolvable | null } | null;
  user?: DiscordUserResolvable | null;
}

export function resolveDisplayName(
  user: DiscordUserResolvable,
  options?: ResolveDisplayNameOptions,
): string | null {
  return (
    user.nick ?? user.global_name ?? user.username ?? user.id ?? options?.terminalFallback ?? null
  );
}

export function resolveMemberDisplayName(
  member: DiscordMemberDisplayNameSource | null | undefined,
  options?: ResolveDisplayNameOptions,
): string | null {
  if (!member) {
    return null;
  }

  return resolveDisplayName(
    {
      nick: member.nick,
      global_name: member.user?.global_name ?? null,
      username: member.user?.username ?? null,
      id: member.user?.id ?? null,
    },
    options,
  );
}

export function resolveResolvedDisplayName(
  resolved: DiscordResolvedDisplayNameSource | null | undefined,
  userId: string,
  options?: ResolveDisplayNameOptions,
): string | null {
  const user = resolved?.users?.[userId] ?? null;
  const member = resolved?.members?.[userId] ?? null;

  return resolveDisplayName(
    {
      nick: member?.nick,
      global_name: user?.global_name ?? null,
      username: user?.username ?? null,
      id: user?.id ?? null,
    },
    options,
  );
}

export function resolveInteractionDisplayName(
  interaction: DiscordInteractionDisplayNameSource | null | undefined,
  options?: ResolveDisplayNameOptions,
): string | null {
  return resolveDisplayName(
    {
      nick: interaction?.member?.nick,
      global_name: interaction?.member?.user?.global_name ?? interaction?.user?.global_name ?? null,
      username: interaction?.member?.user?.username ?? interaction?.user?.username ?? null,
      id: interaction?.member?.user?.id ?? interaction?.user?.id ?? null,
    },
    options,
  );
}

export function resolveMessageDisplayName(
  message: DiscordMessageDisplayNameSource | null | undefined,
  options?: ResolveDisplayNameOptions,
): string | null {
  return resolveDisplayName(
    {
      nick: message?.member?.nick,
      global_name: message?.author?.global_name ?? null,
      username: message?.author?.username ?? null,
      id: message?.author?.id ?? null,
    },
    options,
  );
}

export async function resolveDisplayNameCached(
  kv: KVNamespace,
  user: DiscordUserResolvable,
  options?: ResolveDisplayNameOptions,
): Promise<string | null> {
  const liveName = user.nick ?? user.global_name ?? user.username ?? null;

  if (liveName !== null) {
    if (user.id != null) {
      try {
        await kv.put(`discord_user:${user.id}`, liveName, { expirationTtl: 3600 });
      } catch {
        // KV write failure shouldn't prevent returning the live name
      }
    }
    return liveName;
  }

  if (user.id != null) {
    try {
      const cached = await kv.get(`discord_user:${user.id}`);
      if (cached !== null) {
        return cached;
      }
    } catch {
      // KV read failure — continue to fallback
    }
  }

  return options?.terminalFallback ?? null;
}
