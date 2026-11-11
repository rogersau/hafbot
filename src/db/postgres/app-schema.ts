import { bigInteger, integerBoolean } from "./column-types";
import { sql } from "drizzle-orm";
import {
  doublePrecision,
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const appConfig = pgTable("app_config", {
  key: text("key").primaryKey().notNull(),
  value: text("value").notNull(),
});

export const guildSettings = pgTable("guild_settings", {
  guildId: text("guild_id").primaryKey().notNull(),
  moderationEnabled: boolean("moderation_enabled").notNull().default(true),
  channelMode: text("channel_mode").notNull().default("include"),
  channelIdsJson: text("channel_ids_json").notNull().default("[]"),
});

export const guildBlockedEmojis = pgTable(
  "guild_blocked_emojis",
  {
    guildId: text("guild_id").notNull(),
    normalizedEmoji: text("normalized_emoji").notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.normalizedEmoji] })],
);

export const guildNotificationChannels = pgTable(
  "guild_notification_channels",
  {
    guildId: text("guild_id").notNull(),
    feature: text("feature").notNull(),
    notificationChannelId: text("notification_channel_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.feature] })],
);

export const productAnalyticsPreferences = pgTable("product_analytics_preferences", {
  guildId: text("guild_id").primaryKey().notNull(),
  enabled: boolean("enabled").notNull().default(true),
  updatedAtMs: bigInteger("updated_at_ms").notNull(),
});

export const reactionLimitConfigs = pgTable("reaction_limit_configs", {
  guildId: text("guild_id").primaryKey().notNull(),
  limitsEnabled: boolean("limits_enabled").notNull().default(false),
  maxReactionsPerMessage: integer("max_reactions_per_message"),
  maxReactionsPerUserPerMessage: integer("max_reactions_per_user_per_message"),
  breachThreshold: integer("breach_threshold"),
  breachRoleId: text("breach_role_id"),
  breachRoleDurationMs: bigInteger("breach_role_duration_ms"),
  breachDmText: text("breach_dm_text"),
  channelMode: text("channel_mode").notNull().default("include"),
  channelIdsJson: text("channel_ids_json").notNull().default("[]"),
});

export const reactionLimitBreachCounters = pgTable(
  "reaction_limit_breach_counters",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    breachCount: bigInteger("breach_count").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.userId] })],
);

export const reactionLimitMessageReactionCounts = pgTable(
  "reaction_limit_message_reaction_counts",
  {
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull(),
    messageId: text("message_id").notNull(),
    reactionCount: bigInteger("reaction_count").notNull().default(0),
    updatedAtMs: bigInteger("updated_at_ms").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.channelId, table.messageId] }),
    index("reaction_limit_message_counts_updated_at").on(table.updatedAtMs),
  ],
);

export const reactionLimitUserMessageReactionCounts = pgTable(
  "reaction_limit_user_message_reaction_counts",
  {
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull(),
    messageId: text("message_id").notNull(),
    userId: text("user_id").notNull(),
    reactionCount: bigInteger("reaction_count").notNull().default(0),
    updatedAtMs: bigInteger("updated_at_ms").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.channelId, table.messageId, table.userId] }),
    index("reaction_limit_user_message_counts_updated_at").on(table.updatedAtMs),
  ],
);

export const serverLevelConfigs = pgTable("server_level_configs", {
  guildId: text("guild_id").primaryKey().notNull(),
  enabled: boolean("enabled").notNull().default(false),
  announcementChannelId: text("announcement_channel_id"),
  removedAtMs: bigInteger("removed_at_ms"),
  updatedAtMs: bigInteger("updated_at_ms").notNull(),
});

export const serverLevelServers = pgTable(
  "server_level_servers",
  {
    id: text("id").primaryKey().notNull(),
    guildId: text("guild_id").notNull(),
    displayName: text("display_name").notNull(),
    providerServerId: text("provider_server_id").notNull(),
    maxSlots: integer("max_slots").notNull(),
    endpointId: text("endpoint_id").notNull(),
    webhookCredentialId: text("webhook_credential_id").notNull(),
    webhookVerifiedAtMs: bigInteger("webhook_verified_at_ms"),
    subscribedEventsJson: text("subscribed_events_json").notNull().default("[]"),
    capacityProposalJson: text("capacity_proposal_json"),
    lastRosterReconciledAtMs: bigInteger("last_roster_reconciled_at_ms"),
    lastCapacityCheckedAtMs: bigInteger("last_capacity_checked_at_ms"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("server_level_servers_guild_provider").on(table.guildId, table.providerServerId),
    uniqueIndex("server_level_servers_endpoint").on(table.endpointId),
    index("server_level_servers_guild").on(table.guildId),
  ],
);

export const serverLevelCredentials = pgTable(
  "server_level_credentials",
  {
    credentialId: text("credential_id").primaryKey().notNull(),
    guildId: text("guild_id").notNull(),
    configuredGameServerId: text("configured_game_server_id").notNull(),
    purpose: text("purpose").notNull(),
    keyVersion: text("key_version").notNull(),
    nonce: text("nonce").notNull(),
    ciphertext: text("ciphertext").notNull(),
    fingerprint: text("fingerprint").notNull(),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("server_level_credentials_owner").on(table.configuredGameServerId, table.purpose),
  ],
);

export const serverLevelWebhookInbox = pgTable(
  "server_level_webhook_inbox",
  {
    inboxId: text("inbox_id").primaryKey().notNull(),
    deliveryId: text("delivery_id").notNull(),
    configuredGameServerId: text("configured_game_server_id").notNull(),
    guildId: text("guild_id").notNull(),
    eventType: text("event_type").notNull(),
    occurredAtMs: bigInteger("occurred_at_ms").notNull(),
    steamId64: text("steam_id64"),
    population: integer("population"),
    queueSize: integer("queue_size"),
    status: text("status").notNull().default("accepted"),
    reasonCode: text("reason_code"),
    receivedAtMs: bigInteger("received_at_ms").notNull(),
    bodySha256: text("body_sha256"),
    processedAtMs: bigInteger("processed_at_ms"),
  },
  (table) => [
    uniqueIndex("server_level_webhook_inbox_delivery").on(
      table.configuredGameServerId,
      table.deliveryId,
    ),
    index("server_level_webhook_inbox_processing").on(
      table.configuredGameServerId,
      table.status,
      table.occurredAtMs,
    ),
  ],
);

export const serverLevelIngressOutbox = pgTable(
  "server_level_ingress_outbox",
  {
    inboxId: text("inbox_id").primaryKey().notNull(),
    guildId: text("guild_id").notNull(),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    publishedAtMs: bigInteger("published_at_ms"),
  },
  (table) => [
    index("server_level_ingress_outbox_pending").on(table.publishedAtMs, table.createdAtMs),
  ],
);

export const serverLevelProcessingCursors = pgTable("server_level_processing_cursors", {
  configuredGameServerId: text("configured_game_server_id").primaryKey().notNull(),
  latestSeenAtMs: bigInteger("latest_seen_at_ms").notNull(),
  watermarkAtMs: bigInteger("watermark_at_ms").notNull(),
  lastDeliveryId: text("last_delivery_id").notNull(),
  population: integer("population"),
  queueSize: integer("queue_size"),
  lifecycleGeneration: integer("lifecycle_generation").notNull().default(0),
  updatedAtMs: bigInteger("updated_at_ms").notNull(),
});

export const serverLevelProcessingLeases = pgTable("server_level_processing_leases", {
  configuredGameServerId: text("configured_game_server_id").primaryKey().notNull(),
  leaseId: text("lease_id").notNull(),
  expiresAtMs: bigInteger("expires_at_ms").notNull(),
});

export const serverLevelCurrentPresence = pgTable(
  "server_level_current_presence",
  {
    configuredGameServerId: text("configured_game_server_id").notNull(),
    steamId64: text("steam_id64").notNull(),
    lifecycleGeneration: integer("lifecycle_generation").notNull(),
    joinedAtMs: bigInteger("joined_at_ms").notNull(),
    lastConfirmedAtMs: bigInteger("last_confirmed_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [primaryKey({ columns: [table.configuredGameServerId, table.steamId64] })],
);

export const serverLevelEarningSessions = pgTable(
  "server_level_earning_sessions",
  {
    sessionId: text("session_id").primaryKey().notNull(),
    guildId: text("guild_id").notNull(),
    configuredGameServerId: text("configured_game_server_id").notNull(),
    steamId64: text("steam_id64").notNull(),
    userId: text("user_id").notNull(),
    lifecycleGeneration: integer("lifecycle_generation").notNull(),
    startedAtMs: bigInteger("started_at_ms").notNull(),
    lastConfirmedAtMs: bigInteger("last_confirmed_at_ms").notNull(),
    checkpointAtMs: bigInteger("checkpoint_at_ms").notNull(),
    closedAtMs: bigInteger("closed_at_ms"),
    closeReason: text("close_reason"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    index("server_level_earning_sessions_server_open").on(
      table.configuredGameServerId,
      table.closedAtMs,
      table.checkpointAtMs,
    ),
    index("server_level_earning_sessions_member_open").on(
      table.guildId,
      table.userId,
      table.closedAtMs,
      table.checkpointAtMs,
    ),
  ],
);

export const serverLevelAwards = pgTable(
  "server_level_awards",
  {
    awardId: text("award_id").primaryKey().notNull(),
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    configuredGameServerId: text("configured_game_server_id"),
    sourceInboxId: text("source_inbox_id"),
    kind: text("kind").notNull(),
    intervalStartedAtMs: bigInteger("interval_started_at_ms"),
    intervalEndedAtMs: bigInteger("interval_ended_at_ms"),
    qualifyingSeconds: integer("qualifying_seconds").notNull().default(0),
    multiplier: integer("multiplier"),
    xpUnits: bigInteger("xp_units").notNull(),
    scoringPolicyVersion: integer("scoring_policy_version").notNull(),
    actorUserId: text("actor_user_id"),
    reason: text("reason"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    projectionAppliedAtMs: bigInteger("projection_applied_at_ms"),
  },
  (table) => [
    uniqueIndex("server_level_awards_interval_once").on(
      table.sourceInboxId,
      table.userId,
      table.configuredGameServerId,
      table.intervalStartedAtMs,
      table.intervalEndedAtMs,
    ),
    index("server_level_awards_member_time").on(
      table.guildId,
      table.userId,
      table.intervalStartedAtMs,
      table.intervalEndedAtMs,
    ),
    index("server_level_awards_compaction").on(table.kind, table.createdAtMs),
  ],
);

export const serverLevelMemberTotals = pgTable(
  "server_level_member_totals",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    totalXpUnits: bigInteger("total_xp_units").notNull().default(0),
    currentMember: boolean("current_member").notNull().default(true),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.userId] }),
    index("server_level_member_totals_leaderboard").on(
      table.guildId,
      table.currentMember,
      table.totalXpUnits,
    ),
  ],
);

export const serverLevelAnnouncementOutbox = pgTable(
  "server_level_announcement_outbox",
  {
    announcementId: text("announcement_id").primaryKey().notNull(),
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    channelId: text("channel_id").notNull(),
    level: integer("level").notNull(),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    deliveredAtMs: bigInteger("delivered_at_ms"),
    terminalReason: text("terminal_reason"),
  },
  (table) => [
    uniqueIndex("server_level_announcement_once").on(table.guildId, table.userId, table.level),
    index("server_level_announcement_pending").on(table.deliveredAtMs, table.createdAtMs),
  ],
);

export const serverLevelDailySummaries = pgTable(
  "server_level_daily_summaries",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    dayUtc: text("day_utc").notNull(),
    xpUnits: bigInteger("xp_units").notNull(),
    qualifyingSeconds: integer("qualifying_seconds").notNull(),
    scoringPolicyVersion: integer("scoring_policy_version").notNull(),
    createdAtMs: bigInteger("created_at_ms").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.guildId, table.userId, table.dayUtc, table.scoringPolicyVersion],
    }),
  ],
);

