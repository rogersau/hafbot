// Discord webhook event types

export interface DiscordEmoji {
  id: string | null;
  name: string | null;
  animated: boolean;
}

export interface DiscordReaction {
  channel_id: string;
  message_id: string;
  guild_id: string | undefined;
  emoji: DiscordEmoji;
  user_id: string;
  member?: { user?: { id?: string; bot?: boolean } };
}

export interface DiscordMessageCreate {
  id: string;
  channel_id: string;
  guild_id?: string;
  content: string;
  type?: number;
  author?: {
    id?: string;
    username?: string;
    global_name?: string | null;
    bot?: boolean;
  };
  member?: {
    nick?: string | null;
    roles?: string[];
    permissions?: string;
  };
  webhook_id?: string;
  attachments?: unknown[];
  timestamp?: string;
  edited_timestamp?: string | null;
  mentions?: Array<{
    id: string;
    username?: string;
    global_name?: string | null;
    member?: { roles?: string[] };
  }>;
  mention_roles?: string[];
  mention_everyone?: boolean;
  message_reference?: {
    message_id?: string;
    channel_id?: string;
    guild_id?: string;
  } | null;
  referenced_message?: DiscordMessageCreate | null;
}

export interface DiscordMessageUpdate {
  id?: string;
  channel_id?: string;
  guild_id?: string;
  content?: unknown;
  type?: number;
  author?: {
    id?: string;
    username?: string;
    global_name?: string | null;
    bot?: boolean;
  };
  member?: {
    nick?: string | null;
    roles?: string[];
  };
  webhook_id?: string;
  attachments?: unknown[];
  timestamp?: string;
  edited_timestamp?: string | null;
  mentions?: Array<{
    id: string;
    username?: string;
    global_name?: string | null;
    member?: { roles?: string[] };
  }>;
  mention_roles?: string[];
  mention_everyone?: boolean;
  message_reference?: {
    message_id?: string;
    channel_id?: string;
    guild_id?: string;
  } | null;
  referenced_message?: DiscordMessageCreate | null;
}

export interface DiscordMessageDelete {
  id?: string;
  channel_id?: string;
  guild_id?: string;
  content?: unknown;
  author?: {
    id?: string;
    username?: string;
    global_name?: string | null;
    bot?: boolean;
  };
  member?: {
    roles?: string[];
  };
}

export interface GuildSettingRow {
  guild_id: string;
  moderation_enabled: number;
  channel_mode?: ChannelFilterMode | string | null;
  channel_ids_json?: string | null;
}

export interface GuildBlockedEmojiRow {
  guild_id: string;
  normalized_emoji: string;
}

export interface AppConfigRow {
  key: string;
  value: string;
}

export interface TimedRoleRow {
  guild_id: string;
  user_id: string;
  role_id: string;
  duration_input: string;
  expires_at_ms: number;
  created_at_ms: number;
  updated_at_ms: number;
  suspended_role_ids_json?: string;
  pending_suspension_role_ids_json?: string;
  removed_role_ids_json?: string;
  pending_restoration_role_ids_json?: string;
  restoration_started_at_ms?: number | null;
  target_role_removal_completed_at_ms?: number | null;
}

export interface TimedRoleAssignment {
  guildId: string;
  userId: string;
  roleId: string;
  targetDisplayName?: string | null;
  durationInput: string;
  expiresAtMs: number;
  suspendedRoleIds?: string[];
  pendingSuspensionRoleIds?: string[];
  removedRoleIds?: string[];
  pendingRestorationRoleIds?: string[];
  restorationStartedAtMs?: number | null;
  targetRoleRemovalCompletedAtMs?: number | null;
}

export interface TimedRoleAutomationRule {
  /** Omitted legacy values are enabled. */
  enabled?: boolean;
  roleId: string;
  durationInput: string;
  dmMessage?: string | null;
  suspendedRoleIds?: string[];
}

export interface NewMemberTimedRoleConfig {
  guildId: string;
  roles: TimedRoleAutomationRule[];
}

export interface ManualAssignmentTimedRoleConfig {
  guildId: string;
  roles: TimedRoleAutomationRule[];
}

// Effective blocklist config materialized from the moderation store.
export type ChannelFilterMode = "include" | "exclude";

export interface BlocklistConfig {
  guilds: {
    [guildId: string]: {
      enabled: boolean;
      emojis: string[];
      channelMode?: ChannelFilterMode;
      channelIds?: string[];
    };
  };
  botUserId: string;
}

export interface ReactionLimitConfig {
  guildId: string;
  limitsEnabled: boolean;
  maxReactionsPerMessage: number | null;
  maxReactionsPerUserPerMessage: number | null;
  breachThreshold: number | null;
  breachRoleId: string | null;
  breachRoleDurationMs: number | null;
  breachDmText: string | null;
  channelMode: ChannelFilterMode;
  channelIds: string[];
}

export interface ReactionLimitBreachCounter {
  guildId: string;
  userId: string;
  breachCount: number;
}

export type GuildPlan = "free" | "premium" | "premium_plus";
export type GuildEntitlementTier = GuildPlan;

export type GuildEntitlementNullableLimit = number | null;

export interface GuildEntitlementLimits {
  blocklistMaxEmojis: GuildEntitlementNullableLimit;
  reactionLimitsEnabled: boolean;
  ticketsMaxPanels: GuildEntitlementNullableLimit;
  ticketsMaxTypesPerPanel: GuildEntitlementNullableLimit;
  platformLinkMaxLinks: GuildEntitlementNullableLimit;
  managedMessagesMax: GuildEntitlementNullableLimit;
  clansMax?: GuildEntitlementNullableLimit;
  clanMembersMax?: GuildEntitlementNullableLimit;
  clanOfficersMax?: GuildEntitlementNullableLimit;
  messageTemplatesMax?: GuildEntitlementNullableLimit;
  evidenceVaultMaxRecords: GuildEntitlementNullableLimit;
  r2MaxBytes: number;
  paidFeatures: boolean;
}

export type ManagedMessageStatus = "published" | "missing" | "unpublishing" | "unpublished";

export interface ManagedMessageEmbedField {
  name: string;
  value: string;
  inline: boolean;
}

export interface ManagedMessageEmbed {
  title?: string;
  description: string;
  color?: number;
  imageUrl?: string;
  thumbnailUrl?: string;
  footer?: string;
  fields: ManagedMessageEmbedField[];
}

export interface ManagedMessageAnnouncement {
  roleIds: string[];
  everyone: boolean;
  here: boolean;
  notifyOnCreate: boolean;
}

export interface ManagedMessageLinkButton {
  label: string;
  url: string;
  emoji?: string;
}

export interface ManagedMessage {
  id: string;
  guildId: string;
  internalName: string;
  channelId: string;
  messageId: string;
  embeds: ManagedMessageEmbed[];
  buttons?: ManagedMessageLinkButton[];
  announcement: ManagedMessageAnnouncement;
  status: ManagedMessageStatus;
  createdAtMs: number;
  updatedAtMs: number;
}

