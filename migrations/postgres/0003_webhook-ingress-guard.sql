CREATE TABLE webhook_guard_buckets (
  scope_key TEXT PRIMARY KEY,
  tokens DOUBLE PRECISION NOT NULL CHECK (tokens >= 0),
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE webhook_guard_leases (
  scope_key TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (scope_key, lease_id)
);

CREATE INDEX webhook_guard_leases_expiry_idx
  ON webhook_guard_leases (expires_at, scope_key);

CREATE TABLE webhook_guard_duplicates (
  scope_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (scope_key, sha256)
);

CREATE INDEX webhook_guard_duplicates_expiry_idx
  ON webhook_guard_duplicates (expires_at, scope_key);

CREATE TABLE webhook_guard_counters (
  scope_key TEXT NOT NULL,
  bucket_at TIMESTAMPTZ NOT NULL,
  outcome TEXT NOT NULL,
  count BIGINT NOT NULL CHECK (count > 0),
  PRIMARY KEY (scope_key, bucket_at, outcome)
);

CREATE INDEX webhook_guard_counters_retention_idx
  ON webhook_guard_counters (bucket_at, scope_key);
