import { getGuildEntitlementLimits } from "../types";
import type { GuildEntitlementStore } from "./contracts";
import type { PremiumTier, RouteAccess } from "./admin-route-registry";

export function guildScopedAccess(mode: "read" | "write"): RouteAccess {
  return ({ query }) => {
    const queryRecord = query as { guildId?: unknown; workspaceId?: unknown } | undefined;
    const guildId =
      typeof queryRecord?.guildId === "string" && queryRecord.guildId.length > 0
        ? queryRecord.guildId
        : null;
    if (!guildId) {
      return Response.json({ error: "guildId is required" }, { status: 400 });
    }
    const workspaceId =
      typeof queryRecord?.workspaceId === "string" && queryRecord.workspaceId.length > 0
        ? queryRecord.workspaceId
        : undefined;
    return workspaceId ? { mode, guildId, workspaceId } : { mode, guildId };
  };
}

export function requireGuildQueryId(query: { guildId?: string }): string {
  if (!query.guildId) {
    throw new Error("guildId was not validated before handler execution");
  }
  return query.guildId;
}

export function bodyGuildScopedAccess(mode: "read" | "write"): RouteAccess {
  return async ({ body }) => {
    const bodyRecord = body as { guildId?: unknown; workspaceId?: unknown } | undefined;
    if (!bodyRecord || typeof bodyRecord.guildId !== "string" || bodyRecord.guildId.length === 0) {
      return Response.json({ error: "guildId is required" }, { status: 400 });
    }
    const workspaceId = bodyRecord.workspaceId;
    return typeof workspaceId === "string" && workspaceId.length > 0
      ? { mode, guildId: bodyRecord.guildId, workspaceId }
      : { mode, guildId: bodyRecord.guildId };
  };
}

export function withPremiumTier(tier: PremiumTier) {
  return async (
    guildEntitlements: GuildEntitlementStore,
    guildId: string,
  ): Promise<Response | null> => {
    const entitlement = await guildEntitlements.readGuildEntitlement(guildId);
    const limits = getGuildEntitlementLimits(entitlement.tier);
    if (tier === "reaction-limits" && !limits.reactionLimitsEnabled) {
      return Response.json({ error: "This feature is premium-only." }, { status: 402 });
    }
    if (tier === "premium-only-features" && !limits.paidFeatures) {
      return Response.json({ error: "This feature is premium-only." }, { status: 402 });
    }
    if (
      tier === "steam-link" &&
      limits.platformLinkMaxLinks !== null &&
      limits.platformLinkMaxLinks <= 0
    ) {
      return Response.json({ error: "This feature is premium-only." }, { status: 402 });
    }
    if (tier === "tickets" && !limits.paidFeatures) {
      return Response.json({ error: "This feature is premium-only." }, { status: 402 });
    }
    return null;
  };
}
