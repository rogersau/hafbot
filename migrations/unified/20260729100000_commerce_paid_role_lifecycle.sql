-- hafbot:migration {"phase":"expand"}

ALTER TABLE commerce_paid_role_repairs ADD COLUMN offering_id TEXT;
UPDATE commerce_paid_role_repairs
SET offering_id = (
  SELECT o.id FROM commerce_offerings o
  WHERE o.guild_id = commerce_paid_role_repairs.guild_id
    AND o.discord_role_id = commerce_paid_role_repairs.old_role_id
  LIMIT 1
)
WHERE offering_id IS NULL
  AND 1 = (
    SELECT COUNT(*) FROM commerce_offerings o
    WHERE o.guild_id = commerce_paid_role_repairs.guild_id
      AND o.discord_role_id = commerce_paid_role_repairs.old_role_id
  );
UPDATE commerce_paid_role_repairs
SET status = 'quarantined', last_error_code = 'offering_ambiguous'
WHERE offering_id IS NULL AND status = 'pending'
  AND 1 < (
    SELECT COUNT(*) FROM commerce_offerings o
    WHERE o.guild_id = commerce_paid_role_repairs.guild_id
      AND o.discord_role_id = commerce_paid_role_repairs.old_role_id
  );
UPDATE commerce_paid_role_repairs
SET status = 'quarantined', last_error_code = 'offering_missing'
WHERE offering_id IS NULL AND status = 'pending';

ALTER TABLE commerce_role_assignments RENAME TO commerce_role_assignments_before_lifecycle;
DROP INDEX commerce_role_assignments_due;
DROP INDEX commerce_role_assignments_member;

CREATE TABLE commerce_role_assignments (
  id TEXT PRIMARY KEY NOT NULL,
  entitlement_id TEXT NOT NULL UNIQUE,
  guild_id TEXT NOT NULL,
  discord_user_id TEXT NOT NULL,
  discord_role_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'assigned', 'withheld', 'removing', 'removed', 'failed')),
  withheld_reason TEXT CHECK (
    withheld_reason IS NULL OR withheld_reason IN ('member_absent', 'guild_ban', 'dispute', 'admin_suspension')
  ),
  provider_cancellation_state TEXT NOT NULL DEFAULT 'none' CHECK (
    provider_cancellation_state IN ('none', 'pending', 'scheduled', 'completed', 'failed')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code TEXT,
  next_attempt_at_ms INTEGER,
  assigned_at_ms INTEGER,
  removed_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK ((status = 'withheld' AND withheld_reason IS NOT NULL) OR status <> 'withheld')
);

INSERT INTO commerce_role_assignments (
  id, entitlement_id, guild_id, discord_user_id, discord_role_id, status,
  withheld_reason, provider_cancellation_state, attempt_count, last_error_code,
  next_attempt_at_ms, assigned_at_ms, removed_at_ms, created_at_ms, updated_at_ms
)
SELECT id, entitlement_id, guild_id, discord_user_id, discord_role_id, status,
       NULL, 'none', attempt_count, last_error_code, next_attempt_at_ms,
       assigned_at_ms, removed_at_ms, created_at_ms, updated_at_ms
FROM commerce_role_assignments_before_lifecycle;

DROP TABLE commerce_role_assignments_before_lifecycle;
CREATE INDEX commerce_role_assignments_due
  ON commerce_role_assignments (status, next_attempt_at_ms);
CREATE INDEX commerce_role_assignments_member
  ON commerce_role_assignments (guild_id, discord_user_id);

CREATE TABLE commerce_paid_role_provider_actions (
  id TEXT PRIMARY KEY NOT NULL,
  operation_key TEXT NOT NULL UNIQUE,
  assignment_id TEXT,
  connected_account_id TEXT NOT NULL,
  stripe_subscription_id TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK (
    action_type IN ('subscription.cancel_at_period_end', 'subscription.cancel_immediately')
  ),
  reason_code TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at_ms INTEGER NOT NULL,
  claimed_at_ms INTEGER,
  lease_expires_at_ms INTEGER,
  completed_at_ms INTEGER,
  last_error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX commerce_paid_role_provider_actions_due
  ON commerce_paid_role_provider_actions (status, available_at_ms, lease_expires_at_ms);

CREATE TABLE commerce_guild_deletion_refund_reviews (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  connected_account_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  buyer_id TEXT NOT NULL,
  payment_id TEXT,
  payment_paid_at_ms INTEGER,
  paid_through_at_ms INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending', 'reviewed', 'waived')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (connected_account_id, subscription_id)
);
CREATE INDEX commerce_guild_deletion_refund_reviews_pending
  ON commerce_guild_deletion_refund_reviews (status, created_at_ms);
