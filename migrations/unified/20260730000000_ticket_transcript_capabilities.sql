-- hafbot:migration {"phase":"expand"}

CREATE TABLE ticket_transcript_capabilities (
  object_id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  access_token_hash TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER,
  discarded_at_ms INTEGER,
  retention_expires_at_ms INTEGER NOT NULL,
  last_accessed_at_ms INTEGER,
  access_count INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX ticket_transcript_capabilities_active_guild_channel
  ON ticket_transcript_capabilities (guild_id, channel_id)
  WHERE discarded_at_ms IS NULL;

CREATE INDEX ticket_transcript_capabilities_retention
  ON ticket_transcript_capabilities (retention_expires_at_ms);