export const platformLinkConfigs = pgTable(
  "platform_link_configs",
  {
    guildId: text("guild_id").notNull(),
    enabled: bigInteger("enabled").notNull().default(1),
    platform: text("platform").notNull(),
    linkedRoleId: text("linked_role_id"),
    logChannelId: text("log_channel_id"),
    gameAppIdsJson: text("game_app_ids_json").notNull().default("[]"),
    panelTitle: text("panel_title").notNull().default("Link your account"),
    panelDescription: text("panel_description")
      .notNull()
      .default("Click the button below to securely link your Discord account."),
    panelButtonLabel: text("panel_button_label").notNull().default("Link"),
    panelButtonStyle: text("panel_button_style").notNull().default("Primary"),
    panelColor: bigInteger("panel_color"),
    allowRelink: bigInteger("allow_relink").notNull().default(1),
    allowMultipleLinks: bigInteger("allow_multiple_links").notNull().default(0),
    requireRelinkOnRejoin: bigInteger("require_relink_on_rejoin").notNull().default(0),
    whoisFieldsJson: text("whois_fields_json").notNull().default("[]"),
    customLinksJson: text("custom_links_json"),
    panelChannelId: text("panel_channel_id"),
    panelMessageId: text("panel_message_id"),
    updatedAtMs: bigInteger("updated_at_ms").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.platform] })],
);

export const pendingPlatformLinks = pgTable("pending_platform_links", {
  state: text("state").primaryKey().notNull(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  platform: text("platform").notNull(),
  createdAtMs: bigInteger("created_at_ms").notNull(),
});

export const platformLinks = pgTable(
  "platform_links",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    platform: text("platform").notNull(),
    platformId: text("platform_id").notNull(),
    linkedAtMs: bigInteger("linked_at_ms").notNull(),
    manual: bigInteger("manual").notNull().default(0),
    actionedByUserId: text("actioned_by_user_id"),
    metadataJson: text("metadata_json"),
    active: bigInteger("active").notNull().default(1),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.userId, table.platform, table.platformId] }),
    uniqueIndex("platform_links_by_platform_id").on(
      table.guildId,
      table.platform,
      table.platformId,
    ),
    index("platform_links_by_user").on(table.guildId, table.userId, table.platform),
  ],
);

export const evidenceVaultConfigs = pgTable("evidence_vault_configs", {
  guildId: text("guild_id").primaryKey().notNull(),
  enabled: bigInteger("enabled").notNull().default(1),
  auditChannelId: text("audit_channel_id").notNull(),
  accessRoleIdsJson: text("access_role_ids_json").notNull().default("[]"),
  subjectsEnabled: integerBoolean("subjects_enabled").notNull().default(false),
  fieldsJson: text("fields_json").notNull().default("[]"),
  updatedAtMs: bigInteger("updated_at_ms").notNull(),
});

export const evidenceVaultRecords = pgTable(
  "evidence_vault_records",
  {
    recordId: text("record_id").primaryKey().notNull(),
    guildId: text("guild_id").notNull(),
    status: text("status").notNull(),
    payloadJson: text("payload_json").notNull(),
    hiddenAtMs: bigInteger("hidden_at_ms").notNull(),
  },
  (table) => [index("evidence_vault_records_guild_idx").on(table.guildId, table.hiddenAtMs)],
);

export const identityPatterns = pgTable(
  "identity_patterns",
  {
    id: text("id").primaryKey().notNull(),
    platform: text("platform").notNull(),
    pattern: text("pattern").notNull(),
    captureGroup: bigInteger("capture_group").notNull(),
    position: bigInteger("position").notNull(),
    disabled: integerBoolean("disabled").notNull().default(false),
    createdAtMs: bigInteger("created_at_ms").notNull(),
  },
  (table) => [index("identity_patterns_position_idx").on(table.position)],
);

export const imageRulesConfigs = pgTable("image_rules_configs", {
  guildId: text("guild_id").primaryKey().notNull(),
  enabled: bigInteger("enabled").notNull().default(0),
  topicDescription: text("topic_description").notNull().default(""),
  autoDeleteThreshold: doublePrecision("auto_delete_threshold").notNull().default(0.85),
  modReviewThreshold: doublePrecision("mod_review_threshold").notNull().default(0.65),
  targetChannelIdsJson: text("target_channel_ids_json").notNull().default("[]"),
  excludedRoleIdsJson: text("excluded_role_ids_json").notNull().default("[]"),
  modQueueChannelId: text("mod_queue_channel_id"),
  modRoleIdsJson: text("mod_role_ids_json").notNull().default("[]"),
  pingOnQueuePost: bigInteger("ping_on_queue_post").notNull().default(1),
  reactOnTopic: bigInteger("react_on_topic").notNull().default(0),
  auditOnTopic: bigInteger("audit_on_topic").notNull().default(0),
  dryRun: bigInteger("dry_run").notNull().default(0),
  createdAtMs: bigInteger("created_at_ms").notNull(),
  updatedAtMs: bigInteger("updated_at_ms").notNull(),
});

export const imageRulesModQueueItems = pgTable(
  "image_rules_mod_queue_items",
  {
    id: text("id").primaryKey().notNull(),
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull(),
    messageId: text("message_id").notNull(),
    authorId: text("author_id").notNull(),
    imageUrl: text("image_url").notNull(),
    topicDescription: text("topic_description").notNull(),
    offTopicConfidence: doublePrecision("off_topic_confidence").notNull(),
    onTopicConfidence: doublePrecision("on_topic_confidence").notNull(),
    status: text("status").notNull(),
    queueChannelId: text("queue_channel_id"),
    queueMessageId: text("queue_message_id"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
    decidedByUserId: text("decided_by_user_id"),
    decidedAtMs: bigInteger("decided_at_ms"),
    failureReason: text("failure_reason"),
    restoreClaimToken: text("restore_claim_token"),
    restoreClaimExpiresAtMs: bigInteger("restore_claim_expires_at_ms"),
    restoredMessageId: text("restored_message_id"),
  },
  (table) => [
    index("image_rules_mod_queue_items_by_guild_status").on(
      table.guildId,
      table.status,
      table.createdAtMs,
    ),
    index("image_rules_mod_queue_items_restore_claim").on(table.restoreClaimExpiresAtMs),
    uniqueIndex("image_rules_mod_queue_items_by_source_message").on(
      table.guildId,
      table.channelId,
      table.messageId,
    ),
  ],
);

export const botDefenseConfigs = pgTable("bot_defense_configs", {
  guildId: text("guild_id").primaryKey().notNull(),
  honeypotEnabled: bigInteger("honeypot_enabled").notNull().default(0),
  honeypotWarnUser: bigInteger("honeypot_warn_user").notNull().default(0),
  honeypotDeleteMessage: bigInteger("honeypot_delete_message").notNull().default(0),
  rateEnabled: bigInteger("rate_enabled").notNull().default(0),
  rateWarnUser: bigInteger("rate_warn_user").notNull().default(0),
  rateDeleteMessage: bigInteger("rate_delete_message").notNull().default(0),
  honeypotChannelIdsJson: text("honeypot_channel_ids_json").notNull().default("[]"),
  rateChannelThreshold: bigInteger("rate_channel_threshold").notNull().default(5),
  rateWindowSeconds: bigInteger("rate_window_seconds").notNull().default(60),
  excludedRoleIdsJson: text("excluded_role_ids_json").notNull().default("[]"),
  modRoleIdsJson: text("mod_role_ids_json").notNull().default("[]"),
  modQueueChannelId: text("mod_queue_channel_id"),
  pingOnQueuePost: bigInteger("ping_on_queue_post").notNull().default(1),
  createdAtMs: bigInteger("created_at_ms").notNull(),
  updatedAtMs: bigInteger("updated_at_ms").notNull(),
});

export const botFlags = pgTable(
  "bot_flags",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    status: text("status").notNull(),
    detectorType: text("detector_type").notNull(),
    evidenceJson: text("evidence_json").notNull(),
    queueMessageId: text("queue_message_id"),
    resolvedByDiscordUserId: text("resolved_by_discord_user_id"),
    resolvedAtMs: bigInteger("resolved_at_ms"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.userId] }),
    index("bot_flags_by_guild_status").on(table.guildId, table.status, table.createdAtMs),
  ],
);

export const botDefenseRateWindowEvents = pgTable(
  "bot_defense_rate_window_events",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    channelId: text("channel_id").notNull(),
    messageFingerprint: text("message_fingerprint").notNull().default(""),
    messageTimestampMs: bigInteger("message_timestamp_ms").notNull(),
  },
  (table) => [
    index("bot_defense_rate_window_by_guild_user_time").on(
      table.guildId,
      table.userId,
      table.messageTimestampMs,
    ),
    index("bot_defense_rate_window_by_guild_user_channel").on(
      table.guildId,
      table.userId,
      table.channelId,
    ),
    index("bot_defense_rate_window_by_message").on(
      table.guildId,
      table.userId,
      table.messageFingerprint,
      table.messageTimestampMs,
      table.channelId,
    ),
  ],
);

export const lfgConfigs = pgTable("lfg_configs", {
  guildId: text("guild_id").primaryKey().notNull(),
  enabled: bigInteger("enabled").notNull().default(1),
  noticeChannelId: text("notice_channel_id"),
  noticeMessageId: text("notice_message_id"),
  notificationRoleId: text("notification_role_id"),
  noticeColor: bigInteger("notice_color").notNull().default(2829617),
  counterVoiceChannelId: text("counter_voice_channel_id"),
  counterDisplayFormat: text("counter_display_format").notNull().default("LFG ({count})"),
  approvalFlowEnabled: bigInteger("approval_flow_enabled").notNull().default(0),
  approvalAuditChannelId: text("approval_audit_channel_id"),
  approvalVoiceCategoryId: text("approval_voice_category_id"),
  expiryAction: text("expiry_action").notNull().default("close"),
  expiryDurationHours: bigInteger("expiry_duration_hours").notNull().default(24),
  serverOptionsJson: text("server_options_json").notNull(),
  updatedAtMs: bigInteger("updated_at_ms").notNull(),
});

export const lfgPosts = pgTable(
  "lfg_posts",
  {
    guildId: text("guild_id").notNull(),
    postId: text("post_id").notNull(),
    ownerId: text("owner_id").notNull(),
    ownerDisplayName: text("owner_display_name").notNull(),
    serverId: text("server_id").notNull(),
    serverLabel: text("server_label").notNull(),
    whenPlay: text("when_play").notNull(),
    lookingFor: text("looking_for").notNull(),
    extraInfo: text("extra_info").notNull(),
    channelId: text("channel_id").notNull(),
    messageId: text("message_id"),
    active: bigInteger("active").notNull(),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    expiresAtMs: bigInteger("expires_at_ms"),
    reminderSentAtMs: bigInteger("reminder_sent_at_ms"),
    renewedAtMs: bigInteger("renewed_at_ms"),
    renewalsCount: bigInteger("renewals_count").notNull().default(0),
    closedAtMs: bigInteger("closed_at_ms"),
    closedByUserId: text("closed_by_user_id"),
    scope: text("scope").notNull().default("public"),
    clanId: text("clan_id"),
    clanTag: text("clan_tag"),
    persistentVoiceChannelId: text("persistent_voice_channel_id"),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.postId] }),
    index("lfg_posts_by_owner_active").on(table.guildId, table.ownerId, table.active),
    index("lfg_posts_by_expiry").on(table.active, table.expiresAtMs),
    index("lfg_posts_by_guild_clan_active").on(table.guildId, table.clanId, table.active),
  ],
);

