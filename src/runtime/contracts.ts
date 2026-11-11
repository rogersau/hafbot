import type {
  BlocklistConfig,
  ChannelFilterMode,
  ManualAssignmentTimedRoleConfig,
  NewMemberTimedRoleConfig,
  TicketInstance,
  TicketPanelConfig,
  TimedRoleAssignment,
} from "../types";
import type { AppConfigMutation } from "./admin-types";

export type { GuildNotificationChannelStore } from "./contracts/guild-notification-channel-store";
export type { BlocklistStore } from "./contracts/blocklist-store";
export type { AppConfigStore } from "./contracts/app-config-store";
export type { TimedRoleStore } from "./contracts/timed-role-store";
export type { TicketStore } from "./contracts/ticket-store";
export type { MarketplaceStore } from "./contracts/marketplace-store";
export type { LfgStore } from "./contracts/lfg-store";
export type { ClanStore } from "./contracts/clan-store";
export type { SuggestionStore } from "./contracts/suggestion-store";
export type { FeatureSetupStore } from "./contracts/feature-setup-store";
export type { PlatformLinkStore } from "./contracts/platform-link-store";
export type { GuildRbacStore } from "./contracts/guild-rbac-store";
export type { ProductAnalyticsPreferenceStore } from "./contracts/product-analytics-preference-store";
export type { ServerLevelStore } from "./contracts/server-level-store";
export type { WebhookProxyStore } from "./contracts/webhook-proxy-store";
export type { PlayerCountStore } from "./contracts/player-count-store";
export type { GuildEntitlementStore } from "./contracts/guild-entitlement-store";
export type { GuildPlanProjectionStore } from "./contracts/guild-plan-projection-store";
export type {
  GuildR2ObjectStore,
  GuildR2QuotaStore,
  GuildR2ReservationResult,
  GuildR2Usage,
  ExpiredGuildR2UploadReservation,
} from "./contracts/guild-r2-object-store";
export type { ReactionLimitStore } from "./contracts/reaction-limit-store";
export type { EvidenceVaultStore } from "./contracts/evidence-vault-store";
export type { ImageRulesStore } from "./contracts/image-rules-store";
export type { KnownGuildStore, KnownGuildRecord } from "./contracts/known-guild-store";
export type { UserPreferencesStore } from "./contracts/user-preferences-store";
export type { GuildAuditLogStore } from "./contracts/guild-audit-log-store";
export type { WhiteLabelBotStore } from "./contracts/white-label-bot-store";
export type { BanCaseStore } from "./contracts/ban-case-store";
export type { MemberVerificationStore } from "./contracts/member-verification-store";
export type { BotDefenseStore } from "./contracts/bot-defense-store";
export type { MentionProtectionStore } from "./contracts/mention-protection-store";
export type {
  EventReminderDue,
  EventStore,
  EventTeamRateLimitAction,
  EventTeamRateLimitResult,
  EventTeamRateLimitScope,
} from "./contracts/event-store";
export type { ManagedMessageStore } from "./contracts/managed-message-store";
export type { MessageTemplateStore } from "./contracts/message-template-store";
export type { OperationalIncidentStore } from "../operations/incidents/store";
export type { AdminFeedbackStore, AdminFeedbackRecord } from "./contracts/admin-feedback-store";
export type { OneTimeTokenStore } from "./contracts/one-time-token-store";
export type {
  GuildServiceSuspension,
  GuildServiceSuspensionAuditEvent,
  GuildServiceSuspensionStore,
} from "./contracts/guild-service-suspension-store";

export interface GatewaySnapshot {
  status: "idle" | "connecting" | "ready" | "resuming" | "backoff";
  sessionId: string | null;
  resumeGatewayUrl: string | null;
  lastSequence: number | null;
  backoffAttempt: number;
  lastError: string | null;
  heartbeatIntervalMs: number | null;
}

