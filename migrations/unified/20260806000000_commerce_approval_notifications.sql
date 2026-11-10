-- hafbot:migration {"phase":"expand"}

ALTER TABLE commerce_seller_review_requests ADD COLUMN guild_created_at_ms INTEGER;
