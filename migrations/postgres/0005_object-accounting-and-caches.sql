CREATE TABLE guild_entitlements (
  guild_id TEXT PRIMARY KEY,
  tier TEXT NOT NULL CHECK (tier IN ('free', 'premium', 'premium_plus')),
  plan TEXT CHECK (plan IS NULL OR plan IN ('free', 'premium', 'premium_plus')),
  updated_at_ms BIGINT NOT NULL
);

CREATE TABLE guild_object_accounting (
  guild_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  created_at_ms BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'committed'
    CHECK (status IN ('committed', 'reserved', 'deleted', 'released')),
  reserved_bytes BIGINT NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
  reservation_expires_at_ms BIGINT,
  operation_key TEXT,
  updated_at_ms BIGINT NOT NULL DEFAULT 0,
  reconciliation_generation BIGINT,
  had_committed_object BOOLEAN NOT NULL DEFAULT TRUE,
  upload_started_at_ms BIGINT,
  tombstoned_at_ms BIGINT,
  PRIMARY KEY (guild_id, object_key),
  CONSTRAINT guild_object_reservation_shape CHECK (
    (status = 'reserved' AND reservation_expires_at_ms IS NOT NULL AND operation_key IS NOT NULL)
    OR
    (status <> 'reserved' AND reservation_expires_at_ms IS NULL AND operation_key IS NULL)
  )
);

CREATE INDEX guild_object_accounting_guild_idx
  ON guild_object_accounting (guild_id);
CREATE UNIQUE INDEX guild_object_accounting_operation_idx
  ON guild_object_accounting (operation_key)
  WHERE operation_key IS NOT NULL;
CREATE INDEX guild_object_accounting_expiry_idx
  ON guild_object_accounting (reservation_expires_at_ms, guild_id, object_key)
  WHERE status = 'reserved';

CREATE TABLE guild_object_reconciliation_state (
  bucket_id TEXT PRIMARY KEY,
  cursor TEXT,
  generation BIGINT NOT NULL DEFAULT 1,
  started_at_ms BIGINT,
  last_reconciled_at_ms BIGINT,
  updated_at_ms BIGINT NOT NULL
);

CREATE TABLE steam_ban_lookup_cache (
  steam_id64 TEXT PRIMARY KEY,
  entry_json JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX steam_ban_lookup_cache_expiry_idx
  ON steam_ban_lookup_cache (expires_at);

CREATE TABLE player_count_streak_reports (
  report_key TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX player_count_streak_reports_expiry_idx
  ON player_count_streak_reports (expires_at);
