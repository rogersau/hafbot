CREATE TABLE IF NOT EXISTS server_level_configs (
  guild_id TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  announcement_channel_id TEXT,
  removed_at_ms BIGINT,
  updated_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS server_level_servers (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  provider_server_id TEXT NOT NULL,
  max_slots INTEGER NOT NULL CHECK (max_slots BETWEEN 1 AND 10000),
  endpoint_id TEXT NOT NULL UNIQUE,
  webhook_credential_id TEXT NOT NULL,
  webhook_verified_at_ms BIGINT,
  subscribed_events_json TEXT NOT NULL DEFAULT '[]',
  capacity_proposal_json TEXT,
  last_roster_reconciled_at_ms BIGINT,
  last_capacity_checked_at_ms BIGINT,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  UNIQUE (guild_id, provider_server_id)
);
CREATE INDEX IF NOT EXISTS server_level_servers_guild ON server_level_servers(guild_id);

CREATE OR REPLACE FUNCTION enforce_server_level_server_limit() RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('server-level-server-limit:' || NEW.guild_id, 0)
  );
  IF (SELECT COUNT(*) FROM server_level_servers WHERE guild_id = NEW.guild_id) >= 5 THEN
    RAISE EXCEPTION 'A Guild may configure at most five Configured Game Servers.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS server_level_servers_limit_before_insert ON server_level_servers;
CREATE TRIGGER server_level_servers_limit_before_insert
BEFORE INSERT ON server_level_servers
FOR EACH ROW EXECUTE FUNCTION enforce_server_level_server_limit();

CREATE TABLE IF NOT EXISTS server_level_credentials (
  credential_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  configured_game_server_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('webhook_secret', 'data_api')),
  key_version TEXT NOT NULL,
  nonce TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  UNIQUE (configured_game_server_id, purpose)
);

CREATE TABLE IF NOT EXISTS server_level_webhook_inbox (
  inbox_id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL,
  configured_game_server_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at_ms BIGINT NOT NULL,
  steam_id64 TEXT,
  population INTEGER,
  queue_size INTEGER,
  status TEXT NOT NULL DEFAULT 'accepted',
  reason_code TEXT,
  received_at_ms BIGINT NOT NULL,
  body_sha256 TEXT CHECK (body_sha256 IS NULL OR length(body_sha256) = 64),
  processed_at_ms BIGINT,
  UNIQUE (configured_game_server_id, delivery_id)
);
CREATE INDEX IF NOT EXISTS server_level_webhook_inbox_processing
  ON server_level_webhook_inbox(configured_game_server_id, status, occurred_at_ms);

CREATE TABLE IF NOT EXISTS server_level_ingress_outbox (
  inbox_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  published_at_ms BIGINT
);
CREATE INDEX IF NOT EXISTS server_level_ingress_outbox_pending
  ON server_level_ingress_outbox(published_at_ms, created_at_ms);

CREATE TABLE IF NOT EXISTS server_level_processing_cursors (
  configured_game_server_id TEXT PRIMARY KEY,
  latest_seen_at_ms BIGINT NOT NULL,
  watermark_at_ms BIGINT NOT NULL,
  last_delivery_id TEXT NOT NULL,
  population INTEGER,
  queue_size INTEGER,
  lifecycle_generation INTEGER NOT NULL DEFAULT 0,
  updated_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS server_level_processing_leases (
  configured_game_server_id TEXT PRIMARY KEY,
  lease_id TEXT NOT NULL,
  expires_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS server_level_current_presence (
  configured_game_server_id TEXT NOT NULL,
  steam_id64 TEXT NOT NULL,
  lifecycle_generation INTEGER NOT NULL,
  joined_at_ms BIGINT NOT NULL,
  last_confirmed_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (configured_game_server_id, steam_id64)
);

CREATE TABLE IF NOT EXISTS server_level_earning_sessions (
  session_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  configured_game_server_id TEXT NOT NULL,
  steam_id64 TEXT NOT NULL,
  user_id TEXT NOT NULL,
  lifecycle_generation INTEGER NOT NULL,
  started_at_ms BIGINT NOT NULL,
  last_confirmed_at_ms BIGINT NOT NULL,
  checkpoint_at_ms BIGINT NOT NULL,
  closed_at_ms BIGINT,
  close_reason TEXT,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS server_level_earning_sessions_server_open
  ON server_level_earning_sessions(configured_game_server_id, closed_at_ms, checkpoint_at_ms);
CREATE INDEX IF NOT EXISTS server_level_earning_sessions_member_open
  ON server_level_earning_sessions(guild_id, user_id, closed_at_ms, checkpoint_at_ms);

CREATE TABLE IF NOT EXISTS server_level_awards (
  award_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  configured_game_server_id TEXT,
  source_inbox_id TEXT,
  kind TEXT NOT NULL,
  interval_started_at_ms BIGINT,
  interval_ended_at_ms BIGINT,
  qualifying_seconds INTEGER NOT NULL DEFAULT 0,
  multiplier INTEGER,
  xp_units BIGINT NOT NULL,
  scoring_policy_version INTEGER NOT NULL,
  actor_user_id TEXT,
  reason TEXT,
  created_at_ms BIGINT NOT NULL,
  projection_applied_at_ms BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS server_level_awards_interval_once
  ON server_level_awards(source_inbox_id, user_id, configured_game_server_id, interval_started_at_ms, interval_ended_at_ms);
CREATE INDEX IF NOT EXISTS server_level_awards_member_time
  ON server_level_awards(guild_id, user_id, interval_started_at_ms, interval_ended_at_ms);

CREATE TABLE IF NOT EXISTS server_level_member_totals (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  total_xp_units BIGINT NOT NULL DEFAULT 0 CHECK (total_xp_units >= 0),
  current_member BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX IF NOT EXISTS server_level_member_totals_leaderboard
  ON server_level_member_totals(guild_id, current_member, total_xp_units DESC);

CREATE TABLE IF NOT EXISTS server_level_daily_summaries (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  day_utc TEXT NOT NULL,
  xp_units BIGINT NOT NULL,
  qualifying_seconds INTEGER NOT NULL,
  scoring_policy_version INTEGER NOT NULL,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (guild_id, user_id, day_utc, scoring_policy_version)
);

CREATE TABLE IF NOT EXISTS server_level_announcement_outbox (
  announcement_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  level INTEGER NOT NULL,
  created_at_ms BIGINT NOT NULL,
  delivered_at_ms BIGINT,
  terminal_reason TEXT,
  UNIQUE (guild_id, user_id, level)
);
CREATE INDEX IF NOT EXISTS server_level_announcement_pending
  ON server_level_announcement_outbox(delivered_at_ms, created_at_ms);
