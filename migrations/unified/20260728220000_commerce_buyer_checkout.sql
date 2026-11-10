-- hafbot:migration {"phase":"expand"}

CREATE TABLE commerce_checkout_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  connected_account_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  offering_id TEXT NOT NULL,
  price_id TEXT NOT NULL,
  buyer_id TEXT NOT NULL,
  stripe_checkout_session_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('creating', 'open', 'returned', 'expired', 'failed')),
  expires_at_ms INTEGER NOT NULL,
  returned_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (connected_account_id, stripe_checkout_session_id)
);
CREATE UNIQUE INDEX commerce_checkout_attempts_active_buyer_offering
  ON commerce_checkout_attempts (connected_account_id, buyer_id, offering_id)
  WHERE status IN ('creating', 'open', 'returned');
CREATE INDEX commerce_checkout_attempts_expiry
  ON commerce_checkout_attempts (status, expires_at_ms);

CREATE TABLE commerce_checkout_rate_limits (
  buyer_id TEXT NOT NULL,
  offering_id TEXT NOT NULL,
  window_started_at_ms INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (buyer_id, offering_id)
);

