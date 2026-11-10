-- hafbot:migration {"phase":"expand"}

CREATE TABLE commerce_connected_accounts (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  stripe_account_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'restricted', 'disconnected', 'archived')),
  country TEXT,
  default_currency TEXT CHECK (default_currency IS NULL OR default_currency IN ('AUD', 'USD')),
  charges_enabled INTEGER NOT NULL DEFAULT 0 CHECK (charges_enabled IN (0, 1)),
  payouts_enabled INTEGER NOT NULL DEFAULT 0 CHECK (payouts_enabled IN (0, 1)),
  details_submitted INTEGER NOT NULL DEFAULT 0 CHECK (details_submitted IN (0, 1)),
  provider_created_at_ms INTEGER,
  archived_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK ((status = 'archived') = (archived_at_ms IS NOT NULL))
);
CREATE UNIQUE INDEX commerce_connected_accounts_provider
  ON commerce_connected_accounts (stripe_account_id);
CREATE UNIQUE INDEX commerce_connected_accounts_current_guild
  ON commerce_connected_accounts (guild_id) WHERE status <> 'archived';
CREATE INDEX commerce_connected_accounts_guild_status
  ON commerce_connected_accounts (guild_id, status);

CREATE TABLE commerce_seller_acceptances (
  id TEXT PRIMARY KEY NOT NULL,
  connected_account_id TEXT NOT NULL,
  terms_version TEXT NOT NULL,
  accepted_by_user_id TEXT NOT NULL,
  accepted_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (connected_account_id, terms_version)
);
CREATE INDEX commerce_seller_acceptances_account_time
  ON commerce_seller_acceptances (connected_account_id, accepted_at_ms);

CREATE TABLE commerce_offerings (
  id TEXT PRIMARY KEY NOT NULL,
  connected_account_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  discord_role_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  purchase_type TEXT NOT NULL CHECK (purchase_type IN ('subscription', 'one_time')),
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'archived')),
  archived_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK ((status = 'archived') = (archived_at_ms IS NOT NULL))
);
CREATE UNIQUE INDEX commerce_offerings_active_role
  ON commerce_offerings (guild_id, discord_role_id) WHERE status = 'active';
CREATE INDEX commerce_offerings_seller_status
  ON commerce_offerings (connected_account_id, status);

CREATE TABLE commerce_prices (
  id TEXT PRIMARY KEY NOT NULL,
  connected_account_id TEXT NOT NULL,
  offering_id TEXT NOT NULL,
  stripe_product_id TEXT NOT NULL,
  stripe_price_id TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('AUD', 'USD')),
  unit_amount_minor INTEGER NOT NULL CHECK (unit_amount_minor >= 0),
  price_type TEXT NOT NULL CHECK (price_type IN ('recurring', 'one_time')),
  recurring_interval TEXT CHECK (recurring_interval IN ('month', 'year')),
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  provider_created_at_ms INTEGER,
  retired_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (connected_account_id, stripe_price_id),
  CHECK (
    (price_type = 'recurring' AND recurring_interval IS NOT NULL) OR
    (price_type = 'one_time' AND recurring_interval IS NULL)
  ),
  CHECK ((status = 'retired') = (retired_at_ms IS NOT NULL))
);
CREATE INDEX commerce_prices_offering_status ON commerce_prices (offering_id, status);

CREATE TABLE commerce_buyers (
  id TEXT PRIMARY KEY NOT NULL,
  discord_user_id TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE commerce_customers (
  id TEXT PRIMARY KEY NOT NULL,
  connected_account_id TEXT NOT NULL,
  buyer_id TEXT NOT NULL,
  stripe_customer_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (connected_account_id, buyer_id),
  UNIQUE (connected_account_id, stripe_customer_id)
);

CREATE TABLE commerce_subscriptions (
  id TEXT PRIMARY KEY NOT NULL,
  connected_account_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  buyer_id TEXT NOT NULL,
  offering_id TEXT NOT NULL,
  price_id TEXT NOT NULL,
  stripe_subscription_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('incomplete', 'trialing', 'active', 'past_due', 'paused', 'unpaid', 'canceled', 'ended')
  ),
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0, 1)),
  current_period_start_ms INTEGER,
  current_period_end_ms INTEGER,
  canceled_at_ms INTEGER,
  ended_at_ms INTEGER,
  provider_updated_at_ms INTEGER,
  latest_invoice_id TEXT,
  latest_invoice_status TEXT CHECK (
    latest_invoice_status IS NULL OR latest_invoice_status IN ('draft','open','paid','uncollectible','void')
  ),
  latest_payment_intent_id TEXT,
  latest_payment_status TEXT CHECK (
    latest_payment_status IS NULL OR latest_payment_status IN ('requires_action','processing','succeeded','failed','canceled')
  ),
  grace_started_at_ms INTEGER,
  grace_ends_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (connected_account_id, stripe_subscription_id)
);
CREATE UNIQUE INDEX commerce_subscriptions_active_buyer_offering
  ON commerce_subscriptions (connected_account_id, buyer_id, offering_id)
  WHERE status NOT IN ('canceled', 'ended');
