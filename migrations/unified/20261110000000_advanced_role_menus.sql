-- hafbot:migration {"phase":"expand"}

ALTER TABLE reaction_role_panels ADD COLUMN mode TEXT NOT NULL DEFAULT 'multiple';
ALTER TABLE reaction_role_panels ADD COLUMN required_role_ids_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE reaction_role_panels ADD COLUMN blocked_role_ids_json TEXT NOT NULL DEFAULT '[]';

CREATE TABLE reaction_role_additional_panels (
  guild_id TEXT NOT NULL,
  id TEXT NOT NULL,
  bot_user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  options_json TEXT NOT NULL,
  published_options_json TEXT NOT NULL DEFAULT '[]',
  activated_at_ms INTEGER,
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL,
  mode TEXT NOT NULL DEFAULT 'multiple',
  required_role_ids_json TEXT NOT NULL DEFAULT '[]',
  blocked_role_ids_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (guild_id, id),
  UNIQUE (guild_id, channel_id, message_id)
);
