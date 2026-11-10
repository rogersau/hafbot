export type ClanRecruitmentState = "applications-open" | "invite-only" | "closed";
export type ClanRank = "owner" | "officer" | "member";
export type ClanLifecycleState =
  | "provisioning"
  | "active"
  | "degraded"
  | "archived"
  | "deletion-recovery"
  | "plan-dormant"
  | "permanently-deleted";
export type ClanRequestStatus =
  | "pending"
  | "changes-requested"
  | "approved"
  | "rejected"
  | "cancelled";
export type ClanReviewDecision = "approve" | "request-changes" | "reject";
export type ClanApplicationStatus =
  | "pending"
  | "accepting"
  | "accepted"
  | "rejected"
  | "expired"
  | "cancelled";
export type ClanInvitationStatus = ClanApplicationStatus;
export type ClanActivityType = "text" | "voice" | "clan-lfg" | "membership" | "management";
export type ClanBoardChannelType = "forum" | "text";
export type ClanRequestReviewTicketState =
  | "pending"
  | "creating"
  | "open"
  | "decision-pending"
  | "closed";

export interface ClanManagementConfig {
  guildId: string;
  enabled: boolean;
  reviewerRoleIds: string[];
  staffAccessRoleIds: string[];
  eligibilityAllowedRoleIds: string[];
  eligibilityRequiredRoleIds: string[];
  minimumAccountAgeDays: number;
  minimumGuildTenureDays: number;
  requestCooldownDays: number;
  invitationExpiryDays: number;
  applicationExpiryDays: number;
  localClansMax: number | null;
  localMembersMax: number | null;
  localOfficersMax: number | null;
  categoryId: string | null;
  requestPanelChannelId: string | null;
  requestPanelMessageId: string | null;
  requestReviewCategoryId?: string | null;
  requestPanelTitle?: string;
  requestPanelDescription?: string;
  requestPanelButtonLabel?: string;
  requestPanelColor?: number;
  boardEnabled: boolean;
  boardChannelId: string | null;
  boardChannelType: ClanBoardChannelType | null;
  roleNameTemplate: string;
  textChannelNameTemplate: string;
  voiceChannelNameTemplate: string;
  inactivityEnabled: boolean;
  inactivityWarningDays: number;
  inactivityArchiveDays: number;
  publicLfgAttributionEnabled: boolean;
  updatedAtMs: number;
}

export interface ClanRequest {
  id: string;
  guildId: string;
  requesterId: string;
  name: string;
  normalizedName: string;
  tag: string;
  normalizedTag: string;
  description: string;
  focus: string;
  recruitmentState: ClanRecruitmentState;
  proposedOfficerIds: string[];
  status: ClanRequestStatus;
  revision: number;
  reviewerId: string | null;
  reviewReason: string | null;
  clanId: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  terminalAtMs: number | null;
  retentionExpiresAtMs: number | null;
  reviewChannelId?: string | null;
  reviewMessageId?: string | null;
  reviewTicketState?: ClanRequestReviewTicketState;
  reviewTicketError?: string | null;
}

export interface Clan {
  id: string;
  guildId: string;
  requestId: string;
  name: string;
  normalizedName: string;
  tag: string;
  normalizedTag: string;
  description: string;
  focus: string;
  icon: string | null;
  recruitmentState: ClanRecruitmentState;
  lifecycleState: ClanLifecycleState;
  roleId: string | null;
  textChannelId: string | null;
  voiceChannelId: string | null;
  boardProjectionId: string | null;
  boardProjectionChannelId: string | null;
  operation: string | null;
  degradedReason: string | null;
  sensitiveManagementFrozen: boolean;
  clanLfgLeadershipOnly: boolean;
  latestActivityAtMs: number | null;
  latestActivityType: ClanActivityType | null;
  inactivityWarnedAtMs: number | null;
  deletionDueAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
  permanentlyDeletedAtMs: number | null;
}

export interface ClanMembership {
  clanId: string;
  guildId: string;
  userId: string;
  rank: ClanRank;
  joinedAtMs: number;
  leftAtMs: number | null;
}

