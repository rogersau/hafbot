import type {
  ConfigurationRevision,
  ConfigurationRevisionStore,
  VersionedConfigurationMutation,
} from "../../src/configuration-revisions";

export function createTestConfigurationRevisionCoordinator(
  onCommit: (mutation: VersionedConfigurationMutation) => void | Promise<void>,
): ConfigurationRevisionStore {
  const revisions = new Map<string, ConfigurationRevision>();
  const heads = new Map<string, ConfigurationRevision>();
  return {
    async readHead(input) {
      return heads.get(`${input.guildId}:${input.feature}:${input.resourceKey}`) ?? null;
    },
    async commitTicketPanelMutation() {
      throw new Error("Ticket mutation is not supported by this test coordinator.");
    },
    async commitVersionedMutation(mutation) {
      await onCommit(mutation);
      if (mutation.baselineRevision)
        revisions.set(mutation.baselineRevision.id, mutation.baselineRevision);
      revisions.set(mutation.revision.id, mutation.revision);
      heads.set(
        `${mutation.revision.guildId}:${mutation.revision.feature}:${mutation.revision.resourceKey}`,
        mutation.revision,
      );
    },
    async list() {
      return { revisions: [], nextCursor: null };
    },
    async readById(input) {
      return revisions.get(input.revisionId) ?? null;
    },
  };
}