export const lfgApplications = pgTable(
  "lfg_applications",
  {
    guildId: text("guild_id").notNull(),
    postId: text("post_id").notNull(),
    applicantId: text("applicant_id").notNull(),
    applicantDisplayName: text("applicant_display_name").notNull(),
    message: text("message").notNull(),
    status: text("status").notNull(),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
    reviewedByUserId: text("reviewed_by_user_id"),
    reviewedAtMs: bigInteger("reviewed_at_ms"),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.postId, table.applicantId] }),
    index("lfg_applications_by_post_status").on(
      table.guildId,
      table.postId,
      table.status,
      sql`${table.createdAtMs} DESC`,
    ),
  ],
);

export const lfgVoiceChannels = pgTable(
  "lfg_voice_channels",
  {
    guildId: text("guild_id").notNull(),
    postId: text("post_id").notNull(),
    channelId: text("channel_id").notNull(),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.postId] }),
    index("lfg_voice_channels_by_channel").on(table.channelId),
  ],
);

export const eventTemplates = pgTable(
  "event_templates",
  {
    guildId: text("guild_id").notNull(),
    templateId: text("template_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    signupMode: text("signup_mode").notNull(),
    participationMode: text("participation_mode").notNull().default("individual"),
    requiredTeamSize: bigInteger("required_team_size"),
    threadEnabled: bigInteger("thread_enabled").notNull().default(0),
    waitlistedMembersJoinThread: bigInteger("waitlisted_members_join_thread").notNull().default(0),
    groupsJson: text("groups_json").notNull(),
    remindersJson: text("reminders_json").notNull(),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.templateId] }),
    index("event_templates_by_guild_updated").on(table.guildId, sql`${table.updatedAtMs} DESC`),
  ],
);

export const events = pgTable(
  "events",
  {
    guildId: text("guild_id").notNull(),
    eventId: text("event_id").notNull(),
    templateId: text("template_id"),
    title: text("title").notNull(),
    description: text("description").notNull(),
    status: text("status").notNull(),
    channelId: text("channel_id").notNull(),
    messageId: text("message_id"),
    threadId: text("thread_id"),
    startsAtMs: bigInteger("starts_at_ms").notNull(),
    endsAtMs: bigInteger("ends_at_ms"),
    signupCutoffAtMs: bigInteger("signup_cutoff_at_ms").notNull(),
    signupMode: text("signup_mode").notNull(),
    participationMode: text("participation_mode").notNull().default("individual"),
    requiredTeamSize: bigInteger("required_team_size"),
    threadEnabled: bigInteger("thread_enabled").notNull().default(0),
    waitlistedMembersJoinThread: bigInteger("waitlisted_members_join_thread").notNull().default(0),
    groupsJson: text("groups_json").notNull(),
    remindersJson: text("reminders_json").notNull(),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
    publishedAtMs: bigInteger("published_at_ms"),
    cancelledAtMs: bigInteger("cancelled_at_ms"),
    endedAtMs: bigInteger("ended_at_ms"),
    archivedAtMs: bigInteger("archived_at_ms"),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.eventId] }),
    index("events_by_guild_status_start").on(table.guildId, table.status, table.startsAtMs),
    index("events_by_lifecycle_due").on(table.status, table.startsAtMs, table.endsAtMs),
  ],
);

export const eventSignups = pgTable(
  "event_signups",
  {
    guildId: text("guild_id").notNull(),
    eventId: text("event_id").notNull(),
    userId: text("user_id").notNull(),
    groupId: text("group_id").notNull(),
    status: text("status").notNull(),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.eventId, table.userId, table.groupId] }),
    index("event_signups_by_event").on(
      table.guildId,
      table.eventId,
      table.status,
      table.createdAtMs,
    ),
    index("event_signups_by_user").on(table.guildId, table.eventId, table.userId),
  ],
);

export const marketplaceConfigs = pgTable("marketplace_configs", {
  guildId: text("guild_id").primaryKey().notNull(),
  enabled: bigInteger("enabled").notNull().default(1),
  noticeChannelId: text("notice_channel_id"),
  noticeMessageId: text("notice_message_id"),
  logChannelId: text("log_channel_id"),
  serverOptionsJson: text("server_options_json").notNull(),
  noticeEmbedJson: text("notice_embed_json").notNull(),
  serverChoiceEnabled: bigInteger("server_choice_enabled").notNull().default(1),
  additionalChoicesEnabled: bigInteger("additional_choices_enabled").notNull().default(0),
  additionalChoicesJson: text("additional_choices_json").notNull().default("[]"),
  flowUpdatedAtMs: bigInteger("flow_updated_at_ms").notNull().default(0),
  updatedAtMs: bigInteger("updated_at_ms").notNull(),
});

export const marketplacePosts = pgTable(
  "marketplace_posts",
  {
    guildId: text("guild_id").notNull(),
    postId: text("post_id").notNull(),
    ownerId: text("owner_id").notNull(),
    ownerDisplayName: text("owner_display_name").notNull(),
    tradeType: text("trade_type").notNull(),
    serverId: text("server_id").notNull(),
    serverLabel: text("server_label").notNull(),
    additionalChoicesJson: text("additional_choices_json").notNull().default("[]"),
    have: text("have").notNull(),
    want: text("want").notNull(),
    extra: text("extra").notNull(),
    channelId: text("channel_id").notNull(),
    messageId: text("message_id"),
    active: bigInteger("active").notNull(),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    closedAtMs: bigInteger("closed_at_ms"),
    closedByUserId: text("closed_by_user_id"),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.postId] }),
    index("marketplace_posts_by_owner_active").on(table.guildId, table.ownerId, table.active),
  ],
);

export const marketplaceTradeLogs = pgTable(
  "marketplace_trade_logs",
  {
    guildId: text("guild_id").notNull(),
    logId: text("log_id").notNull(),
    timestampMs: bigInteger("timestamp_ms").notNull(),
    buyerId: text("buyer_id").notNull(),
    buyerDisplayName: text("buyer_display_name").notNull(),
    sellerId: text("seller_id").notNull(),
    postId: text("post_id").notNull(),
    channelId: text("channel_id").notNull(),
    messageId: text("message_id"),
    tradeType: text("trade_type").notNull(),
    serverLabel: text("server_label").notNull(),
    dmSent: bigInteger("dm_sent").notNull(),
    dmError: text("dm_error"),
    have: text("have").notNull(),
    want: text("want").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.logId] }),
    index("marketplace_logs_by_timestamp").on(table.guildId, sql`${table.timestampMs} DESC`),
  ],
);

export const ticketPanels = pgTable(
  "ticket_panels",
  {
    guildId: text("guild_id").notNull(),
    panelId: text("panel_id").notNull().default("main"),
    panelName: text("panel_name").notNull().default("Main panel"),
    panelChannelId: text("panel_channel_id").notNull(),
    categoryChannelId: text("category_channel_id").notNull(),
    transcriptChannelId: text("transcript_channel_id").notNull(),
    panelMessageId: text("panel_message_id"),
    ticketTypesJson: text("ticket_types_json").notNull(),
    ticketCreationLimit: bigInteger("ticket_creation_limit"),
    ticketLimitRejectionMessage: text("ticket_limit_rejection_message"),
    enableTicketClaiming: bigInteger("enable_ticket_claiming").notNull().default(0),
    aiTranscriptSummariesEnabled: bigInteger("ai_transcript_summaries_enabled")
      .notNull()
      .default(0),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.panelId] }),
    uniqueIndex("ticket_panels_unique_name").on(table.guildId, table.panelName),
  ],
);

export const configurationRevisions = pgTable(
  "configuration_revisions",
  {
    id: text("id").primaryKey().notNull(),
    guildId: text("guild_id").notNull(),
    feature: text("feature").notNull(),
    resourceKey: text("resource_key").notNull(),
    schemaVersion: bigInteger("schema_version").notNull(),
    operation: text("operation").notNull(),
    source: text("source").notNull(),
    actorUserId: text("actor_user_id"),
    operationId: text("operation_id").notNull(),
    correlationId: text("correlation_id"),
    previousRevisionId: text("previous_revision_id"),
    restoredFromRevisionId: text("restored_from_revision_id"),
    snapshotJson: text("snapshot_json").notNull(),
    snapshotHash: text("snapshot_hash").notNull(),
    createdAtMs: bigInteger("created_at_ms").notNull(),
  },
  (table) => [
    index("configuration_revisions_by_resource").on(
      table.guildId,
      table.feature,
      table.resourceKey,
      sql`${table.createdAtMs} DESC`,
      sql`${table.id} DESC`,
    ),
    index("configuration_revisions_by_guild").on(
      table.guildId,
      sql`${table.createdAtMs} DESC`,
      sql`${table.id} DESC`,
    ),
    index("configuration_revisions_previous_idx").on(table.previousRevisionId),
    index("configuration_revisions_restored_from_idx").on(table.restoredFromRevisionId),
  ],
);

export const configurationRevisionHeads = pgTable(
  "configuration_revision_heads",
  {
    guildId: text("guild_id").notNull(),
    feature: text("feature").notNull(),
    resourceKey: text("resource_key").notNull(),
    currentRevisionId: text("current_revision_id").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.feature, table.resourceKey] })],
);

export const ticketInstances = pgTable(
  "ticket_instances",
  {
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull(),
    panelId: text("panel_id").default("main"),
    ticketTypeId: text("ticket_type_id").notNull(),
    ticketTypeLabel: text("ticket_type_label").notNull(),
    openerUserId: text("opener_user_id").notNull(),
    supportRoleId: text("support_role_id"),
    status: text("status").notNull(),
    answersJson: text("answers_json").notNull(),
    openedAtMs: bigInteger("opened_at_ms").notNull(),
    closedAtMs: bigInteger("closed_at_ms"),
    closedByUserId: text("closed_by_user_id"),
    transcriptMessageId: text("transcript_message_id"),
    staffThreadId: text("staff_thread_id"),
    claimedByUserId: text("claimed_by_user_id"),
    claimedAtMs: bigInteger("claimed_at_ms"),
    openingMessageId: text("opening_message_id"),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.channelId] }),
    index("ticket_instances_by_status").on(
      table.guildId,
      table.status,
      sql`${table.openedAtMs} DESC`,
    ),
    index("ticket_instances_by_opener_status").on(table.guildId, table.openerUserId, table.status),
    index("ticket_instances_by_opener_opened_at").on(
      table.guildId,
      table.openerUserId,
      sql`${table.openedAtMs} DESC`,
    ),
  ],
);

export const ticketClaimDeliveries = pgTable(
  "ticket_claim_deliveries",
  {
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull(),
    claimedByUserId: text("claimed_by_user_id").notNull(),
    claimedAtMs: bigInteger("claimed_at_ms").notNull(),
    phase: text("phase").notNull(),
    state: text("state").notNull(),
    leaseUntilMs: bigInteger("lease_until_ms"),
  },
  (table) => [
    primaryKey({
      columns: [
        table.guildId,
        table.channelId,
        table.claimedByUserId,
        table.claimedAtMs,
        table.phase,
      ],
    }),
  ],
);

