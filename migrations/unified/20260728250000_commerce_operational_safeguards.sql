-- hafbot:migration {"phase":"expand"}

CREATE TABLE commerce_operational_controls (
  id TEXT PRIMARY KEY NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'guild', 'seller', 'offering')),
  scope_id TEXT NOT NULL,
  control_type TEXT NOT NULL CHECK (control_type IN (
    'commerce_kill', 'new_checkout', 'sales_suspension', 'offering_suspension',
    'renewal_shutdown', 'support_shutdown', 'webhook_quarantine'
  )),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  reason_code TEXT,
  actor_user_id TEXT NOT NULL,
  expires_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (scope_type, scope_id, control_type)
);
CREATE INDEX commerce_operational_controls_active
  ON commerce_operational_controls (enabled, control_type, expires_at_ms);

CREATE TABLE commerce_checkout_capacity_claims (
  id TEXT PRIMARY KEY NOT NULL,
  checkout_kind TEXT NOT NULL CHECK (checkout_kind IN ('subscription', 'support')),
  connected_account_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  offering_id TEXT,
  currency TEXT NOT NULL CHECK (currency IN ('AUD', 'USD')),
  amount_minor INTEGER NOT NULL,
  month_started_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX commerce_checkout_capacity_claims_usage
  ON commerce_checkout_capacity_claims
    (connected_account_id, currency, month_started_at_ms, expires_at_ms);

CREATE TABLE commerce_limit_alerts (
  id TEXT PRIMARY KEY NOT NULL,
  connected_account_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  currency TEXT,
  threshold_percent INTEGER NOT NULL,
  observed_value INTEGER NOT NULL,
  limit_value INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  first_seen_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL,
  resolved_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX commerce_limit_alerts_open
  ON commerce_limit_alerts (guild_id, status, updated_at_ms);
