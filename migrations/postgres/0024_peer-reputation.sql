CREATE TABLE reputation_configs (
  guild_id TEXT PRIMARY KEY,
  settings_json JSONB NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
);

CREATE TABLE reputation_scores (
  guild_id TEXT NOT NULL REFERENCES reputation_configs(guild_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0 CHECK (score >= 0),
  current_member BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX reputation_leaders ON reputation_scores(guild_id, score DESC, user_id) WHERE current_member;

CREATE TABLE reputation_cooldowns (
  guild_id TEXT NOT NULL REFERENCES reputation_configs(guild_id) ON DELETE CASCADE,
  giver_id TEXT NOT NULL,
  next_award_at_ms BIGINT NOT NULL,
  PRIMARY KEY (guild_id, giver_id)
);

CREATE TABLE reputation_awards (
  guild_id TEXT NOT NULL REFERENCES reputation_configs(guild_id) ON DELETE CASCADE,
  interaction_id TEXT NOT NULL,
  giver_id TEXT,
  recipient_id TEXT,
  reason TEXT CHECK (length(reason) <= 300),
  total_score INTEGER NOT NULL DEFAULT 0 CHECK (total_score >= 0),
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (guild_id, interaction_id)
);
CREATE INDEX reputation_awards_giver ON reputation_awards(guild_id, giver_id);
CREATE INDEX reputation_awards_recipient ON reputation_awards(guild_id, recipient_id);

CREATE TABLE reputation_reward_jobs (
  guild_id TEXT NOT NULL REFERENCES reputation_configs(guild_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  threshold INTEGER NOT NULL CHECK (threshold > 0),
  next_attempt_at_ms BIGINT NOT NULL DEFAULT 0,
  delivered_at_ms BIGINT,
  PRIMARY KEY (guild_id, user_id, role_id)
);
CREATE INDEX reputation_reward_jobs_due ON reputation_reward_jobs(next_attempt_at_ms) WHERE delivered_at_ms IS NULL;
