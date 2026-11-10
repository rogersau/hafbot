-- PostgreSQL equivalents of the final unified D1 triggers. Event mutations
-- share an advisory transaction lock so SQLite's serialized-write assumptions
-- remain true when several PostgreSQL workers process the same event.

CREATE FUNCTION haf_reject_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = TG_ARGV[0];
END;
$$;

CREATE TRIGGER commerce_disputes_retained
BEFORE DELETE ON commerce_disputes
FOR EACH ROW EXECUTE FUNCTION haf_reject_mutation('commerce disputes are retained');

CREATE TRIGGER commerce_operations_ledger_immutable_delete
BEFORE DELETE ON commerce_operations_ledger
FOR EACH ROW EXECUTE FUNCTION haf_reject_mutation('commerce operations ledger is retained');

CREATE TRIGGER commerce_operations_ledger_immutable_update
BEFORE UPDATE ON commerce_operations_ledger
FOR EACH ROW EXECUTE FUNCTION haf_reject_mutation('commerce operations ledger is append-only');

CREATE TRIGGER commerce_payments_retained
BEFORE DELETE ON commerce_payments
FOR EACH ROW EXECUTE FUNCTION haf_reject_mutation('commerce payments are retained');

CREATE TRIGGER commerce_prices_economic_fields_immutable
BEFORE UPDATE OF connected_account_id, offering_id, stripe_product_id, stripe_price_id,
  currency, unit_amount_minor, price_type, recurring_interval, provider_created_at_ms, created_at_ms
ON commerce_prices
FOR EACH ROW EXECUTE FUNCTION haf_reject_mutation('commerce prices are immutable; create a new price');

CREATE TRIGGER commerce_refunds_retained
BEFORE DELETE ON commerce_refunds
FOR EACH ROW EXECUTE FUNCTION haf_reject_mutation('commerce refunds are retained');

CREATE TRIGGER commerce_reporting_ledger_immutable_delete
BEFORE DELETE ON commerce_reporting_ledger
FOR EACH ROW EXECUTE FUNCTION haf_reject_mutation('commerce reporting ledger is immutable');

CREATE TRIGGER commerce_reporting_ledger_immutable_update
BEFORE UPDATE ON commerce_reporting_ledger
FOR EACH ROW EXECUTE FUNCTION haf_reject_mutation('commerce reporting ledger is immutable');

CREATE TRIGGER commerce_seller_acceptances_immutable_delete
BEFORE DELETE ON commerce_seller_acceptances
FOR EACH ROW EXECUTE FUNCTION haf_reject_mutation('commerce seller acceptances are retained');

CREATE TRIGGER commerce_seller_acceptances_immutable_update
BEFORE UPDATE ON commerce_seller_acceptances
FOR EACH ROW EXECUTE FUNCTION haf_reject_mutation('commerce seller acceptances are immutable');

CREATE FUNCTION haf_retain_connected_account_history()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM commerce_payments WHERE connected_account_id = OLD.id
  ) OR EXISTS (
    SELECT 1 FROM commerce_seller_acceptances WHERE connected_account_id = OLD.id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'archive commerce sellers with retained history';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER commerce_connected_accounts_retain_financial_history
BEFORE DELETE ON commerce_connected_accounts
FOR EACH ROW EXECUTE FUNCTION haf_retain_connected_account_history();

CREATE FUNCTION haf_retain_offering_history()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM commerce_payments WHERE offering_id = OLD.id
  ) OR EXISTS (
    SELECT 1 FROM commerce_subscriptions WHERE offering_id = OLD.id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'archive commerce offerings with retained history';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER commerce_offerings_retain_financial_history
BEFORE DELETE ON commerce_offerings
FOR EACH ROW EXECUTE FUNCTION haf_retain_offering_history();

CREATE FUNCTION haf_validate_configuration_revision_head()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  current_revision TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.guild_id || ':' || NEW.feature || ':' || NEW.resource_key, 0)
  );
  SELECT current_revision_id
    INTO current_revision
    FROM configuration_revision_heads
   WHERE guild_id = NEW.guild_id
     AND feature = NEW.feature
     AND resource_key = NEW.resource_key
   FOR UPDATE;
  IF FOUND THEN
    IF NEW.previous_revision_id IS DISTINCT FROM current_revision THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'configuration revision head conflict';
    END IF;
  ELSIF NEW.previous_revision_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'configuration revision head conflict';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER configuration_revisions_validate_head
