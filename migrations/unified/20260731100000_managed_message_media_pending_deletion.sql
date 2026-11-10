-- hafbot:migration {"phase":"expand"}

ALTER TABLE managed_message_media_assets
  ADD COLUMN status TEXT NOT NULL DEFAULT 'active';

CREATE INDEX IF NOT EXISTS managed_message_media_assets_pending
  ON managed_message_media_assets (guild_id, status);