export const ticketTranscriptCapabilities = pgTable(
  "ticket_transcript_capabilities",
  {
    objectId: text("object_id").primaryKey().notNull(),
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull(),
    accessTokenHash: text("access_token_hash").notNull(),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    expiresAtMs: bigInteger("expires_at_ms").notNull(),
    revokedAtMs: bigInteger("revoked_at_ms"),
    discardedAtMs: bigInteger("discarded_at_ms"),
    retentionExpiresAtMs: bigInteger("retention_expires_at_ms").notNull(),
    lastAccessedAtMs: bigInteger("last_accessed_at_ms"),
    accessCount: bigInteger("access_count").notNull().default(0),
  },
  (table) => [
    uniqueIndex("ticket_transcript_capabilities_active_guild_channel")
      .on(table.guildId, table.channelId)
      .where(sql`${table.discardedAtMs} IS NULL`),
    index("ticket_transcript_capabilities_retention").on(table.retentionExpiresAtMs),
  ],
);

export const ticketParticipants = pgTable(
  "ticket_participants",
  {
    guildId: text("guild_id").notNull(),
    ticketChannelId: text("ticket_channel_id").notNull(),
    userId: text("user_id").notNull(),
    addedEventId: text("added_event_id").notNull(),
    addedByUserId: text("added_by_user_id").notNull(),
    addedAtMs: bigInteger("added_at_ms").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.ticketChannelId, table.userId] }),
    index("ticket_participants_by_user").on(table.guildId, table.userId),
  ],
);

export const ticketParticipantEvents = pgTable(
  "ticket_participant_events",
  {
    id: text("id").primaryKey().notNull(),
    guildId: text("guild_id").notNull(),
    ticketChannelId: text("ticket_channel_id").notNull(),
    ticketTypeId: text("ticket_type_id").notNull(),
    action: text("action").notNull(),
    targetUserId: text("target_user_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    notificationState: text("notification_state").notNull().default("pending"),
    notificationClaimedAtMs: bigInteger("notification_claimed_at_ms"),
  },
  (table) => [
    index("ticket_participant_events_by_ticket").on(
      table.guildId,
      table.ticketChannelId,
      table.createdAtMs,
    ),
  ],
);

export const ticketStaffMessages = pgTable(
  "ticket_staff_messages",
  {
    guildId: text("guild_id").notNull(),
    ticketChannelId: text("ticket_channel_id").notNull(),
    staffThreadId: text("staff_thread_id").notNull(),
    staffMessageId: text("staff_message_id").notNull(),
    botMessageId: text("bot_message_id").notNull(),
    staffUserId: text("staff_user_id").notNull(),
    staffDisplayName: text("staff_display_name").notNull(),
    content: text("content").notNull(),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    deliveryStatus: text("delivery_status").notNull().default("sent"),
  },
  (table) => [
    index("idx_staff_messages_lookup").on(table.guildId, table.ticketChannelId, table.botMessageId),
    uniqueIndex("idx_staff_messages_staff_lookup").on(
      table.guildId,
      table.staffThreadId,
      table.staffMessageId,
    ),
  ],
);

export const ticketTemplateReplies = pgTable(
  "ticket_template_replies",
  {
    interactionId: text("interaction_id").primaryKey().notNull(),
    guildId: text("guild_id").notNull(),
    ticketChannelId: text("ticket_channel_id").notNull(),
    templateId: text("template_id").notNull(),
    templateInternalName: text("template_internal_name").notNull(),
    staffUserId: text("staff_user_id").notNull(),
    botMessageId: text("bot_message_id"),
    status: text("status").notNull().default("pending"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
  },
  (table) => [
    index("ticket_template_replies_by_ticket").on(
      table.guildId,
      table.ticketChannelId,
      sql`${table.createdAtMs} DESC`,
    ),
  ],
);

export const ticketCounters = pgTable("ticket_counters", {
  guildId: text("guild_id").primaryKey().notNull(),
  nextTicketNumber: bigInteger("next_ticket_number").notNull(),
});

export const timedRoles = pgTable(
  "timed_roles",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    roleId: text("role_id").notNull(),
    targetDisplayName: text("target_display_name"),
    durationInput: text("duration_input").notNull(),
    expiresAtMs: bigInteger("expires_at_ms").notNull(),
    suspendedRoleIdsJson: text("suspended_role_ids_json").notNull().default("[]"),
    pendingSuspensionRoleIdsJson: text("pending_suspension_role_ids_json").notNull().default("[]"),
    removedRoleIdsJson: text("removed_role_ids_json").notNull().default("[]"),
    pendingRestorationRoleIdsJson: text("pending_restoration_role_ids_json")
      .notNull()
      .default("[]"),
    restorationStartedAtMs: bigInteger("restoration_started_at_ms"),
    targetRoleRemovalCompletedAtMs: bigInteger("target_role_removal_completed_at_ms"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.userId, table.roleId] }),
    index("timed_roles_by_expiry").on(table.expiresAtMs),
  ],
);

export const timedRoleConfigRules = pgTable(
  "timed_role_config_rules",
  {
    guildId: text("guild_id").notNull(),
    enabled: bigInteger("enabled").notNull().default(1),
    configType: text("config_type", { enum: ["new-member", "manual-assignment"] }).notNull(),
    roleId: text("role_id").notNull(),
    durationInput: text("duration_input").notNull(),
    dmMessage: text("dm_message"),
    suspendedRoleIdsJson: text("suspended_role_ids_json").notNull().default("[]"),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.configType, table.roleId] })],
);

export const guildRbacSettings = pgTable("guild_rbac_settings", {
  guildId: text("guild_id").primaryKey().notNull(),
  guildAdminRoleId: text("guild_admin_role_id"),
  manageServerAdminEnabled: integerBoolean("manage_server_admin_enabled").notNull().default(true),
});

export const webhookProxyConfigs = pgTable(
  "webhook_proxy_configs",
  {
    guildId: text("guild_id").notNull(),
    publicId: text("public_id").notNull(),
    name: text("name").notNull(),
    enabled: bigInteger("enabled").notNull(),
    destinationsJson: text("destinations_json").notNull(),
    defaultDestinationIdsJson: text("default_destination_ids_json").notNull(),
    routingRulesJson: text("routing_rules_json").notNull(),
    contentReplacementsJson: text("content_replacements_json").notNull().default("[]"),
    banLookupEnabled: bigInteger("ban_lookup_enabled").notNull().default(0),
    banLookupAppIdsJson: text("ban_lookup_app_ids_json").notNull().default("[]"),
    banLookupCredentialId: text("ban_lookup_credential_id"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.publicId] }),
    uniqueIndex("webhook_proxy_configs_public_id_unique").on(table.publicId),
    index("webhook_proxy_configs_by_guild").on(table.guildId, sql`${table.updatedAtMs} DESC`),
  ],
);

export const webhookProxyForwardLogs = pgTable(
  "webhook_proxy_forward_logs",
  {
    guildId: text("guild_id").notNull(),
    logId: text("log_id").notNull(),
    publicId: text("public_id").notNull(),
    destinationId: text("destination_id").notNull(),
    status: bigInteger("status"),
    ok: bigInteger("ok").notNull(),
    attempt: bigInteger("attempt").notNull(),
    error: text("error"),
    credentialFingerprint: text("credential_fingerprint"),
    timestampMs: bigInteger("timestamp_ms").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.logId] }),
    index("webhook_proxy_logs_by_webhook").on(
      table.guildId,
      table.publicId,
      sql`${table.timestampMs} DESC`,
    ),
  ],
);

export const webhookCredentials = pgTable(
  "webhook_credentials",
  {
    credentialId: text("credential_id").primaryKey().notNull(),
    guildId: text("guild_id").notNull(),
    ownerKind: text("owner_kind").notNull(),
    publicId: text("public_id").notNull(),
    destinationId: text("destination_id"),
    provider: text("provider").notNull(),
    envelopeJson: text("envelope_json").notNull(),
    fingerprint: text("fingerprint").notNull(),
    maskedDisplay: text("masked_display").notNull(),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("webhook_credentials_owner_unique").on(
      table.guildId,
      table.ownerKind,
      table.publicId,
      sql`COALESCE(${table.destinationId}, '')`,
    ),
    index("webhook_credentials_guild_public_idx").on(table.guildId, table.publicId),
  ],
);

export const playerCountServers = pgTable(
  "player_count_servers",
  {
    id: text("id").primaryKey().notNull(),
    guildId: text("guild_id").notNull(),
    enabled: bigInteger("enabled").notNull().default(1),
    name: text("name").notNull(),
    provider: text("provider").notNull(),
    providerServerId: text("provider_server_id").notNull(),
    channelId: text("channel_id"),
    alertChannelId: text("alert_channel_id"),
    refreshIntervalMinutes: bigInteger("refresh_interval_minutes").notNull().default(10),
    displayFormat: text("display_format").notNull().default("🎮 Players: {count}/{max}"),
    offlineFormat: text("offline_format").notNull().default("🎮 Players: Offline"),
    failureThreshold: bigInteger("failure_threshold").notNull().default(3),
    renameOffsetMinutes: bigInteger("rename_offset_minutes").notNull().default(0),
    lastRenamedAtMs: bigInteger("last_renamed_at_ms"),
    lastPlayerCount: bigInteger("last_player_count"),
    lastMaxSlots: bigInteger("last_max_slots"),
    lastQueueSize: bigInteger("last_queue_size"),
    lastFetchedAtMs: bigInteger("last_fetched_at_ms"),
    consecutiveFailureCount: bigInteger("consecutive_failure_count").notNull().default(0),
    lastErrorMessage: text("last_error_message"),
    lastErrorAtMs: bigInteger("last_error_at_ms"),
    steamHost: text("steam_host"),
    steamPort: bigInteger("steam_port"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    index("player_count_servers_by_guild").on(table.guildId),
    index("player_count_servers_by_provider").on(table.provider, table.providerServerId),
  ],
);

export const eventTeams = pgTable(
  "event_teams",
  {
    guildId: text("guild_id").notNull(),
    eventId: text("event_id").notNull(),
    teamId: text("team_id").notNull(),
    groupId: text("group_id").notNull(),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    captainUserId: text("captain_user_id").notNull(),
    openToRequests: bigInteger("open_to_requests").notNull().default(0),
    status: text("status").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
    disbandedAtMs: bigInteger("disbanded_at_ms"),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.eventId, table.teamId] }),
    uniqueIndex("event_teams_name_unique").on(table.guildId, table.eventId, table.normalizedName),
    index("event_teams_by_event_group").on(table.guildId, table.eventId, table.groupId),
  ],
);

export const eventTeamMemberships = pgTable(
  "event_team_memberships",
  {
    guildId: text("guild_id").notNull(),
    eventId: text("event_id").notNull(),
    membershipId: text("membership_id").notNull(),
    teamId: text("team_id").notNull(),
    groupId: text("group_id").notNull(),
    userId: text("user_id").notNull(),
    joinedAtMs: bigInteger("joined_at_ms").notNull(),
    leftAtMs: bigInteger("left_at_ms"),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.eventId, table.membershipId] }),
    uniqueIndex("event_team_memberships_active_user_unique")
      .on(table.guildId, table.eventId, table.userId)
      .where(sql`${table.leftAtMs} IS NULL`),
    index("event_team_memberships_by_team").on(
      table.guildId,
      table.eventId,
      table.teamId,
      table.leftAtMs,
    ),
  ],
);

