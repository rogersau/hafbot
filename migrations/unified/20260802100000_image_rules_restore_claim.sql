-- hafbot:migration {"phase":"data","previousWorkerCompatible":true}
-- Image Rules restore claims are durable state and require an additive D1 migration.
-- The lease permits recovery after Worker interruption; provider history is checked
-- before a recovered attempt reposts an ambiguously accepted Discord message.
ALTER TABLE image_rules_mod_queue_items ADD COLUMN restore_claim_token TEXT;
ALTER TABLE image_rules_mod_queue_items ADD COLUMN restore_claim_expires_at_ms INTEGER;
ALTER TABLE image_rules_mod_queue_items ADD COLUMN restored_message_id TEXT;

CREATE INDEX image_rules_mod_queue_items_restore_claim
  ON image_rules_mod_queue_items (restore_claim_expires_at_ms);

-- Delay claim activation long enough for requests running the previous Worker version
-- to drain. The previous Worker ignores this additive app_config entry.
INSERT INTO app_config (key, value)
VALUES (
  'image_rules_restore_claims_enabled_at_ms',
  CAST((unixepoch('now') * 1000 + 300000) AS TEXT)
)
ON CONFLICT(key) DO NOTHING;
