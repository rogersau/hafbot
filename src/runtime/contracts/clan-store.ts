import type {
  Clan,
  ClanApplication,
  ClanHistoryEvent,
  ClanInvitation,
  ClanManagementConfig,
  ClanMembership,
  ClanMembershipBlock,
  ClanOwnershipTransfer,
  ClanRequest,
  ClanRequestStatus,
} from "../../clans";

export interface ClanStore {
  readConfig(guildId: string): Promise<ClanManagementConfig | null>;
  upsertConfig(config: ClanManagementConfig): Promise<void>;
  createRequest(request: ClanRequest): Promise<void>;
  readRequestById(requestId: string): Promise<ClanRequest | null>;
  readRequest(guildId: string, requestId: string): Promise<ClanRequest | null>;
  readPendingRequestByRequester(guildId: string, requesterId: string): Promise<ClanRequest | null>;
  readLatestTerminalRequest(guildId: string, requesterId: string): Promise<ClanRequest | null>;
  listRequests(guildId: string, status?: ClanRequestStatus): Promise<ClanRequest[]>;
  listRequestReviewRecoveries(nowMs: number, limit: number): Promise<ClanRequest[]>;
  updateRequest(request: ClanRequest, expectedRevision: number): Promise<boolean>;
  claimRequestReviewTicket(
    guildId: string,
    requestId: string,
    revision: number,
    nowMs: number,
  ): Promise<boolean>;
  createClan(clan: Clan): Promise<void>;
  updateClan(clan: Clan): Promise<void>;
  readClan(guildId: string, clanId: string): Promise<Clan | null>;
  readClanByRequest(requestId: string): Promise<Clan | null>;
  readClanByResource(guildId: string, resourceId: string): Promise<Clan | null>;
  listClans(guildId: string): Promise<Clan[]>;
  countCapacityConsumingClans(guildId: string): Promise<number>;
  createMembership(membership: ClanMembership): Promise<void>;
  updateMembership(membership: ClanMembership): Promise<void>;
  readActiveMembership(guildId: string, userId: string): Promise<ClanMembership | null>;
  listActiveMemberships(clanId: string): Promise<ClanMembership[]>;
  createApplication(application: ClanApplication): Promise<void>;
  readApplication(guildId: string, applicationId: string): Promise<ClanApplication | null>;
  updateApplication(application: ClanApplication): Promise<void>;
  claimApplication(guildId: string, applicationId: string, nowMs: number): Promise<boolean>;
  createInvitation(invitation: ClanInvitation): Promise<void>;
  readInvitation(guildId: string, invitationId: string): Promise<ClanInvitation | null>;
  updateInvitation(invitation: ClanInvitation): Promise<void>;
  claimInvitation(guildId: string, invitationId: string, nowMs: number): Promise<boolean>;
  createMembershipBlock(block: ClanMembershipBlock): Promise<void>;
  readActiveMembershipBlock(
    clanId: string,
    userId: string,
    nowMs: number,
  ): Promise<ClanMembershipBlock | null>;
  createOwnershipTransfer(transfer: ClanOwnershipTransfer): Promise<void>;
  readOwnershipTransfer(guildId: string, transferId: string): Promise<ClanOwnershipTransfer | null>;
  updateOwnershipTransfer(transfer: ClanOwnershipTransfer): Promise<void>;
  appendHistory(event: ClanHistoryEvent): Promise<void>;
  listHistory(guildId: string, clanId: string, limit?: number): Promise<ClanHistoryEvent[]>;
  listDueApplications(nowMs: number, limit: number): Promise<ClanApplication[]>;
  listDueInvitations(nowMs: number, limit: number): Promise<ClanInvitation[]>;
  expireApplication(guildId: string, applicationId: string, nowMs: number): Promise<boolean>;
  expireInvitation(guildId: string, invitationId: string, nowMs: number): Promise<boolean>;
  listScheduledClans(limit: number): Promise<Clan[]>;
  listDueDeletionClans(nowMs: number, limit: number): Promise<Clan[]>;
  purgeExpiredHistory(nowMs: number, limit: number): Promise<number>;
  purgeExpiredWorkflowRecords(nowMs: number, limit: number): Promise<number>;
}