export const eventTeamProposals = pgTable(
  "event_team_proposals",
  {
    guildId: text("guild_id").notNull(),
    eventId: text("event_id").notNull(),
    proposalId: text("proposal_id").notNull(),
    teamId: text("team_id").notNull(),
    kind: text("kind").notNull(),
    requesterUserId: text("requester_user_id").notNull(),
    targetUserId: text("target_user_id").notNull(),
    status: text("status").notNull(),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
    resolvedAtMs: bigInteger("resolved_at_ms"),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.eventId, table.proposalId] }),
    index("event_team_proposals_by_event_status").on(
      table.guildId,
      table.eventId,
      table.status,
      table.createdAtMs,
    ),
    index("event_team_proposals_by_team").on(table.guildId, table.eventId, table.teamId),
    uniqueIndex("event_team_proposals_pending_join_unique")
      .on(table.guildId, table.eventId, table.requesterUserId)
      .where(sql`${table.kind} = 'join_request' AND ${table.status} = 'pending'`),
    uniqueIndex("event_team_proposals_pending_invite_unique")
      .on(table.guildId, table.eventId, table.teamId, table.targetUserId)
      .where(sql`${table.kind} = 'invitation' AND ${table.status} = 'pending'`),
  ],
);

export const eventTeamInvitationBlocks = pgTable(
  "event_team_invitation_blocks",
  {
    guildId: text("guild_id").notNull(),
    eventId: text("event_id").notNull(),
    teamId: text("team_id").notNull(),
    userId: text("user_id").notNull(),
    createdAtMs: bigInteger("created_at_ms").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.eventId, table.teamId, table.userId] }),
    index("event_team_invitation_blocks_by_event_user").on(
      table.guildId,
      table.eventId,
      table.userId,
    ),
  ],
);

export const eventTeamAuditRecords = pgTable(
  "event_team_audit_records",
  {
    guildId: text("guild_id").notNull(),
    eventId: text("event_id").notNull(),
    auditId: text("audit_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    priorJson: text("prior_json").notNull(),
    resultJson: text("result_json").notNull(),
    occurredAtMs: bigInteger("occurred_at_ms").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.eventId, table.auditId] }),
    index("event_team_audit_by_event_time").on(
      table.guildId,
      table.eventId,
      sql`${table.occurredAtMs} DESC`,
    ),
  ],
);

export const eventTeamRosterSnapshots = pgTable(
  "event_team_roster_snapshots",
  {
    guildId: text("guild_id").notNull(),
    eventId: text("event_id").notNull(),
    teamId: text("team_id").notNull(),
    requiredTeamSize: bigInteger("required_team_size").notNull(),
    membersJson: text("members_json").notNull(),
    capturedAtMs: bigInteger("captured_at_ms").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.eventId, table.teamId] }),
    index("event_team_roster_snapshots_by_event").on(table.guildId, table.eventId),
  ],
);

export const eventTeamDeliveryOutbox = pgTable(
  "event_team_delivery_outbox",
  {
    guildId: text("guild_id").notNull(),
    eventId: text("event_id").notNull(),
    outboxId: text("outbox_id").notNull(),
    kind: text("kind").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    payloadJson: text("payload_json").notNull(),
    status: text("status").notNull(),
    attemptCount: bigInteger("attempt_count").notNull().default(0),
    maxAttempts: bigInteger("max_attempts").notNull().default(5),
    lastError: text("last_error"),
    terminalFailureReason: text("terminal_failure_reason"),
    nextAttemptAtMs: bigInteger("next_attempt_at_ms").notNull(),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
    deliveredAtMs: bigInteger("delivered_at_ms"),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.eventId, table.outboxId] }),
    uniqueIndex("event_team_delivery_outbox_dedupe").on(
      table.guildId,
      table.eventId,
      table.dedupeKey,
    ),
    index("event_team_delivery_outbox_due").on(
      table.guildId,
      table.eventId,
      table.status,
      table.nextAttemptAtMs,
    ),
  ],
);

export const eventTeamRateLimits = pgTable(
  "event_team_rate_limits",
  {
    guildId: text("guild_id").notNull(),
    eventId: text("event_id").notNull(),
    action: text("action").notNull(),
    scopeType: text("scope_type").notNull(),
    scopeId: text("scope_id").notNull(),
    windowStartedAtMs: bigInteger("window_started_at_ms").notNull(),
    attemptCount: bigInteger("attempt_count").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.guildId, table.eventId, table.action, table.scopeType, table.scopeId],
    }),
    index("event_team_rate_limits_expiry").on(table.updatedAtMs),
  ],
);

export const eventTeamStateVersions = pgTable(
  "event_team_state_versions",
  {
    guildId: text("guild_id").notNull(),
    eventId: text("event_id").notNull(),
    version: bigInteger("version").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.eventId] })],
);

export const eventTeamProposalAcceptanceGuards = pgTable(
  "event_team_proposal_acceptance_guards",
  {
    guildId: text("guild_id").notNull(),
    eventId: text("event_id").notNull(),
    proposalId: text("proposal_id").notNull(),
    expectedUpdatedAtMs: bigInteger("expected_updated_at_ms").notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.eventId, table.proposalId] })],
);

export const eventTeamBulkCommitGuards = pgTable("event_team_bulk_commit_guards", {
  guardId: text("guard_id").primaryKey().notNull(),
  guildId: text("guild_id").notNull(),
  eventId: text("event_id").notNull(),
  expectedStateVersion: bigInteger("expected_state_version").notNull(),
});

export const eventLifecycleTransitionGuards = pgTable("event_lifecycle_transition_guards", {
  guardId: text("guard_id").primaryKey().notNull(),
  guildId: text("guild_id").notNull(),
  eventId: text("event_id").notNull(),
  expectedStatus: text("expected_status").notNull(),
  expectedStateVersion: bigInteger("expected_state_version").notNull(),
});

export const eventSignupMutationGuards = pgTable("event_signup_mutation_guards", {
  guardId: text("guard_id").primaryKey().notNull(),
  guildId: text("guild_id").notNull(),
  eventId: text("event_id").notNull(),
  userId: text("user_id").notNull(),
  groupId: text("group_id").notNull(),
  operation: text("operation").notNull(),
});

export const eventLifecycleHistory = pgTable(
  "event_lifecycle_history",
  {
    guildId: text("guild_id").notNull(),
    eventId: text("event_id").notNull(),
    historyId: text("history_id").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    occurredAtMs: bigInteger("occurred_at_ms").notNull(),
    retentionExpiresAtMs: bigInteger("retention_expires_at_ms"),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.eventId, table.historyId] }),
    index("event_lifecycle_history_by_event").on(
      table.guildId,
      table.eventId,
      sql`${table.occurredAtMs} DESC`,
    ),
    index("event_lifecycle_history_retention").on(table.retentionExpiresAtMs),
  ],
);

export const guildR2Objects = pgTable(
  "guild_r2_objects",
  {
    guildId: text("guild_id").notNull(),
    objectKey: text("object_key").notNull(),
    sizeBytes: bigInteger("size_bytes").notNull(),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    status: text("status").notNull().default("committed"),
    reservedBytes: bigInteger("reserved_bytes").notNull().default(0),
    reservationExpiresAtMs: bigInteger("reservation_expires_at_ms"),
    operationKey: text("operation_key"),
    updatedAtMs: bigInteger("updated_at_ms").notNull().default(0),
    reconciliationGeneration: bigInteger("reconciliation_generation"),
    hadCommittedObject: integerBoolean("had_committed_object").notNull().default(true),
    uploadStartedAtMs: bigInteger("upload_started_at_ms"),
    tombstonedAtMs: bigInteger("tombstoned_at_ms"),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.objectKey] }),
    index("idx_guild_r2_objects_guild").on(table.guildId),
    uniqueIndex("idx_guild_r2_objects_operation")
      .on(table.operationKey)
      .where(sql`${table.operationKey} IS NOT NULL`),
    index("idx_guild_r2_objects_expiry").on(table.status, table.reservationExpiresAtMs),
  ],
);

export const guildR2ReconciliationState = pgTable("guild_r2_reconciliation_state", {
  bucketId: text("bucket_id").primaryKey().notNull(),
  cursor: text("cursor"),
  generation: bigInteger("generation").notNull().default(1),
  startedAtMs: bigInteger("started_at_ms"),
  lastReconciledAtMs: bigInteger("last_reconciled_at_ms"),
  updatedAtMs: bigInteger("updated_at_ms").notNull(),
});

export const guildEntitlements = pgTable("guild_entitlements", {
  guildId: text("guild_id").primaryKey().notNull(),
  plan: text("plan").notNull(),
  updatedAtMs: bigInteger("updated_at_ms").notNull(),
});

export const whiteLabelBots = pgTable(
  "white_label_bots",
  {
    guildId: text("guild_id").notNull(),
    applicationId: text("application_id").notNull(),
    botUserId: text("bot_user_id").notNull(),
    displayName: text("display_name").notNull(),
    brandFooterText: text("brand_footer_text"),
    status: text("status").notNull(),
    tokenSecretRef: text("token_secret_ref").notNull(),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.botUserId] }),
    index("white_label_bots_guild_idx").on(table.guildId),
  ],
);

export const knownGuilds = pgTable("known_guilds", {
  guildId: text("guild_id").primaryKey().notNull(),
  name: text("name").notNull(),
  memberIdCount: bigInteger("member_count").notNull().default(0),
  ownerId: text("owner_id").notNull().default(""),
  icon: text("icon"),
  installedAtMs: bigInteger("installed_at_ms").notNull(),
  removedAtMs: bigInteger("removed_at_ms"),
});

export const guildAuditLogConfigs = pgTable("guild_audit_log_configs", {
  guildId: text("guild_id").primaryKey().notNull(),
  auditChannelId: text("audit_channel_id").notNull().default(""),
  groupChannelIdsJson: text("group_channel_ids_json").notNull().default("{}"),
  eventStatesJson: text("event_states_json").notNull().default("{}"),
  excludedChannelIdsJson: text("excluded_channel_ids_json").notNull().default("[]"),
  excludedRoleIdsJson: text("excluded_role_ids_json").notNull().default("[]"),
  updatedAtMs: bigInteger("updated_at_ms").notNull(),
});

export const userPreferences = pgTable("user_preferences", {
  userId: text("user_id").primaryKey().notNull(),
  hiddenGuildIdsJson: text("hidden_guild_ids_json").notNull().default("[]"),
  defaultGuildId: text("default_guild_id"),
  emailNotifications: bigInteger("email_notifications").notNull().default(1),
  pushNotifications: bigInteger("push_notifications").notNull().default(0),
  compactMode: bigInteger("compact_mode").notNull().default(0),
  theme: text("theme").notNull().default("system"),
  language: text("language").notNull().default("en"),
  updatedAtMs: bigInteger("updated_at_ms").notNull(),
});

export const banCaseConfigs = pgTable("ban_case_configs", {
  guildId: text("guild_id").primaryKey().notNull(),
  enabled: integerBoolean("enabled").notNull().default(false),
  forumChannelId: text("forum_channel_id"),
  modRoleIdsJson: text("mod_role_ids_json").notNull().default("[]"),
  updatedAtMs: bigInteger("updated_at_ms").notNull(),
});

export const banCaseSources = pgTable(
  "ban_case_sources",
  {
    guildId: text("guild_id").notNull(),
    sourceId: text("source_id").notNull(),
    publicId: text("public_id").notNull(),
    name: text("name").notNull(),
    enabled: integerBoolean("enabled").notNull().default(false),
    platform: text("platform").notNull(),
    pattern: text("pattern").notNull(),
    flags: text("flags").notNull().default(""),
    subjectIdGroup: text("subject_id_group").notNull().default("subjectId"),
    nameGroup: text("name_group").notNull().default("username"),
    reasonGroup: text("reason_group").notNull().default("reason"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.sourceId] }),
    uniqueIndex("ban_case_sources_public_id_unique").on(table.publicId),
    index("ban_case_sources_by_guild").on(table.guildId, sql`${table.updatedAtMs} DESC`),
  ],
);

