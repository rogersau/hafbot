import { useOptionalAdminSession } from "../lib/admin-session";
import { getGuildResourcesRequest } from "../lib/guild-resources-cache";
import { useAdminReadSnapshot } from "./use-admin-read";

export function useGuildResources(workspaceId: string, guildId: string, path?: string) {
  const cache = useOptionalAdminSession()?.guildResourcesCache;
  const request = guildId.trim()
    ? getGuildResourcesRequest(workspaceId, guildId, { path, cache })
    : null;
  const { data, loading, error } = useAdminReadSnapshot(request?.read ?? null);

  return { resources: data, loading, error, refresh: request?.refresh ?? noResources };
}

async function noResources() {
  return null;
}