export type ManagedMessageDraftStatus = "draft" | "scheduled" | "failed";

export interface ManagedMessageDraft {
  id: string;
  guildId: string;
  internalName: string;
  channelId: string;
  embeds: ManagedMessageEmbed[];
  buttons?: ManagedMessageLinkButton[];
  announcement: ManagedMessageAnnouncement;
  status: ManagedMessageDraftStatus;
  scheduledAtMs: number | null;
  failureReason: string | null;
  attemptCount: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface MessageTemplate {
  id: string;
  guildId: string;
  internalName: string;
  embeds: ManagedMessageEmbed[];
  availableForTicketReplies: boolean;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface TicketTemplateReply {
  interactionId: string;
  guildId: string;
  ticketChannelId: string;
  templateId: string;
  templateInternalName: string;
  staffUserId: string;
  botMessageId: string | null;
  status: "pending" | "sent";
  createdAtMs: number;
}

export interface EvidenceVaultConfig {
  /** Omitted legacy values are enabled. */
  enabled?: boolean;
  guildId: string;
  auditChannelId: string;
  accessRoleIds: string[];
  subjectsEnabled: boolean;
  evidenceFields?: EvidenceFieldDefinition[];
  updatedAtMs: number;
}

export type EvidenceFieldType = "text" | "short_text" | "enum";

export interface EvidenceFieldDefinition {
  key: string;
  label: string;
  type: EvidenceFieldType;
  allowedValues?: string[];
}

export interface ImageRulesConfig {
  guildId: string;
  enabled: boolean;
  topicDescription: string;
  autoDeleteThreshold: number;
  modReviewThreshold: number;
  targetChannelIds: string[];
  excludedRoleIds: string[];
  modQueueChannelId: string | null;
  modRoleIds: string[];
  pingOnQueuePost: boolean;
  reactOnTopic: boolean;
  auditOnTopic: boolean;
  dryRun: boolean;
  createdAtMs: number;
  updatedAtMs: number;
}

export type ImageRulesModQueueItemStatus =
  | "pending"
  | "restoring"
  | "approved"
  | "restored"
  | "restore_failed";

export interface ImageRulesModQueueItem {
  id: string;
  guildId: string;
  channelId: string;
  messageId: string;
  authorId: string;
  imageUrl: string;
  topicDescription: string;
  offTopicConfidence: number;
  onTopicConfidence: number;
  status: ImageRulesModQueueItemStatus;
  queueChannelId: string | null;
  queueMessageId: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  decidedByUserId: string | null;
  decidedAtMs: number | null;
  failureReason: string | null;
  restoreClaimToken: string | null;
  restoreClaimExpiresAtMs: number | null;
  restoredMessageId: string | null;
}

export type BotDefenseDetectorType = "honeypot" | "rate";
export type BotFlagStatus = "open" | "dismissed" | "confirmed";

export interface BotDefenseHoneypotEvidence {
  kind: "honeypot";
  channelId: string;
  messageId: string;
}

export interface BotDefenseRateEvidence {
  kind: "rate";
  channelIds: string[];
  channelCount: number;
  windowSeconds: number;
  messageId?: string;
  messageChannelId?: string;
  messagePreview?: string;
  matchKind?: "image-attachments";
  attachmentCount?: number;
}

export type BotDefenseEvidence = BotDefenseHoneypotEvidence | BotDefenseRateEvidence;

export interface BotFlag {
  guildId: string;
  userId: string;
  status: BotFlagStatus;
  detectorType: BotDefenseDetectorType;
  evidence: BotDefenseEvidence;
  queueMessageId: string | null;
  resolvedByDiscordUserId: string | null;
  resolvedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface BotDefenseConfig {
  guildId: string;
  honeypotEnabled: boolean;
  honeypotWarnUser: boolean;
  honeypotDeleteMessage: boolean;
  rateEnabled: boolean;
  rateWarnUser: boolean;
  rateDeleteMessage: boolean;
  honeypotChannelIds: string[];
  rateChannelThreshold: number;
  rateWindowSeconds: number;
  excludedRoleIds: string[];
  modRoleIds: string[];
  modQueueChannelId: string | null;
  pingOnQueuePost: boolean;
  createdAtMs: number;
  updatedAtMs: number;
}

export type MentionProtectionKind = "admin" | "spam";
export type MentionProtectionCondition =
  | "admin-mention"
  | "mass-mention"
  | "mention-burst"
  | "mass-and-burst";
export type MentionProtectionStage = "initial" | "repeat";

export type MentionProtectionRestriction =
  | { type: "none" }
  | { type: "timeout"; durationMs: number }
  | { type: "timed-role"; roleId: string; durationMs: number };

export interface MentionProtectionResponsePolicy {
  reply: boolean;
  delete: boolean;
  restriction: MentionProtectionRestriction;
}

export interface MentionProtectionConfig {
  guildId: string;
  adminEnabled: boolean;
  spamEnabled: boolean;
  protectedAdminRoleIds: string[];
  channelMode: ChannelFilterMode;
  channelIds: string[];
  excludedRoleIds: string[];
  massMentionThreshold: number;
  burstMessageThreshold: number;
  burstWindowSeconds: number;
  adminRepeatPeriodMs: number;
  spamRepeatPeriodMs: number;
  adminInitialResponse: MentionProtectionResponsePolicy;
  adminRepeatResponse: MentionProtectionResponsePolicy;
  spamInitialResponse: MentionProtectionResponsePolicy;
  spamRepeatResponse: MentionProtectionResponsePolicy;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface MentionProtectionDetection {
  protection: MentionProtectionKind;
  condition: MentionProtectionCondition;
  repeatPeriodMs: number;
  initialResponse: MentionProtectionResponsePolicy;
  repeatResponse: MentionProtectionResponsePolicy;
  evidence: Record<string, unknown>;
}

export interface MentionProtectionClaimInput {
  guildId: string;
  messageId: string;
  userId: string;
  channelId: string;
  messageCreatedAtMs: number;
  contentSnapshot: string;
  nowMs: number;
  detections: MentionProtectionDetection[];
}

export interface MentionProtectionBreach {
  guildId: string;
  messageId: string;
  userId: string;
  channelId: string;
  protection: MentionProtectionKind;
  condition: MentionProtectionCondition;
  stage: MentionProtectionStage;
  responsePolicy: MentionProtectionResponsePolicy;
  evidence: Record<string, unknown>;
  contentSnapshot: string;
  messageCreatedAtMs: number;
  breachedAtMs: number;
}

export type MentionProtectionActionKey =
  | "reply"
  | "delete"
  | "timeout"
  | `timeout:${number}`
  | "audit"
  | `timed-role:${string}`;
export type MentionProtectionActionStatus =
  | "succeeded"
  | "failed"
  | "already-satisfied"
  | "deferred";
export type MentionProtectionActionClaim = "claimed" | "satisfied" | "deferred";

export interface MentionProtectionActionOutcome {
  guildId: string;
  messageId: string;
  action: MentionProtectionActionKey;
  status: MentionProtectionActionStatus;
  detail?: string;
  retryable?: boolean;
  updatedAtMs: number;
}

export interface MemberVerificationConfig {
  guildId: string;
  enabled: boolean;
  verifiedRoleId: string | null;
  title: string;
  description: string;
  color: number;
  imageUrl: string | null;
  thumbnailUrl: string | null;
  rulesUrl: string | null;
  verifyButtonEmoji: string | null;
  deliveryMode: MemberVerificationDeliveryMode;
  verificationMethod: MemberVerificationMethod;
  welcomeChannelId: string | null;
  panelMessageId: string | null;
  updatedAtMs: number;
}

export type MemberVerificationDeliveryMode = "dm" | "channel";

export type MemberVerificationMethod = "discord-button" | "turnstile" | "steam-link";

export interface MemberVerificationState {
  guildId: string;
  userId: string;
  verifiedAtMs: number;
}

export interface MemberVerificationAttempt {
  id: string;
  guildId: string;
  userId: string;
  messageId: string | null;
  channelId: string | null;
  createdAtMs: number;
  expiresAtMs: number;
  usedAtMs: number | null;
}

export type SubjectIdentifierPlatform = "discord" | "steam" | "xbox" | "playstation" | "cftools";

export interface SubjectIdentifier {
  platform: SubjectIdentifierPlatform;
  id: string;
}

export interface IdentityPattern {
  id: string;
  platform: SubjectIdentifierPlatform;
  pattern: string;
  captureGroup: number;
  position: number;
  disabled: boolean;
  createdAtMs: number;
}

export type EvidenceVaultRecordStatus =
  | "active"
  | "source-delete-failed"
  | "placeholder-post-failed";

export interface EvidenceVaultImage {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  r2Key: string;
  /** @deprecated Display links are issued from authoritative record metadata. */
  url: string;
}

export interface EvidenceVaultRecord {
  id: string;
  guildId: string;
  sourceChannelId: string;
  sourceMessageId: string;
  sourceAuthorId: string;
  sourceAuthorDisplayName: string;
  sourceMessageTimestamp: string | null;
  hiderId: string;
  hiderDisplayName: string;
  hiddenAtMs: number;
  status: EvidenceVaultRecordStatus;
  sourceText: string;
  links: string[];
  images: EvidenceVaultImage[];
  totalImageBytes: number;
  placeholderChannelId: string | null;
  placeholderMessageId: string | null;
  subjectUserIds: SubjectIdentifier[];
  subjectsEnabled: boolean;
  evidenceFieldValues?: EvidenceFieldValue[];
}

export interface EvidenceFieldValue {
  key: string;
  label: string;
  type: EvidenceFieldType;
  value: string;
}

export interface GuildEntitlement {
  guildId: string;
  tier: GuildEntitlementTier;
  updatedAtMs: number;
}

export interface GuildPlanProjection {
  guildId: string;
  plan: GuildPlan;
  updatedAtMs: number;
}

export type WhiteLabelBotStatus =
  | "pending_install"
  | "active"
  | "suspended"
  | "decommissioning"
  | "decommissioned";

export interface WhiteLabelBot {
  guildId: string;
  applicationId: string;
  botUserId: string;
  displayName: string;
  brandFooterText: string | null;
  status: WhiteLabelBotStatus;
  tokenSecretRef: string;
  createdAtMs: number;
  updatedAtMs: number;
}

const GUILD_ENTITLEMENT_LIMITS: Record<GuildPlan, GuildEntitlementLimits> = {
  free: {
    blocklistMaxEmojis: 10,
    reactionLimitsEnabled: true,
    ticketsMaxPanels: 1,
    ticketsMaxTypesPerPanel: 1,
    platformLinkMaxLinks: 100,
    managedMessagesMax: 3,
    clansMax: 5,
    clanMembersMax: 25,
    clanOfficersMax: 5,
    messageTemplatesMax: 3,
    evidenceVaultMaxRecords: 30,
    r2MaxBytes: 100 * 1024 * 1024,
    paidFeatures: false,
  },
  premium: {
    blocklistMaxEmojis: null,
    reactionLimitsEnabled: true,
    ticketsMaxPanels: null,
    ticketsMaxTypesPerPanel: null,
    platformLinkMaxLinks: null,
    managedMessagesMax: null,
    clansMax: 25,
    clanMembersMax: null,
    clanOfficersMax: 5,
    messageTemplatesMax: null,
    evidenceVaultMaxRecords: null,
    r2MaxBytes: 1024 * 1024 * 1024,
    paidFeatures: true,
  },
  premium_plus: {
    blocklistMaxEmojis: null,
    reactionLimitsEnabled: true,
    ticketsMaxPanels: null,
    ticketsMaxTypesPerPanel: null,
    platformLinkMaxLinks: null,
    managedMessagesMax: null,
    clansMax: 25,
    clanMembersMax: null,
    clanOfficersMax: 5,
    messageTemplatesMax: null,
    evidenceVaultMaxRecords: null,
    r2MaxBytes: 1024 * 1024 * 1024,
    paidFeatures: true,
  },
};

export function isGuildPlan(value: unknown): value is GuildPlan {
  return value === "free" || value === "premium" || value === "premium_plus";
}

export function getGuildPlanLimits(plan: GuildPlan): GuildEntitlementLimits {
  return GUILD_ENTITLEMENT_LIMITS[plan];
}

export function isGuildEntitlementTier(value: unknown): value is GuildEntitlementTier {
  return isGuildPlan(value);
}

export function getGuildEntitlementLimits(tier: GuildEntitlementTier): GuildEntitlementLimits {
  return getGuildPlanLimits(tier);
}

export function createFreeGuildEntitlement(
  guildId: string,
  updatedAtMs = Date.now(),
): GuildEntitlement {
  return {
    guildId,
    tier: "free",
    updatedAtMs,
  };
}

export type TicketQuestionStyle = "short" | "paragraph";

export type TicketQuestionValidation = "none" | "steamId";

export type TicketButtonStyle = "primary" | "secondary" | "success" | "danger";

export type TicketLinkPlatform = "steam" | "xbox" | "playstation";

export type TicketResponseCondition =
  | { kind: "has-role"; roleId: string }
  | { kind: "lacks-role"; roleId: string }
  | { kind: "lacks-platform-linked-role"; platform?: TicketLinkPlatform };

export interface TicketResponseRule {
  id: string;
  conditions: TicketResponseCondition[];
  message: string;
}

export interface TicketQuestion {
  id: string;
  label: string;
  style: TicketQuestionStyle;
  placeholder: string | null;
  required: boolean;
  validation?: TicketQuestionValidation;
}

export interface TicketTypeConfig {
  /** Omitted legacy values are enabled. */
  enabled?: boolean;
  id: string;
  label: string;
  emoji: string | null;
  buttonStyle: TicketButtonStyle;
  supportRoleId: string;
  allowedCreatorRoleIds?: string[];
  channelNamePrefix: string;
  questions: TicketQuestion[];
  autoReplyEnabled: boolean;
  autoReplyMessage: string | null;
  responseRules?: TicketResponseRule[];
  defaultTicketLinkPlatform?: TicketLinkPlatform | null;
  /** @deprecated Stored-input alias. New configurations use the two explicit settings below. */
  anonymousEnabled?: boolean;
  anonymousSupportEnabled?: boolean;
  staffDiscussionThreadEnabled?: boolean;
  ticketHistoryPromptVisibility?: "off" | "staff-thread";
  participantManagementEnabled?: boolean;
  limitExclusion: boolean;
  mentionSupportRole?: boolean;
}

export interface TicketPanelConfig {
  guildId: string;
  panelId?: string;
  panelName?: string;
  panelChannelId: string;
  categoryChannelId: string;
  transcriptChannelId: string;
  panelEmoji: string | null;
  panelTitle: string | null;
  panelDescription: string | null;
  panelFooter: string | null;
  panelColor?: number;
  panelMessageId: string | null;
  ticketCreationLimit: number | null;
  ticketLimitRejectionMessage: string | null;
  enableTicketClaiming: boolean;
  aiTranscriptSummariesEnabled?: boolean;
  ticketTypes: TicketTypeConfig[];
}

export interface TicketAnswer {
  questionId: string;
  label: string;
  value: string;
}

export interface TicketInstance {
  guildId: string;
  channelId: string;
  panelId?: string | null;
  ticketTypeId: string;
  ticketTypeLabel: string;
  openerUserId: string;
  supportRoleId: string | null;
  status: "open" | "closed";
  answers: TicketAnswer[];
  openedAtMs: number;
  closedAtMs: number | null;
  closedByUserId: string | null;
  transcriptMessageId: string | null;
  staffThreadId: string | null;
  claimedByUserId?: string | null;
  claimedAtMs?: number | null;
  openingMessageId?: string | null;
}

export interface TicketParticipant {
  guildId: string;
  ticketChannelId: string;
  userId: string;
  addedEventId: string;
  addedByUserId: string;
  addedAtMs: number;
}

export interface TicketParticipantEvent {
  id: string;
  guildId: string;
  ticketChannelId: string;
  ticketTypeId: string;
  action: "participant-added" | "participant-removed";
  targetUserId: string;
  actorUserId: string;
  createdAtMs: number;
  notificationState: "pending" | "delivering" | "delivered";
  notificationClaimedAtMs: number | null;
}

export type MarketplaceTradeType = "have" | "want";

export interface MarketplaceServerOption {
  id: string;
  label: string;
  emoji: string | null;
}

export interface MarketplaceNoticeEmbed {
  title: string;
  description: string;
  color: number;
  buttonLabel: string;
  buttonEmoji: string | null;
}

export interface MarketplaceChoiceOption {
  id: string;
  label: string;
  emoji: string | null;
}

export interface MarketplaceAdditionalChoice {
  id: string;
  label: string;
  options: MarketplaceChoiceOption[];
}

export interface MarketplaceChoiceSelection {
  choiceId: string;
  choiceLabel: string;
  optionId: string;
  optionLabel: string;
}

export interface MarketplaceConfig {
  enabled?: boolean;
  guildId: string;
  noticeChannelId: string | null;
  noticeMessageId: string | null;
  logChannelId: string | null;
  serverOptions: MarketplaceServerOption[];
  noticeEmbed?: MarketplaceNoticeEmbed;
  serverChoiceEnabled?: boolean;
  additionalChoicesEnabled?: boolean;
  additionalChoices?: MarketplaceAdditionalChoice[];
  flowUpdatedAtMs?: number;
  updatedAtMs: number;
}

export interface MarketplacePost {
  guildId: string;
  id: string;
  ownerId: string;
  ownerDisplayName: string;
  tradeType: MarketplaceTradeType;
  serverId: string;
  serverLabel: string;
  additionalChoices?: MarketplaceChoiceSelection[];
  have: string;
  want: string;
  extra: string;
  channelId: string;
  messageId: string | null;
  active: boolean;
  createdAtMs: number;
  closedAtMs: number | null;
  closedByUserId: string | null;
}

export interface MarketplaceBusinessLog {
  guildId: string;
  id: string;
  timestampMs: number;
  buyerId: string;
  buyerDisplayName: string;
  sellerId: string;
  postId: string;
  channelId: string;
  messageId: string | null;
  tradeType: MarketplaceTradeType;
  serverLabel: string;
  dmSent: boolean;
  dmError: string | null;
  have: string;
  want: string;
}

export interface LfgServerOption {
  id: string;
  label: string;
  emoji: string | null;
}

export interface LfgConfig {
  enabled?: boolean;
  guildId: string;
  noticeChannelId: string | null;
  noticeMessageId: string | null;
  notificationRoleId: string | null;
  noticeColor?: number;
  counterVoiceChannelId: string | null;
  counterDisplayFormat: string;
  approvalFlowEnabled: boolean;
  approvalAuditChannelId: string | null;
  approvalVoiceCategoryId: string | null;
  expiryAction: "close" | "delete" | "nothing";
  expiryDurationHours: number;
  serverOptions: LfgServerOption[];
  updatedAtMs: number;
}

export interface LfgPost {
  guildId: string;
  id: string;
  ownerId: string;
  ownerDisplayName: string;
  serverId: string;
  serverLabel: string;
  whenPlay: string;
  lookingFor: string;
  extraInfo: string;
  channelId: string;
  messageId: string | null;
  active: boolean;
  createdAtMs: number;
  expiresAtMs: number | null;
  reminderSentAtMs: number | null;
  renewedAtMs: number | null;
  renewalsCount: number;
  closedAtMs: number | null;
  closedByUserId: string | null;
  scope?: "public" | "clan";
  clanId?: string | null;
  clanTag?: string | null;
  persistentVoiceChannelId?: string | null;
}

export type LfgApplicationStatus = "pending" | "accepted" | "rejected";

export interface LfgApplication {
  guildId: string;
  postId: string;
  applicantId: string;
  applicantDisplayName: string;
  message: string;
  status: LfgApplicationStatus;
  createdAtMs: number;
  updatedAtMs: number;
  reviewedByUserId: string | null;
  reviewedAtMs: number | null;
}

export interface LfgVoiceChannel {
  guildId: string;
  postId: string;
  channelId: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export type EventStatus = "draft" | "scheduled" | "live" | "ended" | "cancelled" | "archived";

export type EventSignupMode = "single_choice" | "multi_choice";

export type EventParticipationMode = "individual" | "team";

export type EventSignupStatus = "confirmed" | "waitlisted";

export type EventReminderAudience =
  | "signed_up"
  | "waitlisted"
  | "not_signed_up"
  | "channel_public"
  | "signup_group";

export interface EventSignupGroup {
  id: string;
  label: string;
  emoji: string | null;
  capacity: number | null;
  waitlistEnabled: boolean;
  allowedRoleIds: string[];
  blockedRoleIds: string[];
  grantRoleId: string | null;
}

export interface EventReminder {
  id: string;
  offsetMinutes: number;
  audience: EventReminderAudience;
  signupGroupIds: string[];
  message: string;
  sentAtMs: number | null;
}

export interface EventTemplate {
  guildId: string;
  id: string;
  name: string;
  description: string;
  signupMode: EventSignupMode;
  participationMode: EventParticipationMode;
  requiredTeamSize: number | null;
  threadEnabled: boolean;
  waitlistedMembersJoinThread: boolean;
  groups: EventSignupGroup[];
  reminders: EventReminder[];
  createdAtMs: number;
  updatedAtMs: number;
}

export interface EventRecord {
  guildId: string;
  id: string;
  templateId: string | null;
  title: string;
  description: string;
  status: EventStatus;
  channelId: string;
  messageId: string | null;
  threadId: string | null;
  startsAtMs: number;
  endsAtMs: number | null;
  signupCutoffAtMs: number;
  signupMode: EventSignupMode;
  participationMode: EventParticipationMode;
  requiredTeamSize: number | null;
  threadEnabled: boolean;
  waitlistedMembersJoinThread: boolean;
  groups: EventSignupGroup[];
  reminders: EventReminder[];
  createdAtMs: number;
  updatedAtMs: number;
  publishedAtMs: number | null;
  cancelledAtMs: number | null;
  endedAtMs: number | null;
  archivedAtMs: number | null;
}

export interface EventSignup {
  guildId: string;
  eventId: string;
  userId: string;
  groupId: string;
  status: EventSignupStatus;
  createdAtMs: number;
  updatedAtMs: number;
}

export type EventTeamStatus = "active" | "disbanded";

export interface EventTeam {
  guildId: string;
  eventId: string;
  id: string;
  groupId: string;
  name: string;
  normalizedName: string;
  captainUserId: string;
  openToRequests: boolean;
  status: EventTeamStatus;
  createdByUserId: string;
  createdAtMs: number;
  updatedAtMs: number;
  disbandedAtMs: number | null;
}

export interface EventTeamMembership {
  guildId: string;
  eventId: string;
  id: string;
  teamId: string;
  groupId: string;
  userId: string;
  joinedAtMs: number;
  leftAtMs: number | null;
}

export type EventTeamProposalKind = "join_request" | "invitation";
export type EventTeamProposalStatus =
  | "pending"
  | "accepted"
  | "declined"
  | "rejected"
  | "withdrawn"
  | "cancelled"
  | "expired";

/** An append-only proposal between an Event Team and a participant. */
export interface EventTeamProposal {
  guildId: string;
  eventId: string;
  id: string;
  teamId: string;
  kind: EventTeamProposalKind;
  requesterUserId: string;
  targetUserId: string;
  status: EventTeamProposalStatus;
  createdAtMs: number;
  updatedAtMs: number;
  resolvedAtMs: number | null;
}

/** A permanent per-team decline barrier for invitations. */
export interface EventTeamInvitationBlock {
  guildId: string;
  eventId: string;
  teamId: string;
  userId: string;
  createdAtMs: number;
}

/** Immutable record of a Team-scoped mutation. Payloads are intentionally JSON-safe snapshots. */
export interface EventTeamAuditRecord {
  guildId: string;
  eventId: string;
  id: string;
  actorUserId: string;
  action: string;
  targetType: "team" | "proposal" | "member" | "captain" | "admin" | "event";
  targetId: string;
  prior?: unknown;
  result?: unknown;
  occurredAtMs: number;
}

export interface EventTeamRosterSnapshotMember {
  membershipId: string;
  userId: string;
  groupId: string;
  signupStatus: EventSignupStatus | null;
}

/** Captured once when a team Event becomes live; subsequent roster changes never mutate it. */
export interface EventTeamRosterSnapshot {
  guildId: string;
  eventId: string;
  teamId: string;
  requiredTeamSize: number;
  members: EventTeamRosterSnapshotMember[];
  capturedAtMs: number;
}

export type EventTeamDeliveryOutboxKind = "notification" | "canonical_refresh";
export type EventTeamDeliveryOutboxStatus = "pending" | "processing" | "delivered" | "failed";

/** Durable delivery intent. Payloads remain available for retries and terminal diagnostics. */
export interface EventTeamDeliveryOutboxRecord {
  guildId: string;
  eventId: string;
  id: string;
  kind: EventTeamDeliveryOutboxKind;
  dedupeKey: string;
  payload?: unknown;
  status: EventTeamDeliveryOutboxStatus;
  attemptCount: number;
  maxAttempts: number;
  lastError: string | null;
  terminalFailureReason: string | null;
  nextAttemptAtMs: number;
  createdAtMs: number;
  updatedAtMs: number;
  deliveredAtMs: number | null;
}

export interface EventLifecycleHistoryRecord {
  guildId: string;
  eventId: string;
  id: string;
  fromStatus: EventStatus | null;
  toStatus: EventStatus;
  occurredAtMs: number;
  retentionExpiresAtMs: number | null;
}

export interface WebhookProxyDestination {
  id: string;
  label: string;
  url: string;
}

export interface WebhookProxyRoutingRule {
  id: string;
  label: string;
  pattern: string;
  flags: string;
  destinationIds: string[];
}

export interface WebhookProxyContentReplacement {
  id: string;
  label: string;
  pattern: string;
  flags: string;
  replacement: string;
}

export interface WebhookProxyConfig {
  guildId: string;
  publicId: string;
  name: string;
  enabled: boolean;
  banLookupEnabled: boolean;
  banLookupNotificationUrl: string | null;
  banLookupAppIds: number[];
  destinations: WebhookProxyDestination[];
  destinationsV2?: Array<{ id: string; label: string; credentialId: string }>;
  banLookupCredentialId?: string | null;
  credentialMigratedAtMs?: number | null;
  defaultDestinationIds: string[];
  routingRules: WebhookProxyRoutingRule[];
  contentReplacements?: WebhookProxyContentReplacement[];
  createdAtMs: number;
  updatedAtMs: number;
}

export interface WebhookProxyForwardLog {
  guildId: string;
  id: string;
  publicId: string;
  destinationId: string;
  destinationUrl?: string;
  credentialFingerprint?: string | null;
  status: number | null;
  ok: boolean;
  attempt: number;
  error: string | null;
  timestampMs: number;
}

export type BanCaseStatus = "new" | "completed";

/**
 * The per-Guild, per-source webhook endpoint that owns Ban Case intake for one
 * game-server ban feed. Distinct from a WebhookProxyConfig: a Ban Case Source
 * consumes a webhook to create a Ban Case Thread and forwards nothing.
 */
export interface BanCaseSource {
  guildId: string;
  sourceId: string;
  publicId: string;
  name: string;
  enabled: boolean;
  /** Declared platform of the captured subject id (admin assertion, not bot inference). */
  platform: SubjectIdentifierPlatform;
  /** Regex pattern (with {@link BanCaseSource.flags}) applied to the text webhook body. */
  pattern: string;
  flags: string;
  /** Named capture group in {@link BanCaseSource.pattern} holding the banned subject's id. */
  subjectIdGroup: string;
  /** Named capture group holding the banned subject's display name. */
  nameGroup: string;
  /** Named capture group holding the ban reason. */
  reasonGroup: string;
  createdAtMs: number;
  updatedAtMs: number;
}

/**
 * The per-Guild Ban Case configuration: the forum channel where Ban Case Threads
 * are created and the roles permitted to set a Ban Case Status. Sources are
 * stored separately (see {@link BanCaseSource}); this config is the shared surface.
 */
export interface BanCaseConfig {
  guildId: string;
  enabled: boolean;
  /** Forum channel ID where Ban Case Threads are created. Required before cases can be created. */
  forumChannelId: string | null;
  /** Discord role(s) permitted to set a Ban Case Status. Empty = Guild admins only. */
  modRoleIds: string[];
  updatedAtMs: number;
}

/**
 * A staff-worked container opened automatically when the bot receives a ban
 * webhook, materialised as a bot-owned Ban Case Thread. Uniquely identified per
 * Guild by its subject: a repeat ban for the same subject appends to the
 * existing thread without altering its status.
 */
export interface BanCase {
  guildId: string;
  caseId: string;
  sourceId: string;
  /** Public id of the source that created (or most recently fed) this case. */
  publicId: string;
  subject: SubjectIdentifier;
  /** Display name captured from the webhook body (no platform profile lookup in v1). */
  username: string;
  status: BanCaseStatus;
  /** Forum thread channel id. */
  threadChannelId: string;
  /** Id of the bot-owned starter message in the thread. */
  threadMessageId: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export type AuditEventGroupId =
  | "member"
  | "message"
  | "guild-structure"
  | "reaction-rule"
  | "timed-role"
  | "ticket"
  | "event"
  | "lfg"
  | "marketplace"
  | "evidence-vault"
  | "platform-link"
  | "player-count"
  | "wardogs"
  | "server-level"
  | "reputation"
  | "image-rule"
  | "ban-case"
  | "member-verification"
  | "bot-defense"
  | "mention-protection"
  | "managed-message"
  | "clan-management"
  | "suggestion"
  | "guild-audit-log";

export type AuditEventId =
  | "member.join"
  | "member.leave"
  | "member.nickname-change"
  | "member.role-assign"
  | "member.role-remove"
  | "member.ban"
  | "member.unban"
  | "message.delete"
  | "message.update"
  | "guild-structure.invite-create"
  | "guild-structure.channel-create"
  | "guild-structure.channel-update"
  | "guild-structure.channel-delete"
  | "guild-structure.channel-permissions-copied"
  | "guild-structure.feature-resource-setup"
  | "reaction-rule.enforcement"
  | "reaction-rule.config-change"
  | "timed-role.assignment"
  | "reaction-role.config-change"
  | "timed-role.removal"
  | "timed-role.expiry"
  | "ticket.creation"
  | "ticket.claim"
  | "ticket.close"
  | "ticket.panel-config-change"
  | "ticket.link-reminder"
  | "event.create"
  | "event.update"
  | "event.publish"
  | "event.cancel"
  | "event.archive"
  | "event.signup"
  | "event.leave"
  | "event.reminder"
  | "event.lifecycle"
  | "lfg.post-create"
  | "lfg.post-close"
  | "lfg.application-decision"
  | "lfg.voice-channel-create"
  | "lfg.voice-channel-cleanup"
  | "marketplace.post-create"
  | "marketplace.post-close"
  | "marketplace.trade"
  | "evidence-vault.hide"
  | "evidence-vault.view"
  | "evidence-vault.search"
  | "evidence-vault.subject-amend"
  | "platform-link.create"
  | "platform-link.remove"
  | "platform-link.manual-change"
  | "platform-link.role-restoration"
  | "platform-link.panel-publish-failed"
  | "player-count.fetch-failed"
  | "player-count.server-delete"
  | "wardogs.target-change"
  | "server-level.config-change"
  | "server-level.enable"
  | "server-level.disable"
  | "server-level.server-add"
  | "server-level.server-remove"
  | "server-level.capacity-accept"
  | "server-level.credential-rotate"
  | "server-level.webhook-verified"
  | "server-level.support-adjustment"
  | "server-level.personal-erasure"
  | "reputation.personal-erasure"
  | "image-rule.on-topic"
  | "image-rule.off-topic-delete"
  | "image-rule.classification-failed"
  | "image-rule.mod-queue-action"
  | "ban-case.create"
  | "ban-case.status-change"
  | "ban-case.server-action"
  | "member-verification.dm-sent"
  | "member-verification.dm-undeliverable"
  | "member-verification.dm-blocked"
  | "member-verification.verify"
  | "member-verification.verify-failed"
  | "member-verification.role-restoration"
  | "member-verification.panel-published"
  | "member-verification.attempt-created"
  | "member-verification.attempt-expired"
  | "member-verification.attempt-reused"
  | "member-verification.discord-mismatch"
  | "member-verification.turnstile-failed"
  | "member-verification.turnstile-pass"
  | "member-verification.steam-link-required"
  | "member-verification.steam-link-missing"
  | "bot-defense.honeypot-trip"
  | "bot-defense.rate-trip"
  | "bot-defense.confirm"
  | "bot-defense.dismiss"
  | "mention-protection.delete"
  | "managed-message.create"
  | "managed-message.update"
  | "managed-message.unpublish"
  | "managed-message.delete"
  | "managed-message.deleted-out-of-band"
  | "managed-message.repair"
  | "managed-message.schedule"
  | "managed-message.reschedule"
  | "managed-message.cancel"
  | "managed-message.publish"
  | "managed-message.publish-failed"
  | "managed-message.draft-delete"
  | "clan-management.request"
  | "clan-management.provisioning"
  | "clan-management.profile"
  | "clan-management.application"
  | "clan-management.invitation"
  | "clan-management.membership"
  | "clan-management.leadership"
  | "clan-management.override"
  | "clan-management.degradation"
  | "clan-management.repair"
  | "clan-management.board"
  | "clan-management.lifecycle"
  | "clan-management.dormancy"
  | "clan-management.deletion"
  | "suggestion.config-change"
  | "suggestion.panel-publish"
  | "suggestion.create"
  | "suggestion.revision"
  | "suggestion.status-change"
  | "suggestion.outcome"
  | "suggestion.reply-collapse"
  | "suggestion.mod-decision"
  | "suggestion.repair"
  | "message-template.create"
  | "message-template.update"
  | "message-template.delete"
  | "guild-audit-log.exclusion-policy-change"
  | "guild-audit-log.webhook-credential-reveal";

export interface AuditEventStates {
  groups: Partial<Record<AuditEventGroupId, boolean>>;
  overrides: Partial<Record<AuditEventId, boolean>>;
}

export interface GuildAuditLogConfig {
  guildId: string;
  auditChannelId: string;
  groupChannelIds: Partial<Record<AuditEventGroupId, string>>;
  eventStates: AuditEventStates;
  excludedChannelIds?: string[];
  excludedRoleIds?: string[];
  updatedAtMs: number;
}

export const AUDIT_EVENT_GROUP_LABELS: Record<AuditEventGroupId, string> = {
  member: "Member Events",
  message: "Message Events",
  "guild-structure": "Guild Structure Events",
  "reaction-rule": "Reaction Rule Events",
  "timed-role": "Timed Role Events",
  ticket: "Ticket Events",
  event: "Community Event Events",
  lfg: "LFG Events",
  marketplace: "Marketplace Events",
  "evidence-vault": "Evidence Vault Events",
  "platform-link": "Play Link Events",
  "player-count": "Player Count Events",
  wardogs: "WARDOGS Events",
  "server-level": "Server Levels Events",
  reputation: "Reputation Events",
  "image-rule": "Image Rule Events",
  "ban-case": "Ban Case Events",
  "member-verification": "Member Verification Events",
  "bot-defense": "Bot Defense Events",
  "mention-protection": "Mention Protection Events",
  "managed-message": "Managed Message Events",
  "clan-management": "Clan Management Events",
  suggestion: "Suggestion Events",
  "guild-audit-log": "Guild Audit Log Events",
};

export const AUDIT_EVENT_LABELS: Record<AuditEventId, string> = {
  "member.join": "Member Join",
  "member.leave": "Member Leave",
  "member.nickname-change": "Nickname Change",
  "member.role-assign": "Role Assignment",
  "member.role-remove": "Role Removal",
  "member.ban": "Member Ban",
  "member.unban": "Member Unban",
  "message.delete": "Message Deletion",
  "message.update": "Message Update",
  "guild-structure.invite-create": "Invite Creation",
  "guild-structure.channel-create": "Channel Creation",
  "guild-structure.channel-update": "Channel Update",
  "guild-structure.channel-delete": "Channel Deletion",
  "guild-structure.channel-permissions-copied": "Channel Permissions Copied",
  "guild-structure.feature-resource-setup": "Feature Resource Setup",
  "reaction-rule.enforcement": "Reaction Rule Enforcement",
  "reaction-rule.config-change": "Reaction Rules Config Change",
  "timed-role.assignment": "Timed Role Assignment",
  "reaction-role.config-change": "Reaction Roles Configuration Changed",
  "timed-role.removal": "Timed Role Removal",
  "timed-role.expiry": "Timed Role Expiry",
  "ticket.creation": "Ticket Creation",
  "ticket.claim": "Ticket Claim",
  "ticket.close": "Ticket Close",
  "ticket.panel-config-change": "Ticket Panel Config Change",
  "ticket.link-reminder": "Ticket Link Reminder",
  "event.create": "Event Created",
  "event.update": "Event Updated",
  "event.publish": "Event Published",
  "event.cancel": "Event Cancelled",
  "event.archive": "Event Archived",
  "event.signup": "Event Signup",
  "event.leave": "Event Signup Removed",
  "event.reminder": "Event Reminder Sent",
  "event.lifecycle": "Event Lifecycle Change",
  "lfg.post-create": "LFG Post Creation",
  "lfg.post-close": "LFG Post Closure",
  "lfg.application-decision": "LFG Application Decision",
  "lfg.voice-channel-create": "LFG Voice Channel Creation",
  "lfg.voice-channel-cleanup": "LFG Voice Channel Cleanup",
  "marketplace.post-create": "Marketplace Post Creation",
  "marketplace.post-close": "Marketplace Post Closure",
  "marketplace.trade": "Marketplace Trade",
  "evidence-vault.hide": "Evidence Vault Hide",
  "evidence-vault.view": "Evidence Vault View",
  "evidence-vault.search": "Evidence Vault Search",
  "evidence-vault.subject-amend": "Evidence Vault Subject Amend",
  "platform-link.create": "Play Link Creation",
  "platform-link.remove": "Play Link Removal",
  "platform-link.manual-change": "Play Link Manual Change",
  "platform-link.role-restoration": "Play Link Role Restoration",
  "platform-link.panel-publish-failed": "Play Link Panel Publish Failed",
  "player-count.fetch-failed": "Player Count Fetch Failed",
  "player-count.server-delete": "Player Count Server Deleted",
  "wardogs.target-change": "WARDOGS Target Changed",
  "server-level.config-change": "Server Levels Configuration Changed",
  "server-level.enable": "Server Levels Enabled",
  "server-level.disable": "Server Levels Disabled",
  "server-level.server-add": "Configured Game Server Added",
  "server-level.server-remove": "Configured Game Server Removed",
  "server-level.capacity-accept": "Server Levels Capacity Accepted",
  "server-level.credential-rotate": "Server Levels Credential Rotated",
  "server-level.webhook-verified": "Server Levels Webhook Verified",
  "server-level.support-adjustment": "Server XP Support Adjustment",
  "server-level.personal-erasure": "Server Levels Personal Data Erased",
  "reputation.personal-erasure": "Reputation Personal Data Erased",
  "image-rule.on-topic": "On-Topic Image Classified",
  "image-rule.off-topic-delete": "Off-Topic Image Deleted",
  "image-rule.classification-failed": "Image Classification Failed",
  "image-rule.mod-queue-action": "Image Rules Mod Queue Action",
  "ban-case.create": "Ban Case Created",
  "ban-case.status-change": "Ban Case Status Change",
  "ban-case.server-action": "Ban Case Server Action",
  "member-verification.dm-sent": "Member Verification DM Sent",
  "member-verification.dm-undeliverable": "Member Verification DM Undeliverable",
  "member-verification.dm-blocked": "Member Verification DM Blocked",
  "member-verification.verify": "Member Verified",
  "member-verification.verify-failed": "Member Verification Failed",
  "member-verification.role-restoration": "Member Verification Role Restored",
  "member-verification.panel-published": "Member Verification Panel Published",
  "member-verification.attempt-created": "Member Verification Attempt Created",
  "member-verification.attempt-expired": "Member Verification Attempt Expired",
  "member-verification.attempt-reused": "Member Verification Attempt Reused",
  "member-verification.discord-mismatch": "Member Verification Discord Mismatch",
  "member-verification.turnstile-failed": "Member Verification Turnstile Failed",
  "member-verification.turnstile-pass": "Member Verification Turnstile Passed",
  "member-verification.steam-link-required": "Member Verification Steam Link Required",
  "member-verification.steam-link-missing": "Member Verification Steam Link Missing",
  "bot-defense.honeypot-trip": "Bot Defense Honeypot Trip",
  "bot-defense.rate-trip": "Bot Defense Rate Trip",
  "bot-defense.confirm": "Bot Defense Confirmed",
  "bot-defense.dismiss": "Bot Defense Dismissed",
  "mention-protection.delete": "Mention Protection Deletion",
  "managed-message.create": "Managed Message Created",
  "managed-message.update": "Managed Message Updated",
  "managed-message.unpublish": "Managed Message Unpublished",
  "managed-message.delete": "Managed Message Deleted",
  "managed-message.deleted-out-of-band": "Managed Message Deleted Outside HAF",
  "managed-message.repair": "Managed Message Repaired",
  "managed-message.schedule": "Managed Message Scheduled",
  "managed-message.reschedule": "Managed Message Rescheduled",
  "managed-message.cancel": "Managed Message Schedule Cancelled",
  "managed-message.publish": "Managed Message Published",
  "managed-message.publish-failed": "Managed Message Publication Failed",
  "managed-message.draft-delete": "Managed Message Draft Deleted",
  "clan-management.request": "Clan Request Change",
  "clan-management.provisioning": "Clan Provisioning Change",
  "clan-management.profile": "Clan Profile Change",
  "clan-management.application": "Clan Application Change",
  "clan-management.invitation": "Clan Invitation Change",
  "clan-management.membership": "Clan Membership Change",
  "clan-management.leadership": "Clan Leadership Change",
  "clan-management.override": "Clan Admin Override",
  "clan-management.degradation": "Clan Degraded",
  "clan-management.repair": "Clan Repaired",
  "clan-management.board": "Clan Board Projection Change",
  "clan-management.lifecycle": "Clan Lifecycle Change",
  "clan-management.dormancy": "Clan Plan Dormancy Change",
  "clan-management.deletion": "Clan Deletion Change",
  "suggestion.config-change": "Suggestion Configuration Changed",
  "suggestion.panel-publish": "Suggestion Panel Published",
  "suggestion.create": "Suggestion Created",
  "suggestion.revision": "Suggestion Revised",
  "suggestion.status-change": "Suggestion Status Changed",
  "suggestion.outcome": "Suggestion Outcome Recorded",
  "suggestion.reply-collapse": "Considered Reply Collapsed",
  "suggestion.mod-decision": "Suggestion Moderation Decision",
  "suggestion.repair": "Suggestion Projection Repaired",
  "message-template.create": "Message Template Created",
  "message-template.update": "Message Template Updated",
  "message-template.delete": "Message Template Deleted",
  "guild-audit-log.exclusion-policy-change": "Audit Exclusion Policy Changed",
  "guild-audit-log.webhook-credential-reveal": "Webhook Credential Revealed",
};

export const AUDIT_EVENT_GROUP_MEMBERS: Record<AuditEventGroupId, readonly AuditEventId[]> = {
  reputation: ["reputation.personal-erasure"],
  member: [
    "member.join",
    "member.leave",
    "member.nickname-change",
    "member.role-assign",
    "member.role-remove",
    "member.ban",
    "member.unban",
  ],
  message: ["message.delete", "message.update"],
  "guild-structure": [
    "guild-structure.invite-create",
    "guild-structure.channel-create",
    "guild-structure.channel-update",
    "guild-structure.channel-delete",
    "guild-structure.channel-permissions-copied",
    "guild-structure.feature-resource-setup",
    "reaction-role.config-change",
  ],
  "reaction-rule": ["reaction-rule.enforcement", "reaction-rule.config-change"],
  "timed-role": ["timed-role.assignment", "timed-role.removal", "timed-role.expiry"],
  ticket: [
    "ticket.creation",
    "ticket.claim",
    "ticket.close",
    "ticket.panel-config-change",
    "ticket.link-reminder",
  ],
  event: [
    "event.create",
    "event.update",
    "event.publish",
    "event.cancel",
    "event.archive",
    "event.signup",
    "event.leave",
    "event.reminder",
    "event.lifecycle",
  ],
  lfg: [
    "lfg.post-create",
    "lfg.post-close",
    "lfg.application-decision",
    "lfg.voice-channel-create",
    "lfg.voice-channel-cleanup",
  ],
  marketplace: ["marketplace.post-create", "marketplace.post-close", "marketplace.trade"],
  "evidence-vault": [
    "evidence-vault.hide",
    "evidence-vault.view",
    "evidence-vault.search",
    "evidence-vault.subject-amend",
  ],
  "platform-link": [
    "platform-link.create",
    "platform-link.remove",
    "platform-link.manual-change",
    "platform-link.role-restoration",
    "platform-link.panel-publish-failed",
  ],
  "player-count": ["player-count.fetch-failed", "player-count.server-delete"],
  wardogs: ["wardogs.target-change"],
  "server-level": [
    "server-level.config-change",
    "server-level.enable",
    "server-level.disable",
    "server-level.server-add",
    "server-level.server-remove",
    "server-level.capacity-accept",
    "server-level.credential-rotate",
    "server-level.webhook-verified",
    "server-level.support-adjustment",
    "server-level.personal-erasure",
  ],
  "image-rule": [
    "image-rule.on-topic",
    "image-rule.off-topic-delete",
    "image-rule.classification-failed",
    "image-rule.mod-queue-action",
  ],
  "ban-case": ["ban-case.create", "ban-case.status-change", "ban-case.server-action"],
  "member-verification": [
    "member-verification.dm-sent",
    "member-verification.dm-undeliverable",
    "member-verification.dm-blocked",
    "member-verification.verify",
    "member-verification.verify-failed",
    "member-verification.role-restoration",
    "member-verification.panel-published",
    "member-verification.attempt-created",
    "member-verification.attempt-expired",
    "member-verification.attempt-reused",
    "member-verification.discord-mismatch",
    "member-verification.turnstile-failed",
    "member-verification.turnstile-pass",
    "member-verification.steam-link-required",
    "member-verification.steam-link-missing",
  ],
  "bot-defense": [
    "bot-defense.honeypot-trip",
    "bot-defense.rate-trip",
    "bot-defense.confirm",
    "bot-defense.dismiss",
  ] as const,
  "mention-protection": ["mention-protection.delete"],
  "managed-message": [
    "managed-message.create",
    "managed-message.update",
    "managed-message.unpublish",
    "managed-message.delete",
    "managed-message.deleted-out-of-band",
    "managed-message.repair",
    "managed-message.schedule",
    "managed-message.reschedule",
    "managed-message.cancel",
    "managed-message.publish",
    "managed-message.publish-failed",
    "managed-message.draft-delete",
    "message-template.create",
    "message-template.update",
    "message-template.delete",
  ],
  "clan-management": [
    "clan-management.request",
    "clan-management.provisioning",
    "clan-management.profile",
    "clan-management.application",
    "clan-management.invitation",
    "clan-management.membership",
    "clan-management.leadership",
    "clan-management.override",
    "clan-management.degradation",
    "clan-management.repair",
    "clan-management.board",
    "clan-management.lifecycle",
    "clan-management.dormancy",
    "clan-management.deletion",
  ],
  suggestion: [
    "suggestion.config-change",
    "suggestion.panel-publish",
    "suggestion.create",
    "suggestion.revision",
    "suggestion.status-change",
    "suggestion.outcome",
    "suggestion.reply-collapse",
    "suggestion.mod-decision",
    "suggestion.repair",
  ],
  "guild-audit-log": [
    "guild-audit-log.exclusion-policy-change",
    "guild-audit-log.webhook-credential-reveal",
  ],
};
