import { useAdminApi } from "./use-admin-api";
import { useCallback, useEffect, useState } from "react";
import type {
  AdminGuildDirectoryEntry,
  AdminGuildDirectoryResponse,
} from "../../runtime/admin-types";
import { describeError } from "../lib/api";

interface UseGuildDirectoryResult {
  guildDirectory: AdminGuildDirectoryEntry[] | null;
  guildLookupError: string | null;
  loadGuildDirectory: (refreshDiscordCache?: boolean) => Promise<AdminGuildDirectoryResponse>;
  refreshGuildDirectory: () => Promise<void>;
}

export function useGuildDirectory(
  enabled: boolean,
  selectedWorkspaceId: string,
): UseGuildDirectoryResult {
  const [guildDirectory, setGuildDirectory] = useState<AdminGuildDirectoryEntry[] | null>(null);
  const { run, cancel, error: guildLookupError, setError } = useAdminApi();

  const loadGuildDirectory = useCallback(
    async (refreshDiscordCache = false) => {
      const { crossCuttingClient } = await import("../generated/admin-client/cross-cutting");
      return crossCuttingClient.guildDirectory({
        workspaceId: selectedWorkspaceId || undefined,
        refresh: refreshDiscordCache ? "1" : undefined,
      });
    },
    [selectedWorkspaceId],
  );

  useEffect(() => {
    if (!enabled) {
      setGuildDirectory(null);
      cancel();
      setError(null);
      return;
    }

    void run(
      loadGuildDirectory,
      (response) => setGuildDirectory(response.guilds),
      (error) => {
        setGuildDirectory(null);
        setError(describeError(new Error(error)));
      },
    );
    return cancel;
  }, [enabled, loadGuildDirectory, run, cancel, setError]);

  const refreshGuildDirectory = useCallback(async () => {
    await run(
      () => loadGuildDirectory(true),
      (response) => setGuildDirectory(response.guilds),
      (error) => setError(describeError(new Error(error))),
    );
  }, [loadGuildDirectory, run, setError]);

  return { guildDirectory, guildLookupError, loadGuildDirectory, refreshGuildDirectory };
}
