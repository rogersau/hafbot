import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const bigInteger = (name: string) => bigint(name, { mode: "number" });

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
