CREATE TABLE gateway_sessions (
  identity_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'idle'
    CHECK (status IN ('idle', 'connecting', 'ready', 'resuming', 'backoff')),
  session_id TEXT,
  resume_gateway_url TEXT,
  last_sequence BIGINT,
  backoff_attempt INTEGER NOT NULL DEFAULT 0 CHECK (backoff_attempt >= 0),
  last_error TEXT,
  heartbeat_interval_ms INTEGER,
  last_heartbeat_at TIMESTAMPTZ,
  last_heartbeat_ack_at TIMESTAMPTZ,
  fencing_generation BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE gateway_member_roles (
  identity_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role_ids_json JSONB NOT NULL,
  PRIMARY KEY (identity_id, guild_id, user_id)
);

CREATE TABLE gateway_member_nicks (
  identity_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  nick_json JSONB NOT NULL,
  PRIMARY KEY (identity_id, guild_id, user_id)
);

CREATE TABLE gateway_message_audit_context (
  identity_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  author_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (identity_id, message_id)
);

CREATE INDEX gateway_message_audit_context_retention_idx
  ON gateway_message_audit_context (identity_id, updated_at DESC, message_id DESC);

CREATE TABLE gateway_voice_states (
  identity_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  PRIMARY KEY (identity_id, guild_id, user_id)
);

CREATE INDEX gateway_voice_channel_members_idx
  ON gateway_voice_states (identity_id, guild_id, channel_id);
