-- hafbot:migration {"phase":"expand"}
-- One canonical, seller-scoped Discord sales panel per Commerce Guild.
CREATE TABLE commerce_sales_panels (
  connected_account_id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  last_error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE UNIQUE INDEX commerce_sales_panels_guild ON commerce_sales_panels (guild_id);
CREATE INDEX commerce_sales_panels_message ON commerce_sales_panels (channel_id, message_id);
