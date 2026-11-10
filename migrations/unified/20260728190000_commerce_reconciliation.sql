-- hafbot:migration {"phase":"expand"}

ALTER TABLE commerce_webhook_events ADD COLUMN object_id TEXT;
ALTER TABLE commerce_webhook_events ADD COLUMN payload_hash TEXT;
ALTER TABLE commerce_webhook_events ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;

ALTER TABLE commerce_sync_state ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE commerce_sync_state ADD COLUMN applied_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE commerce_sync_state ADD COLUMN lease_token TEXT;
ALTER TABLE commerce_sync_state ADD COLUMN lease_expires_at_ms INTEGER;

CREATE TABLE commerce_sync_outbox (
  id TEXT PRIMARY KEY NOT NULL,
  connected_account_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  sent_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (connected_account_id, event_id)
);
CREATE INDEX commerce_sync_outbox_pending
  ON commerce_sync_outbox (sent_at_ms, created_at_ms);
