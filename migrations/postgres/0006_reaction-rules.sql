-- PostgreSQL persistence for the first moderation domain port. Booleans are
-- native PostgreSQL values; the D1 import mapping converts SQLite 0/1 values.

CREATE TABLE guild_settings (
  guild_id TEXT PRIMARY KEY,
  moderation_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  channel_mode TEXT NOT NULL DEFAULT 'include',
  channel_ids_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE guild_blocked_emojis (
  guild_id TEXT NOT NULL,
  normalized_emoji TEXT NOT NULL,
  PRIMARY KEY (guild_id, normalized_emoji)
);

CREATE TABLE guild_notification_channels (
  guild_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  notification_channel_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, feature)
);

CREATE TABLE product_analytics_preferences (
  guild_id TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at_ms BIGINT NOT NULL
);

CREATE TABLE reaction_limit_configs (
  guild_id TEXT PRIMARY KEY,
  limits_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  max_reactions_per_message INTEGER,
  max_reactions_per_user_per_message INTEGER,
  breach_threshold INTEGER,
  breach_role_id TEXT,
  breach_role_duration_ms BIGINT,
  breach_dm_text TEXT,
  channel_mode TEXT NOT NULL DEFAULT 'include',
  channel_ids_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE reaction_limit_breach_counters (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  breach_count BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE reaction_limit_message_reaction_counts (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  reaction_count BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, channel_id, message_id)
);

CREATE TABLE reaction_limit_user_message_reaction_counts (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  reaction_count BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, channel_id, message_id, user_id)
);
