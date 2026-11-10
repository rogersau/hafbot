import { getGuildEntitlementLimits } from "../types";
import type { GuildEntitlementStore } from "../runtime/contracts";
import {
  prepareConfigurationRevisions,
  type ConfigurationActorContext,
  type ConfigurationFeatureKey,
  type ConfigurationRevisionAdapter,
  type ConfigurationRevisionStore,
  type VersionedConfigurationMutation,
} from "./index";

export interface VersionedConfigurationMutationInput<TCurrent, TSnapshot> {
  guildId: string;
  feature: ConfigurationFeatureKey;
  resourceKey: string;
  current: TCurrent | null;
  next: TCurrent | null;
  adapter: ConfigurationRevisionAdapter<TCurrent, TSnapshot>;
  actor: ConfigurationActorContext;
  operation?: "restore";
  restoredFromRevisionId?: string;
}

export async function commitVersionedConfigurationMutation<TCurrent, TSnapshot>(options: {
  revisions?: ConfigurationRevisionStore;
  entitlements: Pick<GuildEntitlementStore, "readGuildEntitlement">;
  mutation: VersionedConfigurationMutationInput<TCurrent, TSnapshot>;
  commitFree: () => Promise<void>;
}): Promise<{ revisionRecorded: boolean }> {
  const { mutation } = options;
  const entitlement = await options.entitlements.readGuildEntitlement(mutation.guildId);
  if (!getGuildEntitlementLimits(entitlement.tier).paidFeatures) {
    await options.commitFree();
    return { revisionRecorded: false };
  }
  if (!options.revisions?.commitVersionedMutation) {
    throw new Error("Configuration revision coordinator is unavailable for this Premium Guild.");
  }
  const head = await options.revisions.readHead({
    guildId: mutation.guildId,
    feature: mutation.feature,
    resourceKey: mutation.resourceKey,
  });
  const prepared = await prepareConfigurationRevisions({
    guildId: mutation.guildId,
    feature: mutation.feature,
    resourceKey: mutation.resourceKey,
    currentSnapshot: mutation.adapter.serialize(mutation.current, mutation.resourceKey),
    nextSnapshot: mutation.adapter.serialize(mutation.next, mutation.resourceKey),
    currentExists: mutation.current !== null,
    nextExists: mutation.next !== null,
    head,
    actor: mutation.actor,
    operation: mutation.operation,
    restoredFromRevisionId: mutation.restoredFromRevisionId,
  });
  await options.revisions.commitVersionedMutation({
    feature: mutation.feature,
    current: mutation.current,
    next: mutation.next,
    ...prepared,
  } as VersionedConfigurationMutation);
  return { revisionRecorded: true };
}
