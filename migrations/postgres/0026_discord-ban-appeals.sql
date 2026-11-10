CREATE TABLE discord_ban_appeal_configs (
  guild_id TEXT PRIMARY KEY,
  settings_json JSONB NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
CREATE TABLE discord_ban_appeals (
  guild_id TEXT NOT NULL REFERENCES discord_ban_appeal_configs(guild_id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
  appeal_text TEXT NOT NULL CHECK (length(appeal_text) BETWEEN 20 AND 4000),
  ban_reason TEXT CHECK (length(ban_reason) <= 2000),
  status TEXT NOT NULL CHECK (status IN ('pending','unban_pending','unbanned','rejected')),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at_ms BIGINT NOT NULL,
  resolved_at_ms BIGINT,
  reviewer_user_id TEXT,
  decision_reason TEXT CHECK (length(decision_reason) <= 500),
  operation_id TEXT,
  PRIMARY KEY(guild_id,id)
);
CREATE UNIQUE INDEX discord_ban_appeals_one_open ON discord_ban_appeals(guild_id,user_id) WHERE status IN ('pending','unban_pending');
CREATE INDEX discord_ban_appeals_user_history ON discord_ban_appeals(guild_id,user_id,created_at_ms DESC);
CREATE TABLE discord_ban_appeal_cooldowns (
  guild_id TEXT NOT NULL REFERENCES discord_ban_appeal_configs(guild_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  next_submission_at_ms BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY(guild_id,user_id)
);
CREATE TABLE discord_ban_appeal_operations (
  guild_id TEXT NOT NULL,
  appeal_id TEXT NOT NULL,
  id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  outcome TEXT NOT NULL CHECK (outcome IN ('started','succeeded','failed','uncertain')),
  created_at_ms BIGINT NOT NULL,
  completed_at_ms BIGINT,
  PRIMARY KEY(guild_id,id),
  FOREIGN KEY(guild_id,appeal_id) REFERENCES discord_ban_appeals(guild_id,id) ON DELETE CASCADE
);
