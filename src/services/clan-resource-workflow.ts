import type { Clan } from "../clans";

type Resources = Pick<Clan, "roleId" | "textChannelId" | "voiceChannelId">;
export type ClanProvisioningStep =
  | "create-category"
  | "create-role"
  | "create-text-channel"
  | "create-voice-channel"
  | "resources-ready";
export type ClanCleanupStep =
  | { kind: "delete-text-channel" | "delete-voice-channel" | "delete-role"; resourceId: string }
  | { kind: "resources-removed" };

/** Only successful persisted checkpoints may change the next external operation. */
export function nextClanProvisioningStep(
  resources: Resources,
  categoryId: string | null,
): ClanProvisioningStep {
  if (!categoryId) return "create-category";
  if (!resources.roleId) return "create-role";
  if (!resources.textChannelId) return "create-text-channel";
  if (!resources.voiceChannelId) return "create-voice-channel";
  return "resources-ready";
}

export function nextClanCleanupStep(resources: Resources): ClanCleanupStep {
  if (resources.textChannelId)
    return { kind: "delete-text-channel", resourceId: resources.textChannelId };
  if (resources.voiceChannelId)
    return { kind: "delete-voice-channel", resourceId: resources.voiceChannelId };
  if (resources.roleId) return { kind: "delete-role", resourceId: resources.roleId };
  return { kind: "resources-removed" };
}
