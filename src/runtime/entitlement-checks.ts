import { getGuildEntitlementLimits, type GuildEntitlementNullableLimit } from "../types";
import type { GuildEntitlementStore } from "./contracts";

export class QuantityLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuantityLimitError";
  }
}

export function isAtLimit(currentCount: number, max: GuildEntitlementNullableLimit): boolean {
  return max !== null && currentCount >= max;
}

export async function assertGuildPremiumTier(
  guildEntitlementStore: GuildEntitlementStore,
  guildId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const entitlement = await guildEntitlementStore.readGuildEntitlement(guildId);
  const limits = getGuildEntitlementLimits(entitlement.tier);
  if (!limits.paidFeatures) {
    return { ok: false, message: "This feature requires the premium tier." };
  }

  return { ok: true };
}
