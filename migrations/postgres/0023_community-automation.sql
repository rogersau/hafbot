CREATE TABLE community_tool_configs (
  guild_id TEXT NOT NULL,
  feature TEXT NOT NULL CHECK (feature IN ('automation','moderation','feeds')),
  config_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (guild_id, feature)
);
CREATE TABLE community_tool_claims (
  claim_key TEXT PRIMARY KEY,
  expires_at_ms BIGINT NOT NULL
);
CREATE INDEX community_tool_claims_expiry ON community_tool_claims (expires_at_ms);
CREATE TABLE community_moderation_cases (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  actor_user_id TEXT,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  rule_id TEXT,
  created_at_ms BIGINT NOT NULL
);
CREATE INDEX community_moderation_history ON community_moderation_cases (guild_id,user_id,created_at_ms DESC);
CREATE TABLE community_feed_state (
  guild_id TEXT NOT NULL,
  feed_id TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  seen_ids_json TEXT NOT NULL DEFAULT '[]',
  initialized INTEGER NOT NULL DEFAULT 0,
  checked_at_ms BIGINT NOT NULL DEFAULT 0,
  last_error TEXT,
  PRIMARY KEY (guild_id,feed_id)
);
CREATE TABLE community_tool_deliveries (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  item_id TEXT NOT NULL,
  config_revision INTEGER NOT NULL,
  bot_user_id TEXT,
  channel_id TEXT NOT NULL,
  content TEXT NOT NULL,
  role_ids_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','delivered','failed','cancelled')),
  created_at_ms BIGINT NOT NULL,
  lease_token TEXT,
  lease_until_ms BIGINT NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX community_tool_deliveries_pending ON community_tool_deliveries(status,created_at_ms);
