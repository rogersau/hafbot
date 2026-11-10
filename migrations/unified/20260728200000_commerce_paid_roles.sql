-- hafbot:migration {"phase":"expand"}

CREATE TABLE commerce_paid_role_states (
  entitlement_id TEXT PRIMARY KEY NOT NULL,
  connected_account_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  discord_user_id TEXT NOT NULL,
  discord_role_id TEXT NOT NULL,
  subscription_id TEXT,
  subscription_status TEXT NOT NULL CHECK (subscription_status IN ('incomplete','trialing','active','past_due','paused','unpaid','canceled','ended')),
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0,1)),
  current_period_end_ms INTEGER,
  payment_status TEXT CHECK (payment_status IS NULL OR payment_status IN ('requires_action','processing','succeeded','failed','canceled')),
  amount_minor INTEGER,
  amount_refunded_minor INTEGER NOT NULL DEFAULT 0,
  dispute_status TEXT CHECK (dispute_status IS NULL OR dispute_status IN ('warning_needs_response','warning_under_review','warning_closed','needs_response','under_review','won','lost')),
  failed_payment_at_ms INTEGER,
  admin_action TEXT CHECK (admin_action IS NULL OR admin_action IN ('suspend','revoke')),
  member_state TEXT NOT NULL CHECK (member_state IN ('present','left','kicked','rejoined','banned')),
  updated_at_ms INTEGER NOT NULL,
  CHECK (amount_minor IS NULL OR amount_minor >= 0),
  CHECK (amount_refunded_minor >= 0),
  CHECK (amount_minor IS NULL OR amount_refunded_minor <= amount_minor)
);
CREATE INDEX commerce_paid_role_states_guild_role ON commerce_paid_role_states (guild_id, discord_role_id);

CREATE TABLE commerce_paid_role_operations (
  operation_key TEXT PRIMARY KEY NOT NULL,
  entitlement_id TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing','committed')),
  created_at_ms INTEGER NOT NULL,
  claimed_at_ms INTEGER NOT NULL,
  lease_expires_at_ms INTEGER NOT NULL,
  committed_at_ms INTEGER,
  CHECK (
    (status = 'processing' AND committed_at_ms IS NULL) OR
    (status = 'committed' AND committed_at_ms IS NOT NULL)
  )
);
CREATE INDEX commerce_paid_role_operations_entitlement ON commerce_paid_role_operations (entitlement_id, created_at_ms);

CREATE TABLE commerce_paid_role_outbox (
  id TEXT PRIMARY KEY NOT NULL,
  operation_key TEXT NOT NULL UNIQUE,
  entitlement_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  discord_user_id TEXT NOT NULL,
  discord_role_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('assign','remove','repair')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL CHECK (status IN ('pending','sent','dead_letter')),
  available_at_ms INTEGER NOT NULL,
  sent_at_ms INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK ((status = 'pending' AND sent_at_ms IS NULL) OR status <> 'pending')
);
CREATE INDEX commerce_paid_role_outbox_due ON commerce_paid_role_outbox (status, available_at_ms, created_at_ms);

CREATE TABLE commerce_paid_role_repairs (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  old_role_id TEXT NOT NULL,
  replacement_role_id TEXT,
  started_at_ms INTEGER NOT NULL,
  deadline_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','complete','quarantined')),
  repaired_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK (deadline_at_ms > started_at_ms)
);
CREATE INDEX commerce_paid_role_repairs_due ON commerce_paid_role_repairs (status, deadline_at_ms);