export const banCases = pgTable(
  "ban_cases",
  {
    guildId: text("guild_id").notNull(),
    caseId: text("case_id").notNull(),
    sourceId: text("source_id").notNull(),
    publicId: text("public_id").notNull(),
    subjectPlatform: text("subject_platform").notNull(),
    subjectId: text("subject_id").notNull(),
    username: text("username").notNull(),
    status: text("status").notNull().default("new"),
    threadChannelId: text("thread_channel_id").notNull(),
    threadMessageId: text("thread_message_id").notNull(),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.caseId] }),
    uniqueIndex("ban_cases_subject_unique").on(
      table.guildId,
      table.subjectPlatform,
      table.subjectId,
    ),
    index("ban_cases_by_source").on(table.guildId, table.sourceId),
  ],
);

export const memberVerificationConfigs = pgTable("member_verification_configs", {
  guildId: text("guild_id").primaryKey().notNull(),
  enabled: integerBoolean("enabled").notNull().default(false),
  verifiedRoleId: text("verified_role_id"),
  title: text("title").notNull().default("Welcome"),
  description: text("description")
    .notNull()
    .default("Welcome to the Guild! Please verify to gain access."),
  color: bigInteger("color").notNull().default(0x5865f2),
  imageUrl: text("image_url"),
  thumbnailUrl: text("thumbnail_url"),
  rulesUrl: text("rules_url"),
  verifyButtonEmoji: text("verify_button_emoji"),
  // "dm" sends the welcome message to each new member; "channel" posts a
  // persistent welcome panel (embed + Verify button) in welcomeChannelId.
  deliveryMode: text("delivery_mode").notNull().default("dm"),
  // "discord-button" grants the role immediately; "turnstile" requires a
  // Cloudflare Turnstile challenge; "steam-link" requires a linked Steam account.
  verificationMethod: text("verification_method").notNull().default("discord-button"),
  welcomeChannelId: text("welcome_channel_id"),
  panelMessageId: text("panel_message_id"),
  updatedAtMs: bigInteger("updated_at_ms").notNull(),
});

export const memberVerificationStates = pgTable(
  "member_verification_states",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    verifiedAtMs: bigInteger("verified_at_ms").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.userId] }),
    index("member_verification_states_by_guild").on(table.guildId, table.verifiedAtMs),
  ],
);

export const memberVerificationAttempts = pgTable(
  "member_verification_attempts",
  {
    id: text("id").primaryKey().notNull(),
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    messageId: text("message_id"),
    channelId: text("channel_id"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    expiresAtMs: bigInteger("expires_at_ms").notNull(),
    usedAtMs: bigInteger("used_at_ms"),
  },
  (table) => [
    index("member_verification_attempts_by_guild_user").on(table.guildId, table.userId),
    index("member_verification_attempts_by_expires").on(table.expiresAtMs),
  ],
);

export const memberVerificationManualDmRateLimits = pgTable(
  "member_verification_manual_dm_rate_limits",
  {
    guildId: text("guild_id").notNull(),
    scopeType: text("scope_type", { enum: ["guild", "actor", "target"] }).notNull(),
    scopeId: text("scope_id").notNull(),
    windowStartedAtMs: bigInteger("window_started_at_ms").notNull(),
    attemptCount: bigInteger("attempt_count").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.scopeType, table.scopeId] }),
    index("member_verification_manual_dm_rate_limits_expiry").on(table.updatedAtMs),
  ],
);

export const mentionProtectionConfigs = pgTable("mention_protection_configs", {
  guildId: text("guild_id").primaryKey().notNull(),
  adminEnabled: integerBoolean("admin_enabled").notNull().default(false),
  spamEnabled: integerBoolean("spam_enabled").notNull().default(false),
  protectedAdminRoleIdsJson: text("protected_admin_role_ids_json").notNull().default("[]"),
  channelMode: text("channel_mode").notNull().default("exclude"),
  channelIdsJson: text("channel_ids_json").notNull().default("[]"),
  excludedRoleIdsJson: text("excluded_role_ids_json").notNull().default("[]"),
  massMentionThreshold: bigInteger("mass_mention_threshold").notNull().default(5),
  burstMessageThreshold: bigInteger("burst_message_threshold").notNull().default(5),
  burstWindowSeconds: bigInteger("burst_window_seconds").notNull().default(10),
  adminRepeatPeriodMs: bigInteger("admin_repeat_period_ms").notNull().default(86_400_000),
  spamRepeatPeriodMs: bigInteger("spam_repeat_period_ms").notNull().default(86_400_000),
  adminInitialResponseJson: text("admin_initial_response_json").notNull(),
  adminRepeatResponseJson: text("admin_repeat_response_json").notNull(),
  spamInitialResponseJson: text("spam_initial_response_json").notNull(),
  spamRepeatResponseJson: text("spam_repeat_response_json").notNull(),
  createdAtMs: bigInteger("created_at_ms").notNull(),
  updatedAtMs: bigInteger("updated_at_ms").notNull(),
});

export const mentionProtectionBurstEvents = pgTable(
  "mention_protection_burst_events",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    messageId: text("message_id").notNull(),
    messageTimestampMs: bigInteger("message_timestamp_ms").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.userId, table.messageId] }),
    index("mention_protection_burst_by_member_time").on(
      table.guildId,
      table.userId,
      table.messageTimestampMs,
    ),
  ],
);

export const mentionProtectionEscalations = pgTable(
  "mention_protection_escalations",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    protection: text("protection").notNull(),
    lastBreachAtMs: bigInteger("last_breach_at_ms").notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.userId, table.protection] })],
);

export const mentionProtectionBreaches = pgTable(
  "mention_protection_breaches",
  {
    guildId: text("guild_id").notNull(),
    messageId: text("message_id").notNull(),
    userId: text("user_id").notNull(),
    channelId: text("channel_id").notNull(),
    protection: text("protection").notNull(),
    condition: text("condition").notNull(),
    stage: text("stage").notNull(),
    responsePolicyJson: text("response_policy_json").notNull(),
    evidenceJson: text("evidence_json").notNull(),
    contentSnapshot: text("content_snapshot").notNull(),
    messageCreatedAtMs: bigInteger("message_created_at_ms").notNull(),
    breachedAtMs: bigInteger("breached_at_ms").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.messageId, table.protection] }),
    index("mention_protection_breaches_by_member").on(
      table.guildId,
      table.userId,
      table.breachedAtMs,
    ),
  ],
);

export const mentionProtectionActionOutcomes = pgTable(
  "mention_protection_action_outcomes",
  {
    guildId: text("guild_id").notNull(),
    messageId: text("message_id").notNull(),
    action: text("action").notNull(),
    status: text("status").notNull(),
    detail: text("detail"),
    retryable: integerBoolean("retryable").notNull().default(false),
    attemptCount: bigInteger("attempt_count").notNull().default(1),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.messageId, table.action] })],
);

export const managedMessages = pgTable(
  "managed_messages",
  {
    id: text("id").primaryKey().notNull(),
    guildId: text("guild_id").notNull(),
    internalName: text("internal_name").notNull(),
    channelId: text("channel_id").notNull(),
    messageId: text("message_id").notNull(),
    embedsJson: text("embeds_json").notNull(),
    buttonsJson: text("buttons_json").notNull().default("[]"),
    announcementJson: text("announcement_json").notNull(),
    status: text("status").notNull(),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("managed_messages_by_guild_name").on(table.guildId, table.internalName),
    uniqueIndex("managed_messages_by_canonical_message").on(
      table.guildId,
      table.channelId,
      table.messageId,
    ),
    index("managed_messages_by_guild_updated").on(table.guildId, sql`${table.updatedAtMs} DESC`),
  ],
);

export const managedMessageDrafts = pgTable(
  "managed_message_drafts",
  {
    id: text("id").primaryKey().notNull(),
    guildId: text("guild_id").notNull(),
    internalName: text("internal_name").notNull(),
    channelId: text("channel_id").notNull(),
    embedsJson: text("embeds_json").notNull(),
    buttonsJson: text("buttons_json").notNull().default("[]"),
    announcementJson: text("announcement_json").notNull(),
    status: text("status").notNull(),
    scheduledAtMs: bigInteger("scheduled_at_ms"),
    failureReason: text("failure_reason"),
    attemptCount: bigInteger("attempt_count").notNull().default(0),
    publicationClaimedAtMs: bigInteger("publication_claimed_at_ms"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("managed_message_drafts_by_guild_name").on(table.guildId, table.internalName),
    index("managed_message_drafts_by_guild_updated").on(
      table.guildId,
      sql`${table.updatedAtMs} DESC`,
    ),
    index("managed_message_drafts_due").on(table.status, table.scheduledAtMs),
  ],
);

export const managedMessageMediaAssets = pgTable(
  "managed_message_media_assets",
  {
    guildId: text("guild_id").notNull(),
    filename: text("filename").notNull(),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    status: text("status").notNull().default("active"),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.filename] }),
    index("managed_message_media_assets_pending").on(table.guildId, table.status),
  ],
);

