import type { GuildEntitlementLimits, GuildEntitlementTier } from "../../types";
import { useAdminRead } from "./use-admin-read";

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
  const scope = guildId.trim();
  const { data, loading, error } = useAdminRead(
    enabled && scope ? JSON.stringify(["entitlement", workspaceId.trim(), scope]) : null,
    async () => {
      const { crossCuttingClient } = await import("../generated/admin-client/cross-cutting");
      return crossCuttingClient.entitlement({
        workspaceId: workspaceId.trim() || undefined,
        guildId: scope,
      });
    },
    { shared: true, revalidate: true },
  );
  return { data, loading, error: error ? String(error) : null };
}
