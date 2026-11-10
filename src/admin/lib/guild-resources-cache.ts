import { buildWorkspaceGuildPath, describeError } from "./api";

export interface GuildResource {
  id: string;
  name: string;
}

export interface GuildResources {
  guildId: string;
  roles: GuildResource[];
  categories: GuildResource[];
  textChannels: GuildResource[];
  voiceChannels: GuildResource[];
  stageChannels?: GuildResource[];
  forumChannels: GuildResource[];
  emojis?: Array<{ id: string; name: string; animated: boolean; available: boolean }>;
}

type GuildResourcesEntry =
  | { kind: "loading"; request: Promise<GuildResources> }
  | { kind: "ready"; value: GuildResources };

const guildResourcesCache = new Map<string, GuildResourcesEntry>();

interface LoadGuildResourcesOptions {
  refresh?: boolean;
  path?: string;
}

export async function loadGuildResources(
  workspaceId: string,
  guildId: string,
  options: LoadGuildResourcesOptions = {},
): Promise<GuildResources> {
  const trimmedGuildId = guildId.trim();
  const trimmedWorkspaceId = workspaceId.trim();
  const path = options.path ?? "/admin/api/tickets/resources";
  const cacheKey = `${path}:${trimmedWorkspaceId}:${trimmedGuildId}`;
  const cached = options.refresh ? undefined : guildResourcesCache.get(cacheKey);
  if (cached) {
    return cached.kind === "loading" ? cached.request : cached.value;
  }

  const request = (async () => {
    const path = buildWorkspaceGuildPath(
      options.path ?? "/admin/api/tickets/resources",
      trimmedWorkspaceId,
      trimmedGuildId,
    );
    const response = await fetch(options.refresh ? `${path}&refresh=1` : path);
    if (!response.ok) {
      const rawMessage = (await response.text()) || `${response.status} ${response.statusText}`;
      throw new Error(describeError(new Error(rawMessage)));
    }
    return (await response.json()) as GuildResources;
  })();

  const entry: GuildResourcesEntry = { kind: "loading", request };
  guildResourcesCache.set(cacheKey, entry);

  try {
    const value = await request;
    if (guildResourcesCache.get(cacheKey) === entry) {
      guildResourcesCache.set(cacheKey, { kind: "ready", value });
    }
    return value;
  } catch (error) {
    // A superseded failure cannot evict a newer refresh or repopulate a reset cache.
    if (guildResourcesCache.get(cacheKey) === entry) guildResourcesCache.delete(cacheKey);
    throw error;
  }
}

export function resetGuildResourcesCache(): void {
  guildResourcesCache.clear();
}