export interface ClanApplication {
  id: string;
  clanId: string;
  guildId: string;
  applicantId: string;
  message: string;
  experience: string | null;
  availability: string | null;
  playStyle: string | null;
  status: ClanApplicationStatus;
  decidedByUserId: string | null;
  decisionReason: string | null;
  expiresAtMs: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ClanInvitation {
  id: string;
  clanId: string;
  guildId: string;
  inviteeId: string;
  invitedByUserId: string;
  intendedRank: Exclude<ClanRank, "owner">;
  status: ClanInvitationStatus;
  expiresAtMs: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ClanMembershipBlock {
  id: string;
  clanId: string;
  guildId: string;
  userId: string;
  reason: string;
  createdByUserId: string;
  createdAtMs: number;
  expiresAtMs: number;
  liftedAtMs: number | null;
  liftedByUserId: string | null;
}

export interface ClanOwnershipTransfer {
  id: string;
  clanId: string;
  guildId: string;
  fromUserId: string;
  toUserId: string;
  status: "pending" | "accepted" | "cancelled" | "expired";
  createdAtMs: number;
  expiresAtMs: number;
  resolvedAtMs: number | null;
}

export interface ClanHistoryEvent {
  id: string;
  guildId: string;
  clanId: string | null;
  requestId: string | null;
  event: string;
  actorUserId: string;
  reason: string | null;
  beforeJson: string | null;
  afterJson: string | null;
  createdAtMs: number;
  retentionExpiresAtMs: number;
}

export function normalizeClanIdentity(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

export type ClanInteractionId =
  | { action: "request" }
  | { action: "request-modal"; requestId: string | null; revision: number | null }
  | { action: "revise"; requestId: string }
  | {
      action: "review";
      requestId: string;
      revision: number;
      decision: "approve" | "request-changes" | "reject";
    }
  | {
      action: "review-reason";
      requestId: string;
      revision: number;
      decision: "request-changes" | "reject";
    };

export function parseClanInteractionId(value: string): ClanInteractionId | null {
  const parts = value.split(":");
  if (parts[0] !== "clan") return null;
  if (parts[1] === "request" && parts.length === 2) return { action: "request" };
  if (parts[1] === "request-modal") {
    if (parts[2] === "new" && parts.length === 3)
      return { action: "request-modal", requestId: null, revision: null };
    const revision = Number(parts[3]);
    return parts[2] && Number.isInteger(revision) && revision > 0
      ? { action: "request-modal", requestId: parts[2], revision }
      : null;
  }
  if (parts[1] === "revise" && parts[2] && parts.length === 3)
    return { action: "revise", requestId: parts[2] };
  const revision = Number(parts[3]);
  if (!parts[2] || !Number.isInteger(revision) || revision < 1) return null;
  if (parts[1] === "review" && isClanReviewDecision(parts[4])) {
    return { action: "review", requestId: parts[2], revision, decision: parts[4] };
  }
  if (parts[1] === "review-reason" && (parts[4] === "request-changes" || parts[4] === "reject")) {
    return { action: "review-reason", requestId: parts[2], revision, decision: parts[4] };
  }
  return null;
}

export const buildClanRequestButtonId = () => "clan:request";
export const buildClanRequestModalId = (request?: Pick<ClanRequest, "id" | "revision">) =>
  request ? `clan:request-modal:${request.id}:${request.revision}` : "clan:request-modal:new";
export const buildClanReviseButtonId = (requestId: string) => `clan:revise:${requestId}`;
export const buildClanReviewButtonId = (
  request: Pick<ClanRequest, "id" | "revision">,
  decision: "approve" | "request-changes" | "reject",
) => `clan:review:${request.id}:${request.revision}:${decision}`;
export const buildClanReviewReasonModalId = (
  request: Pick<ClanRequest, "id" | "revision">,
  decision: "request-changes" | "reject",
) => `clan:review-reason:${request.id}:${request.revision}:${decision}`;

function isClanReviewDecision(value: string | undefined): value is ClanReviewDecision {
  return value === "approve" || value === "request-changes" || value === "reject";
}

export function defaultClanManagementConfig(
  guildId: string,
  nowMs = Date.now(),
): ClanManagementConfig {
  return {
    guildId,
    enabled: false,
    reviewerRoleIds: [],
    staffAccessRoleIds: [],
    eligibilityAllowedRoleIds: [],
    eligibilityRequiredRoleIds: [],
    minimumAccountAgeDays: 0,
    minimumGuildTenureDays: 0,
    requestCooldownDays: 7,
    invitationExpiryDays: 7,
    applicationExpiryDays: 7,
    localClansMax: null,
    localMembersMax: null,
    localOfficersMax: null,
    categoryId: null,
    requestPanelChannelId: null,
    requestPanelMessageId: null,
    requestReviewCategoryId: null,
    requestPanelTitle: "Create a Clan",
    requestPanelDescription:
      "Submit a Clan creation request for staff review. A private review ticket will be created for you and the Clan review team.",
    requestPanelButtonLabel: "Create Clan",
    requestPanelColor: 0x5865f2,
    boardEnabled: false,
    boardChannelId: null,
    boardChannelType: null,
    roleNameTemplate: "[{tag}] {name}",
    textChannelNameTemplate: "{tag}-chat",
    voiceChannelNameTemplate: "{tag} Voice",
    inactivityEnabled: false,
    inactivityWarningDays: 60,
    inactivityArchiveDays: 90,
    publicLfgAttributionEnabled: true,
    updatedAtMs: nowMs,
  };
}