CREATE INDEX commerce_subscriptions_customer_status
  ON commerce_subscriptions (customer_id, status);

CREATE TABLE commerce_entitlements (
  id TEXT PRIMARY KEY NOT NULL,
  connected_account_id TEXT NOT NULL,
  buyer_id TEXT NOT NULL,
  offering_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('subscription', 'payment')),
  source_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'revoked', 'expired')),
  effective_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER,
  revoked_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (connected_account_id, source_type, source_id)
);
CREATE INDEX commerce_entitlements_buyer_status
  ON commerce_entitlements (buyer_id, status);
CREATE INDEX commerce_entitlements_offering_status
  ON commerce_entitlements (offering_id, status);

CREATE TABLE commerce_role_assignments (
  id TEXT PRIMARY KEY NOT NULL,
  entitlement_id TEXT NOT NULL UNIQUE,
  guild_id TEXT NOT NULL,
  discord_user_id TEXT NOT NULL,
  discord_role_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'assigned', 'removing', 'removed', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code TEXT,
  next_attempt_at_ms INTEGER,
  assigned_at_ms INTEGER,
  removed_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX commerce_role_assignments_due
  ON commerce_role_assignments (status, next_attempt_at_ms);
CREATE INDEX commerce_role_assignments_member
  ON commerce_role_assignments (guild_id, discord_user_id);

CREATE TABLE commerce_payments (
  id TEXT PRIMARY KEY NOT NULL,
  connected_account_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  buyer_id TEXT NOT NULL,
  offering_id TEXT NOT NULL,
  price_id TEXT NOT NULL,
  stripe_payment_intent_id TEXT NOT NULL,
  stripe_charge_id TEXT,
  stripe_checkout_session_id TEXT,
  stripe_invoice_id TEXT,
  stripe_subscription_id TEXT,
  invoice_period_start_ms INTEGER,
  invoice_period_end_ms INTEGER,
  is_latest_subscription_invoice INTEGER NOT NULL DEFAULT 0 CHECK (is_latest_subscription_invoice IN (0, 1)),
  currency TEXT NOT NULL CHECK (currency IN ('AUD', 'USD')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  amount_received_minor INTEGER NOT NULL DEFAULT 0 CHECK (amount_received_minor >= 0),
  amount_refunded_minor INTEGER NOT NULL DEFAULT 0 CHECK (amount_refunded_minor >= 0),
  status TEXT NOT NULL CHECK (
    status IN ('requires_action', 'processing', 'succeeded', 'failed', 'canceled')
  ),
  provider_created_at_ms INTEGER,
  paid_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (connected_account_id, stripe_payment_intent_id),
  UNIQUE (connected_account_id, stripe_invoice_id),
  CHECK (amount_received_minor <= amount_minor),
  CHECK (amount_refunded_minor <= amount_received_minor)
);
CREATE UNIQUE INDEX commerce_payments_charge
  ON commerce_payments (connected_account_id, stripe_charge_id)
  WHERE stripe_charge_id IS NOT NULL;
CREATE UNIQUE INDEX commerce_payments_checkout
  ON commerce_payments (connected_account_id, stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;
CREATE INDEX commerce_payments_buyer_created
  ON commerce_payments (buyer_id, created_at_ms);
CREATE INDEX commerce_payments_subscription_period
  ON commerce_payments (connected_account_id, stripe_subscription_id, invoice_period_end_ms);

CREATE TABLE commerce_refunds (
  id TEXT PRIMARY KEY NOT NULL,
  connected_account_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  stripe_refund_id TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('AUD', 'USD')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  application_fee_refunded_minor INTEGER CHECK (
    application_fee_refunded_minor IS NULL OR application_fee_refunded_minor >= 0
  ),
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'canceled')),
  reason TEXT,
  provider_created_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (connected_account_id, stripe_refund_id)
);
CREATE INDEX commerce_refunds_payment ON commerce_refunds (payment_id, created_at_ms);

CREATE TABLE commerce_disputes (
  id TEXT PRIMARY KEY NOT NULL,
  connected_account_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  stripe_dispute_id TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('AUD', 'USD')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  status TEXT NOT NULL CHECK (
    status IN ('warning_needs_response', 'warning_under_review', 'warning_closed',
      'needs_response', 'under_review', 'won', 'lost')
  ),
  reason TEXT,
  provider_created_at_ms INTEGER,
  closed_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (connected_account_id, stripe_dispute_id)
);
CREATE INDEX commerce_disputes_payment ON commerce_disputes (payment_id, created_at_ms);

CREATE TABLE commerce_webhook_events (
  id TEXT PRIMARY KEY NOT NULL,
  connected_account_id TEXT NOT NULL,
  stripe_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  api_version TEXT,
  provider_created_at_ms INTEGER NOT NULL,
  received_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'processed', 'failed', 'ignored')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code TEXT,
  processed_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (connected_account_id, stripe_event_id)
);
CREATE INDEX commerce_webhook_events_pending
  ON commerce_webhook_events (status, received_at_ms);