export const managedMessageMediaRefs = pgTable(
  "managed_message_media_refs",
  {
    guildId: text("guild_id").notNull(),
    filename: text("filename").notNull(),
    ownerType: text("owner_type").notNull(),
    ownerId: text("owner_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.filename, table.ownerType, table.ownerId] }),
    index("managed_message_media_refs_by_owner").on(table.guildId, table.ownerType, table.ownerId),
  ],
);

export const messageTemplates = pgTable(
  "message_templates",
  {
    id: text("id").primaryKey().notNull(),
    guildId: text("guild_id").notNull(),
    internalName: text("internal_name").notNull(),
    embedsJson: text("embeds_json").notNull(),
    availableForTicketReplies: integerBoolean("available_for_ticket_replies")
      .notNull()
      .default(false),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("message_templates_by_guild_name").on(table.guildId, table.internalName),
    index("message_templates_by_guild_updated").on(table.guildId, sql`${table.updatedAtMs} DESC`),
  ],
);

export const managedMessageAuditOutbox = pgTable(
  "managed_message_audit_outbox",
  {
    eventKey: text("event_key").primaryKey().notNull(),
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull(),
    messageId: text("message_id").notNull(),
    internalName: text("internal_name").notNull(),
    claimedAtMs: bigInteger("claimed_at_ms"),
    deliveredAtMs: bigInteger("delivered_at_ms"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("managed_message_audit_outbox_by_canonical_message").on(
      table.guildId,
      table.channelId,
      table.messageId,
    ),
  ],
);

export const guildServiceSuspensions = pgTable(
  "guild_service_suspensions",
  {
    guildId: text("guild_id").primaryKey().notNull(),
    reason: text("reason").notNull(),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    removedAtMs: bigInteger("removed_at_ms"),
    removedByUserId: text("removed_by_user_id"),
  },
  (table) => [index("guild_service_suspensions_active").on(table.removedAtMs, table.createdAtMs)],
);

export const guildServiceSuspensionAudit = pgTable(
  "guild_service_suspension_audit",
  {
    id: text("id").primaryKey().notNull(),
    guildId: text("guild_id").notNull(),
    action: text("action").notNull(),
    reason: text("reason"),
    actorUserId: text("actor_user_id").notNull(),
    occurredAtMs: bigInteger("occurred_at_ms").notNull(),
  },
  (table) => [
    index("guild_service_suspension_audit_by_guild").on(table.guildId, table.occurredAtMs),
  ],
);

export const gatewayEventOperations = pgTable(
  "gateway_event_operations",
  {
    eventKey: text("event_key").notNull(),
    handlerKey: text("handler_key").notNull(),
    state: text("state").notNull(),
    leaseToken: text("lease_token"),
    leaseExpiresAtMs: bigInteger("lease_expires_at_ms"),
    attempts: bigInteger("attempts").notNull().default(1),
    outcomeCode: text("outcome_code"),
    outcomeJson: text("outcome_json"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
    completedAtMs: bigInteger("completed_at_ms"),
  },
  (table) => [
    primaryKey({ columns: [table.eventKey, table.handlerKey] }),
    index("gateway_event_operations_by_completion")
      .on(table.completedAtMs)
      .where(sql`${table.state} IN ('completed', 'terminal')`),
  ],
);

export const gatewayReactionLimitMutations = pgTable(
  "gateway_reaction_limit_mutations",
  {
    eventKey: text("event_key").notNull(),
    mutationKind: text("mutation_kind").notNull(),
    resultOne: bigInteger("result_one"),
    resultTwo: bigInteger("result_two"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.eventKey, table.mutationKind] }),
    index("gateway_reaction_limit_mutations_by_completion")
      .on(table.createdAtMs)
      .where(sql`${table.resultOne} IS NOT NULL`),
  ],
);

export const featureSetupRuns = pgTable(
  "feature_setup_runs",
  {
    id: text("id").primaryKey().notNull(),
    guildId: text("guild_id").notNull(),
    featureKey: text("feature_key").notNull(),
    definitionVersion: bigInteger("definition_version").notNull(),
    status: text("status").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    choicesJson: text("choices_json").notNull(),
    failureDependencyKey: text("failure_dependency_key"),
    failureMessage: text("failure_message"),
    pendingCreationDependencyKey: text("pending_creation_dependency_key"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
    completedAtMs: bigInteger("completed_at_ms"),
  },
  (table) => [
    uniqueIndex("feature_setup_runs_one_active")
      .on(table.guildId, table.featureKey)
      .where(sql`${table.status} IN ('planned', 'running', 'incomplete')`),
    index("feature_setup_runs_by_feature").on(table.guildId, table.featureKey, table.createdAtMs),
  ],
);

export const featureSetupResolutions = pgTable(
  "feature_setup_resolutions",
  {
    runId: text("run_id").notNull(),
    dependencyKey: text("dependency_key").notNull(),
    resourceId: text("resource_id").notNull(),
    resourceName: text("resource_name").notNull(),
    resourceKind: text("resource_kind").notNull(),
    relationship: text("relationship").notNull(),
    templateVersion: bigInteger("template_version").notNull(),
    validationStatus: text("validation_status").notNull(),
    validationDetail: text("validation_detail"),
    appliedAtMs: bigInteger("applied_at_ms"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.dependencyKey] }),
    index("feature_setup_resolutions_by_resource").on(table.resourceId),
  ],
);

export const clanManagementConfigs = pgTable("clan_management_configs", {
  guildId: text("guild_id").primaryKey().notNull(),
  enabled: integerBoolean("enabled").notNull().default(true),
  reviewerRoleIdsJson: text("reviewer_role_ids_json").notNull().default("[]"),
  staffAccessRoleIdsJson: text("staff_access_role_ids_json").notNull().default("[]"),
  eligibilityAllowedRoleIdsJson: text("eligibility_allowed_role_ids_json").notNull().default("[]"),
  eligibilityRequiredRoleIdsJson: text("eligibility_required_role_ids_json")
    .notNull()
    .default("[]"),
  minimumAccountAgeDays: bigInteger("minimum_account_age_days").notNull().default(0),
  minimumGuildTenureDays: bigInteger("minimum_guild_tenure_days").notNull().default(0),
  requestCooldownDays: bigInteger("request_cooldown_days").notNull().default(7),
  invitationExpiryDays: bigInteger("invitation_expiry_days").notNull().default(7),
  applicationExpiryDays: bigInteger("application_expiry_days").notNull().default(7),
  localClansMax: bigInteger("local_clans_max"),
  localMembersMax: bigInteger("local_members_max"),
  localOfficersMax: bigInteger("local_officers_max"),
  categoryId: text("category_id"),
  requestPanelChannelId: text("request_panel_channel_id"),
  requestPanelMessageId: text("request_panel_message_id"),
  requestReviewCategoryId: text("request_review_category_id"),
  requestPanelTitle: text("request_panel_title").notNull().default("Create a Clan"),
  requestPanelDescription: text("request_panel_description")
    .notNull()
    .default("Submit a Clan creation request for staff review."),
  requestPanelButtonLabel: text("request_panel_button_label").notNull().default("Create Clan"),
  requestPanelColor: bigInteger("request_panel_color").notNull().default(5793266),
  boardEnabled: integerBoolean("board_enabled").notNull().default(false),
  boardChannelId: text("board_channel_id"),
  boardChannelType: text("board_channel_type"),
  roleNameTemplate: text("role_name_template").notNull().default("[{tag}] {name}"),
  textChannelNameTemplate: text("text_channel_name_template").notNull().default("{tag}-chat"),
  voiceChannelNameTemplate: text("voice_channel_name_template").notNull().default("{tag} Voice"),
  inactivityEnabled: integerBoolean("inactivity_enabled").notNull().default(false),
  inactivityWarningDays: bigInteger("inactivity_warning_days").notNull().default(60),
  inactivityArchiveDays: bigInteger("inactivity_archive_days").notNull().default(90),
  publicLfgAttributionEnabled: integerBoolean("public_lfg_attribution_enabled")
    .notNull()
    .default(true),
  updatedAtMs: bigInteger("updated_at_ms").notNull(),
});

