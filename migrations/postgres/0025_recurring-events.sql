CREATE TABLE event_recurrence_series (
  guild_id TEXT NOT NULL,
  series_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  frequency TEXT NOT NULL,
  until_at_ms BIGINT,
  next_starts_at_ms BIGINT NOT NULL,
  next_publishes_at_ms BIGINT NOT NULL,
  status TEXT NOT NULL,
  pending_event_id TEXT,
  publication_attempted_at_ms BIGINT,
  last_event_id TEXT NOT NULL,
  failure_reason TEXT,
  created_by_user_id TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  lease_token TEXT,
  lease_until_ms BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, series_id),
  UNIQUE (guild_id, source_event_id)
);
CREATE INDEX event_recurrence_due ON event_recurrence_series(status, next_publishes_at_ms);
ALTER TABLE events ADD COLUMN recurrence_series_id TEXT;
CREATE INDEX events_recurrence_series ON events(guild_id, recurrence_series_id);
