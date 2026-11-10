-- hafbot:migration {"phase":"expand"}

ALTER TABLE commerce_payments
  ADD COLUMN application_fee_minor INTEGER
  CHECK (application_fee_minor IS NULL OR application_fee_minor >= 0);
ALTER TABLE commerce_payments
  ADD COLUMN stripe_fee_minor INTEGER
  CHECK (stripe_fee_minor IS NULL OR stripe_fee_minor >= 0);
ALTER TABLE commerce_payments
  ADD COLUMN stripe_fee_tax_minor INTEGER
  CHECK (stripe_fee_tax_minor IS NULL OR stripe_fee_tax_minor >= 0);

CREATE TABLE commerce_reporting_ledger (
  id TEXT PRIMARY KEY NOT NULL,
  connected_account_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  seller_country TEXT,
  buyer_id TEXT,
  transaction_type TEXT NOT NULL CHECK (
    transaction_type IN (
      'membership_payment', 'membership_refund', 'membership_dispute',
      'support_payment', 'support_refund', 'support_dispute'
    )
  ),
  source_record_id TEXT NOT NULL,
  provider_transaction_id TEXT NOT NULL,
  provider_status TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('AUD', 'USD')),
  gross_amount_minor INTEGER NOT NULL CHECK (gross_amount_minor >= 0),
  application_fee_minor INTEGER CHECK (application_fee_minor IS NULL OR application_fee_minor >= 0),
  stripe_fee_minor INTEGER CHECK (stripe_fee_minor IS NULL OR stripe_fee_minor >= 0),
  stripe_fee_tax_minor INTEGER CHECK (stripe_fee_tax_minor IS NULL OR stripe_fee_tax_minor >= 0),
  occurred_at_ms INTEGER NOT NULL,
  reporting_period TEXT NOT NULL,
  correction_of_transaction_type TEXT,
  correction_of_source_record_id TEXT,
  aud_amount_minor INTEGER CHECK (aud_amount_minor IS NULL OR aud_amount_minor >= 0),
  aud_conversion_rate TEXT,
  aud_conversion_source TEXT,
  aud_conversion_at_ms INTEGER,
  recorded_at_ms INTEGER NOT NULL,
  UNIQUE (transaction_type, connected_account_id, source_record_id),
  CHECK (
    (currency = 'AUD' AND aud_amount_minor = gross_amount_minor) OR
    (currency = 'USD' AND (
      (aud_amount_minor IS NULL AND aud_conversion_rate IS NULL
        AND aud_conversion_source IS NULL AND aud_conversion_at_ms IS NULL) OR
      (aud_amount_minor IS NOT NULL AND aud_conversion_rate IS NOT NULL
        AND aud_conversion_source IS NOT NULL AND aud_conversion_at_ms IS NOT NULL)
    ))
  )
);
CREATE INDEX commerce_reporting_ledger_period
  ON commerce_reporting_ledger (reporting_period, currency, transaction_type);
CREATE INDEX commerce_reporting_ledger_seller
  ON commerce_reporting_ledger (connected_account_id, occurred_at_ms);
CREATE INDEX commerce_reporting_ledger_buyer
  ON commerce_reporting_ledger (buyer_id, occurred_at_ms);

CREATE TRIGGER commerce_reporting_ledger_immutable_update
BEFORE UPDATE ON commerce_reporting_ledger
BEGIN
  SELECT RAISE(ABORT, 'commerce reporting ledger is immutable');
END;

CREATE TRIGGER commerce_reporting_ledger_immutable_delete
BEFORE DELETE ON commerce_reporting_ledger
BEGIN
  SELECT RAISE(ABORT, 'commerce reporting ledger is immutable');
END;