BEFORE INSERT ON configuration_revisions
FOR EACH ROW EXECUTE FUNCTION haf_validate_configuration_revision_head();

CREATE FUNCTION haf_advance_configuration_revision_head()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO configuration_revision_heads (
    guild_id, feature, resource_key, current_revision_id, updated_at_ms
  ) VALUES (
    NEW.guild_id, NEW.feature, NEW.resource_key, NEW.id, NEW.created_at_ms
  )
  ON CONFLICT (guild_id, feature, resource_key) DO UPDATE SET
    current_revision_id = EXCLUDED.current_revision_id,
    updated_at_ms = EXCLUDED.updated_at_ms;
  RETURN NEW;
END;
$$;

CREATE TRIGGER configuration_revisions_advance_head
AFTER INSERT ON configuration_revisions
FOR EACH ROW EXECUTE FUNCTION haf_advance_configuration_revision_head();

CREATE FUNCTION haf_lock_event(guild_id TEXT, event_id TEXT)
RETURNS VOID
LANGUAGE sql
AS $$
  SELECT pg_advisory_xact_lock(hashtextextended(guild_id || ':' || event_id, 0));
$$;

CREATE FUNCTION haf_guard_event_lifecycle_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM haf_lock_event(NEW.guild_id, NEW.event_id);
  IF NOT EXISTS (
    SELECT 1 FROM events
    JOIN event_team_state_versions
      ON event_team_state_versions.guild_id = events.guild_id
     AND event_team_state_versions.event_id = events.event_id
    WHERE events.guild_id = NEW.guild_id
      AND events.event_id = NEW.event_id
      AND events.status = NEW.expected_status
      AND event_team_state_versions.version = NEW.expected_state_version
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Event lifecycle state or Team roster changed concurrently';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER event_lifecycle_transition_guard
BEFORE INSERT ON event_lifecycle_transition_guards
FOR EACH ROW EXECUTE FUNCTION haf_guard_event_lifecycle_transition();

CREATE FUNCTION haf_guard_event_signup_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM haf_lock_event(NEW.guild_id, NEW.event_id);
  IF (
    NEW.operation = 'delete'
    AND EXISTS (
      SELECT 1 FROM event_team_memberships
       WHERE guild_id = NEW.guild_id AND event_id = NEW.event_id
         AND user_id = NEW.user_id AND group_id = NEW.group_id
         AND left_at_ms IS NULL
    )
  ) OR (
    NEW.operation = 'upsert'
    AND EXISTS (
      SELECT 1 FROM event_team_memberships
       WHERE guild_id = NEW.guild_id AND event_id = NEW.event_id
         AND user_id = NEW.user_id AND group_id <> NEW.group_id
         AND left_at_ms IS NULL
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Active Event Team membership requires its compatible signup';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER event_signup_mutation_guard
BEFORE INSERT ON event_signup_mutation_guards
FOR EACH ROW EXECUTE FUNCTION haf_guard_event_signup_mutation();

CREATE FUNCTION haf_guard_event_team_bulk_commit()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM haf_lock_event(NEW.guild_id, NEW.event_id);
  IF NOT EXISTS (
    SELECT 1 FROM events
    JOIN event_team_state_versions
      ON event_team_state_versions.guild_id = events.guild_id
     AND event_team_state_versions.event_id = events.event_id
    WHERE events.guild_id = NEW.guild_id
      AND events.event_id = NEW.event_id
      AND events.status NOT IN ('ended', 'cancelled', 'archived')
      AND event_team_state_versions.version = NEW.expected_state_version
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Event Team bulk state is stale or terminal';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER event_team_bulk_commit_guard
BEFORE INSERT ON event_team_bulk_commit_guards
FOR EACH ROW EXECUTE FUNCTION haf_guard_event_team_bulk_commit();

CREATE FUNCTION haf_guard_event_team_membership_group()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM haf_lock_event(NEW.guild_id, NEW.event_id);
  IF NOT EXISTS (
    SELECT 1 FROM event_teams
     WHERE guild_id = NEW.guild_id AND event_id = NEW.event_id
       AND team_id = NEW.team_id AND group_id = NEW.group_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'incompatible Event Team membership';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER event_team_memberships_group_guard
BEFORE INSERT ON event_team_memberships
FOR EACH ROW EXECUTE FUNCTION haf_guard_event_team_membership_group();

CREATE FUNCTION haf_guard_event_team_membership_signup()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM haf_lock_event(NEW.guild_id, NEW.event_id);
  IF NEW.left_at_ms IS NULL AND NOT EXISTS (
    SELECT 1 FROM event_signups
     WHERE guild_id = NEW.guild_id AND event_id = NEW.event_id
       AND user_id = NEW.user_id AND group_id = NEW.group_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Event Team membership requires a compatible signup';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER event_team_memberships_signup_guard
BEFORE INSERT ON event_team_memberships
FOR EACH ROW EXECUTE FUNCTION haf_guard_event_team_membership_signup();

CREATE FUNCTION haf_guard_event_team_membership_size()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  required_size BIGINT;
  current_size BIGINT;
BEGIN
  PERFORM haf_lock_event(NEW.guild_id, NEW.event_id);
  IF NEW.left_at_ms IS NULL THEN
    SELECT COALESCE(required_team_size, 0)
      INTO required_size
      FROM events
     WHERE guild_id = NEW.guild_id AND event_id = NEW.event_id
       AND participation_mode = 'team';
    required_size := COALESCE(required_size, 0);
    SELECT COUNT(*)
      INTO current_size
      FROM event_team_memberships
     WHERE guild_id = NEW.guild_id AND event_id = NEW.event_id
       AND team_id = NEW.team_id AND left_at_ms IS NULL;
    IF current_size >= required_size THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Event Team roster is full';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER event_team_memberships_size_guard
BEFORE INSERT ON event_team_memberships
FOR EACH ROW EXECUTE FUNCTION haf_guard_event_team_membership_size();

CREATE FUNCTION haf_guard_event_team_proposal_acceptance()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM haf_lock_event(NEW.guild_id, NEW.event_id);
  IF NOT EXISTS (
    SELECT 1 FROM event_team_proposals
     WHERE guild_id = NEW.guild_id AND event_id = NEW.event_id
       AND proposal_id = NEW.proposal_id AND status = 'pending'
       AND updated_at_ms = NEW.expected_updated_at_ms
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Event Team proposal is no longer pending at the expected version';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER event_team_proposal_acceptance_guard
BEFORE INSERT ON event_team_proposal_acceptance_guards
FOR EACH ROW EXECUTE FUNCTION haf_guard_event_team_proposal_acceptance();

CREATE FUNCTION haf_enqueue_missing_managed_message()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO managed_message_audit_outbox (
    event_key, guild_id, channel_id, message_id, internal_name,
    claimed_at_ms, delivered_at_ms, created_at_ms
  ) VALUES (
    'managed-message.deleted-out-of-band:' || NEW.guild_id || ':' || NEW.message_id,
    NEW.guild_id, NEW.channel_id, NEW.message_id, NEW.internal_name,
    NULL, NULL, NEW.updated_at_ms
  ) ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER managed_message_deleted_out_of_band_outbox
AFTER UPDATE OF status ON managed_messages
FOR EACH ROW
WHEN (OLD.status = 'published' AND NEW.status = 'missing')
EXECUTE FUNCTION haf_enqueue_missing_managed_message();
