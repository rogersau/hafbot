-- hafbot:migration {"phase":"expand"}

-- Seller-authored presentation settings are deliberately separate from
-- Commerce financial projections and cannot replace fixed disclosures.
CREATE TABLE commerce_store_branding (
  guild_id TEXT PRIMARY KEY NOT NULL,
  connected_account_id TEXT NOT NULL UNIQUE,
  accent_color INTEGER NOT NULL DEFAULT 5793266 CHECK (
    accent_color BETWEEN 0 AND 16777215 AND accent_color = CAST(accent_color AS INTEGER)
  ),
  tagline TEXT NOT NULL DEFAULT '' CHECK (length(tagline) <= 160),
  created_by_user_id TEXT NOT NULL,
  updated_by_user_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX commerce_store_branding_updated ON commerce_store_branding (updated_at_ms);
