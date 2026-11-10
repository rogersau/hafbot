-- hafbot:migration {"phase":"expand"}
ALTER TABLE ticket_instances ADD COLUMN opening_message_id TEXT;

CREATE TABLE ticket_claim_deliveries (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  claimed_by_user_id TEXT NOT NULL,
  claimed_at_ms INTEGER NOT NULL,
  phase TEXT NOT NULL,
  state TEXT NOT NULL,
  lease_until_ms INTEGER,
  PRIMARY KEY (guild_id, channel_id, claimed_by_user_id, claimed_at_ms, phase)
);
