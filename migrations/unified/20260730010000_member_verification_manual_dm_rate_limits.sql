-- hafbot:migration {"phase":"expand"}

-- Durable abuse counters for administrator-triggered Member Verification DMs.
-- Guild, actor, and target scopes prevent one administrator or target from
-- consuming the full Guild budget without also enforcing a repeat cooldown.
CREATE TABLE member_verification_manual_dm_rate_limits (
  guild_id TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('guild', 'actor', 'target')),
  scope_id TEXT NOT NULL,
  window_started_at_ms INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (guild_id, scope_type, scope_id)
);

CREATE INDEX member_verification_manual_dm_rate_limits_expiry
ON member_verification_manual_dm_rate_limits (updated_at_ms);
