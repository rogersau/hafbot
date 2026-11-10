-- Feature-owned durable intents. The operation row is also its execution outbox:
-- creating it atomically publishes pending work, without a Queue dual-write gap.
CREATE TABLE ban_case_confirmations (
  id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, actor_id TEXT NOT NULL, expires_at_ms BIGINT NOT NULL, operation_id TEXT, data TEXT NOT NULL
);
CREATE TABLE ban_case_operations (
  id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, physical_target TEXT NOT NULL,
  subject TEXT NOT NULL, action TEXT NOT NULL, active INTEGER NOT NULL, revision INTEGER NOT NULL,
  next_at_ms BIGINT NOT NULL, data TEXT NOT NULL
);
CREATE UNIQUE INDEX ban_case_operation_active ON ban_case_operations(physical_target, subject) WHERE active = 1;
CREATE INDEX ban_case_operation_due ON ban_case_operations(active, next_at_ms);
CREATE INDEX ban_case_operation_guild ON ban_case_operations(guild_id);
CREATE TABLE ban_case_operation_projections (
  id TEXT PRIMARY KEY REFERENCES ban_case_operations(id),
  token TEXT NOT NULL, next_at_ms BIGINT NOT NULL, delivered_revision INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX ban_case_projection_due ON ban_case_operation_projections(next_at_ms);

-- Feature-owned incidents reuse the operational-incident lifecycle.
CREATE TABLE ban_case_operational_incidents (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  incident_key TEXT NOT NULL,
  feature TEXT NOT NULL CHECK (feature IN ('ban-cases')),
  resource_kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  condition TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'error', 'critical')),
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  summary_code TEXT NOT NULL,
  safe_args_json TEXT NOT NULL,
  remediation_code TEXT NOT NULL,
  first_seen_at_ms BIGINT NOT NULL,
  open_since_ms BIGINT NOT NULL,
  last_seen_at_ms BIGINT NOT NULL,
  resolved_at_ms BIGINT,
  occurrence_count BIGINT NOT NULL DEFAULT 1,
  last_correlation_id TEXT,
  version BIGINT NOT NULL DEFAULT 1,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  UNIQUE (guild_id, incident_key)
);

CREATE INDEX ban_case_operational_incidents_guild_status_severity
  ON ban_case_operational_incidents (guild_id, status, severity, last_seen_at_ms DESC);
CREATE INDEX ban_case_operational_incidents_guild_feature_status
  ON ban_case_operational_incidents (guild_id, feature, status);
CREATE INDEX ban_case_operational_incidents_retention
  ON ban_case_operational_incidents (status, resolved_at_ms);

CREATE TABLE ban_case_operational_incident_events (
  id TEXT PRIMARY KEY NOT NULL,
  incident_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('opened', 'observed', 'severity_changed', 'remediation_started', 'remediation_succeeded', 'remediation_failed', 'resolved', 'reopened')),
  observation_id TEXT,
  reason_code TEXT,
  safe_args_json TEXT NOT NULL,
  correlation_id TEXT,
  actor_user_id TEXT,
  created_at_ms BIGINT NOT NULL,
  UNIQUE (incident_id, observation_id)
);

CREATE INDEX ban_case_operational_incident_events_incident_created
  ON ban_case_operational_incident_events (incident_id, created_at_ms DESC);
CREATE INDEX ban_case_operational_incident_events_retention
  ON ban_case_operational_incident_events (created_at_ms);
