-- hafbot:migration {"phase":"expand"}

CREATE TABLE suggestions_configs (
  guild_id TEXT PRIMARY KEY NOT NULL, enabled INTEGER DEFAULT 0 NOT NULL,
  forum_channel_id TEXT, panel_channel_id TEXT, panel_message_id TEXT,
  panel_title TEXT NOT NULL, panel_body TEXT NOT NULL, panel_button_text TEXT NOT NULL,
  prompts_json TEXT NOT NULL, categories_json TEXT DEFAULT '[]' NOT NULL,
  status_tag_ids_json TEXT DEFAULT '{}' NOT NULL, category_tag_ids_json TEXT DEFAULT '{}' NOT NULL,
  reply_webhook_id TEXT, reply_webhook_credential_id TEXT,
  mod_role_ids_json TEXT DEFAULT '[]' NOT NULL, mod_queue_channel_id TEXT, voter_role_id TEXT,
  minimum_tenure_days INTEGER DEFAULT 0 NOT NULL, collapse_threshold INTEGER DEFAULT 3 NOT NULL,
  submission_cooldown_seconds INTEGER DEFAULT 300 NOT NULL,
  active_suggestion_limit INTEGER DEFAULT 3 NOT NULL, digest_enabled INTEGER DEFAULT 0 NOT NULL,
  digest_channel_id TEXT, digest_cadence_days INTEGER DEFAULT 7 NOT NULL, updated_at_ms INTEGER NOT NULL
);
CREATE TABLE suggestions (
  id TEXT PRIMARY KEY NOT NULL, guild_id TEXT NOT NULL, author_id TEXT NOT NULL, title TEXT NOT NULL,
  normalized_search_text TEXT NOT NULL, answers_json TEXT NOT NULL, category TEXT, status TEXT NOT NULL,
  revision INTEGER DEFAULT 1 NOT NULL, thread_id TEXT, starter_message_id TEXT, projection_error TEXT,
  support_count INTEGER DEFAULT 0 NOT NULL, oppose_count INTEGER DEFAULT 0 NOT NULL, outcome_json TEXT,
  created_at_ms INTEGER NOT NULL, edited_at_ms INTEGER, updated_at_ms INTEGER NOT NULL
);
CREATE INDEX suggestions_by_guild_status ON suggestions(guild_id,status,updated_at_ms);
CREATE INDEX suggestions_by_author ON suggestions(guild_id,author_id,created_at_ms);
CREATE UNIQUE INDEX suggestions_thread_unique ON suggestions(thread_id);
CREATE TABLE suggestion_revisions (
  id TEXT PRIMARY KEY NOT NULL, suggestion_id TEXT NOT NULL, guild_id TEXT NOT NULL,
  revision INTEGER NOT NULL, title TEXT NOT NULL, answers_json TEXT NOT NULL, category TEXT,
  edited_by_user_id TEXT NOT NULL, created_at_ms INTEGER NOT NULL
);
CREATE UNIQUE INDEX suggestion_revisions_unique ON suggestion_revisions(suggestion_id,revision);
CREATE TABLE suggestion_votes (
  suggestion_id TEXT NOT NULL, guild_id TEXT NOT NULL, member_id TEXT NOT NULL, value TEXT NOT NULL,
  active INTEGER DEFAULT 1 NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(suggestion_id,member_id)
);
CREATE INDEX suggestion_votes_by_member ON suggestion_votes(guild_id,member_id,active);
CREATE TABLE suggestion_status_events (
  id TEXT PRIMARY KEY NOT NULL, suggestion_id TEXT NOT NULL, guild_id TEXT NOT NULL,
  from_status TEXT NOT NULL, to_status TEXT NOT NULL, actor_user_id TEXT NOT NULL,
  reason TEXT, created_at_ms INTEGER NOT NULL
);
CREATE INDEX suggestion_status_history ON suggestion_status_events(suggestion_id,created_at_ms);
CREATE TABLE considered_replies (
  id TEXT PRIMARY KEY NOT NULL, suggestion_id TEXT NOT NULL, thread_id TEXT, guild_id TEXT NOT NULL,
  author_id TEXT NOT NULL, perspective TEXT NOT NULL, reasoning TEXT NOT NULL, improvement TEXT,
  state TEXT NOT NULL, flag_count INTEGER DEFAULT 0 NOT NULL, webhook_message_id TEXT,
  queue_message_id TEXT, collapsed_at_ms INTEGER, resolved_at_ms INTEGER,
  resolved_by_user_id TEXT, resolution_reason TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
);
CREATE INDEX considered_replies_by_suggestion ON considered_replies(suggestion_id,created_at_ms);
CREATE UNIQUE INDEX considered_replies_webhook_message_unique ON considered_replies(webhook_message_id);
CREATE TABLE considered_reply_flags (
  reply_id TEXT NOT NULL, guild_id TEXT NOT NULL, member_id TEXT NOT NULL,
  active INTEGER DEFAULT 1 NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(reply_id,member_id)
);
CREATE TABLE pending_suggestion_submissions (
  id TEXT PRIMARY KEY NOT NULL, guild_id TEXT NOT NULL, author_id TEXT NOT NULL, title TEXT NOT NULL,
  answers_json TEXT NOT NULL, category TEXT, likely_duplicate_ids_json TEXT NOT NULL, expires_at_ms INTEGER NOT NULL
);
CREATE TABLE suggestion_digest_runs (
  guild_id TEXT NOT NULL, period_key TEXT NOT NULL, status TEXT NOT NULL, delivered_message_id TEXT,
  created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, PRIMARY KEY(guild_id,period_key)
);
CREATE TABLE suggestion_action_rate_limits (
  guild_id TEXT NOT NULL, actor_user_id TEXT NOT NULL, action TEXT NOT NULL,
  window_start_ms INTEGER NOT NULL, count INTEGER DEFAULT 1 NOT NULL, updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(guild_id,actor_user_id,action,window_start_ms)
);
CREATE INDEX suggestion_action_limits_expiry ON suggestion_action_rate_limits(updated_at_ms);
