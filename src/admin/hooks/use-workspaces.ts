import { useCallback, useEffect, useState } from "react";
import type { WorkspaceSummary } from "../../runtime/workspace-types";
import { describeError } from "../lib/api";

export function useWorkspaces(authenticated: boolean) {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [loading, setLoading] = useState(authenticated);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { crossCuttingClient } = await import("../generated/admin-client/cross-cutting");
    return crossCuttingClient.workspaces({});
  }, []);

  useEffect(() => {
    if (!authenticated) {
      setWorkspaces([]);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    void load()
      .then((response) => {
        if (!cancelled) {
          setWorkspaces(response.workspaces);
          setError(null);
        }
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setWorkspaces([]);
          setError(describeError(loadError));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [authenticated, load]);

  return { workspaces, loading, error };
}
