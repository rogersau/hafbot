import { useEffect, useState } from "react";
import type { GuildEntitlementLimits, GuildEntitlementTier } from "../../types";

export interface EntitlementInfo {
  tier: GuildEntitlementTier;
  limits: GuildEntitlementLimits;
  supportInvite: string | null;
  r2Usage: {
    usedBytes: number;
    reservedBytes: number;
    maxBytes: number;
    lastReconciledAtMs: number | null;
  };
}

export interface EntitlementResult {
  data: EntitlementInfo | null;
  loading: boolean;
  error: string | null;
}

export function useEntitlement(
  workspaceId: string,
  guildId: string,
  enabled = true,
): EntitlementResult {
  const [result, setResult] = useState<EntitlementResult>({
    data: null,
    loading: false,
    error: null,
  });

  useEffect(() => {
    if (!enabled) {
      setResult({ data: null, loading: false, error: null });
      return;
    }

    const trimmedGuildId = guildId.trim();
    if (!trimmedGuildId) {
      setResult({ data: null, loading: false, error: null });
      return;
    }

    let cancelled = false;
    setResult({ data: null, loading: true, error: null });

    async function load() {
      try {
        const { crossCuttingClient } = await import("../generated/admin-client/cross-cutting");
        const data = await crossCuttingClient.entitlement({
          workspaceId: workspaceId.trim() || undefined,
          guildId: trimmedGuildId,
        });
        if (!cancelled) {
          setResult({
            data: {
              tier: data.tier,
              limits: data.limits,
              supportInvite: data.supportInvite,
              r2Usage: data.r2Usage,
            },
            loading: false,
            error: null,
          });
        }
      } catch (err) {
        if (!cancelled) {
          setResult((prev) => ({
            ...prev,
            loading: false,
            error: err instanceof Error ? err.message : String(err),
          }));
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [enabled, workspaceId, guildId]);

  return result;
}