export interface RuntimeStore {
  readConfig(): Promise<BlocklistConfig>;
  upsertAppConfig(body: AppConfigMutation): Promise<void>;
  applyGuildEmojiMutation(body: {
    guildId: string;
    emoji: string;
    action: "add" | "remove";
  }): Promise<BlocklistConfig>;
  upsertGuildChannelFilter?(body: {
    guildId: string;
    channelMode: ChannelFilterMode;
    channelIds: string[];
  }): Promise<BlocklistConfig>;
  reserveNextTicketNumber(guildId: string): Promise<number>;
  readTicketPanelConfig(guildId: string): Promise<TicketPanelConfig | null>;
  upsertTicketPanelConfig(panel: TicketPanelConfig): Promise<void>;
  countOpenTicketsByUser(guildId: string, userId: string): Promise<number>;
  createTicketInstance(instance: TicketInstance): Promise<void>;
  deleteTicketInstance(body: { guildId: string; channelId: string }): Promise<void>;
  readOpenTicketByChannel(guildId: string, channelId: string): Promise<TicketInstance | null>;
  updateTicketClaim(body: {
    guildId: string;
    channelId: string;
    claimedByUserId: string | null;
    claimedAtMs: number | null;
  }): Promise<void>;
  listClosedTicketInstances(body: {
    guildId: string;
    panelId?: string | null;
    limit: number;
    beforeOpenedAtMs: number | null;
  }): Promise<{ tickets: TicketInstance[]; total: number; nextCursor: number | null }>;
  closeTicketInstance(body: {
    guildId: string;
    channelId: string;
    closedByUserId: string;
    closedAtMs: number;
    transcriptMessageId: string | null;
    staffThreadId?: string | null;
  }): Promise<void>;
  listTimedRoles(): Promise<TimedRoleAssignment[]>;
  listTimedRolesByGuild(guildId: string): Promise<TimedRoleAssignment[]>;
  upsertTimedRole(body: TimedRoleAssignment): Promise<void>;
  deleteTimedRole(body: { guildId: string; userId: string; roleId: string }): Promise<void>;
  listExpiredTimedRoles(nowMs: number): Promise<TimedRoleAssignment[]>;
  readNewMemberTimedRoleConfig(guildId: string): Promise<NewMemberTimedRoleConfig>;
  upsertNewMemberTimedRoleConfig(body: NewMemberTimedRoleConfig): Promise<void>;
  readManualAssignmentTimedRoleConfig(guildId: string): Promise<ManualAssignmentTimedRoleConfig>;
  upsertManualAssignmentTimedRoleConfig(body: ManualAssignmentTimedRoleConfig): Promise<void>;
  readGatewaySnapshot(): Promise<GatewaySnapshot>;
  writeGatewaySnapshot(snapshot: GatewaySnapshot): Promise<void>;
}

export interface TicketTranscriptBlobStore {
  putHtml(key: string, html: string): Promise<void>;
  getHtml(key: string): Promise<string | null>;
  putAttachment(
    key: string,
    body: ReadableStream<Uint8Array> | ArrayBuffer | string,
    options: { contentType: string | null; sizeBytes?: number },
  ): Promise<void>;
  getAttachment(key: string): Promise<{
    body: ReadableStream<Uint8Array> | ArrayBuffer | string;
    contentType: string | null;
  } | null>;
  deleteTranscriptArtifacts?(input: {
    guildId: string;
    channelId: string;
    objectId: string;
  }): Promise<void>;
}

export interface TicketTranscriptCapabilityAccess {
  issue(input: {
    objectId: string;
    guildId: string;
    channelId: string;
    accessToken: string;
    createdAtMs: number;
    expiresAtMs: number;
    retentionExpiresAtMs: number;
  }): Promise<void>;
  authorize(input: {
    guildId: string;
    channelId: string;
    accessToken: string;
    nowMs: number;
  }): Promise<{ objectId: string } | null>;
  revoke(input: { guildId: string; channelId: string; revokedAtMs: number }): Promise<boolean>;
  rotate(input: {
    guildId: string;
    channelId: string;
    accessToken: string;
    rotatedAtMs: number;
    expiresAtMs: number;
  }): Promise<{ expiresAtMs: number } | null>;
  discard(input: {
    objectId: string;
    guildId: string;
    channelId: string;
    discardedAtMs: number;
  }): Promise<boolean>;
  listRetentionExpired(
    nowMs: number,
    limit: number,
  ): Promise<Array<{ objectId: string; guildId: string; channelId: string }>>;
  deleteRetentionExpired(input: { objectId: string; nowMs: number }): Promise<boolean>;
}

export interface GatewayController {
  start(): Promise<unknown>;
  status(): Promise<unknown>;
  stop?(): Promise<unknown> | unknown;
}

export interface ManagedGatewayController extends GatewayController {
  stop(): void;
}

export interface ClosableRuntimeStore extends RuntimeStore {
  close(): void;
}
