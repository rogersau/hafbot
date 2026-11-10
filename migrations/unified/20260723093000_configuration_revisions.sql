-- hafbot:migration {"phase":"expand"}
-- Append-only Premium configuration history for the first Ticket Panel vertical slice.
-- Writers keep timestamps monotonic per resource so timestamp cursors cannot skip same-clock changes.

CREATE TABLE IF NOT EXISTS configuration_revisions (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  operation TEXT NOT NULL,
  source TEXT NOT NULL,
  actor_user_id TEXT,
  operation_id TEXT NOT NULL,
  correlation_id TEXT,
  previous_revision_id TEXT,
  restored_from_revision_id TEXT,
  snapshot_json TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS configuration_revision_heads (
  guild_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  current_revision_id TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (guild_id, feature, resource_key)
);

CREATE INDEX IF NOT EXISTS configuration_revisions_by_resource
  ON configuration_revisions (guild_id, feature, resource_key, created_at_ms DESC, id DESC);
CREATE INDEX IF NOT EXISTS configuration_revisions_by_guild
  ON configuration_revisions (guild_id, created_at_ms DESC, id DESC);
CREATE INDEX IF NOT EXISTS configuration_revisions_previous_idx
  ON configuration_revisions (previous_revision_id);
CREATE INDEX IF NOT EXISTS configuration_revisions_restored_from_idx
  ON configuration_revisions (restored_from_revision_id);

CREATE TRIGGER IF NOT EXISTS configuration_revisions_validate_head
BEFORE INSERT ON configuration_revisions
BEGIN
  SELECT RAISE(ABORT, 'configuration revision head conflict')
  WHERE EXISTS (
    SELECT 1 FROM configuration_revision_heads
    WHERE guild_id = NEW.guild_id
      AND feature = NEW.feature
      AND resource_key = NEW.resource_key
  ) AND NEW.previous_revision_id IS NOT (
    SELECT current_revision_id FROM configuration_revision_heads
    WHERE guild_id = NEW.guild_id
      AND feature = NEW.feature
      AND resource_key = NEW.resource_key
  );

  SELECT RAISE(ABORT, 'configuration revision head conflict')
  WHERE NOT EXISTS (
    SELECT 1 FROM configuration_revision_heads
    WHERE guild_id = NEW.guild_id
      AND feature = NEW.feature
      AND resource_key = NEW.resource_key
  ) AND NEW.previous_revision_id IS NOT NULL;
END;

CREATE TRIGGER IF NOT EXISTS configuration_revisions_advance_head
AFTER INSERT ON configuration_revisions
BEGIN
  INSERT INTO configuration_revision_heads (
    guild_id, feature, resource_key, current_revision_id, updated_at_ms
  ) VALUES (
    NEW.guild_id, NEW.feature, NEW.resource_key, NEW.id, NEW.created_at_ms
  )
  ON CONFLICT(guild_id, feature, resource_key) DO UPDATE SET
    current_revision_id = excluded.current_revision_id,
    updated_at_ms = excluded.updated_at_ms;
END;
