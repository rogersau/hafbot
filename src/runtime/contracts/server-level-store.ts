import type {
  ConfiguredGameServer,
  ServerLevelConfig,
  ServerLevelIngressOutboxRecord,
  ServerLevelAward,
  ServerLevelEarningSession,
  ServerLevelProfile,
  ServerLevelProcessingCursor,
  ServerLevelPresence,
  ServerLevelProviderEvent,
  ServerLevelAnnouncement,
} from "../../server-levels/model";

export interface ServerLevelStore {
  readConfig(guildId: string): Promise<ServerLevelConfig | null>;
  upsertConfig(config: ServerLevelConfig): Promise<void>;
  createConfiguredGameServer(server: ConfiguredGameServer): Promise<void>;
  updateConfiguredGameServer(server: ConfiguredGameServer): Promise<void>;
  replaceConfiguredGameServerProvider(
    server: ConfiguredGameServer,
    changedAtMs: number,
  ): Promise<void>;
  deleteConfiguredGameServer(guildId: string, serverId: string): Promise<void>;
  listConfiguredGameServers(guildId: string): Promise<ConfiguredGameServer[]>;
  readConfiguredGameServer(guildId: string, serverId: string): Promise<ConfiguredGameServer | null>;
  readConfiguredGameServerById(serverId: string): Promise<ConfiguredGameServer | null>;
  readConfiguredGameServerByEndpoint(endpointId: string): Promise<ConfiguredGameServer | null>;
  listAllConfiguredGameServers(
    limit: number,
    after?: { guildId: string; createdAtMs: number; id: string },
  ): Promise<ConfiguredGameServer[]>;
  recordReconciliationState(
    guildId: string,
    serverId: string,
    state: {
      rosterAtMs: number;
      capacityCheckedAtMs?: number;
      capacityProposal?: ConfiguredGameServer["capacityProposal"];
    },
  ): Promise<void>;
  acceptProviderEvent(event: ServerLevelProviderEvent): Promise<{
    accepted: boolean;
    inboxId: string;
    duplicateBodyMatches: boolean;
  }>;
  readProviderEvent(inboxId: string): Promise<ServerLevelProviderEvent | null>;
  listPendingIngressOutbox(limit: number): Promise<ServerLevelIngressOutboxRecord[]>;
  markIngressPublished(inboxId: string, publishedAtMs: number): Promise<void>;
  markProviderEventProcessed(
    inboxId: string,
    status: "processed" | "late" | "rejected" | "failed",
    reasonCode: string | null,
    processedAtMs: number,
  ): Promise<void>;
  readProfile(guildId: string, userId: string): Promise<ServerLevelProfile | null>;
  listLeaderboard(
    guildId: string,
    limit: number,
    after?: { totalXpUnits: number; userId: string },
  ): Promise<ServerLevelProfile[]>;
  listAcceptedProviderEvents(
    configuredGameServerId: string,
    safeThroughMs: number,
  ): Promise<ServerLevelProviderEvent[]>;
  readEarliestAcceptedProviderEvent(
    configuredGameServerId: string,
  ): Promise<ServerLevelProviderEvent | null>;
  acquireProcessingLease?(
    configuredGameServerId: string,
    leaseId: string,
    nowMs: number,
    expiresAtMs: number,
  ): Promise<boolean>;
  releaseProcessingLease?(configuredGameServerId: string, leaseId: string): Promise<void>;
  readProcessingCursor(configuredGameServerId: string): Promise<ServerLevelProcessingCursor | null>;
  upsertProcessingCursor(cursor: ServerLevelProcessingCursor): Promise<void>;
  listCurrentPresence(configuredGameServerId: string): Promise<ServerLevelPresence[]>;
  readCurrentPresence(
    configuredGameServerId: string,
    steamId64: string,
  ): Promise<ServerLevelPresence | null>;
  upsertCurrentPresence(presence: ServerLevelPresence): Promise<void>;
  deleteCurrentPresence(
    guildId: string,
    configuredGameServerId: string,
    steamId64: string,
  ): Promise<void>;
  clearCurrentPresence(guildId: string, configuredGameServerId: string): Promise<void>;
  listOpenEarningSessions(configuredGameServerId: string): Promise<ServerLevelEarningSession[]>;
  readOpenEarningSession(
    configuredGameServerId: string,
    steamId64: string,
  ): Promise<ServerLevelEarningSession | null>;
  upsertEarningSession(session: ServerLevelEarningSession): Promise<void>;
  closeEarningSession(sessionId: string, closedAtMs: number, closeReason: string): Promise<void>;
  closeAllEarningSessions(
    configuredGameServerId: string,
    closedAtMs: number,
    closeReason: string,
  ): Promise<void>;
  listMemberAwards(
    guildId: string,
    userId: string,
    startedBeforeMs: number,
    endedAfterMs: number,
  ): Promise<ServerLevelAward[]>;
  appendAward(award: ServerLevelAward): Promise<{
    applied: boolean;
    previousTotalXpUnits: number;
    totalXpUnits: number;
  }>;
  setCurrentMembership(
    guildId: string,
    userId: string,
    current: boolean,
    atMs: number,
  ): Promise<void>;
  enqueueLevelAnnouncement(announcement: ServerLevelAnnouncement): Promise<void>;
  listPendingLevelAnnouncements(limit: number): Promise<ServerLevelAnnouncement[]>;
  markLevelAnnouncementDelivered(announcementId: string, deliveredAtMs: number): Promise<void>;
  markLevelAnnouncementTerminal(
    announcementId: string,
    reason: string,
    terminalAtMs: number,
  ): Promise<void>;
  compactIntervalAwards(createdBeforeMs: number, limit: number): Promise<number>;
  purgeRemovedGuilds(removedBeforeMs: number, limit: number): Promise<number>;
  eraseMemberProgression(guildId: string, userId: string): Promise<void>;
}
