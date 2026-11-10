-- hafbot:migration {"phase":"expand"}

CREATE TABLE IF NOT EXISTS managed_message_media_assets (
  guild_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (guild_id, filename)
);

CREATE TABLE IF NOT EXISTS managed_message_media_refs (
  guild_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('draft', 'message')),
  owner_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, filename, owner_type, owner_id)
);

CREATE INDEX IF NOT EXISTS managed_message_media_refs_by_owner
  ON managed_message_media_refs (guild_id, owner_type, owner_id);