CREATE TABLE commerce_sync_state (
  id TEXT PRIMARY KEY NOT NULL,
  connected_account_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'synced', 'failed', 'quarantined')),
  provider_updated_at_ms INTEGER,
  provider_event_id TEXT,
  last_synced_at_ms INTEGER,
  last_error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (connected_account_id, resource_type, resource_id)
);
CREATE INDEX commerce_sync_state_status ON commerce_sync_state (status, updated_at_ms);

CREATE TABLE commerce_operations_ledger (
  id TEXT PRIMARY KEY NOT NULL,
  connected_account_id TEXT,
  guild_id TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('system', 'stripe', 'buyer', 'seller', 'operator')),
  actor_id TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at_ms INTEGER NOT NULL,
  UNIQUE (guild_id, operation_key)
);
CREATE INDEX commerce_operations_ledger_entity
  ON commerce_operations_ledger (entity_type, entity_id, created_at_ms);
CREATE INDEX commerce_operations_ledger_seller_time
  ON commerce_operations_ledger (connected_account_id, created_at_ms);

CREATE TABLE commerce_delivery_outbox (
  id TEXT PRIMARY KEY NOT NULL,
  operation_id TEXT NOT NULL,
  destination_type TEXT NOT NULL CHECK (destination_type IN ('buyer_dm', 'seller_audit', 'admin_audit')),
  destination_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'delivered', 'dead_letter')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at_ms INTEGER NOT NULL,
  last_error_code TEXT,
  delivered_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (operation_id, destination_type, destination_id)
);
CREATE INDEX commerce_delivery_outbox_due
  ON commerce_delivery_outbox (status, available_at_ms, created_at_ms);

CREATE TABLE commerce_incidents (
  id TEXT PRIMARY KEY NOT NULL,
  connected_account_id TEXT,
  guild_id TEXT NOT NULL,
  incident_key TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'error', 'critical')),
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  summary_code TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  safe_args_json TEXT NOT NULL CHECK (json_valid(safe_args_json)),
  occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
  first_seen_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL,
  resolved_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (guild_id, incident_key)
);
CREATE INDEX commerce_incidents_guild_status
  ON commerce_incidents (guild_id, status, severity, last_seen_at_ms);

CREATE TRIGGER commerce_prices_economic_fields_immutable
BEFORE UPDATE OF connected_account_id, offering_id, stripe_product_id, stripe_price_id,
  currency, unit_amount_minor, price_type, recurring_interval, provider_created_at_ms, created_at_ms
ON commerce_prices
BEGIN
  SELECT RAISE(ABORT, 'commerce prices are immutable; create a new price');
END;

CREATE TRIGGER commerce_seller_acceptances_immutable_update
BEFORE UPDATE ON commerce_seller_acceptances
BEGIN
  SELECT RAISE(ABORT, 'commerce seller acceptances are immutable');
END;

CREATE TRIGGER commerce_seller_acceptances_immutable_delete
BEFORE DELETE ON commerce_seller_acceptances
BEGIN
  SELECT RAISE(ABORT, 'commerce seller acceptances are retained');
END;

CREATE TRIGGER commerce_operations_ledger_immutable_update
BEFORE UPDATE ON commerce_operations_ledger
BEGIN
  SELECT RAISE(ABORT, 'commerce operations ledger is append-only');
END;

CREATE TRIGGER commerce_operations_ledger_immutable_delete
BEFORE DELETE ON commerce_operations_ledger
BEGIN
  SELECT RAISE(ABORT, 'commerce operations ledger is retained');
END;

CREATE TRIGGER commerce_connected_accounts_retain_financial_history
BEFORE DELETE ON commerce_connected_accounts
WHEN EXISTS (
  SELECT 1 FROM commerce_payments p WHERE p.connected_account_id = OLD.id
) OR EXISTS (
  SELECT 1 FROM commerce_seller_acceptances a WHERE a.connected_account_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'archive commerce sellers with retained history');
END;

CREATE TRIGGER commerce_offerings_retain_financial_history
BEFORE DELETE ON commerce_offerings
WHEN EXISTS (
  SELECT 1 FROM commerce_payments p WHERE p.offering_id = OLD.id
) OR EXISTS (
  SELECT 1 FROM commerce_subscriptions s WHERE s.offering_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'archive commerce offerings with retained history');
END;

CREATE TRIGGER commerce_payments_retained
BEFORE DELETE ON commerce_payments
BEGIN
  SELECT RAISE(ABORT, 'commerce payments are retained');
END;

CREATE TRIGGER commerce_refunds_retained
BEFORE DELETE ON commerce_refunds
BEGIN
  SELECT RAISE(ABORT, 'commerce refunds are retained');
END;

CREATE TRIGGER commerce_disputes_retained
BEFORE DELETE ON commerce_disputes
BEGIN
  SELECT RAISE(ABORT, 'commerce disputes are retained');
END;
