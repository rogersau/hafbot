-- hafbot:migration {"phase":"expand"}

CREATE TABLE commerce_seller_review_requests (
  id TEXT PRIMARY KEY NOT NULL,
  connected_account_id TEXT NOT NULL UNIQUE,
  guild_id TEXT NOT NULL,
  seller_owner_user_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processing', 'approved', 'rejected')),
  stripe_details_submitted INTEGER NOT NULL DEFAULT 0,
  stripe_charges_enabled INTEGER NOT NULL DEFAULT 0,
  stripe_payouts_enabled INTEGER NOT NULL DEFAULT 0,
  review_channel_id TEXT,
  review_message_id TEXT,
  notification_lease_token TEXT,
  notification_lease_expires_at_ms INTEGER,
  decision_actor_user_id TEXT,
  decision_state TEXT,
  decision_reason TEXT,
  decided_at_ms INTEGER,
  decision_notified_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX commerce_seller_review_requests_pending
  ON commerce_seller_review_requests (state, created_at_ms);
CREATE INDEX commerce_seller_review_requests_lease
  ON commerce_seller_review_requests (notification_lease_expires_at_ms);
