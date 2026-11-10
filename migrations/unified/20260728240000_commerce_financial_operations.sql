-- hafbot:migration {"phase":"expand"}

CREATE TABLE commerce_financial_actions (
  id TEXT PRIMARY KEY NOT NULL,
  connected_account_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  amount_minor INTEGER,
  currency TEXT,
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  provider_result_id TEXT,
  access_action TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  last_error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER
);
CREATE INDEX commerce_financial_actions_seller_time
  ON commerce_financial_actions (connected_account_id, created_at_ms);
CREATE INDEX commerce_financial_actions_entity_time
  ON commerce_financial_actions (entity_type, entity_id, created_at_ms);

CREATE TABLE commerce_seller_offboarding (
  connected_account_id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('canceling', 'waiting', 'ready', 'completed', 'unexpected_deauthorization')),
  reason_code TEXT NOT NULL,
  actor_user_id TEXT,
  active_subscription_count INTEGER NOT NULL DEFAULT 0,
  latest_paid_through_at_ms INTEGER,
  started_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE commerce_support_disputes (
  id TEXT PRIMARY KEY NOT NULL,
  connected_account_id TEXT NOT NULL,
  support_payment_id TEXT NOT NULL,
  stripe_dispute_id TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('AUD', 'USD')),
  amount_minor INTEGER NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  provider_created_at_ms INTEGER,
  closed_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (connected_account_id, stripe_dispute_id)
);
CREATE INDEX commerce_support_disputes_payment_time
  ON commerce_support_disputes (support_payment_id, created_at_ms);
