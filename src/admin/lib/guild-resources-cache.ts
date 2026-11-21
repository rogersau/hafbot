import { getAdminRead, type AdminReadCache } from "./admin-read";
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

export type GuildResourcesCache = AdminReadCache;

const fallbackCache: GuildResourcesCache = new Map();

interface LoadGuildResourcesOptions {
  refresh?: boolean;
  path?: string;
  cache?: GuildResourcesCache;
}

export function getGuildResourcesRequest(
  workspaceId: string,
  guildId: string,
  options: LoadGuildResourcesOptions = {},
) {
  const url = buildWorkspaceGuildPath(
    options.path ?? "/admin/api/tickets/resources",
    workspaceId.trim(),
    guildId.trim(),
  );
  async function fetchResources(refresh = false) {
    const response = await fetch(refresh ? `${url}&refresh=1` : url);
    if (!response.ok) {
      const rawMessage = (await response.text()) || `${response.status} ${response.statusText}`;
      throw new Error(describeError(new Error(rawMessage)));
    }
    return (await response.json()) as GuildResources;
  }
  const read = getAdminRead(options.cache ?? fallbackCache, url, fetchResources);
  return { read, refresh: () => read.refresh(() => fetchResources(true)) };
}

export function loadGuildResources(
  workspaceId: string,
  guildId: string,
  options: LoadGuildResourcesOptions = {},
): Promise<GuildResources> {
  const { read, refresh } = getGuildResourcesRequest(workspaceId, guildId, options);
  return options.refresh ? refresh() : read.ensure();
}

export function resetGuildResourcesCache(cache = fallbackCache): void {
  cache.clear();
}
