-- hafbot:migration {"phase":"expand"}
-- Seller-controlled Discord sales panel copy, retained through publication recovery.
ALTER TABLE commerce_sales_panels ADD COLUMN title TEXT NOT NULL DEFAULT 'Support this Discord server';
ALTER TABLE commerce_sales_panels ADD COLUMN description TEXT NOT NULL DEFAULT 'Discover paid Discord role access from this server.';
ALTER TABLE commerce_sales_panels ADD COLUMN pending_title TEXT;
ALTER TABLE commerce_sales_panels ADD COLUMN pending_description TEXT;