export const clanRequests = pgTable(
  "clan_requests",
  {
    id: text("id").primaryKey().notNull(),
    guildId: text("guild_id").notNull(),
    requesterId: text("requester_id").notNull(),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    tag: text("tag").notNull(),
    normalizedTag: text("normalized_tag").notNull(),
    description: text("description").notNull(),
    focus: text("focus").notNull(),
    recruitmentState: text("recruitment_state").notNull(),
    proposedOfficerIdsJson: text("proposed_officer_ids_json").notNull().default("[]"),
    status: text("status").notNull(),
    revision: bigInteger("revision").notNull().default(1),
    reviewerId: text("reviewer_id"),
    reviewReason: text("review_reason"),
    clanId: text("clan_id"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
    terminalAtMs: bigInteger("terminal_at_ms"),
    retentionExpiresAtMs: bigInteger("retention_expires_at_ms"),
    reviewChannelId: text("review_channel_id"),
    reviewMessageId: text("review_message_id"),
    reviewTicketState: text("review_ticket_state").notNull().default("pending"),
    reviewTicketError: text("review_ticket_error"),
  },
  (table) => [
    index("clan_requests_by_guild_status").on(table.guildId, table.status, table.createdAtMs),
  ],
);

export const clans = pgTable(
  "clans",
  {
    id: text("id").primaryKey().notNull(),
    guildId: text("guild_id").notNull(),
    requestId: text("request_id").notNull().unique(),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    tag: text("tag").notNull(),
    normalizedTag: text("normalized_tag").notNull(),
    description: text("description").notNull(),
    focus: text("focus").notNull(),
    icon: text("icon"),
    recruitmentState: text("recruitment_state").notNull(),
    lifecycleState: text("lifecycle_state").notNull(),
    roleId: text("role_id"),
    textChannelId: text("text_channel_id"),
    voiceChannelId: text("voice_channel_id"),
    boardProjectionId: text("board_projection_id"),
    boardProjectionChannelId: text("board_projection_channel_id"),
    operation: text("operation"),
    degradedReason: text("degraded_reason"),
    sensitiveManagementFrozen: integerBoolean("sensitive_management_frozen")
      .notNull()
      .default(false),
    clanLfgLeadershipOnly: integerBoolean("clan_lfg_leadership_only").notNull().default(false),
    latestActivityAtMs: bigInteger("latest_activity_at_ms"),
    latestActivityType: text("latest_activity_type"),
    inactivityWarnedAtMs: bigInteger("inactivity_warned_at_ms"),
    deletionDueAtMs: bigInteger("deletion_due_at_ms"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
    permanentlyDeletedAtMs: bigInteger("permanently_deleted_at_ms"),
  },
  (table) => [
    index("clans_by_guild_lifecycle").on(table.guildId, table.lifecycleState, table.createdAtMs),
  ],
);

export const clanMemberships = pgTable(
  "clan_memberships",
  {
    clanId: text("clan_id").notNull(),
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    rank: text("rank").notNull(),
    joinedAtMs: bigInteger("joined_at_ms").notNull(),
    leftAtMs: bigInteger("left_at_ms"),
  },
  (table) => [
    primaryKey({ columns: [table.clanId, table.userId, table.joinedAtMs] }),
    index("clan_memberships_active_by_clan").on(table.clanId, table.rank, table.joinedAtMs),
  ],
);

export const clanApplications = pgTable(
  "clan_applications",
  {
    id: text("id").primaryKey().notNull(),
    clanId: text("clan_id").notNull(),
    guildId: text("guild_id").notNull(),
    applicantId: text("applicant_id").notNull(),
    message: text("message").notNull(),
    experience: text("experience"),
    availability: text("availability"),
    playStyle: text("play_style"),
    status: text("status").notNull(),
    decidedByUserId: text("decided_by_user_id"),
    decisionReason: text("decision_reason"),
    expiresAtMs: bigInteger("expires_at_ms").notNull(),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [index("clan_applications_due").on(table.status, table.expiresAtMs)],
);

export const clanInvitations = pgTable(
  "clan_invitations",
  {
    id: text("id").primaryKey().notNull(),
    clanId: text("clan_id").notNull(),
    guildId: text("guild_id").notNull(),
    inviteeId: text("invitee_id").notNull(),
    invitedByUserId: text("invited_by_user_id").notNull(),
    intendedRank: text("intended_rank").notNull(),
    status: text("status").notNull(),
    expiresAtMs: bigInteger("expires_at_ms").notNull(),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [index("clan_invitations_due").on(table.status, table.expiresAtMs)],
);

export const clanMembershipBlocks = pgTable("clan_membership_blocks", {
  id: text("id").primaryKey().notNull(),
  clanId: text("clan_id").notNull(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  reason: text("reason").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAtMs: bigInteger("created_at_ms").notNull(),
  expiresAtMs: bigInteger("expires_at_ms").notNull(),
  liftedAtMs: bigInteger("lifted_at_ms"),
  liftedByUserId: text("lifted_by_user_id"),
});

export const clanOwnershipTransfers = pgTable("clan_ownership_transfers", {
  id: text("id").primaryKey().notNull(),
  clanId: text("clan_id").notNull(),
  guildId: text("guild_id").notNull(),
  fromUserId: text("from_user_id").notNull(),
  toUserId: text("to_user_id").notNull(),
  status: text("status").notNull(),
  createdAtMs: bigInteger("created_at_ms").notNull(),
  expiresAtMs: bigInteger("expires_at_ms").notNull(),
  resolvedAtMs: bigInteger("resolved_at_ms"),
});

export const clanChangeRequests = pgTable("clan_change_requests", {
  id: text("id").primaryKey().notNull(),
  clanId: text("clan_id").notNull(),
  guildId: text("guild_id").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  payloadJson: text("payload_json").notNull(),
  requestedByUserId: text("requested_by_user_id").notNull(),
  reviewedByUserId: text("reviewed_by_user_id"),
  reviewReason: text("review_reason"),
  revision: bigInteger("revision").notNull().default(1),
  createdAtMs: bigInteger("created_at_ms").notNull(),
  updatedAtMs: bigInteger("updated_at_ms").notNull(),
  retentionExpiresAtMs: bigInteger("retention_expires_at_ms"),
});

export const clanHistory = pgTable(
  "clan_history",
  {
    id: text("id").primaryKey().notNull(),
    guildId: text("guild_id").notNull(),
    clanId: text("clan_id"),
    requestId: text("request_id"),
    event: text("event").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    reason: text("reason"),
    beforeJson: text("before_json"),
    afterJson: text("after_json"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    retentionExpiresAtMs: bigInteger("retention_expires_at_ms").notNull(),
  },
  (table) => [
    index("clan_history_by_clan").on(table.guildId, table.clanId, sql`${table.createdAtMs} DESC`),
    index("clan_history_retention").on(table.retentionExpiresAtMs),
  ],
);

export const suggestionsConfigs = pgTable("suggestions_configs", {
  guildId: text("guild_id").primaryKey().notNull(),
  enabled: integerBoolean("enabled").notNull().default(false),
  forumChannelId: text("forum_channel_id"),
  panelChannelId: text("panel_channel_id"),
  panelMessageId: text("panel_message_id"),
  panelTitle: text("panel_title").notNull(),
  panelBody: text("panel_body").notNull(),
  panelButtonText: text("panel_button_text").notNull(),
  promptsJson: text("prompts_json").notNull(),
  categoriesJson: text("categories_json").notNull().default("[]"),
  statusTagIdsJson: text("status_tag_ids_json").notNull().default("{}"),
  categoryTagIdsJson: text("category_tag_ids_json").notNull().default("{}"),
  replyWebhookId: text("reply_webhook_id"),
  replyWebhookCredentialId: text("reply_webhook_credential_id"),
  modRoleIdsJson: text("mod_role_ids_json").notNull().default("[]"),
  modQueueChannelId: text("mod_queue_channel_id"),
  voterRoleId: text("voter_role_id"),
  minimumTenureDays: bigInteger("minimum_tenure_days").notNull().default(0),
  collapseThreshold: bigInteger("collapse_threshold").notNull().default(3),
  submissionCooldownSeconds: bigInteger("submission_cooldown_seconds").notNull().default(300),
  activeSuggestionLimit: bigInteger("active_suggestion_limit").notNull().default(3),
  digestEnabled: integerBoolean("digest_enabled").notNull().default(false),
  digestChannelId: text("digest_channel_id"),
  digestCadenceDays: bigInteger("digest_cadence_days").notNull().default(7),
  updatedAtMs: bigInteger("updated_at_ms").notNull(),
});

export const suggestions = pgTable(
  "suggestions",
  {
    id: text("id").primaryKey().notNull(),
    guildId: text("guild_id").notNull(),
    authorId: text("author_id").notNull(),
    title: text("title").notNull(),
    normalizedSearchText: text("normalized_search_text").notNull(),
    answersJson: text("answers_json").notNull(),
    category: text("category"),
    status: text("status").notNull(),
    revision: bigInteger("revision").notNull().default(1),
    threadId: text("thread_id"),
    starterMessageId: text("starter_message_id"),
    projectionError: text("projection_error"),
    supportCount: bigInteger("support_count").notNull().default(0),
    opposeCount: bigInteger("oppose_count").notNull().default(0),
    outcomeJson: text("outcome_json"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    editedAtMs: bigInteger("edited_at_ms"),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    index("suggestions_by_guild_status").on(table.guildId, table.status, table.updatedAtMs),
    index("suggestions_by_author").on(table.guildId, table.authorId, table.createdAtMs),
    uniqueIndex("suggestions_thread_unique").on(table.threadId),
  ],
);

export const suggestionRevisions = pgTable(
  "suggestion_revisions",
  {
    id: text("id").primaryKey().notNull(),
    suggestionId: text("suggestion_id").notNull(),
    guildId: text("guild_id").notNull(),
    revision: bigInteger("revision").notNull(),
    title: text("title").notNull(),
    answersJson: text("answers_json").notNull(),
    category: text("category"),
    editedByUserId: text("edited_by_user_id").notNull(),
    createdAtMs: bigInteger("created_at_ms").notNull(),
  },
  (table) => [uniqueIndex("suggestion_revisions_unique").on(table.suggestionId, table.revision)],
);

export const suggestionVotes = pgTable(
  "suggestion_votes",
  {
    suggestionId: text("suggestion_id").notNull(),
    guildId: text("guild_id").notNull(),
    memberId: text("member_id").notNull(),
    value: text("value").notNull(),
    active: integerBoolean("active").notNull().default(true),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.suggestionId, table.memberId] }),
    index("suggestion_votes_by_member").on(table.guildId, table.memberId, table.active),
  ],
);

export const suggestionStatusEvents = pgTable(
  "suggestion_status_events",
  {
    id: text("id").primaryKey().notNull(),
    suggestionId: text("suggestion_id").notNull(),
    guildId: text("guild_id").notNull(),
    fromStatus: text("from_status").notNull(),
    toStatus: text("to_status").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    reason: text("reason"),
    outcomeJson: text("outcome_json"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
  },
  (table) => [index("suggestion_status_history").on(table.suggestionId, table.createdAtMs)],
);

export const consideredReplies = pgTable(
  "considered_replies",
  {
    id: text("id").primaryKey().notNull(),
    suggestionId: text("suggestion_id").notNull(),
    threadId: text("thread_id"),
    guildId: text("guild_id").notNull(),
    authorId: text("author_id").notNull(),
    perspective: text("perspective").notNull(),
    reasoning: text("reasoning").notNull(),
    improvement: text("improvement"),
    state: text("state").notNull(),
    flagCount: bigInteger("flag_count").notNull().default(0),
    webhookMessageId: text("webhook_message_id"),
    queueMessageId: text("queue_message_id"),
    collapsedAtMs: bigInteger("collapsed_at_ms"),
    resolvedAtMs: bigInteger("resolved_at_ms"),
    resolvedByUserId: text("resolved_by_user_id"),
    resolutionReason: text("resolution_reason"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    index("considered_replies_by_suggestion").on(table.suggestionId, table.createdAtMs),
    uniqueIndex("considered_replies_webhook_message_unique").on(table.webhookMessageId),
  ],
);

export const consideredReplyFlags = pgTable(
  "considered_reply_flags",
  {
    replyId: text("reply_id").notNull(),
    guildId: text("guild_id").notNull(),
    memberId: text("member_id").notNull(),
    active: integerBoolean("active").notNull().default(true),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [primaryKey({ columns: [table.replyId, table.memberId] })],
);

export const pendingSuggestionSubmissions = pgTable("pending_suggestion_submissions", {
  id: text("id").primaryKey().notNull(),
  guildId: text("guild_id").notNull(),
  authorId: text("author_id").notNull(),
  title: text("title").notNull(),
  answersJson: text("answers_json").notNull(),
  category: text("category"),
  likelyDuplicateIdsJson: text("likely_duplicate_ids_json").notNull(),
  expiresAtMs: bigInteger("expires_at_ms").notNull(),
});

export const suggestionDigestRuns = pgTable(
  "suggestion_digest_runs",
  {
    guildId: text("guild_id").notNull(),
    periodKey: text("period_key").notNull(),
    status: text("status").notNull(),
    deliveredMessageId: text("delivered_message_id"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.periodKey] })],
);

export const suggestionActionRateLimits = pgTable(
  "suggestion_action_rate_limits",
  {
    guildId: text("guild_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    action: text("action").notNull(),
    windowStartMs: bigInteger("window_start_ms").notNull(),
    count: bigInteger("count").notNull().default(1),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.guildId, table.actorUserId, table.action, table.windowStartMs],
    }),
    index("suggestion_action_limits_expiry").on(table.updatedAtMs),
  ],
);

export const adminFeedback = pgTable(
  "admin_feedback",
  {
    id: text("id").primaryKey().notNull(),
    reference: text("reference").notNull(),
    category: text("category").notNull(),
    summary: text("summary").notNull(),
    description: text("description").notNull(),
    reporterUserId: text("reporter_user_id").notNull(),
    guildId: text("guild_id"),
    workspaceId: text("workspace_id"),
    route: text("route").notNull(),
    pageLabel: text("page_label"),
    correlationId: text("correlation_id"),
    errorCode: text("error_code"),
    rayId: text("ray_id"),
    workerVersion: text("worker_version").notNull(),
    environment: text("environment").notNull(),
    diagnosticsIncluded: integerBoolean("diagnostics_included").notNull(),
    browser: text("browser"),
    os: text("os"),
    notificationState: text("notification_state").notNull().default("pending"),
    notificationErrorCode: text("notification_error_code"),
    createdAtMs: bigInteger("created_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("admin_feedback_reference_unique").on(table.reference),
    index("admin_feedback_reporter_created").on(table.reporterUserId, table.createdAtMs),
    index("admin_feedback_created").on(table.createdAtMs),
    index("admin_feedback_notification_state").on(table.notificationState),
  ],
);

export const oneTimeTokens = pgTable(
  "one_time_tokens",
  {
    nonce: text("nonce").primaryKey().notNull(),
    expiresAtMs: bigInteger("expires_at_ms").notNull(),
    consumedAtMs: bigInteger("consumed_at_ms").notNull(),
  },
  (table) => [index("one_time_tokens_expires_at").on(table.expiresAtMs)],
);

export const wardogsTargets = pgTable(
  "wardogs_targets",
  {
    id: text("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    slot: bigInteger("slot").notNull(),
    generation: bigInteger("generation").notNull(),
    data: text("data").notNull(),
  },
  (table) => [uniqueIndex("wardogs_targets_guild_slot").on(table.guildId, table.slot)],
);

export const wardogsBudgets = pgTable("wardogs_budgets", {
  origin: text("origin").primaryKey(),
  token: text("token").notNull(),
  leaseUntilMs: bigInteger("lease_until_ms").notNull(),
  nextAtMs: bigInteger("next_at_ms").notNull(),
  data: text("data").notNull(),
});

export const reactionRolePanels = pgTable(
  "reaction_role_panels",
  {
    guildId: text("guild_id").notNull(),
    id: text("id").notNull(),
    botUserId: text("bot_user_id").notNull(),
    channelId: text("channel_id").notNull(),
    messageId: text("message_id"),
    title: text("title").notNull(),
    description: text("description").notNull(),
    mode: text("mode").notNull().default("multiple"),
    requiredRoleIdsJson: text("required_role_ids_json").notNull().default("[]"),
    blockedRoleIdsJson: text("blocked_role_ids_json").notNull().default("[]"),
    optionsJson: text("options_json").notNull(),
    publishedOptionsJson: text("published_options_json").notNull().default("[]"),
    activatedAtMs: bigInteger("activated_at_ms"),
    enabled: integerBoolean("enabled").notNull().default(false),
    sortOrder: bigInteger("sort_order").notNull(),
    updatedAtMs: bigInteger("updated_at_ms").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.id] }),
    uniqueIndex("reaction_role_panels_by_message").on(
      table.guildId,
      table.channelId,
      table.messageId,
    ),
  ],
);

export const reactionRoleLeases = pgTable("reaction_role_leases", {
  guildId: text("guild_id").primaryKey().notNull(),
  token: text("token").notNull(),
  expiresAtMs: bigInteger("expires_at_ms").notNull(),
});
