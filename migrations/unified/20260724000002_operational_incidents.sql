-- hafbot:migration {"phase":"expand"}

CREATE TABLE operational_incidents (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  incident_key TEXT NOT NULL,
  feature TEXT NOT NULL CHECK (feature IN ('managed-messages', 'webhooks', 'player-count')),
  resource_kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  condition TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'error', 'critical')),
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  summary_code TEXT NOT NULL,
  safe_args_json TEXT NOT NULL,
  remediation_code TEXT NOT NULL,
  first_seen_at_ms INTEGER NOT NULL,
  open_since_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL,
  resolved_at_ms INTEGER,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  last_correlation_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (guild_id, incident_key)
);

CREATE INDEX operational_incidents_guild_status_severity
  ON operational_incidents (guild_id, status, severity, last_seen_at_ms DESC);
CREATE INDEX operational_incidents_guild_feature_status
  ON operational_incidents (guild_id, feature, status);
CREATE INDEX operational_incidents_retention
  ON operational_incidents (status, resolved_at_ms);

CREATE TABLE operational_incident_events (
  id TEXT PRIMARY KEY NOT NULL,
  incident_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('opened', 'observed', 'severity_changed', 'remediation_started', 'remediation_succeeded', 'remediation_failed', 'resolved', 'reopened')),
  observation_id TEXT,
  reason_code TEXT,
  safe_args_json TEXT NOT NULL,
  correlation_id TEXT,
  actor_user_id TEXT,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (incident_id, observation_id)
);

CREATE INDEX operational_incident_events_incident_created
  ON operational_incident_events (incident_id, created_at_ms DESC);
CREATE INDEX operational_incident_events_retention
  ON operational_incident_events (created_at_ms);
