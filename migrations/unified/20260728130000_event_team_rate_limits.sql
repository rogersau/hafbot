-- hafbot:migration {"phase":"expand"}

-- Sliding-window abuse counters for Event Team mutations.
-- Counters are scoped independently to a member and an Event so one noisy
-- member cannot exhaust an Event's entire budget (and vice versa).
CREATE TABLE event_team_rate_limits (
  guild_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  action TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('user', 'event')),
  scope_id TEXT NOT NULL,
  window_started_at_ms INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (guild_id, event_id, action, scope_type, scope_id)
);

CREATE INDEX event_team_rate_limits_expiry
ON event_team_rate_limits (updated_at_ms);
