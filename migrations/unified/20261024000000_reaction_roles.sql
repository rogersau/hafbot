-- hafbot:migration {"phase":"expand"}

CREATE TABLE reaction_role_panels (
  guild_id TEXT PRIMARY KEY NOT NULL,
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
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE reaction_role_leases (
  guild_id TEXT PRIMARY KEY NOT NULL,
  token TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL
);
