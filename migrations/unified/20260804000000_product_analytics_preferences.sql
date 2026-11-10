-- hafbot:migration {"phase":"expand"}
CREATE TABLE product_analytics_preferences (
  guild_id TEXT PRIMARY KEY NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  updated_at_ms INTEGER NOT NULL
);
