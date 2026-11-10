-- hafbot:migration {"phase":"expand"}

CREATE TABLE commerce_seller_profiles (
  connected_account_id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL UNIQUE,
  lifecycle_state TEXT NOT NULL CHECK (
    lifecycle_state IN (
      'onboarding_incomplete',
      'pending_review',
      'active',
      'restricted',
      'repair_required',
      'offboarding',
      'disconnected',
      'suspended'
    )
  ),
  approval_state TEXT NOT NULL CHECK (approval_state IN ('pending', 'approved', 'rejected')),
  support_contact TEXT NOT NULL,
  adult_attested_at_ms INTEGER NOT NULL,
  two_factor_evidence TEXT NOT NULL CHECK (
    two_factor_evidence IN ('discord_verified', 'seller_attested')
  ),
  guild_created_at_ms INTEGER NOT NULL,
  ownership_transferred_at_ms INTEGER,
  guild_good_standing INTEGER NOT NULL DEFAULT 0 CHECK (guild_good_standing IN (0, 1)),
  seller_good_standing INTEGER NOT NULL DEFAULT 0 CHECK (seller_good_standing IN (0, 1)),
  requirements_currently_due_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(requirements_currently_due_json)),
  requirements_eventually_due_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(requirements_eventually_due_json)),
  requirements_pending_verification_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(requirements_pending_verification_json)),
  disabled_reason TEXT,
  reviewed_by_user_id TEXT,
  reviewed_at_ms INTEGER,
  capabilities_updated_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK (
    (approval_state = 'pending' AND reviewed_at_ms IS NULL AND reviewed_by_user_id IS NULL) OR
    (approval_state IN ('approved', 'rejected') AND reviewed_at_ms IS NOT NULL
      AND reviewed_by_user_id IS NOT NULL)
  )
);
CREATE INDEX commerce_seller_profiles_lifecycle
  ON commerce_seller_profiles (lifecycle_state, approval_state, updated_at_ms);

CREATE TABLE commerce_seller_controls (
  id TEXT PRIMARY KEY NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'guild')),
  scope_id TEXT NOT NULL,
  suspended INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0, 1)),
  reason_code TEXT,
  actor_user_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (scope_type, scope_id),
  CHECK (
    (scope_type = 'global' AND scope_id = 'commerce') OR
    (scope_type = 'guild' AND length(scope_id) > 0)
  ),
  CHECK ((suspended = 1 AND reason_code IS NOT NULL) OR suspended = 0)
);
CREATE INDEX commerce_seller_controls_active
  ON commerce_seller_controls (suspended, scope_type, updated_at_ms);
