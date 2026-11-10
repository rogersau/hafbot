import { useEffect, useState } from "react";

import { type GuildResources, loadGuildResources } from "../lib/guild-resources-cache";

export function useGuildResources(workspaceId: string, guildId: string, path?: string) {
  const [resources, setResources] = useState<GuildResources | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const trimmedGuildId = guildId.trim();
    if (!trimmedGuildId) {
      setResources(null);
      return;
    }

    let cancelled = false;
    setLoading(true);

    void (async () => {
      try {
        const nextResources = await loadGuildResources(workspaceId, trimmedGuildId, { path });
        if (!cancelled) setResources(nextResources);
      } catch {
        if (!cancelled) setResources(null);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [workspaceId, guildId, path]);

  async function refresh() {
    const trimmedGuildId = guildId.trim();
    if (!trimmedGuildId) return null;
    setLoading(true);
    try {
      const nextResources = await loadGuildResources(workspaceId, trimmedGuildId, {
        path,
        refresh: true,
      });
      setResources(nextResources);
      return nextResources;
    } finally {
      setLoading(false);
    }
  }

  return { resources, loading, refresh };
}
