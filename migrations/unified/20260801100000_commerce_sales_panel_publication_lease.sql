-- hafbot:migration {"phase":"expand"}
-- Serialize Discord publication and retain enough intent to reconcile a
-- provider success that outlives the originating Worker request.
ALTER TABLE commerce_sales_panels ADD COLUMN pending_channel_id TEXT;
ALTER TABLE commerce_sales_panels ADD COLUMN publication_nonce TEXT;
ALTER TABLE commerce_sales_panels ADD COLUMN publication_lease_token TEXT;
ALTER TABLE commerce_sales_panels ADD COLUMN publication_lease_expires_at_ms INTEGER;
CREATE INDEX commerce_sales_panels_lease
  ON commerce_sales_panels (publication_lease_expires_at_ms);
