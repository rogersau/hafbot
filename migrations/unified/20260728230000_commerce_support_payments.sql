-- hafbot:migration {"phase":"expand"}

CREATE TABLE commerce_support_configs (
  connected_account_id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  explanation TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('AUD', 'USD')),
  suggested_amounts_json TEXT NOT NULL,
  support_contact TEXT NOT NULL,
  terms_version TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE commerce_support_checkout_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  connected_account_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  buyer_id TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('AUD', 'USD')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor BETWEEN 200 AND 50000),
  application_fee_minor INTEGER NOT NULL CHECK (application_fee_minor >= 0),
  stripe_checkout_session_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('creating', 'open', 'returned', 'expired', 'failed')),
  expires_at_ms INTEGER NOT NULL,
  returned_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (connected_account_id, stripe_checkout_session_id)
);
CREATE UNIQUE INDEX commerce_support_checkout_active_buyer_guild
  ON commerce_support_checkout_attempts (connected_account_id, buyer_id, guild_id)
  WHERE status IN ('creating', 'open', 'returned');
CREATE INDEX commerce_support_checkout_expiry
  ON commerce_support_checkout_attempts (status, expires_at_ms);

CREATE TABLE commerce_support_rate_limits (
  buyer_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  window_started_at_ms INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (buyer_id, guild_id)
);

CREATE TABLE commerce_support_payments (
  id TEXT PRIMARY KEY NOT NULL,
  connected_account_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  buyer_id TEXT NOT NULL,
  checkout_attempt_id TEXT NOT NULL,
  stripe_payment_intent_id TEXT NOT NULL,
  stripe_charge_id TEXT,
  stripe_checkout_session_id TEXT,
  currency TEXT NOT NULL CHECK (currency IN ('AUD', 'USD')),
  amount_minor INTEGER NOT NULL,
  amount_received_minor INTEGER NOT NULL DEFAULT 0,
  amount_refunded_minor INTEGER NOT NULL DEFAULT 0,
  application_fee_minor INTEGER NOT NULL,
  stripe_fee_tax_minor INTEGER CHECK (stripe_fee_tax_minor IS NULL OR stripe_fee_tax_minor >= 0),
  stripe_fee_minor INTEGER,
  status TEXT NOT NULL,
  provider_created_at_ms INTEGER,
  paid_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (connected_account_id, stripe_payment_intent_id),
  UNIQUE (connected_account_id, checkout_attempt_id)
);
CREATE INDEX commerce_support_payments_seller_time
  ON commerce_support_payments (connected_account_id, created_at_ms);
CREATE INDEX commerce_support_payments_buyer_time
  ON commerce_support_payments (buyer_id, created_at_ms);

CREATE TABLE commerce_support_refunds (
  id TEXT PRIMARY KEY NOT NULL,
  connected_account_id TEXT NOT NULL,
  support_payment_id TEXT NOT NULL,
  stripe_refund_id TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('AUD', 'USD')),
  amount_minor INTEGER NOT NULL,
  application_fee_refunded_minor INTEGER,
  status TEXT NOT NULL,
  reason TEXT,
  provider_created_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (connected_account_id, stripe_refund_id)
);
CREATE INDEX commerce_support_refunds_payment_time
  ON commerce_support_refunds (support_payment_id, created_at_ms);
