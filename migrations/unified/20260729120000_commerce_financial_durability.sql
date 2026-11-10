-- hafbot:migration {"phase":"expand"}

ALTER TABLE commerce_financial_actions ADD COLUMN lease_token TEXT;
ALTER TABLE commerce_financial_actions ADD COLUMN claimed_at_ms INTEGER;
ALTER TABLE commerce_financial_actions ADD COLUMN lease_expires_at_ms INTEGER;
ALTER TABLE commerce_financial_actions ADD COLUMN available_at_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE commerce_financial_actions ADD COLUMN provider_completed_at_ms INTEGER;
ALTER TABLE commerce_financial_actions ADD COLUMN reconciliation_requested_at_ms INTEGER;
ALTER TABLE commerce_financial_actions ADD COLUMN quarantined_at_ms INTEGER;

CREATE INDEX commerce_financial_actions_due
  ON commerce_financial_actions (status, available_at_ms, lease_expires_at_ms);

CREATE TABLE commerce_financial_provider_actions (
  id TEXT PRIMARY KEY NOT NULL,
  operation_key TEXT NOT NULL UNIQUE,
  parent_action_id TEXT NOT NULL,
  workflow_type TEXT NOT NULL CHECK (
    workflow_type IN (
      'offering_retirement', 'seller_offboarding', 'renewal_shutdown', 'refund_followup'
    )
  ),
  workflow_id TEXT NOT NULL,
  connected_account_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  offering_id TEXT,
  subscription_id TEXT NOT NULL,
  stripe_subscription_id TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK (
    action_type IN ('subscription.cancel_at_period_end', 'subscription.cancel_immediately')
  ),
  reason_code TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'processing', 'completed', 'failed', 'quarantined')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at_ms INTEGER NOT NULL,
  lease_token TEXT,
  claimed_at_ms INTEGER,
  lease_expires_at_ms INTEGER,
  provider_completed_at_ms INTEGER,
  reconciliation_requested_at_ms INTEGER,
  completed_at_ms INTEGER,
  last_error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX commerce_financial_provider_actions_due
  ON commerce_financial_provider_actions (status, available_at_ms, lease_expires_at_ms);
CREATE INDEX commerce_financial_provider_actions_workflow
  ON commerce_financial_provider_actions (workflow_type, workflow_id, status);

CREATE TABLE commerce_offering_retirements (
  id TEXT PRIMARY KEY NOT NULL,
  connected_account_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  offering_id TEXT NOT NULL UNIQUE,
  requested_by_user_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'requested',
      'stopping_sales',
      'scheduling_cancellations',
      'waiting_for_period_end',
      'complete',
      'failed'
    )
  ),
  active_subscription_count INTEGER NOT NULL DEFAULT 0,
  scheduled_cancellation_count INTEGER NOT NULL DEFAULT 0,
  failed_cancellation_count INTEGER NOT NULL DEFAULT 0,
  latest_period_end_ms INTEGER,
  last_error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER
);

CREATE INDEX commerce_offering_retirements_status
  ON commerce_offering_retirements (status, updated_at_ms);
