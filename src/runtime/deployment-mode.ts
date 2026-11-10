import type { GuildEntitlementStore } from "./contracts/guild-entitlement-store";

export type DeploymentMode = "hosted" | "self-hosted";

export function parseDeploymentMode(value: string | undefined): DeploymentMode {
  if (value === undefined) return "hosted";
  if (value === "hosted" || value === "self-hosted") return value;
  throw new Error("HAF_DEPLOYMENT_MODE must be hosted or self-hosted.");
}

// Capability view only: do not create subscriptions, assignments or billing projection rows.
// Existing storage, resource, Discord and abuse bounds still apply.
export const selfHostedGuildEntitlements: GuildEntitlementStore = {
  async readGuildEntitlement(guildId) {
    return { guildId, tier: "premium_plus", updatedAtMs: 0 };
  },
};
