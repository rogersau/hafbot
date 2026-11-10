-- hafbot:migration {"phase":"expand"}

ALTER TABLE commerce_seller_profiles
  ADD COLUMN seller_owner_user_id TEXT NOT NULL DEFAULT '';

UPDATE commerce_seller_profiles
SET seller_owner_user_id = (
  SELECT accepted_by_user_id
  FROM commerce_seller_acceptances
  WHERE connected_account_id = commerce_seller_profiles.connected_account_id
  ORDER BY accepted_at_ms ASC
  LIMIT 1
);

CREATE INDEX commerce_seller_profiles_owner
  ON commerce_seller_profiles (seller_owner_user_id, guild_id);

CREATE TABLE commerce_authority_grants (
  connected_account_id TEXT NOT NULL,
  discord_user_id TEXT NOT NULL,
  capability TEXT NOT NULL CHECK (
    capability IN (
      'commerce.read',
      'commerce.offerings.manage',
      'commerce.subscribers.manage',
      'commerce.finance.refund',
      'commerce.finance.cancel',
      'commerce.seller.manage',
      'commerce.risk.manage'
    )
  ),
  granted_by_user_id TEXT NOT NULL,
  granted_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER,
  PRIMARY KEY (connected_account_id, discord_user_id, capability)
);

CREATE INDEX commerce_authority_grants_active_user
  ON commerce_authority_grants (connected_account_id, discord_user_id, revoked_at_ms);
