import { useCallback } from "react";
import { describeError } from "../lib/api";
import { useAdminRead } from "./use-admin-read";

async function loadGuildDirectory(workspaceId: string, refresh = false) {
  const { crossCuttingClient } = await import("../generated/admin-client/cross-cutting");
  return crossCuttingClient.guildDirectory({
    workspaceId: workspaceId || undefined,
    refresh: refresh ? "1" : undefined,
  });
}

export function useGuildDirectory(enabled: boolean, workspaceId: string) {
  const { read, data, error } = useAdminRead(
    enabled ? JSON.stringify(["guild-directory", workspaceId]) : null,
    () => loadGuildDirectory(workspaceId),
    { shared: true, revalidate: true },
  );
  const refreshGuildDirectory = useCallback(async () => {
    await read?.refresh(() => loadGuildDirectory(workspaceId, true)).catch(() => undefined);
  }, [read, workspaceId]);

  return {
    guildDirectory: data?.guilds ?? null,
    guildLookupError: error ? describeError(error) : null,
    refreshGuildDirectory,
  };
}
