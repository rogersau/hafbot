-- Current public schema for a new, empty PostgreSQL database.
-- No private deployment state or upgrade history is part of this installation.

CREATE FUNCTION public.enforce_server_level_server_limit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('server-level-server-limit:' || NEW.guild_id, 0)
  );
  IF (SELECT COUNT(*) FROM server_level_servers WHERE guild_id = NEW.guild_id) >= 5 THEN
    RAISE EXCEPTION 'A Guild may configure at most five Configured Game Servers.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.haf_advance_configuration_revision_head() RETURNS trigger
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

CREATE FUNCTION public.haf_enqueue_missing_managed_message() RETURNS trigger
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

CREATE FUNCTION public.haf_guard_event_lifecycle_transition() RETURNS trigger
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

CREATE FUNCTION public.haf_guard_event_signup_mutation() RETURNS trigger
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

CREATE FUNCTION public.haf_guard_event_team_bulk_commit() RETURNS trigger
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

CREATE FUNCTION public.haf_guard_event_team_membership_group() RETURNS trigger
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

CREATE FUNCTION public.haf_guard_event_team_membership_signup() RETURNS trigger
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

CREATE FUNCTION public.haf_guard_event_team_membership_size() RETURNS trigger
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

CREATE FUNCTION public.haf_guard_event_team_proposal_acceptance() RETURNS trigger
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

CREATE FUNCTION public.haf_json_valid(value text) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE STRICT
    AS $$
BEGIN
  PERFORM value::JSONB;
  RETURN TRUE;
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END;
$$;

CREATE FUNCTION public.haf_lock_event(guild_id text, event_id text) RETURNS void
    LANGUAGE sql
    AS $$
  SELECT pg_advisory_xact_lock(hashtextextended(guild_id || ':' || event_id, 0));
$$;

CREATE FUNCTION public.haf_reject_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = TG_ARGV[0];
END;
$$;

CREATE FUNCTION public.haf_retain_connected_account_history() RETURNS trigger
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

CREATE FUNCTION public.haf_retain_offering_history() RETURNS trigger
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

CREATE FUNCTION public.haf_validate_configuration_revision_head() RETURNS trigger
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

CREATE TABLE public."Account" (
    id text NOT NULL,
    "accountId" text NOT NULL,
    "providerId" text NOT NULL,
    "userId" text NOT NULL,
    "accessToken" text,
    "refreshToken" text,
    "idToken" text,
    "accessTokenExpiresAt" timestamp with time zone,
    "refreshTokenExpiresAt" timestamp with time zone,
    scope text,
    password text,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);

CREATE TABLE public."Invitation" (
    id text NOT NULL,
    "organizationId" text NOT NULL,
    email text NOT NULL,
    role text,
    status text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "inviterId" text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public."Member" (
    id text NOT NULL,
    "organizationId" text NOT NULL,
    "userId" text NOT NULL,
    role text NOT NULL,
    "createdAt" timestamp with time zone NOT NULL
);

CREATE TABLE public."Organization" (
    id text NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    logo text,
    metadata text,
    "createdAt" timestamp with time zone NOT NULL
);

CREATE TABLE public."Session" (
    id text NOT NULL,
    token text NOT NULL,
    "userId" text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "ipAddress" text,
    "userAgent" text,
    "activeOrganizationId" text,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);

CREATE TABLE public."User" (
    id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    "emailVerified" boolean NOT NULL,
    image text,
    "discordUserId" text NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);

CREATE TABLE public."Verification" (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone,
    "updatedAt" timestamp with time zone
);

CREATE TABLE public."WorkspaceEntitlement" (
    "workspaceId" text NOT NULL,
    plan text NOT NULL,
    status text NOT NULL,
    "enabledFlagsJson" text NOT NULL,
    "updatedAtMs" bigint NOT NULL
);

CREATE TABLE public."WorkspaceGuild" (
    "workspaceId" text NOT NULL,
    "guildId" text NOT NULL,
    "linkedByUserId" text NOT NULL,
    "linkedAtMs" bigint NOT NULL
);

CREATE TABLE public."WorkspaceGuildAuditEvent" (
    id text NOT NULL,
    "workspaceId" text NOT NULL,
    "guildId" text NOT NULL,
    action text NOT NULL,
    "actorUserId" text NOT NULL,
    "occurredAtMs" bigint NOT NULL,
    "previousWorkspaceId" text,
    CONSTRAINT "WorkspaceGuildAuditEvent_action_check" CHECK ((action = ANY (ARRAY['linked'::text, 'unlinked'::text])))
);

CREATE TABLE public.admin_feedback (
    id text NOT NULL,
    reference text NOT NULL,
    category text NOT NULL,
    summary text NOT NULL,
    description text NOT NULL,
    reporter_user_id text NOT NULL,
    guild_id text,
    workspace_id text,
    route text NOT NULL,
    correlation_id text,
    ray_id text,
    worker_version text NOT NULL,
    environment text NOT NULL,
    diagnostics_included bigint NOT NULL,
    browser text,
    os text,
    notification_state text DEFAULT 'pending'::text NOT NULL,
    notification_error_code text,
    created_at_ms bigint NOT NULL,
    page_label text,
    error_code text,
    CONSTRAINT admin_feedback_category_check CHECK ((category = ANY (ARRAY['problem'::text, 'suggestion'::text, 'other'::text]))),
    CONSTRAINT admin_feedback_diagnostics_included_check CHECK ((diagnostics_included = ANY (ARRAY[(0)::bigint, (1)::bigint]))),
    CONSTRAINT admin_feedback_notification_state_check CHECK ((notification_state = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text])))
);

CREATE TABLE public.app_config (
    key text NOT NULL,
    value text NOT NULL
);

CREATE TABLE public.attendance_observation_reports (
    id text NOT NULL,
    guild_id text NOT NULL,
    data text NOT NULL
);

CREATE TABLE public.attendance_observation_runs (
    id text NOT NULL,
    guild_id text NOT NULL,
    target_id text NOT NULL,
    generation integer NOT NULL,
    active_target text,
    revision integer NOT NULL,
    lease text,
    next_at_ms bigint NOT NULL,
    expires_at_ms bigint NOT NULL,
    delete_at_ms bigint NOT NULL,
    duplicates integer DEFAULT 0 NOT NULL,
    late integer DEFAULT 0 NOT NULL,
    data text NOT NULL
);

CREATE TABLE public.attendance_observation_samples (
    id text NOT NULL,
    run_id text NOT NULL,
    guild_id text NOT NULL,
    target_id text NOT NULL,
    generation integer NOT NULL,
    slot bigint NOT NULL,
    claim_token text NOT NULL,
    next_allowed_at_ms bigint NOT NULL,
    delete_at_ms bigint NOT NULL,
    data text NOT NULL
);

CREATE TABLE public.ban_case_configs (
    guild_id text NOT NULL,
    enabled bigint DEFAULT 0 NOT NULL,
    forum_channel_id text,
    mod_role_ids_json text DEFAULT '[]'::text NOT NULL,
    updated_at_ms bigint NOT NULL
);

CREATE TABLE public.ban_case_confirmations (
    id text NOT NULL,
    guild_id text NOT NULL,
    actor_id text NOT NULL,
    expires_at_ms bigint NOT NULL,
    operation_id text,
    data text NOT NULL
);

CREATE TABLE public.ban_case_operation_projections (
    id text NOT NULL,
    token text NOT NULL,
    next_at_ms bigint NOT NULL,
    delivered_revision integer NOT NULL,
    data text NOT NULL
);

CREATE TABLE public.ban_case_operational_incident_events (
    id text NOT NULL,
    incident_id text NOT NULL,
    guild_id text NOT NULL,
    event_type text NOT NULL,
    observation_id text,
    reason_code text,
    safe_args_json text NOT NULL,
    correlation_id text,
    actor_user_id text,
    created_at_ms bigint NOT NULL,
    CONSTRAINT ban_case_operational_incident_events_event_type_check CHECK ((event_type = ANY (ARRAY['opened'::text, 'observed'::text, 'severity_changed'::text, 'remediation_started'::text, 'remediation_succeeded'::text, 'remediation_failed'::text, 'resolved'::text, 'reopened'::text])))
);

CREATE TABLE public.ban_case_operational_incidents (
    id text NOT NULL,
    guild_id text NOT NULL,
    incident_key text NOT NULL,
    feature text NOT NULL,
    resource_kind text NOT NULL,
    resource_id text NOT NULL,
    condition text NOT NULL,
    severity text NOT NULL,
    status text NOT NULL,
    summary_code text NOT NULL,
    safe_args_json text NOT NULL,
    remediation_code text NOT NULL,
    first_seen_at_ms bigint NOT NULL,
    open_since_ms bigint NOT NULL,
    last_seen_at_ms bigint NOT NULL,
    resolved_at_ms bigint,
    occurrence_count bigint DEFAULT 1 NOT NULL,
    last_correlation_id text,
    version bigint DEFAULT 1 NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT ban_case_operational_incidents_feature_check CHECK ((feature = 'ban-cases'::text)),
    CONSTRAINT ban_case_operational_incidents_severity_check CHECK ((severity = ANY (ARRAY['warning'::text, 'error'::text, 'critical'::text]))),
    CONSTRAINT ban_case_operational_incidents_status_check CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text])))
);

CREATE TABLE public.ban_case_operations (
    id text NOT NULL,
    guild_id text NOT NULL,
    physical_target text NOT NULL,
    subject text NOT NULL,
    action text NOT NULL,
    active integer NOT NULL,
    revision integer NOT NULL,
    next_at_ms bigint NOT NULL,
    data text NOT NULL
);

CREATE TABLE public.ban_case_sources (
    guild_id text NOT NULL,
    source_id text NOT NULL,
    public_id text NOT NULL,
    name text NOT NULL,
    enabled bigint DEFAULT 0 NOT NULL,
    platform text NOT NULL,
    pattern text NOT NULL,
    flags text DEFAULT ''::text NOT NULL,
    subject_id_group text DEFAULT 'subjectId'::text NOT NULL,
    name_group text DEFAULT 'username'::text NOT NULL,
    reason_group text DEFAULT 'reason'::text NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL
);

CREATE TABLE public.ban_cases (
    guild_id text NOT NULL,
    case_id text NOT NULL,
    source_id text NOT NULL,
    public_id text NOT NULL,
    subject_platform text NOT NULL,
    subject_id text NOT NULL,
    username text NOT NULL,
    status text DEFAULT 'new'::text NOT NULL,
    thread_channel_id text NOT NULL,
    thread_message_id text NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL
);

CREATE TABLE public.billing_customer_bindings (
    owner_id text NOT NULL,
    stripe_customer_id text NOT NULL,
    created_at_ms bigint NOT NULL
);

CREATE TABLE public.billing_delivery_attempts (
    id text NOT NULL,
    operation_id text NOT NULL,
    destination text NOT NULL,
    outcome text NOT NULL,
    provider_correlation_id text,
    attempted_at_ms bigint NOT NULL
);

CREATE TABLE public.billing_delivery_outbox (
    operation_id text NOT NULL,
    created_at_ms bigint NOT NULL,
    sent_at_ms bigint
);

CREATE TABLE public.billing_guild_assignments (
    guild_id text NOT NULL,
    owner_id text NOT NULL,
    stripe_subscription_id text NOT NULL,
    assigned_at_ms bigint NOT NULL
);

CREATE TABLE public.billing_operation_delivery (
    operation_id text NOT NULL,
    owner_dm_status text DEFAULT 'pending'::text NOT NULL,
    audit_status text DEFAULT 'pending'::text NOT NULL,
    next_attempt_at_ms bigint,
    terminal_reason text,
    updated_at_ms bigint NOT NULL,
    owner_dm_message_id text,
    audit_message_id text,
    owner_attempt_count bigint DEFAULT 0 NOT NULL
);

CREATE TABLE public.billing_operations_ledger (
    id text NOT NULL,
    owner_id text NOT NULL,
    kind text NOT NULL,
    source text NOT NULL,
    correlation_id text,
    summary_json text NOT NULL,
    created_at_ms bigint NOT NULL
);

CREATE TABLE public.billing_owner_sync_state (
    owner_id text NOT NULL,
    generation bigint DEFAULT 0 NOT NULL,
    lease_until_ms bigint,
    completed_generation bigint DEFAULT 0 NOT NULL,
    updated_at_ms bigint NOT NULL
);

CREATE TABLE public.billing_reconciliation_failures (
    owner_id text NOT NULL,
    reason text NOT NULL,
    attempt_count bigint DEFAULT 1 NOT NULL,
    first_failed_at_ms bigint NOT NULL,
    last_failed_at_ms bigint NOT NULL,
    terminal_at_ms bigint
);

CREATE TABLE public.billing_subscriptions (
    owner_id text NOT NULL,
    stripe_customer_id text NOT NULL,
    stripe_subscription_id text,
    stripe_price_id text,
    stripe_product_id text,
    plan text NOT NULL,
    frequency text,
    status text NOT NULL,
    current_period_start_ms bigint,
    current_period_end_ms bigint,
    cancel_at_period_end bigint DEFAULT 0 NOT NULL,
    cancelled_at_ms bigint,
    latest_invoice_id text,
    schedule_id text,
    observed_at_ms bigint NOT NULL,
    quarantine_reason text,
    grace_started_at_ms bigint,
    grace_ends_at_ms bigint,
    grace_expired_at_ms bigint,
    CONSTRAINT billing_subscriptions_frequency_check CHECK (((frequency IS NULL) OR (frequency = ANY (ARRAY['monthly'::text, 'yearly'::text])))),
    CONSTRAINT billing_subscriptions_plan_check CHECK ((plan = ANY (ARRAY['free'::text, 'premium'::text, 'premium_plus'::text])))
);

CREATE TABLE public.billing_support_cases (
    id text NOT NULL,
    owner_id text NOT NULL,
    kind text NOT NULL,
    status text NOT NULL,
    safe_provider_ids_json text DEFAULT '[]'::text NOT NULL,
    opened_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    resolved_at_ms bigint
);

CREATE TABLE public.billing_sync_outbox (
    event_id text NOT NULL,
    stripe_customer_id text NOT NULL,
    created_at_ms bigint NOT NULL,
    sent_at_ms bigint
);

CREATE TABLE public.billing_tester_cutovers (
    owner_id text NOT NULL,
    status text NOT NULL,
    inventory_json text NOT NULL,
    promotion_code_id text,
    deadline_ms bigint NOT NULL,
    rolled_back_at_ms bigint,
    completed_at_ms bigint,
    updated_at_ms bigint NOT NULL
);

CREATE TABLE public.billing_webhook_events (
    event_id text NOT NULL,
    event_type text NOT NULL,
    object_id text,
    stripe_customer_id text NOT NULL,
    stripe_created_at_ms bigint NOT NULL,
    payload_hash text NOT NULL,
    received_at_ms bigint NOT NULL,
    processing_status text NOT NULL,
    processed_at_ms bigint,
    terminal_reason text,
    CONSTRAINT billing_webhook_events_processing_status_check CHECK ((processing_status = ANY (ARRAY['pending'::text, 'processed'::text, 'terminal'::text])))
);

CREATE TABLE public.bot_defense_configs (
    guild_id text NOT NULL,
    honeypot_enabled bigint DEFAULT 0 NOT NULL,
    rate_enabled bigint DEFAULT 0 NOT NULL,
    honeypot_channel_ids_json text DEFAULT '[]'::text NOT NULL,
    rate_channel_threshold bigint DEFAULT 5 NOT NULL,
    rate_window_seconds bigint DEFAULT 60 NOT NULL,
    excluded_role_ids_json text DEFAULT '[]'::text NOT NULL,
    mod_role_ids_json text DEFAULT '[]'::text NOT NULL,
    mod_queue_channel_id text,
    ping_on_queue_post bigint DEFAULT 1 NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    honeypot_warn_user bigint DEFAULT 0 NOT NULL,
    honeypot_delete_message bigint DEFAULT 0 NOT NULL,
    rate_warn_user bigint DEFAULT 0 NOT NULL,
    rate_delete_message bigint DEFAULT 0 NOT NULL
);

CREATE TABLE public.bot_defense_rate_window_events (
    id bigint NOT NULL,
    guild_id text NOT NULL,
    user_id text NOT NULL,
    channel_id text NOT NULL,
    message_timestamp_ms bigint NOT NULL,
    message_fingerprint text DEFAULT ''::text NOT NULL
);

CREATE SEQUENCE public.bot_defense_rate_window_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.bot_defense_rate_window_events_id_seq OWNED BY public.bot_defense_rate_window_events.id;

CREATE TABLE public.bot_flags (
    guild_id text NOT NULL,
    user_id text NOT NULL,
    status text NOT NULL,
    detector_type text NOT NULL,
    evidence_json text NOT NULL,
    queue_message_id text,
    resolved_by_discord_user_id text,
    resolved_at_ms bigint,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL
);

CREATE TABLE public.clan_applications (
    id text NOT NULL,
    clan_id text NOT NULL,
    guild_id text NOT NULL,
    applicant_id text NOT NULL,
    message text NOT NULL,
    experience text,
    availability text,
    play_style text,
    status text NOT NULL,
    decided_by_user_id text,
    decision_reason text,
    expires_at_ms bigint NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT clan_applications_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepting'::text, 'accepted'::text, 'rejected'::text, 'expired'::text, 'cancelled'::text])))
);

CREATE TABLE public.clan_change_requests (
    id text NOT NULL,
    clan_id text NOT NULL,
    guild_id text NOT NULL,
    kind text NOT NULL,
    status text NOT NULL,
    payload_json text NOT NULL,
    requested_by_user_id text NOT NULL,
    reviewed_by_user_id text,
    review_reason text,
    revision bigint DEFAULT 1 NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    retention_expires_at_ms bigint,
    CONSTRAINT clan_change_requests_kind_check CHECK ((kind = ANY (ARRAY['identity'::text, 'deletion'::text, 'restoration'::text, 'owner-recovery'::text]))),
    CONSTRAINT clan_change_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'cancelled'::text])))
);

CREATE TABLE public.clan_history (
    id text NOT NULL,
    guild_id text NOT NULL,
    clan_id text,
    request_id text,
    event text NOT NULL,
    actor_user_id text NOT NULL,
    reason text,
    before_json text,
    after_json text,
    created_at_ms bigint NOT NULL,
    retention_expires_at_ms bigint NOT NULL
);

CREATE TABLE public.clan_invitations (
    id text NOT NULL,
    clan_id text NOT NULL,
    guild_id text NOT NULL,
    invitee_id text NOT NULL,
    invited_by_user_id text NOT NULL,
    intended_rank text NOT NULL,
    status text NOT NULL,
    expires_at_ms bigint NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT clan_invitations_intended_rank_check CHECK ((intended_rank = ANY (ARRAY['officer'::text, 'member'::text]))),
    CONSTRAINT clan_invitations_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepting'::text, 'accepted'::text, 'rejected'::text, 'expired'::text, 'cancelled'::text])))
);

CREATE TABLE public.clan_management_configs (
    guild_id text NOT NULL,
    enabled bigint DEFAULT 1 NOT NULL,
    reviewer_role_ids_json text DEFAULT '[]'::text NOT NULL,
    staff_access_role_ids_json text DEFAULT '[]'::text NOT NULL,
    eligibility_allowed_role_ids_json text DEFAULT '[]'::text NOT NULL,
    eligibility_required_role_ids_json text DEFAULT '[]'::text NOT NULL,
    minimum_account_age_days bigint DEFAULT 0 NOT NULL,
    minimum_guild_tenure_days bigint DEFAULT 0 NOT NULL,
    request_cooldown_days bigint DEFAULT 7 NOT NULL,
    invitation_expiry_days bigint DEFAULT 7 NOT NULL,
    application_expiry_days bigint DEFAULT 7 NOT NULL,
    local_clans_max bigint,
    local_members_max bigint,
    local_officers_max bigint,
    category_id text,
    request_panel_channel_id text,
    request_panel_message_id text,
    board_enabled bigint DEFAULT 0 NOT NULL,
    board_channel_id text,
    board_channel_type text,
    role_name_template text DEFAULT '[{tag}] {name}'::text NOT NULL,
    text_channel_name_template text DEFAULT '{tag}-chat'::text NOT NULL,
    voice_channel_name_template text DEFAULT '{tag} Voice'::text NOT NULL,
    inactivity_enabled bigint DEFAULT 0 NOT NULL,
    inactivity_warning_days bigint DEFAULT 60 NOT NULL,
    inactivity_archive_days bigint DEFAULT 90 NOT NULL,
    public_lfg_attribution_enabled bigint DEFAULT 1 NOT NULL,
    updated_at_ms bigint NOT NULL,
    request_review_category_id text,
    request_panel_title text DEFAULT 'Create a Clan'::text NOT NULL,
    request_panel_description text DEFAULT 'Submit a Clan creation request for staff review. A private review ticket will be created for you and the Clan review team.'::text NOT NULL,
    request_panel_button_label text DEFAULT 'Create Clan'::text NOT NULL,
    request_panel_color bigint DEFAULT 5793266 NOT NULL,
    CONSTRAINT clan_management_configs_application_expiry_days_check CHECK ((application_expiry_days > 0)),
    CONSTRAINT clan_management_configs_board_channel_type_check CHECK (((board_channel_type IS NULL) OR (board_channel_type = ANY (ARRAY['forum'::text, 'text'::text])))),
    CONSTRAINT clan_management_configs_board_enabled_check CHECK ((board_enabled = ANY (ARRAY[(0)::bigint, (1)::bigint]))),
    CONSTRAINT clan_management_configs_check CHECK ((inactivity_archive_days > inactivity_warning_days)),
    CONSTRAINT clan_management_configs_enabled_check CHECK ((enabled = ANY (ARRAY[(0)::bigint, (1)::bigint]))),
    CONSTRAINT clan_management_configs_inactivity_enabled_check CHECK ((inactivity_enabled = ANY (ARRAY[(0)::bigint, (1)::bigint]))),
    CONSTRAINT clan_management_configs_inactivity_warning_days_check CHECK ((inactivity_warning_days > 0)),
    CONSTRAINT clan_management_configs_invitation_expiry_days_check CHECK ((invitation_expiry_days > 0)),
    CONSTRAINT clan_management_configs_local_clans_max_check CHECK (((local_clans_max IS NULL) OR (local_clans_max > 0))),
    CONSTRAINT clan_management_configs_local_members_max_check CHECK (((local_members_max IS NULL) OR (local_members_max > 0))),
    CONSTRAINT clan_management_configs_local_officers_max_check CHECK (((local_officers_max IS NULL) OR (local_officers_max >= 0))),
    CONSTRAINT clan_management_configs_minimum_account_age_days_check CHECK ((minimum_account_age_days >= 0)),
    CONSTRAINT clan_management_configs_minimum_guild_tenure_days_check CHECK ((minimum_guild_tenure_days >= 0)),
    CONSTRAINT clan_management_configs_public_lfg_attribution_enabled_check CHECK ((public_lfg_attribution_enabled = ANY (ARRAY[(0)::bigint, (1)::bigint]))),
    CONSTRAINT clan_management_configs_request_cooldown_days_check CHECK ((request_cooldown_days >= 0)),
    CONSTRAINT clan_management_configs_request_panel_color_check CHECK (((request_panel_color >= 0) AND (request_panel_color <= 16777215)))
);

CREATE TABLE public.clan_membership_blocks (
    id text NOT NULL,
    clan_id text NOT NULL,
    guild_id text NOT NULL,
    user_id text NOT NULL,
    reason text NOT NULL,
    created_by_user_id text NOT NULL,
    created_at_ms bigint NOT NULL,
    expires_at_ms bigint NOT NULL,
    lifted_at_ms bigint,
    lifted_by_user_id text
);

CREATE TABLE public.clan_memberships (
    clan_id text NOT NULL,
    guild_id text NOT NULL,
    user_id text NOT NULL,
    rank text NOT NULL,
    joined_at_ms bigint NOT NULL,
    left_at_ms bigint,
    CONSTRAINT clan_memberships_rank_check CHECK ((rank = ANY (ARRAY['owner'::text, 'officer'::text, 'member'::text])))
);

CREATE TABLE public.clan_ownership_transfers (
    id text NOT NULL,
    clan_id text NOT NULL,
    guild_id text NOT NULL,
    from_user_id text NOT NULL,
    to_user_id text NOT NULL,
    status text NOT NULL,
    created_at_ms bigint NOT NULL,
    expires_at_ms bigint NOT NULL,
    resolved_at_ms bigint,
    CONSTRAINT clan_ownership_transfers_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'cancelled'::text, 'expired'::text])))
);

CREATE TABLE public.clan_requests (
    id text NOT NULL,
    guild_id text NOT NULL,
    requester_id text NOT NULL,
    name text NOT NULL,
    normalized_name text NOT NULL,
    tag text NOT NULL,
    normalized_tag text NOT NULL,
    description text NOT NULL,
    focus text NOT NULL,
    recruitment_state text NOT NULL,
    proposed_officer_ids_json text DEFAULT '[]'::text NOT NULL,
    status text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    reviewer_id text,
    review_reason text,
    clan_id text,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    terminal_at_ms bigint,
    retention_expires_at_ms bigint,
    review_channel_id text,
    review_message_id text,
    review_ticket_state text DEFAULT 'pending'::text NOT NULL,
    review_ticket_error text,
    CONSTRAINT clan_requests_recruitment_state_check CHECK ((recruitment_state = ANY (ARRAY['applications-open'::text, 'invite-only'::text, 'closed'::text]))),
    CONSTRAINT clan_requests_review_ticket_state_check CHECK ((review_ticket_state = ANY (ARRAY['pending'::text, 'creating'::text, 'open'::text, 'decision-pending'::text, 'closed'::text]))),
    CONSTRAINT clan_requests_revision_check CHECK ((revision > 0)),
    CONSTRAINT clan_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'changes-requested'::text, 'approved'::text, 'rejected'::text, 'cancelled'::text])))
);

CREATE TABLE public.clans (
    id text NOT NULL,
    guild_id text NOT NULL,
    request_id text NOT NULL,
    name text NOT NULL,
    normalized_name text NOT NULL,
    tag text NOT NULL,
    normalized_tag text NOT NULL,
    description text NOT NULL,
    focus text NOT NULL,
    icon text,
    recruitment_state text NOT NULL,
    lifecycle_state text NOT NULL,
    role_id text,
    text_channel_id text,
    voice_channel_id text,
    board_projection_id text,
    board_projection_channel_id text,
    operation text,
    degraded_reason text,
    sensitive_management_frozen bigint DEFAULT 0 NOT NULL,
    clan_lfg_leadership_only bigint DEFAULT 0 NOT NULL,
    latest_activity_at_ms bigint,
    latest_activity_type text,
    inactivity_warned_at_ms bigint,
    deletion_due_at_ms bigint,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    permanently_deleted_at_ms bigint,
    CONSTRAINT clans_clan_lfg_leadership_only_check CHECK ((clan_lfg_leadership_only = ANY (ARRAY[(0)::bigint, (1)::bigint]))),
    CONSTRAINT clans_latest_activity_type_check CHECK (((latest_activity_type IS NULL) OR (latest_activity_type = ANY (ARRAY['text'::text, 'voice'::text, 'clan-lfg'::text, 'membership'::text, 'management'::text])))),
    CONSTRAINT clans_lifecycle_state_check CHECK ((lifecycle_state = ANY (ARRAY['provisioning'::text, 'active'::text, 'degraded'::text, 'archived'::text, 'deletion-recovery'::text, 'plan-dormant'::text, 'permanently-deleted'::text]))),
    CONSTRAINT clans_recruitment_state_check CHECK ((recruitment_state = ANY (ARRAY['applications-open'::text, 'invite-only'::text, 'closed'::text]))),
    CONSTRAINT clans_sensitive_management_frozen_check CHECK ((sensitive_management_frozen = ANY (ARRAY[(0)::bigint, (1)::bigint])))
);

CREATE TABLE public.commerce_authority_grants (
    connected_account_id text NOT NULL,
    discord_user_id text NOT NULL,
    capability text NOT NULL,
    granted_by_user_id text NOT NULL,
    granted_at_ms bigint NOT NULL,
    revoked_at_ms bigint,
    CONSTRAINT commerce_authority_grants_capability_check CHECK ((capability = ANY (ARRAY['commerce.read'::text, 'commerce.offerings.manage'::text, 'commerce.subscribers.manage'::text, 'commerce.finance.refund'::text, 'commerce.finance.cancel'::text, 'commerce.seller.manage'::text, 'commerce.risk.manage'::text])))
);

CREATE TABLE public.commerce_buyers (
    id text NOT NULL,
    discord_user_id text NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL
);

CREATE TABLE public.commerce_checkout_attempts (
    id text NOT NULL,
    connected_account_id text NOT NULL,
    guild_id text NOT NULL,
    offering_id text NOT NULL,
    price_id text NOT NULL,
    buyer_id text NOT NULL,
    stripe_checkout_session_id text,
    status text NOT NULL,
    expires_at_ms bigint NOT NULL,
    returned_at_ms bigint,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    provider_terminal_at_ms bigint,
    pre_session_failed_at_ms bigint,
    CONSTRAINT commerce_checkout_attempts_status_check CHECK ((status = ANY (ARRAY['creating'::text, 'open'::text, 'returned'::text, 'expired'::text, 'failed'::text])))
);

CREATE TABLE public.commerce_checkout_capacity_claims (
    id text NOT NULL,
    checkout_kind text NOT NULL,
    connected_account_id text NOT NULL,
    guild_id text NOT NULL,
    offering_id text,
    currency text NOT NULL,
    amount_minor bigint NOT NULL,
    month_started_at_ms bigint NOT NULL,
    expires_at_ms bigint NOT NULL,
    created_at_ms bigint NOT NULL,
    CONSTRAINT commerce_checkout_capacity_claims_checkout_kind_check CHECK ((checkout_kind = ANY (ARRAY['subscription'::text, 'support'::text]))),
    CONSTRAINT commerce_checkout_capacity_claims_currency_check CHECK ((currency = ANY (ARRAY['AUD'::text, 'USD'::text])))
);

CREATE TABLE public.commerce_checkout_rate_limits (
    buyer_id text NOT NULL,
    offering_id text NOT NULL,
    window_started_at_ms bigint NOT NULL,
    attempt_count bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT commerce_checkout_rate_limits_attempt_count_check CHECK ((attempt_count >= 0))
);

CREATE TABLE public.commerce_connected_accounts (
    id text NOT NULL,
    guild_id text NOT NULL,
    stripe_account_id text NOT NULL,
    status text NOT NULL,
    country text,
    default_currency text,
    charges_enabled bigint DEFAULT 0 NOT NULL,
    payouts_enabled bigint DEFAULT 0 NOT NULL,
    details_submitted bigint DEFAULT 0 NOT NULL,
    provider_created_at_ms bigint,
    archived_at_ms bigint,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT commerce_connected_accounts_charges_enabled_check CHECK ((charges_enabled = ANY (ARRAY[(0)::bigint, (1)::bigint]))),
    CONSTRAINT commerce_connected_accounts_check CHECK (((status = 'archived'::text) = (archived_at_ms IS NOT NULL))),
    CONSTRAINT commerce_connected_accounts_default_currency_check CHECK (((default_currency IS NULL) OR (default_currency = ANY (ARRAY['AUD'::text, 'USD'::text])))),
    CONSTRAINT commerce_connected_accounts_details_submitted_check CHECK ((details_submitted = ANY (ARRAY[(0)::bigint, (1)::bigint]))),
    CONSTRAINT commerce_connected_accounts_payouts_enabled_check CHECK ((payouts_enabled = ANY (ARRAY[(0)::bigint, (1)::bigint]))),
    CONSTRAINT commerce_connected_accounts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'restricted'::text, 'disconnected'::text, 'archived'::text])))
);

CREATE TABLE public.commerce_customers (
    id text NOT NULL,
    connected_account_id text NOT NULL,
    buyer_id text NOT NULL,
    stripe_customer_id text NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL
);

CREATE TABLE public.commerce_delivery_outbox (
    id text NOT NULL,
    operation_id text NOT NULL,
    destination_type text NOT NULL,
    destination_id text NOT NULL,
    payload_json text NOT NULL,
    status text NOT NULL,
    attempt_count bigint DEFAULT 0 NOT NULL,
    available_at_ms bigint NOT NULL,
    last_error_code text,
    delivered_at_ms bigint,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT commerce_delivery_outbox_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT commerce_delivery_outbox_destination_type_check CHECK ((destination_type = ANY (ARRAY['buyer_dm'::text, 'seller_audit'::text, 'admin_audit'::text]))),
    CONSTRAINT commerce_delivery_outbox_payload_json_check CHECK (public.haf_json_valid(payload_json)),
    CONSTRAINT commerce_delivery_outbox_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'delivered'::text, 'dead_letter'::text])))
);

CREATE TABLE public.commerce_disputes (
    id text NOT NULL,
    connected_account_id text NOT NULL,
    payment_id text NOT NULL,
    stripe_dispute_id text NOT NULL,
    currency text NOT NULL,
    amount_minor bigint NOT NULL,
    status text NOT NULL,
    reason text,
    provider_created_at_ms bigint,
    closed_at_ms bigint,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT commerce_disputes_amount_minor_check CHECK ((amount_minor >= 0)),
    CONSTRAINT commerce_disputes_currency_check CHECK ((currency = ANY (ARRAY['AUD'::text, 'USD'::text]))),
    CONSTRAINT commerce_disputes_status_check CHECK ((status = ANY (ARRAY['warning_needs_response'::text, 'warning_under_review'::text, 'warning_closed'::text, 'needs_response'::text, 'under_review'::text, 'won'::text, 'lost'::text])))
);

CREATE TABLE public.commerce_entitlements (
    id text NOT NULL,
    connected_account_id text NOT NULL,
    buyer_id text NOT NULL,
    offering_id text NOT NULL,
    source_type text NOT NULL,
    source_id text NOT NULL,
    status text NOT NULL,
    effective_at_ms bigint NOT NULL,
    expires_at_ms bigint,
    revoked_at_ms bigint,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT commerce_entitlements_source_type_check CHECK ((source_type = ANY (ARRAY['subscription'::text, 'payment'::text]))),
    CONSTRAINT commerce_entitlements_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'revoked'::text, 'expired'::text])))
);

CREATE TABLE public.commerce_financial_actions (
    id text NOT NULL,
    connected_account_id text NOT NULL,
    guild_id text NOT NULL,
    action_type text NOT NULL,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    actor_user_id text NOT NULL,
    reason_code text NOT NULL,
    amount_minor bigint,
    currency text,
    status text NOT NULL,
    provider_result_id text,
    access_action text,
    attempt_count bigint DEFAULT 1 NOT NULL,
    last_error_code text,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    completed_at_ms bigint,
    lease_token text,
    claimed_at_ms bigint,
    lease_expires_at_ms bigint,
    available_at_ms bigint DEFAULT 0 NOT NULL,
    provider_completed_at_ms bigint,
    reconciliation_requested_at_ms bigint,
    quarantined_at_ms bigint,
    CONSTRAINT commerce_financial_actions_status_check CHECK ((status = ANY (ARRAY['processing'::text, 'completed'::text, 'failed'::text])))
);

CREATE TABLE public.commerce_financial_provider_actions (
    id text NOT NULL,
    operation_key text NOT NULL,
    parent_action_id text NOT NULL,
    workflow_type text NOT NULL,
    workflow_id text NOT NULL,
    connected_account_id text NOT NULL,
    guild_id text NOT NULL,
    offering_id text,
    subscription_id text NOT NULL,
    stripe_subscription_id text NOT NULL,
    action_type text NOT NULL,
    reason_code text NOT NULL,
    status text NOT NULL,
    attempt_count bigint DEFAULT 0 NOT NULL,
    available_at_ms bigint NOT NULL,
    lease_token text,
    claimed_at_ms bigint,
    lease_expires_at_ms bigint,
    provider_completed_at_ms bigint,
    reconciliation_requested_at_ms bigint,
    completed_at_ms bigint,
    last_error_code text,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT commerce_financial_provider_actions_action_type_check CHECK ((action_type = ANY (ARRAY['subscription.cancel_at_period_end'::text, 'subscription.cancel_immediately'::text]))),
    CONSTRAINT commerce_financial_provider_actions_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT commerce_financial_provider_actions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text, 'failed'::text, 'quarantined'::text]))),
    CONSTRAINT commerce_financial_provider_actions_workflow_type_check CHECK ((workflow_type = ANY (ARRAY['offering_retirement'::text, 'seller_offboarding'::text, 'renewal_shutdown'::text, 'refund_followup'::text])))
);

CREATE TABLE public.commerce_game_assignments (
    id text NOT NULL,
    guild_id text NOT NULL,
    user_id text NOT NULL,
    physical_target text NOT NULL,
    subject text NOT NULL,
    slot integer,
    generation integer NOT NULL,
    revision integer NOT NULL,
    next_at_ms bigint NOT NULL,
    data text NOT NULL
);

CREATE TABLE public.commerce_game_audit (
    id text NOT NULL,
    guild_id text NOT NULL,
    created_at_ms bigint NOT NULL,
    data text NOT NULL
);

CREATE TABLE public.commerce_game_fulfillments (
    offering_id text NOT NULL,
    guild_id text NOT NULL,
    target_id text NOT NULL,
    physical_target text NOT NULL,
    origin text NOT NULL,
    data text NOT NULL
);

CREATE TABLE public.commerce_game_selections (
    checkout_id text NOT NULL,
    offering_id text NOT NULL,
    buyer_id text NOT NULL,
    assignment_id text NOT NULL,
    data text NOT NULL
);

CREATE TABLE public.commerce_guild_deletion_refund_reviews (
    id text NOT NULL,
    guild_id text NOT NULL,
    connected_account_id text NOT NULL,
    subscription_id text NOT NULL,
    buyer_id text NOT NULL,
    payment_id text,
    payment_paid_at_ms bigint,
    paid_through_at_ms bigint,
    status text NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT commerce_guild_deletion_refund_reviews_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'reviewed'::text, 'waived'::text])))
);

CREATE TABLE public.commerce_incidents (
    id text NOT NULL,
    connected_account_id text,
    guild_id text NOT NULL,
    incident_key text NOT NULL,
    severity text NOT NULL,
    status text NOT NULL,
    summary_code text NOT NULL,
    entity_type text,
    entity_id text,
    safe_args_json text NOT NULL,
    occurrence_count bigint DEFAULT 1 NOT NULL,
    first_seen_at_ms bigint NOT NULL,
    last_seen_at_ms bigint NOT NULL,
    resolved_at_ms bigint,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT commerce_incidents_occurrence_count_check CHECK ((occurrence_count > 0)),
    CONSTRAINT commerce_incidents_safe_args_json_check CHECK (public.haf_json_valid(safe_args_json)),
    CONSTRAINT commerce_incidents_severity_check CHECK ((severity = ANY (ARRAY['warning'::text, 'error'::text, 'critical'::text]))),
    CONSTRAINT commerce_incidents_status_check CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text])))
);

CREATE TABLE public.commerce_limit_alerts (
    id text NOT NULL,
    connected_account_id text NOT NULL,
    guild_id text NOT NULL,
    metric text NOT NULL,
    currency text,
    threshold_percent bigint NOT NULL,
    observed_value bigint NOT NULL,
    limit_value bigint NOT NULL,
    status text NOT NULL,
    first_seen_at_ms bigint NOT NULL,
    last_seen_at_ms bigint NOT NULL,
    resolved_at_ms bigint,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT commerce_limit_alerts_status_check CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text])))
);

CREATE TABLE public.commerce_offering_retirements (
    id text NOT NULL,
    connected_account_id text NOT NULL,
    guild_id text NOT NULL,
    offering_id text NOT NULL,
    requested_by_user_id text NOT NULL,
    reason_code text NOT NULL,
    status text NOT NULL,
    active_subscription_count bigint DEFAULT 0 NOT NULL,
    scheduled_cancellation_count bigint DEFAULT 0 NOT NULL,
    failed_cancellation_count bigint DEFAULT 0 NOT NULL,
    latest_period_end_ms bigint,
    last_error_code text,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    completed_at_ms bigint,
    CONSTRAINT commerce_offering_retirements_status_check CHECK ((status = ANY (ARRAY['requested'::text, 'stopping_sales'::text, 'scheduling_cancellations'::text, 'waiting_for_period_end'::text, 'complete'::text, 'failed'::text])))
);

CREATE TABLE public.commerce_offerings (
    id text NOT NULL,
    connected_account_id text NOT NULL,
    guild_id text NOT NULL,
    discord_role_id text NOT NULL,
    name text NOT NULL,
    description text,
    purchase_type text NOT NULL,
    state text NOT NULL,
    terms_version text,
    included_benefits_json text DEFAULT '[]'::text NOT NULL,
    support_contact text,
    role_manageable bigint DEFAULT 0 NOT NULL,
    repair_deadline_at_ms bigint,
    repair_previous_state text,
    retire_at_ms bigint,
    published_at_ms bigint,
    archived_at_ms bigint,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT commerce_offerings_archived_check CHECK (((state = 'archived'::text) = (archived_at_ms IS NOT NULL))),
    CONSTRAINT commerce_offerings_included_benefits_json_check CHECK (public.haf_json_valid(included_benefits_json)),
    CONSTRAINT commerce_offerings_purchase_type_check CHECK ((purchase_type = ANY (ARRAY['subscription'::text, 'one_time'::text]))),
    CONSTRAINT commerce_offerings_repair_previous_state_check CHECK (((repair_previous_state IS NULL) OR (repair_previous_state = ANY (ARRAY['draft'::text, 'published'::text, 'unpublished'::text, 'retiring'::text, 'suspended'::text])))),
    CONSTRAINT commerce_offerings_repair_state_check CHECK (((state = 'repair_required'::text) = (repair_previous_state IS NOT NULL))),
    CONSTRAINT commerce_offerings_retiring_check CHECK (((state <> 'retiring'::text) OR (retire_at_ms IS NOT NULL))),
    CONSTRAINT commerce_offerings_role_manageable_check CHECK ((role_manageable = ANY (ARRAY[(0)::bigint, (1)::bigint]))),
    CONSTRAINT commerce_offerings_state_check CHECK ((state = ANY (ARRAY['draft'::text, 'published'::text, 'unpublished'::text, 'repair_required'::text, 'retiring'::text, 'archived'::text, 'suspended'::text])))
);

CREATE TABLE public.commerce_operational_controls (
    id text NOT NULL,
    scope_type text NOT NULL,
    scope_id text NOT NULL,
    control_type text NOT NULL,
    enabled bigint DEFAULT 0 NOT NULL,
    reason_code text,
    actor_user_id text NOT NULL,
    expires_at_ms bigint,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT commerce_operational_controls_control_type_check CHECK ((control_type = ANY (ARRAY['commerce_kill'::text, 'new_checkout'::text, 'sales_suspension'::text, 'offering_suspension'::text, 'renewal_shutdown'::text, 'support_shutdown'::text, 'webhook_quarantine'::text]))),
    CONSTRAINT commerce_operational_controls_enabled_check CHECK ((enabled = ANY (ARRAY[(0)::bigint, (1)::bigint]))),
    CONSTRAINT commerce_operational_controls_scope_type_check CHECK ((scope_type = ANY (ARRAY['global'::text, 'guild'::text, 'seller'::text, 'offering'::text])))
);

CREATE TABLE public.commerce_operations_ledger (
    id text NOT NULL,
    connected_account_id text,
    guild_id text NOT NULL,
    operation_key text NOT NULL,
    operation_type text NOT NULL,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    actor_type text NOT NULL,
    actor_id text,
    payload_json text NOT NULL,
    created_at_ms bigint NOT NULL,
    CONSTRAINT commerce_operations_ledger_actor_type_check CHECK ((actor_type = ANY (ARRAY['system'::text, 'stripe'::text, 'buyer'::text, 'seller'::text, 'operator'::text]))),
    CONSTRAINT commerce_operations_ledger_payload_json_check CHECK (public.haf_json_valid(payload_json))
);

CREATE TABLE public.commerce_paid_role_operations (
    operation_key text NOT NULL,
    entitlement_id text NOT NULL,
    operation_type text NOT NULL,
    status text NOT NULL,
    created_at_ms bigint NOT NULL,
    claimed_at_ms bigint NOT NULL,
    lease_expires_at_ms bigint NOT NULL,
    committed_at_ms bigint,
    CONSTRAINT commerce_paid_role_operations_check CHECK ((((status = 'processing'::text) AND (committed_at_ms IS NULL)) OR ((status = 'committed'::text) AND (committed_at_ms IS NOT NULL)))),
    CONSTRAINT commerce_paid_role_operations_status_check CHECK ((status = ANY (ARRAY['processing'::text, 'committed'::text])))
);

CREATE TABLE public.commerce_paid_role_outbox (
    id text NOT NULL,
    operation_key text NOT NULL,
    entitlement_id text NOT NULL,
    guild_id text NOT NULL,
    discord_user_id text NOT NULL,
    discord_role_id text NOT NULL,
    action text NOT NULL,
    payload_json text NOT NULL,
    status text NOT NULL,
    available_at_ms bigint NOT NULL,
    sent_at_ms bigint,
    attempt_count bigint DEFAULT 0 NOT NULL,
    last_error_code text,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT commerce_paid_role_outbox_action_check CHECK ((action = ANY (ARRAY['assign'::text, 'remove'::text, 'repair'::text]))),
    CONSTRAINT commerce_paid_role_outbox_check CHECK ((((status = 'pending'::text) AND (sent_at_ms IS NULL)) OR (status <> 'pending'::text))),
    CONSTRAINT commerce_paid_role_outbox_payload_json_check CHECK (public.haf_json_valid(payload_json)),
    CONSTRAINT commerce_paid_role_outbox_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'dead_letter'::text])))
);

CREATE TABLE public.commerce_paid_role_provider_actions (
    id text NOT NULL,
    operation_key text NOT NULL,
    assignment_id text,
    connected_account_id text NOT NULL,
    stripe_subscription_id text NOT NULL,
    action_type text NOT NULL,
    reason_code text NOT NULL,
    status text NOT NULL,
    attempt_count bigint DEFAULT 0 NOT NULL,
    available_at_ms bigint NOT NULL,
    claimed_at_ms bigint,
    lease_expires_at_ms bigint,
    completed_at_ms bigint,
    last_error_code text,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT commerce_paid_role_provider_actions_action_type_check CHECK ((action_type = ANY (ARRAY['subscription.cancel_at_period_end'::text, 'subscription.cancel_immediately'::text]))),
    CONSTRAINT commerce_paid_role_provider_actions_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT commerce_paid_role_provider_actions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text, 'failed'::text])))
);

CREATE TABLE public.commerce_paid_role_repairs (
    id text NOT NULL,
    guild_id text NOT NULL,
    old_role_id text NOT NULL,
    replacement_role_id text,
    started_at_ms bigint NOT NULL,
    deadline_at_ms bigint NOT NULL,
    status text NOT NULL,
    repaired_count bigint DEFAULT 0 NOT NULL,
    last_error_code text,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    offering_id text,
    CONSTRAINT commerce_paid_role_repairs_check CHECK ((deadline_at_ms > started_at_ms)),
    CONSTRAINT commerce_paid_role_repairs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'complete'::text, 'quarantined'::text])))
);

CREATE TABLE public.commerce_paid_role_states (
    entitlement_id text NOT NULL,
    connected_account_id text NOT NULL,
    guild_id text NOT NULL,
    discord_user_id text NOT NULL,
    discord_role_id text NOT NULL,
    subscription_id text,
    subscription_status text NOT NULL,
    cancel_at_period_end bigint DEFAULT 0 NOT NULL,
    current_period_end_ms bigint,
    payment_status text,
    amount_minor bigint,
    amount_refunded_minor bigint DEFAULT 0 NOT NULL,
    dispute_status text,
    failed_payment_at_ms bigint,
    admin_action text,
    member_state text NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT commerce_paid_role_states_admin_action_check CHECK (((admin_action IS NULL) OR (admin_action = ANY (ARRAY['suspend'::text, 'revoke'::text])))),
    CONSTRAINT commerce_paid_role_states_amount_minor_check CHECK (((amount_minor IS NULL) OR (amount_minor >= 0))),
    CONSTRAINT commerce_paid_role_states_amount_refunded_minor_check CHECK ((amount_refunded_minor >= 0)),
    CONSTRAINT commerce_paid_role_states_cancel_at_period_end_check CHECK ((cancel_at_period_end = ANY (ARRAY[(0)::bigint, (1)::bigint]))),
    CONSTRAINT commerce_paid_role_states_check CHECK (((amount_minor IS NULL) OR (amount_refunded_minor <= amount_minor))),
    CONSTRAINT commerce_paid_role_states_dispute_status_check CHECK (((dispute_status IS NULL) OR (dispute_status = ANY (ARRAY['warning_needs_response'::text, 'warning_under_review'::text, 'warning_closed'::text, 'needs_response'::text, 'under_review'::text, 'won'::text, 'lost'::text])))),
    CONSTRAINT commerce_paid_role_states_member_state_check CHECK ((member_state = ANY (ARRAY['present'::text, 'left'::text, 'kicked'::text, 'rejoined'::text, 'banned'::text]))),
    CONSTRAINT commerce_paid_role_states_payment_status_check CHECK (((payment_status IS NULL) OR (payment_status = ANY (ARRAY['requires_action'::text, 'processing'::text, 'succeeded'::text, 'failed'::text, 'canceled'::text])))),
    CONSTRAINT commerce_paid_role_states_subscription_status_check CHECK ((subscription_status = ANY (ARRAY['incomplete'::text, 'trialing'::text, 'active'::text, 'past_due'::text, 'paused'::text, 'unpaid'::text, 'canceled'::text, 'ended'::text])))
);

CREATE TABLE public.commerce_payments (
    id text NOT NULL,
    connected_account_id text NOT NULL,
    customer_id text NOT NULL,
    buyer_id text NOT NULL,
    offering_id text NOT NULL,
    price_id text NOT NULL,
    stripe_payment_intent_id text NOT NULL,
    stripe_charge_id text,
    stripe_checkout_session_id text,
    stripe_invoice_id text,
    stripe_subscription_id text,
    invoice_period_start_ms bigint,
    invoice_period_end_ms bigint,
    is_latest_subscription_invoice bigint DEFAULT 0 NOT NULL,
    currency text NOT NULL,
    amount_minor bigint NOT NULL,
    amount_received_minor bigint DEFAULT 0 NOT NULL,
    amount_refunded_minor bigint DEFAULT 0 NOT NULL,
    status text NOT NULL,
    provider_created_at_ms bigint,
    paid_at_ms bigint,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    application_fee_minor bigint,
    stripe_fee_minor bigint,
    stripe_fee_tax_minor bigint,
    CONSTRAINT commerce_payments_amount_minor_check CHECK ((amount_minor >= 0)),
    CONSTRAINT commerce_payments_amount_received_minor_check CHECK ((amount_received_minor >= 0)),
    CONSTRAINT commerce_payments_amount_refunded_minor_check CHECK ((amount_refunded_minor >= 0)),
    CONSTRAINT commerce_payments_application_fee_minor_check CHECK (((application_fee_minor IS NULL) OR (application_fee_minor >= 0))),
    CONSTRAINT commerce_payments_check CHECK ((amount_received_minor <= amount_minor)),
    CONSTRAINT commerce_payments_check1 CHECK ((amount_refunded_minor <= amount_received_minor)),
    CONSTRAINT commerce_payments_currency_check CHECK ((currency = ANY (ARRAY['AUD'::text, 'USD'::text]))),
    CONSTRAINT commerce_payments_is_latest_subscription_invoice_check CHECK ((is_latest_subscription_invoice = ANY (ARRAY[(0)::bigint, (1)::bigint]))),
    CONSTRAINT commerce_payments_status_check CHECK ((status = ANY (ARRAY['requires_action'::text, 'processing'::text, 'succeeded'::text, 'failed'::text, 'canceled'::text]))),
    CONSTRAINT commerce_payments_stripe_fee_minor_check CHECK (((stripe_fee_minor IS NULL) OR (stripe_fee_minor >= 0))),
    CONSTRAINT commerce_payments_stripe_fee_tax_minor_check CHECK (((stripe_fee_tax_minor IS NULL) OR (stripe_fee_tax_minor >= 0)))
);

CREATE TABLE public.commerce_prices (
    id text NOT NULL,
    connected_account_id text NOT NULL,
    offering_id text NOT NULL,
    stripe_product_id text NOT NULL,
    stripe_price_id text NOT NULL,
    currency text NOT NULL,
    unit_amount_minor bigint NOT NULL,
    price_type text NOT NULL,
    recurring_interval text,
    status text NOT NULL,
    provider_created_at_ms bigint,
    retired_at_ms bigint,
    created_at_ms bigint NOT NULL,
    CONSTRAINT commerce_prices_check CHECK ((((price_type = 'recurring'::text) AND (recurring_interval IS NOT NULL)) OR ((price_type = 'one_time'::text) AND (recurring_interval IS NULL)))),
    CONSTRAINT commerce_prices_check1 CHECK (((status = 'retired'::text) = (retired_at_ms IS NOT NULL))),
    CONSTRAINT commerce_prices_currency_check CHECK ((currency = ANY (ARRAY['AUD'::text, 'USD'::text]))),
    CONSTRAINT commerce_prices_price_type_check CHECK ((price_type = ANY (ARRAY['recurring'::text, 'one_time'::text]))),
    CONSTRAINT commerce_prices_recurring_interval_check CHECK ((recurring_interval = ANY (ARRAY['month'::text, 'year'::text]))),
    CONSTRAINT commerce_prices_status_check CHECK ((status = ANY (ARRAY['active'::text, 'retired'::text]))),
    CONSTRAINT commerce_prices_unit_amount_minor_check CHECK ((unit_amount_minor >= 0))
);

CREATE TABLE public.commerce_refunds (
    id text NOT NULL,
    connected_account_id text NOT NULL,
    payment_id text NOT NULL,
    stripe_refund_id text NOT NULL,
    currency text NOT NULL,
    amount_minor bigint NOT NULL,
    application_fee_refunded_minor bigint,
    status text NOT NULL,
    reason text,
    provider_created_at_ms bigint,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT commerce_refunds_amount_minor_check CHECK ((amount_minor >= 0)),
    CONSTRAINT commerce_refunds_application_fee_refunded_minor_check CHECK (((application_fee_refunded_minor IS NULL) OR (application_fee_refunded_minor >= 0))),
    CONSTRAINT commerce_refunds_currency_check CHECK ((currency = ANY (ARRAY['AUD'::text, 'USD'::text]))),
    CONSTRAINT commerce_refunds_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'succeeded'::text, 'failed'::text, 'canceled'::text])))
);

CREATE TABLE public.commerce_reporting_ledger (
    id text NOT NULL,
    connected_account_id text NOT NULL,
    guild_id text NOT NULL,
    seller_country text,
    buyer_id text,
    transaction_type text NOT NULL,
    source_record_id text NOT NULL,
    provider_transaction_id text NOT NULL,
    provider_status text NOT NULL,
    currency text NOT NULL,
    gross_amount_minor bigint NOT NULL,
    application_fee_minor bigint,
    stripe_fee_minor bigint,
    stripe_fee_tax_minor bigint,
    occurred_at_ms bigint NOT NULL,
    reporting_period text NOT NULL,
    correction_of_transaction_type text,
    correction_of_source_record_id text,
    aud_amount_minor bigint,
    aud_conversion_rate text,
    aud_conversion_source text,
    aud_conversion_at_ms bigint,
    recorded_at_ms bigint NOT NULL,
    CONSTRAINT commerce_reporting_ledger_application_fee_minor_check CHECK (((application_fee_minor IS NULL) OR (application_fee_minor >= 0))),
    CONSTRAINT commerce_reporting_ledger_aud_amount_minor_check CHECK (((aud_amount_minor IS NULL) OR (aud_amount_minor >= 0))),
    CONSTRAINT commerce_reporting_ledger_check CHECK ((((currency = 'AUD'::text) AND (aud_amount_minor = gross_amount_minor)) OR ((currency = 'USD'::text) AND (((aud_amount_minor IS NULL) AND (aud_conversion_rate IS NULL) AND (aud_conversion_source IS NULL) AND (aud_conversion_at_ms IS NULL)) OR ((aud_amount_minor IS NOT NULL) AND (aud_conversion_rate IS NOT NULL) AND (aud_conversion_source IS NOT NULL) AND (aud_conversion_at_ms IS NOT NULL)))))),
    CONSTRAINT commerce_reporting_ledger_currency_check CHECK ((currency = ANY (ARRAY['AUD'::text, 'USD'::text]))),
    CONSTRAINT commerce_reporting_ledger_gross_amount_minor_check CHECK ((gross_amount_minor >= 0)),
    CONSTRAINT commerce_reporting_ledger_stripe_fee_minor_check CHECK (((stripe_fee_minor IS NULL) OR (stripe_fee_minor >= 0))),
    CONSTRAINT commerce_reporting_ledger_stripe_fee_tax_minor_check CHECK (((stripe_fee_tax_minor IS NULL) OR (stripe_fee_tax_minor >= 0))),
    CONSTRAINT commerce_reporting_ledger_transaction_type_check CHECK ((transaction_type = ANY (ARRAY['membership_payment'::text, 'membership_refund'::text, 'membership_dispute'::text, 'support_payment'::text, 'support_refund'::text, 'support_dispute'::text])))
);

CREATE TABLE public.commerce_role_assignments (
    id text NOT NULL,
    entitlement_id text NOT NULL,
    guild_id text NOT NULL,
    discord_user_id text NOT NULL,
    discord_role_id text NOT NULL,
    status text NOT NULL,
    withheld_reason text,
    provider_cancellation_state text DEFAULT 'none'::text NOT NULL,
    attempt_count bigint DEFAULT 0 NOT NULL,
    last_error_code text,
    next_attempt_at_ms bigint,
    assigned_at_ms bigint,
    removed_at_ms bigint,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT commerce_role_assignments_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT commerce_role_assignments_check CHECK ((((status = 'withheld'::text) AND (withheld_reason IS NOT NULL)) OR (status <> 'withheld'::text))),
    CONSTRAINT commerce_role_assignments_provider_cancellation_state_check CHECK ((provider_cancellation_state = ANY (ARRAY['none'::text, 'pending'::text, 'scheduled'::text, 'completed'::text, 'failed'::text]))),
    CONSTRAINT commerce_role_assignments_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'assigned'::text, 'withheld'::text, 'removing'::text, 'removed'::text, 'failed'::text]))),
    CONSTRAINT commerce_role_assignments_withheld_reason_check CHECK (((withheld_reason IS NULL) OR (withheld_reason = ANY (ARRAY['member_absent'::text, 'guild_ban'::text, 'dispute'::text, 'admin_suspension'::text]))))
);

CREATE TABLE public.commerce_sales_panels (
    connected_account_id text NOT NULL,
    guild_id text NOT NULL,
    channel_id text NOT NULL,
    message_id text,
    last_error_code text,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    pending_channel_id text,
    publication_nonce text,
    publication_lease_token text,
    publication_lease_expires_at_ms bigint,
    title text DEFAULT 'Support this Discord server'::text NOT NULL,
    description text DEFAULT 'Discover paid Discord role access from this server.'::text NOT NULL,
    pending_title text,
    pending_description text
);

CREATE TABLE public.commerce_seller_acceptances (
    id text NOT NULL,
    connected_account_id text NOT NULL,
    terms_version text NOT NULL,
    accepted_by_user_id text NOT NULL,
    accepted_at_ms bigint NOT NULL,
    created_at_ms bigint NOT NULL
);

CREATE TABLE public.commerce_seller_controls (
    id text NOT NULL,
    scope_type text NOT NULL,
    scope_id text NOT NULL,
    suspended bigint DEFAULT 0 NOT NULL,
    reason_code text,
    actor_user_id text NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT commerce_seller_controls_check CHECK ((((scope_type = 'global'::text) AND (scope_id = 'commerce'::text)) OR ((scope_type = 'guild'::text) AND (length(scope_id) > 0)))),
    CONSTRAINT commerce_seller_controls_check1 CHECK ((((suspended = 1) AND (reason_code IS NOT NULL)) OR (suspended = 0))),
    CONSTRAINT commerce_seller_controls_scope_type_check CHECK ((scope_type = ANY (ARRAY['global'::text, 'guild'::text]))),
    CONSTRAINT commerce_seller_controls_suspended_check CHECK ((suspended = ANY (ARRAY[(0)::bigint, (1)::bigint])))
);

CREATE TABLE public.commerce_seller_offboarding (
    connected_account_id text NOT NULL,
    guild_id text NOT NULL,
    status text NOT NULL,
    reason_code text NOT NULL,
    actor_user_id text,
    active_subscription_count bigint DEFAULT 0 NOT NULL,
    latest_paid_through_at_ms bigint,
    started_at_ms bigint NOT NULL,
    completed_at_ms bigint,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT commerce_seller_offboarding_status_check CHECK ((status = ANY (ARRAY['canceling'::text, 'waiting'::text, 'ready'::text, 'completed'::text, 'unexpected_deauthorization'::text])))
);

CREATE TABLE public.commerce_seller_profiles (
    connected_account_id text NOT NULL,
    guild_id text NOT NULL,
    lifecycle_state text NOT NULL,
    approval_state text NOT NULL,
    support_contact text NOT NULL,
    adult_attested_at_ms bigint NOT NULL,
    two_factor_evidence text NOT NULL,
    guild_created_at_ms bigint NOT NULL,
    ownership_transferred_at_ms bigint,
    guild_good_standing bigint DEFAULT 0 NOT NULL,
    seller_good_standing bigint DEFAULT 0 NOT NULL,
    requirements_currently_due_json text DEFAULT '[]'::text NOT NULL,
    requirements_eventually_due_json text DEFAULT '[]'::text NOT NULL,
    requirements_pending_verification_json text DEFAULT '[]'::text NOT NULL,
    disabled_reason text,
    reviewed_by_user_id text,
    reviewed_at_ms bigint,
    capabilities_updated_at_ms bigint,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    seller_owner_user_id text DEFAULT ''::text NOT NULL,
    CONSTRAINT commerce_seller_profiles_approval_state_check CHECK ((approval_state = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text]))),
    CONSTRAINT commerce_seller_profiles_check CHECK ((((approval_state = 'pending'::text) AND (reviewed_at_ms IS NULL) AND (reviewed_by_user_id IS NULL)) OR ((approval_state = ANY (ARRAY['approved'::text, 'rejected'::text])) AND (reviewed_at_ms IS NOT NULL) AND (reviewed_by_user_id IS NOT NULL)))),
    CONSTRAINT commerce_seller_profiles_guild_good_standing_check CHECK ((guild_good_standing = ANY (ARRAY[(0)::bigint, (1)::bigint]))),
    CONSTRAINT commerce_seller_profiles_lifecycle_state_check CHECK ((lifecycle_state = ANY (ARRAY['onboarding_incomplete'::text, 'pending_review'::text, 'active'::text, 'restricted'::text, 'repair_required'::text, 'offboarding'::text, 'disconnected'::text, 'suspended'::text]))),
    CONSTRAINT commerce_seller_profiles_requirements_currently_due_json_check CHECK (public.haf_json_valid(requirements_currently_due_json)),
    CONSTRAINT commerce_seller_profiles_requirements_eventually_due_json_check CHECK (public.haf_json_valid(requirements_eventually_due_json)),
    CONSTRAINT commerce_seller_profiles_requirements_pending_verificatio_check CHECK (public.haf_json_valid(requirements_pending_verification_json)),
    CONSTRAINT commerce_seller_profiles_seller_good_standing_check CHECK ((seller_good_standing = ANY (ARRAY[(0)::bigint, (1)::bigint]))),
    CONSTRAINT commerce_seller_profiles_two_factor_evidence_check CHECK ((two_factor_evidence = ANY (ARRAY['discord_verified'::text, 'seller_attested'::text])))
);

CREATE TABLE public.commerce_seller_review_requests (
    id text NOT NULL,
    connected_account_id text NOT NULL,
    guild_id text NOT NULL,
    seller_owner_user_id text NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    stripe_details_submitted bigint DEFAULT 0 NOT NULL,
    stripe_charges_enabled bigint DEFAULT 0 NOT NULL,
    stripe_payouts_enabled bigint DEFAULT 0 NOT NULL,
    review_channel_id text,
    review_message_id text,
    notification_lease_token text,
    notification_lease_expires_at_ms bigint,
    decision_actor_user_id text,
    decision_state text,
    decision_reason text,
    decided_at_ms bigint,
    decision_notified_at_ms bigint,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    guild_created_at_ms bigint,
    CONSTRAINT commerce_seller_review_requests_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'processing'::text, 'approved'::text, 'rejected'::text])))
);

CREATE TABLE public.commerce_store_branding (
    guild_id text NOT NULL,
    connected_account_id text NOT NULL,
    accent_color bigint DEFAULT 5793266 NOT NULL,
    tagline text DEFAULT ''::text NOT NULL,
    created_by_user_id text NOT NULL,
    updated_by_user_id text NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT commerce_store_branding_accent_color_check CHECK ((((accent_color >= 0) AND (accent_color <= 16777215)) AND (accent_color = accent_color))),
    CONSTRAINT commerce_store_branding_tagline_check CHECK ((length(tagline) <= 160))
);

CREATE TABLE public.commerce_subscriptions (
    id text NOT NULL,
    connected_account_id text NOT NULL,
    customer_id text NOT NULL,
    buyer_id text NOT NULL,
    offering_id text NOT NULL,
    price_id text NOT NULL,
    stripe_subscription_id text NOT NULL,
    status text NOT NULL,
    cancel_at_period_end bigint DEFAULT 0 NOT NULL,
    current_period_start_ms bigint,
    current_period_end_ms bigint,
    canceled_at_ms bigint,
    ended_at_ms bigint,
    provider_updated_at_ms bigint,
    latest_invoice_id text,
    latest_invoice_status text,
    latest_payment_intent_id text,
    latest_payment_status text,
    grace_started_at_ms bigint,
    grace_ends_at_ms bigint,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    checkout_attempt_id text,
    CONSTRAINT commerce_subscriptions_cancel_at_period_end_check CHECK ((cancel_at_period_end = ANY (ARRAY[(0)::bigint, (1)::bigint]))),
    CONSTRAINT commerce_subscriptions_latest_invoice_status_check CHECK (((latest_invoice_status IS NULL) OR (latest_invoice_status = ANY (ARRAY['draft'::text, 'open'::text, 'paid'::text, 'uncollectible'::text, 'void'::text])))),
    CONSTRAINT commerce_subscriptions_latest_payment_status_check CHECK (((latest_payment_status IS NULL) OR (latest_payment_status = ANY (ARRAY['requires_action'::text, 'processing'::text, 'succeeded'::text, 'failed'::text, 'canceled'::text])))),
    CONSTRAINT commerce_subscriptions_status_check CHECK ((status = ANY (ARRAY['incomplete'::text, 'trialing'::text, 'active'::text, 'past_due'::text, 'paused'::text, 'unpaid'::text, 'canceled'::text, 'ended'::text])))
);

CREATE TABLE public.commerce_support_checkout_attempts (
    id text NOT NULL,
    connected_account_id text NOT NULL,
    guild_id text NOT NULL,
    buyer_id text NOT NULL,
    currency text NOT NULL,
    amount_minor bigint NOT NULL,
    application_fee_minor bigint NOT NULL,
    stripe_checkout_session_id text,
    status text NOT NULL,
    expires_at_ms bigint NOT NULL,
    returned_at_ms bigint,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT commerce_support_checkout_attempts_amount_minor_check CHECK (((amount_minor >= 200) AND (amount_minor <= 50000))),
    CONSTRAINT commerce_support_checkout_attempts_application_fee_minor_check CHECK ((application_fee_minor >= 0)),
    CONSTRAINT commerce_support_checkout_attempts_currency_check CHECK ((currency = ANY (ARRAY['AUD'::text, 'USD'::text]))),
    CONSTRAINT commerce_support_checkout_attempts_status_check CHECK ((status = ANY (ARRAY['creating'::text, 'open'::text, 'returned'::text, 'expired'::text, 'failed'::text])))
);

CREATE TABLE public.commerce_support_configs (
    connected_account_id text NOT NULL,
    guild_id text NOT NULL,
    enabled bigint DEFAULT 0 NOT NULL,
    explanation text NOT NULL,
    currency text NOT NULL,
    suggested_amounts_json text NOT NULL,
    support_contact text NOT NULL,
    terms_version text NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT commerce_support_configs_currency_check CHECK ((currency = ANY (ARRAY['AUD'::text, 'USD'::text]))),
    CONSTRAINT commerce_support_configs_enabled_check CHECK ((enabled = ANY (ARRAY[(0)::bigint, (1)::bigint])))
);

CREATE TABLE public.commerce_support_disputes (
    id text NOT NULL,
    connected_account_id text NOT NULL,
    support_payment_id text NOT NULL,
    stripe_dispute_id text NOT NULL,
    currency text NOT NULL,
    amount_minor bigint NOT NULL,
    status text NOT NULL,
    reason text,
    provider_created_at_ms bigint,
    closed_at_ms bigint,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT commerce_support_disputes_currency_check CHECK ((currency = ANY (ARRAY['AUD'::text, 'USD'::text])))
);

CREATE TABLE public.commerce_support_payments (
    id text NOT NULL,
    connected_account_id text NOT NULL,
    guild_id text NOT NULL,
    customer_id text NOT NULL,
    buyer_id text NOT NULL,
    checkout_attempt_id text NOT NULL,
    stripe_payment_intent_id text NOT NULL,
    stripe_charge_id text,
    stripe_checkout_session_id text,
    currency text NOT NULL,
    amount_minor bigint NOT NULL,
    amount_received_minor bigint DEFAULT 0 NOT NULL,
    amount_refunded_minor bigint DEFAULT 0 NOT NULL,
    application_fee_minor bigint NOT NULL,
    stripe_fee_tax_minor bigint,
    stripe_fee_minor bigint,
    status text NOT NULL,
    provider_created_at_ms bigint,
    paid_at_ms bigint,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT commerce_support_payments_currency_check CHECK ((currency = ANY (ARRAY['AUD'::text, 'USD'::text]))),
    CONSTRAINT commerce_support_payments_stripe_fee_tax_minor_check CHECK (((stripe_fee_tax_minor IS NULL) OR (stripe_fee_tax_minor >= 0)))
);

CREATE TABLE public.commerce_support_rate_limits (
    buyer_id text NOT NULL,
    guild_id text NOT NULL,
    window_started_at_ms bigint NOT NULL,
    attempt_count bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT commerce_support_rate_limits_attempt_count_check CHECK ((attempt_count >= 0))
);

CREATE TABLE public.commerce_support_refunds (
    id text NOT NULL,
    connected_account_id text NOT NULL,
    support_payment_id text NOT NULL,
    stripe_refund_id text NOT NULL,
    currency text NOT NULL,
    amount_minor bigint NOT NULL,
    application_fee_refunded_minor bigint,
    status text NOT NULL,
    reason text,
    provider_created_at_ms bigint,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT commerce_support_refunds_currency_check CHECK ((currency = ANY (ARRAY['AUD'::text, 'USD'::text])))
);

CREATE TABLE public.commerce_sync_outbox (
    id text NOT NULL,
    connected_account_id text NOT NULL,
    event_id text NOT NULL,
    resource_type text NOT NULL,
    resource_id text NOT NULL,
    generation bigint NOT NULL,
    sent_at_ms bigint,
    created_at_ms bigint NOT NULL,
    CONSTRAINT commerce_sync_outbox_generation_check CHECK ((generation > 0))
);

CREATE TABLE public.commerce_sync_state (
    id text NOT NULL,
    connected_account_id text NOT NULL,
    resource_type text NOT NULL,
    resource_id text NOT NULL,
    status text NOT NULL,
    provider_updated_at_ms bigint,
    provider_event_id text,
    last_synced_at_ms bigint,
    last_error_code text,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    generation bigint DEFAULT 0 NOT NULL,
    applied_generation bigint DEFAULT 0 NOT NULL,
    lease_token text,
    lease_expires_at_ms bigint,
    CONSTRAINT commerce_sync_state_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'synced'::text, 'failed'::text, 'quarantined'::text])))
);

CREATE TABLE public.commerce_webhook_events (
    id text NOT NULL,
    connected_account_id text NOT NULL,
    stripe_event_id text NOT NULL,
    event_type text NOT NULL,
    api_version text,
    provider_created_at_ms bigint NOT NULL,
    received_at_ms bigint NOT NULL,
    status text NOT NULL,
    attempt_count bigint DEFAULT 0 NOT NULL,
    last_error_code text,
    processed_at_ms bigint,
    updated_at_ms bigint NOT NULL,
    object_id text,
    payload_hash text,
    generation bigint DEFAULT 0 NOT NULL,
    CONSTRAINT commerce_webhook_events_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT commerce_webhook_events_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'processed'::text, 'failed'::text, 'ignored'::text])))
);

CREATE TABLE public.community_feed_state (
    guild_id text NOT NULL,
    feed_id text NOT NULL,
    source_fingerprint text NOT NULL,
    seen_ids_json text DEFAULT '[]'::text NOT NULL,
    initialized integer DEFAULT 0 NOT NULL,
    checked_at_ms bigint DEFAULT 0 NOT NULL,
    last_error text
);

CREATE TABLE public.community_moderation_cases (
    id text NOT NULL,
    guild_id text NOT NULL,
    user_id text NOT NULL,
    actor_user_id text,
    action text NOT NULL,
    reason text NOT NULL,
    rule_id text,
    created_at_ms bigint NOT NULL
);

CREATE TABLE public.community_tool_claims (
    claim_key text NOT NULL,
    expires_at_ms bigint NOT NULL
);

CREATE TABLE public.community_tool_configs (
    guild_id text NOT NULL,
    feature text NOT NULL,
    config_json text NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT community_tool_configs_feature_check CHECK ((feature = ANY (ARRAY['automation'::text, 'moderation'::text, 'feeds'::text])))
);

CREATE TABLE public.community_tool_deliveries (
    id text NOT NULL,
    guild_id text NOT NULL,
    feature text NOT NULL,
    item_id text NOT NULL,
    config_revision integer NOT NULL,
    bot_user_id text,
    channel_id text NOT NULL,
    content text NOT NULL,
    role_ids_json text DEFAULT '[]'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at_ms bigint NOT NULL,
    lease_token text,
    lease_until_ms bigint DEFAULT 0 NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    CONSTRAINT community_tool_deliveries_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sending'::text, 'delivered'::text, 'failed'::text, 'cancelled'::text])))
);

CREATE TABLE public.configuration_revision_heads (
    guild_id text NOT NULL,
    feature text NOT NULL,
    resource_key text NOT NULL,
    current_revision_id text NOT NULL,
    updated_at_ms bigint NOT NULL
);

CREATE TABLE public.configuration_revisions (
    id text NOT NULL,
    guild_id text NOT NULL,
    feature text NOT NULL,
    resource_key text NOT NULL,
    schema_version bigint NOT NULL,
    operation text NOT NULL,
    source text NOT NULL,
    actor_user_id text,
    operation_id text NOT NULL,
    correlation_id text,
    previous_revision_id text,
    restored_from_revision_id text,
    snapshot_json text NOT NULL,
    snapshot_hash text NOT NULL,
    created_at_ms bigint NOT NULL
);

CREATE TABLE public.considered_replies (
    id text NOT NULL,
    suggestion_id text NOT NULL,
    thread_id text,
    guild_id text NOT NULL,
    author_id text NOT NULL,
    perspective text NOT NULL,
    reasoning text NOT NULL,
    improvement text,
    state text NOT NULL,
    flag_count bigint DEFAULT 0 NOT NULL,
    webhook_message_id text,
    queue_message_id text,
    collapsed_at_ms bigint,
    resolved_at_ms bigint,
    resolved_by_user_id text,
    resolution_reason text,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL
);

CREATE TABLE public.considered_reply_flags (
    reply_id text NOT NULL,
    guild_id text NOT NULL,
    member_id text NOT NULL,
    active bigint DEFAULT 1 NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL
);

CREATE TABLE public.discord_ban_appeal_configs (
    guild_id text NOT NULL,
    settings_json jsonb NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    CONSTRAINT discord_ban_appeal_configs_revision_check CHECK ((revision >= 0))
);

CREATE TABLE public.discord_ban_appeal_cooldowns (
    guild_id text NOT NULL,
    user_id text NOT NULL,
    next_submission_at_ms bigint DEFAULT 0 NOT NULL
);

CREATE TABLE public.discord_ban_appeal_operations (
    guild_id text NOT NULL,
    appeal_id text NOT NULL,
    id text NOT NULL,
    actor_user_id text NOT NULL,
    reason text NOT NULL,
    outcome text NOT NULL,
    created_at_ms bigint NOT NULL,
    completed_at_ms bigint,
    CONSTRAINT discord_ban_appeal_operations_outcome_check CHECK ((outcome = ANY (ARRAY['started'::text, 'succeeded'::text, 'failed'::text, 'uncertain'::text]))),
    CONSTRAINT discord_ban_appeal_operations_reason_check CHECK (((length(reason) >= 3) AND (length(reason) <= 500)))
);

CREATE TABLE public.discord_ban_appeals (
    guild_id text NOT NULL,
    id text NOT NULL,
    user_id text NOT NULL,
    display_name text NOT NULL,
    appeal_text text NOT NULL,
    ban_reason text,
    status text NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    created_at_ms bigint NOT NULL,
    resolved_at_ms bigint,
    reviewer_user_id text,
    decision_reason text,
    operation_id text,
    CONSTRAINT discord_ban_appeals_appeal_text_check CHECK (((length(appeal_text) >= 20) AND (length(appeal_text) <= 4000))),
    CONSTRAINT discord_ban_appeals_ban_reason_check CHECK ((length(ban_reason) <= 2000)),
    CONSTRAINT discord_ban_appeals_decision_reason_check CHECK ((length(decision_reason) <= 500)),
    CONSTRAINT discord_ban_appeals_display_name_check CHECK (((length(display_name) >= 1) AND (length(display_name) <= 100))),
    CONSTRAINT discord_ban_appeals_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'unban_pending'::text, 'unbanned'::text, 'rejected'::text])))
);

CREATE TABLE public.donor_claims (
    guild_id text NOT NULL,
    claimed_by_user_id text NOT NULL,
    claimed_at_ms bigint NOT NULL,
    suspended_at_ms bigint
);

CREATE TABLE public.event_lifecycle_history (
    guild_id text NOT NULL,
    event_id text NOT NULL,
    history_id text NOT NULL,
    from_status text,
    to_status text NOT NULL,
    occurred_at_ms bigint NOT NULL,
    retention_expires_at_ms bigint
);

CREATE TABLE public.event_lifecycle_transition_guards (
    guard_id text NOT NULL,
    guild_id text NOT NULL,
    event_id text NOT NULL,
    expected_status text NOT NULL,
    expected_state_version bigint NOT NULL
);

CREATE TABLE public.event_recurrence_series (
    guild_id text NOT NULL,
    series_id text NOT NULL,
    source_event_id text NOT NULL,
    snapshot_json text NOT NULL,
    frequency text NOT NULL,
    until_at_ms bigint,
    next_starts_at_ms bigint NOT NULL,
    next_publishes_at_ms bigint NOT NULL,
    status text NOT NULL,
    pending_event_id text,
    publication_attempted_at_ms bigint,
    last_event_id text NOT NULL,
    failure_reason text,
    created_by_user_id text NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    lease_token text,
    lease_until_ms bigint DEFAULT 0 NOT NULL
);

CREATE TABLE public.event_signup_mutation_guards (
    guard_id text NOT NULL,
    guild_id text NOT NULL,
    event_id text NOT NULL,
    user_id text NOT NULL,
    group_id text NOT NULL,
    operation text NOT NULL,
    CONSTRAINT event_signup_mutation_guards_operation_check CHECK ((operation = ANY (ARRAY['upsert'::text, 'delete'::text])))
);

CREATE TABLE public.event_signups (
    guild_id text NOT NULL,
    event_id text NOT NULL,
    user_id text NOT NULL,
    group_id text NOT NULL,
    status text NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL
);

CREATE TABLE public.event_team_audit_records (
    guild_id text NOT NULL,
    event_id text NOT NULL,
    audit_id text NOT NULL,
    actor_user_id text NOT NULL,
    action text NOT NULL,
    target_type text NOT NULL,
    target_id text NOT NULL,
    prior_json text NOT NULL,
    result_json text NOT NULL,
    occurred_at_ms bigint NOT NULL
);

CREATE TABLE public.event_team_bulk_commit_guards (
    guard_id text NOT NULL,
    guild_id text NOT NULL,
    event_id text NOT NULL,
    expected_state_version bigint NOT NULL
);

CREATE TABLE public.event_team_delivery_outbox (
    guild_id text NOT NULL,
    event_id text NOT NULL,
    outbox_id text NOT NULL,
    kind text NOT NULL,
    dedupe_key text NOT NULL,
    payload_json text NOT NULL,
    status text NOT NULL,
    attempt_count bigint DEFAULT 0 NOT NULL,
    max_attempts bigint DEFAULT 5 NOT NULL,
    last_error text,
    terminal_failure_reason text,
    next_attempt_at_ms bigint NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    delivered_at_ms bigint,
    CONSTRAINT event_team_delivery_outbox_kind_check CHECK ((kind = ANY (ARRAY['notification'::text, 'canonical_refresh'::text]))),
    CONSTRAINT event_team_delivery_outbox_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'delivered'::text, 'failed'::text])))
);

CREATE TABLE public.event_team_invitation_blocks (
    guild_id text NOT NULL,
    event_id text NOT NULL,
    team_id text NOT NULL,
    user_id text NOT NULL,
    created_at_ms bigint NOT NULL
);

CREATE TABLE public.event_team_memberships (
    guild_id text NOT NULL,
    event_id text NOT NULL,
    membership_id text NOT NULL,
    team_id text NOT NULL,
    group_id text NOT NULL,
    user_id text NOT NULL,
    joined_at_ms bigint NOT NULL,
    left_at_ms bigint
);

CREATE TABLE public.event_team_proposal_acceptance_guards (
    guild_id text NOT NULL,
    event_id text NOT NULL,
    proposal_id text NOT NULL,
    expected_updated_at_ms bigint NOT NULL
);

CREATE TABLE public.event_team_proposals (
    guild_id text NOT NULL,
    event_id text NOT NULL,
    proposal_id text NOT NULL,
    team_id text NOT NULL,
    kind text NOT NULL,
    requester_user_id text NOT NULL,
    target_user_id text NOT NULL,
    status text NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    resolved_at_ms bigint,
    CONSTRAINT event_team_proposals_kind_check CHECK ((kind = ANY (ARRAY['join_request'::text, 'invitation'::text]))),
    CONSTRAINT event_team_proposals_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text, 'rejected'::text, 'withdrawn'::text, 'cancelled'::text, 'expired'::text])))
);

CREATE TABLE public.event_team_rate_limits (
    guild_id text NOT NULL,
    event_id text NOT NULL,
    action text NOT NULL,
    scope_type text NOT NULL,
    scope_id text NOT NULL,
    window_started_at_ms bigint NOT NULL,
    attempt_count bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT event_team_rate_limits_scope_type_check CHECK ((scope_type = ANY (ARRAY['user'::text, 'event'::text])))
);

CREATE TABLE public.event_team_roster_snapshots (
    guild_id text NOT NULL,
    event_id text NOT NULL,
    team_id text NOT NULL,
    required_team_size bigint NOT NULL,
    members_json text NOT NULL,
    captured_at_ms bigint NOT NULL
);

CREATE TABLE public.event_team_state_versions (
    guild_id text NOT NULL,
    event_id text NOT NULL,
    version bigint DEFAULT 0 NOT NULL
);

CREATE TABLE public.event_teams (
    guild_id text NOT NULL,
    event_id text NOT NULL,
    team_id text NOT NULL,
    group_id text NOT NULL,
    name text NOT NULL,
    normalized_name text NOT NULL,
    captain_user_id text NOT NULL,
    open_to_requests bigint DEFAULT 0 NOT NULL,
    status text NOT NULL,
    created_by_user_id text NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    disbanded_at_ms bigint,
    CONSTRAINT event_teams_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disbanded'::text])))
);

CREATE TABLE public.event_templates (
    guild_id text NOT NULL,
    template_id text NOT NULL,
    name text NOT NULL,
    description text NOT NULL,
    signup_mode text NOT NULL,
    thread_enabled bigint DEFAULT 0 NOT NULL,
    waitlisted_members_join_thread bigint DEFAULT 0 NOT NULL,
    groups_json text NOT NULL,
    reminders_json text NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    participation_mode text DEFAULT 'individual'::text NOT NULL,
    required_team_size bigint,
    CONSTRAINT event_templates_participation_mode_check CHECK ((participation_mode = ANY (ARRAY['individual'::text, 'team'::text]))),
    CONSTRAINT event_templates_required_team_size_check CHECK (((required_team_size IS NULL) OR ((required_team_size >= 2) AND (required_team_size <= 50))))
);

CREATE TABLE public.events (
    guild_id text NOT NULL,
    event_id text NOT NULL,
    template_id text,
    title text NOT NULL,
    description text NOT NULL,
    status text NOT NULL,
    channel_id text NOT NULL,
    message_id text,
    thread_id text,
    starts_at_ms bigint NOT NULL,
    ends_at_ms bigint,
    signup_cutoff_at_ms bigint NOT NULL,
    signup_mode text NOT NULL,
    thread_enabled bigint DEFAULT 0 NOT NULL,
    waitlisted_members_join_thread bigint DEFAULT 0 NOT NULL,
    groups_json text NOT NULL,
    reminders_json text NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    published_at_ms bigint,
    cancelled_at_ms bigint,
    ended_at_ms bigint,
    archived_at_ms bigint,
    participation_mode text DEFAULT 'individual'::text NOT NULL,
    required_team_size bigint,
    recurrence_series_id text,
    CONSTRAINT events_participation_mode_check CHECK ((participation_mode = ANY (ARRAY['individual'::text, 'team'::text]))),
    CONSTRAINT events_required_team_size_check CHECK (((required_team_size IS NULL) OR ((required_team_size >= 2) AND (required_team_size <= 50))))
);

CREATE TABLE public.evidence_vault_configs (
    guild_id text NOT NULL,
    audit_channel_id text NOT NULL,
    updated_at_ms bigint NOT NULL,
    access_role_ids_json text DEFAULT '[]'::text NOT NULL,
    subjects_enabled bigint DEFAULT 0 NOT NULL,
    fields_json text DEFAULT '[]'::text NOT NULL,
    enabled bigint DEFAULT 1 NOT NULL
);

CREATE TABLE public.evidence_vault_records (
    record_id text NOT NULL,
    guild_id text NOT NULL,
    status text NOT NULL,
    payload_json text NOT NULL,
    hidden_at_ms bigint NOT NULL
);

CREATE TABLE public.feature_setup_resolutions (
    run_id text NOT NULL,
    dependency_key text NOT NULL,
    resource_id text NOT NULL,
    resource_name text NOT NULL,
    resource_kind text NOT NULL,
    relationship text NOT NULL,
    template_version bigint NOT NULL,
    validation_status text NOT NULL,
    validation_detail text,
    applied_at_ms bigint,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT feature_setup_resolutions_relationship_check CHECK ((relationship = ANY (ARRAY['referenced'::text, 'haf_configured'::text, 'haf_managed'::text]))),
    CONSTRAINT feature_setup_resolutions_resource_kind_check CHECK ((resource_kind = ANY (ARRAY['text_channel'::text, 'voice_channel'::text, 'forum_channel'::text, 'category'::text, 'role'::text]))),
    CONSTRAINT feature_setup_resolutions_template_version_check CHECK ((template_version > 0)),
    CONSTRAINT feature_setup_resolutions_validation_status_check CHECK ((validation_status = ANY (ARRAY['valid'::text, 'needs_attention'::text])))
);

CREATE TABLE public.feature_setup_runs (
    id text NOT NULL,
    guild_id text NOT NULL,
    feature_key text NOT NULL,
    definition_version bigint NOT NULL,
    status text NOT NULL,
    actor_user_id text NOT NULL,
    choices_json text NOT NULL,
    failure_dependency_key text,
    failure_message text,
    pending_creation_dependency_key text,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    completed_at_ms bigint,
    CONSTRAINT feature_setup_runs_definition_version_check CHECK ((definition_version > 0)),
    CONSTRAINT feature_setup_runs_status_check CHECK ((status = ANY (ARRAY['planned'::text, 'running'::text, 'incomplete'::text, 'completed'::text, 'cancelled'::text])))
);

CREATE TABLE public.gateway_event_operations (
    event_key text NOT NULL,
    handler_key text NOT NULL,
    state text NOT NULL,
    lease_token text,
    lease_expires_at_ms bigint,
    attempts bigint DEFAULT 1 NOT NULL,
    outcome_code text,
    outcome_json text,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    completed_at_ms bigint,
    CONSTRAINT gateway_event_operations_state_check CHECK ((state = ANY (ARRAY['processing'::text, 'completed'::text, 'terminal'::text])))
);

CREATE TABLE public.gateway_member_nicks (
    identity_id text NOT NULL,
    guild_id text NOT NULL,
    user_id text NOT NULL,
    nick_json jsonb NOT NULL
);

CREATE TABLE public.gateway_member_roles (
    identity_id text NOT NULL,
    guild_id text NOT NULL,
    user_id text NOT NULL,
    role_ids_json jsonb NOT NULL
);

CREATE TABLE public.gateway_message_audit_context (
    identity_id text NOT NULL,
    message_id text NOT NULL,
    guild_id text NOT NULL,
    author_json jsonb NOT NULL,
    updated_at timestamp with time zone NOT NULL
);

CREATE TABLE public.gateway_reaction_limit_mutations (
    event_key text NOT NULL,
    mutation_kind text NOT NULL,
    result_one bigint,
    result_two bigint,
    created_at_ms bigint NOT NULL
);

CREATE TABLE public.gateway_sessions (
    identity_id text NOT NULL,
    status text DEFAULT 'idle'::text NOT NULL,
    session_id text,
    resume_gateway_url text,
    last_sequence bigint,
    backoff_attempt integer DEFAULT 0 NOT NULL,
    last_error text,
    heartbeat_interval_ms integer,
    last_heartbeat_at timestamp with time zone,
    last_heartbeat_ack_at timestamp with time zone,
    fencing_generation bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT gateway_sessions_backoff_attempt_check CHECK ((backoff_attempt >= 0)),
    CONSTRAINT gateway_sessions_status_check CHECK ((status = ANY (ARRAY['idle'::text, 'connecting'::text, 'ready'::text, 'resuming'::text, 'backoff'::text])))
);

CREATE TABLE public.gateway_voice_states (
    identity_id text NOT NULL,
    guild_id text NOT NULL,
    user_id text NOT NULL,
    channel_id text NOT NULL
);

CREATE TABLE public.guild_audit_log_configs (
    guild_id text NOT NULL,
    audit_channel_id text DEFAULT ''::text NOT NULL,
    event_states_json text DEFAULT '{}'::text NOT NULL,
    updated_at_ms bigint NOT NULL,
    group_channel_ids_json text DEFAULT '{}'::text NOT NULL,
    excluded_channel_ids_json text DEFAULT '[]'::text NOT NULL,
    excluded_role_ids_json text DEFAULT '[]'::text NOT NULL
);

CREATE TABLE public.guild_blocked_emojis (
    guild_id text NOT NULL,
    normalized_emoji text NOT NULL
);

CREATE TABLE public.guild_entitlements (
    guild_id text NOT NULL,
    plan text NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT guild_entitlements_plan_check CHECK ((plan = ANY (ARRAY['free'::text, 'premium'::text, 'premium_plus'::text])))
);

CREATE TABLE public.guild_notification_channels (
    guild_id text NOT NULL,
    feature text NOT NULL,
    notification_channel_id text NOT NULL
);

CREATE TABLE public.guild_object_accounting (
    guild_id text NOT NULL,
    object_key text NOT NULL,
    size_bytes bigint NOT NULL,
    created_at_ms bigint NOT NULL,
    status text DEFAULT 'committed'::text NOT NULL,
    reserved_bytes bigint DEFAULT 0 NOT NULL,
    reservation_expires_at_ms bigint,
    operation_key text,
    updated_at_ms bigint DEFAULT 0 NOT NULL,
    reconciliation_generation bigint,
    had_committed_object boolean DEFAULT true NOT NULL,
    upload_started_at_ms bigint,
    tombstoned_at_ms bigint,
    CONSTRAINT guild_object_accounting_reserved_bytes_check CHECK ((reserved_bytes >= 0)),
    CONSTRAINT guild_object_accounting_size_bytes_check CHECK ((size_bytes >= 0)),
    CONSTRAINT guild_object_accounting_status_check CHECK ((status = ANY (ARRAY['committed'::text, 'reserved'::text, 'deleted'::text, 'released'::text]))),
    CONSTRAINT guild_object_reservation_shape CHECK ((((status = 'reserved'::text) AND (reservation_expires_at_ms IS NOT NULL) AND (operation_key IS NOT NULL)) OR ((status <> 'reserved'::text) AND (reservation_expires_at_ms IS NULL) AND (operation_key IS NULL))))
);

CREATE TABLE public.guild_object_reconciliation_state (
    bucket_id text NOT NULL,
    cursor text,
    generation bigint DEFAULT 1 NOT NULL,
    started_at_ms bigint,
    last_reconciled_at_ms bigint,
    updated_at_ms bigint NOT NULL
);

CREATE TABLE public.guild_rbac_settings (
    guild_id text NOT NULL,
    guild_admin_role_id text,
    manage_server_admin_enabled boolean DEFAULT true NOT NULL
);

CREATE TABLE public.guild_service_suspension_audit (
    id text NOT NULL,
    guild_id text NOT NULL,
    action text NOT NULL,
    reason text,
    actor_user_id text NOT NULL,
    occurred_at_ms bigint NOT NULL,
    CONSTRAINT guild_service_suspension_audit_action_check CHECK ((action = ANY (ARRAY['suspended'::text, 'restored'::text])))
);

CREATE TABLE public.guild_service_suspensions (
    guild_id text NOT NULL,
    reason text NOT NULL,
    created_at_ms bigint NOT NULL,
    created_by_user_id text NOT NULL,
    removed_at_ms bigint,
    removed_by_user_id text
);

CREATE TABLE public.guild_settings (
    guild_id text NOT NULL,
    moderation_enabled boolean DEFAULT true NOT NULL,
    channel_mode text DEFAULT 'include'::text NOT NULL,
    channel_ids_json text DEFAULT '[]'::text NOT NULL
);

CREATE TABLE public.identity_patterns (
    id text NOT NULL,
    platform text NOT NULL,
    pattern text NOT NULL,
    capture_group bigint NOT NULL,
    "position" bigint NOT NULL,
    disabled bigint DEFAULT 0 NOT NULL,
    created_at_ms bigint NOT NULL
);

CREATE TABLE public.image_rules_configs (
    guild_id text NOT NULL,
    enabled bigint DEFAULT 0 NOT NULL,
    topic_description text DEFAULT ''::text NOT NULL,
    auto_delete_threshold double precision DEFAULT 0.85 NOT NULL,
    mod_review_threshold double precision DEFAULT 0.65 NOT NULL,
    target_channel_ids_json text DEFAULT '[]'::text NOT NULL,
    excluded_role_ids_json text DEFAULT '[]'::text NOT NULL,
    mod_queue_channel_id text,
    mod_role_ids_json text DEFAULT '[]'::text NOT NULL,
    ping_on_queue_post bigint DEFAULT 1 NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    react_on_topic bigint DEFAULT 0 NOT NULL,
    audit_on_topic bigint DEFAULT 0 NOT NULL,
    dry_run bigint DEFAULT 0 NOT NULL
);

CREATE TABLE public.image_rules_mod_queue_items (
    id text NOT NULL,
    guild_id text NOT NULL,
    channel_id text NOT NULL,
    message_id text NOT NULL,
    author_id text NOT NULL,
    image_url text NOT NULL,
    topic_description text NOT NULL,
    off_topic_confidence double precision NOT NULL,
    on_topic_confidence double precision NOT NULL,
    status text NOT NULL,
    queue_channel_id text,
    queue_message_id text,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    decided_by_user_id text,
    decided_at_ms bigint,
    failure_reason text,
    restore_claim_token text,
    restore_claim_expires_at_ms bigint,
    restored_message_id text
);

CREATE TABLE public.jobs (
    id text NOT NULL,
    queue_name text NOT NULL,
    dedupe_key text,
    payload_json jsonb NOT NULL,
    state text DEFAULT 'queued'::text NOT NULL,
    available_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 4 NOT NULL,
    lease_owner text,
    lease_token text,
    lease_expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    completed_at timestamp with time zone,
    terminal_reason_code text,
    CONSTRAINT jobs_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT jobs_lease_shape CHECK ((((state = 'running'::text) AND (lease_owner IS NOT NULL) AND (lease_token IS NOT NULL) AND (lease_expires_at IS NOT NULL)) OR ((state <> 'running'::text) AND (lease_owner IS NULL) AND (lease_token IS NULL) AND (lease_expires_at IS NULL)))),
    CONSTRAINT jobs_max_attempts_check CHECK ((max_attempts > 0)),
    CONSTRAINT jobs_state_check CHECK ((state = ANY (ARRAY['queued'::text, 'running'::text, 'completed'::text, 'terminal'::text])))
);

CREATE TABLE public.known_guilds (
    guild_id text NOT NULL,
    name text NOT NULL,
    member_count integer DEFAULT 0 NOT NULL,
    owner_id text DEFAULT ''::text NOT NULL,
    icon text,
    installed_at_ms bigint NOT NULL,
    removed_at_ms bigint
);

CREATE TABLE public.lfg_applications (
    guild_id text NOT NULL,
    post_id text NOT NULL,
    applicant_id text NOT NULL,
    applicant_display_name text NOT NULL,
    message text NOT NULL,
    status text NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    reviewed_by_user_id text,
    reviewed_at_ms bigint
);

CREATE TABLE public.lfg_configs (
    guild_id text NOT NULL,
    notice_channel_id text,
    notice_message_id text,
    notification_role_id text,
    counter_voice_channel_id text,
    counter_display_format text DEFAULT 'LFG ({count})'::text NOT NULL,
    expiry_action text DEFAULT 'close'::text NOT NULL,
    expiry_duration_hours bigint DEFAULT 24 NOT NULL,
    server_options_json text NOT NULL,
    updated_at_ms bigint NOT NULL,
    approval_flow_enabled bigint DEFAULT 0 NOT NULL,
    approval_audit_channel_id text,
    approval_voice_category_id text,
    notice_color bigint DEFAULT 2829617 NOT NULL,
    enabled bigint DEFAULT 1 NOT NULL
);

CREATE TABLE public.lfg_posts (
    guild_id text NOT NULL,
    post_id text NOT NULL,
    owner_id text NOT NULL,
    owner_display_name text NOT NULL,
    server_id text NOT NULL,
    server_label text NOT NULL,
    when_play text NOT NULL,
    looking_for text NOT NULL,
    extra_info text NOT NULL,
    channel_id text NOT NULL,
    message_id text,
    active bigint NOT NULL,
    created_at_ms bigint NOT NULL,
    expires_at_ms bigint,
    reminder_sent_at_ms bigint,
    renewed_at_ms bigint,
    renewals_count bigint DEFAULT 0 NOT NULL,
    closed_at_ms bigint,
    closed_by_user_id text,
    scope text DEFAULT 'public'::text NOT NULL,
    clan_id text,
    clan_tag text,
    persistent_voice_channel_id text,
    CONSTRAINT lfg_posts_scope_check CHECK ((scope = ANY (ARRAY['public'::text, 'clan'::text])))
);

CREATE TABLE public.lfg_voice_channels (
    guild_id text NOT NULL,
    post_id text NOT NULL,
    channel_id text NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL
);

CREATE TABLE public.managed_message_audit_outbox (
    event_key text NOT NULL,
    guild_id text NOT NULL,
    channel_id text NOT NULL,
    message_id text NOT NULL,
    internal_name text NOT NULL,
    claimed_at_ms bigint,
    delivered_at_ms bigint,
    created_at_ms bigint NOT NULL
);

CREATE TABLE public.managed_message_drafts (
    id text NOT NULL,
    guild_id text NOT NULL,
    internal_name text NOT NULL,
    channel_id text NOT NULL,
    embeds_json text NOT NULL,
    announcement_json text NOT NULL,
    status text NOT NULL,
    scheduled_at_ms bigint,
    failure_reason text,
    attempt_count bigint DEFAULT 0 NOT NULL,
    publication_claimed_at_ms bigint,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    buttons_json text DEFAULT '[]'::text NOT NULL
);

CREATE TABLE public.managed_message_media_assets (
    guild_id text NOT NULL,
    filename text NOT NULL,
    created_at_ms bigint NOT NULL,
    status text DEFAULT 'active'::text NOT NULL
);

CREATE TABLE public.managed_message_media_refs (
    guild_id text NOT NULL,
    filename text NOT NULL,
    owner_type text NOT NULL,
    owner_id text NOT NULL,
    CONSTRAINT managed_message_media_refs_owner_type_check CHECK ((owner_type = ANY (ARRAY['draft'::text, 'message'::text])))
);

CREATE TABLE public.managed_messages (
    id text NOT NULL,
    guild_id text NOT NULL,
    internal_name text NOT NULL,
    channel_id text NOT NULL,
    message_id text NOT NULL,
    embeds_json text NOT NULL,
    announcement_json text NOT NULL,
    status text NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    buttons_json text DEFAULT '[]'::text NOT NULL
);

CREATE TABLE public.marketplace_configs (
    guild_id text NOT NULL,
    notice_channel_id text,
    notice_message_id text,
    log_channel_id text,
    server_options_json text NOT NULL,
    updated_at_ms bigint NOT NULL,
    notice_embed_json text DEFAULT '{"title":"💼 Marketplace Noticeboard","description":"Create a Marketplace Post. Click the button below to start.","color":3447003,"buttonLabel":"Create Marketplace Post","buttonEmoji":"💼"}'::text NOT NULL,
    server_choice_enabled bigint DEFAULT 1 NOT NULL,
    additional_choices_enabled bigint DEFAULT 0 NOT NULL,
    additional_choices_json text DEFAULT '[]'::text NOT NULL,
    flow_updated_at_ms bigint DEFAULT 0 NOT NULL,
    enabled bigint DEFAULT 1 NOT NULL
);

CREATE TABLE public.marketplace_posts (
    guild_id text NOT NULL,
    post_id text NOT NULL,
    owner_id text NOT NULL,
    owner_display_name text NOT NULL,
    trade_type text NOT NULL,
    server_id text NOT NULL,
    server_label text NOT NULL,
    have text NOT NULL,
    want text NOT NULL,
    extra text NOT NULL,
    channel_id text NOT NULL,
    message_id text,
    active bigint NOT NULL,
    created_at_ms bigint NOT NULL,
    closed_at_ms bigint,
    closed_by_user_id text,
    additional_choices_json text DEFAULT '[]'::text NOT NULL
);

CREATE TABLE public.marketplace_trade_logs (
    guild_id text NOT NULL,
    log_id text NOT NULL,
    timestamp_ms bigint NOT NULL,
    buyer_id text NOT NULL,
    buyer_display_name text NOT NULL,
    seller_id text NOT NULL,
    post_id text NOT NULL,
    channel_id text NOT NULL,
    message_id text,
    trade_type text NOT NULL,
    server_label text NOT NULL,
    dm_sent bigint NOT NULL,
    dm_error text,
    have text NOT NULL,
    want text NOT NULL
);

CREATE TABLE public.member_verification_attempts (
    id text NOT NULL,
    guild_id text NOT NULL,
    user_id text NOT NULL,
    message_id text,
    channel_id text,
    created_at_ms bigint NOT NULL,
    expires_at_ms bigint NOT NULL,
    used_at_ms bigint
);

CREATE TABLE public.member_verification_configs (
    guild_id text NOT NULL,
    enabled bigint DEFAULT 0 NOT NULL,
    verified_role_id text,
    title text DEFAULT 'Welcome'::text NOT NULL,
    description text DEFAULT 'Welcome to the Guild! Please verify to gain access.'::text NOT NULL,
    color bigint DEFAULT 5793266 NOT NULL,
    image_url text,
    thumbnail_url text,
    rules_url text,
    updated_at_ms bigint NOT NULL,
    delivery_mode text DEFAULT 'dm'::text NOT NULL,
    welcome_channel_id text,
    panel_message_id text,
    verify_button_emoji text,
    verification_method text DEFAULT 'discord-button'::text NOT NULL
);

CREATE TABLE public.member_verification_manual_dm_rate_limits (
    guild_id text NOT NULL,
    scope_type text NOT NULL,
    scope_id text NOT NULL,
    window_started_at_ms bigint NOT NULL,
    attempt_count bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT member_verification_manual_dm_rate_limits_scope_type_check CHECK ((scope_type = ANY (ARRAY['guild'::text, 'actor'::text, 'target'::text])))
);

CREATE TABLE public.member_verification_states (
    guild_id text NOT NULL,
    user_id text NOT NULL,
    verified_at_ms bigint NOT NULL
);

CREATE TABLE public.mention_protection_action_outcomes (
    guild_id text NOT NULL,
    message_id text NOT NULL,
    action text NOT NULL,
    status text NOT NULL,
    detail text,
    retryable bigint DEFAULT 0 NOT NULL,
    attempt_count bigint DEFAULT 1 NOT NULL,
    updated_at_ms bigint NOT NULL
);

CREATE TABLE public.mention_protection_breaches (
    guild_id text NOT NULL,
    message_id text NOT NULL,
    user_id text NOT NULL,
    channel_id text NOT NULL,
    protection text NOT NULL,
    condition text NOT NULL,
    stage text NOT NULL,
    response_policy_json text NOT NULL,
    evidence_json text NOT NULL,
    content_snapshot text NOT NULL,
    message_created_at_ms bigint NOT NULL,
    breached_at_ms bigint NOT NULL
);

CREATE TABLE public.mention_protection_burst_events (
    guild_id text NOT NULL,
    user_id text NOT NULL,
    message_id text NOT NULL,
    message_timestamp_ms bigint NOT NULL
);

CREATE TABLE public.mention_protection_configs (
    guild_id text NOT NULL,
    admin_enabled bigint DEFAULT 0 NOT NULL,
    spam_enabled bigint DEFAULT 0 NOT NULL,
    protected_admin_role_ids_json text DEFAULT '[]'::text NOT NULL,
    channel_mode text DEFAULT 'exclude'::text NOT NULL,
    channel_ids_json text DEFAULT '[]'::text NOT NULL,
    excluded_role_ids_json text DEFAULT '[]'::text NOT NULL,
    mass_mention_threshold bigint DEFAULT 5 NOT NULL,
    burst_message_threshold bigint DEFAULT 5 NOT NULL,
    burst_window_seconds bigint DEFAULT 10 NOT NULL,
    admin_repeat_period_ms bigint DEFAULT 86400000 NOT NULL,
    spam_repeat_period_ms bigint DEFAULT 86400000 NOT NULL,
    admin_initial_response_json text NOT NULL,
    admin_repeat_response_json text NOT NULL,
    spam_initial_response_json text NOT NULL,
    spam_repeat_response_json text NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL
);

CREATE TABLE public.mention_protection_escalations (
    guild_id text NOT NULL,
    user_id text NOT NULL,
    protection text NOT NULL,
    last_breach_at_ms bigint NOT NULL
);

CREATE TABLE public.message_templates (
    id text NOT NULL,
    guild_id text NOT NULL,
    internal_name text NOT NULL,
    embeds_json text NOT NULL,
    available_for_ticket_replies bigint DEFAULT 0 NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL
);

CREATE TABLE public.one_time_tokens (
    nonce text NOT NULL,
    expires_at_ms bigint NOT NULL,
    consumed_at_ms bigint NOT NULL
);

CREATE TABLE public.operational_incident_events (
    id text NOT NULL,
    incident_id text NOT NULL,
    guild_id text NOT NULL,
    event_type text NOT NULL,
    observation_id text,
    reason_code text,
    safe_args_json text NOT NULL,
    correlation_id text,
    actor_user_id text,
    created_at_ms bigint NOT NULL,
    CONSTRAINT operational_incident_events_event_type_check CHECK ((event_type = ANY (ARRAY['opened'::text, 'observed'::text, 'severity_changed'::text, 'remediation_started'::text, 'remediation_succeeded'::text, 'remediation_failed'::text, 'resolved'::text, 'reopened'::text])))
);

CREATE TABLE public.operational_incidents (
    id text NOT NULL,
    guild_id text NOT NULL,
    incident_key text NOT NULL,
    feature text NOT NULL,
    resource_kind text NOT NULL,
    resource_id text NOT NULL,
    condition text NOT NULL,
    severity text NOT NULL,
    status text NOT NULL,
    summary_code text NOT NULL,
    safe_args_json text NOT NULL,
    remediation_code text NOT NULL,
    first_seen_at_ms bigint NOT NULL,
    open_since_ms bigint NOT NULL,
    last_seen_at_ms bigint NOT NULL,
    resolved_at_ms bigint,
    occurrence_count bigint DEFAULT 1 NOT NULL,
    last_correlation_id text,
    version bigint DEFAULT 1 NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT operational_incidents_feature_check CHECK ((feature = ANY (ARRAY['managed-messages'::text, 'webhooks'::text, 'player-count'::text]))),
    CONSTRAINT operational_incidents_severity_check CHECK ((severity = ANY (ARRAY['warning'::text, 'error'::text, 'critical'::text]))),
    CONSTRAINT operational_incidents_status_check CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text])))
);

CREATE TABLE public.pending_platform_links (
    state text NOT NULL,
    guild_id text NOT NULL,
    user_id text NOT NULL,
    platform text NOT NULL,
    created_at_ms bigint NOT NULL
);

CREATE TABLE public.pending_suggestion_submissions (
    id text NOT NULL,
    guild_id text NOT NULL,
    author_id text NOT NULL,
    title text NOT NULL,
    answers_json text NOT NULL,
    category text,
    likely_duplicate_ids_json text NOT NULL,
    expires_at_ms bigint NOT NULL
);

CREATE TABLE public.platform_link_configs (
    guild_id text NOT NULL,
    platform text NOT NULL,
    linked_role_id text,
    log_channel_id text,
    game_app_ids_json text DEFAULT '[]'::text NOT NULL,
    panel_title text DEFAULT 'Link your account'::text NOT NULL,
    panel_description text DEFAULT 'Click the button below to securely link your Discord account.'::text NOT NULL,
    panel_button_label text DEFAULT 'Link'::text NOT NULL,
    panel_button_style text DEFAULT 'Primary'::text NOT NULL,
    allow_relink bigint DEFAULT 1 NOT NULL,
    allow_multiple_links bigint DEFAULT 0 NOT NULL,
    whois_fields_json text DEFAULT '[]'::text NOT NULL,
    custom_links_json text,
    panel_channel_id text,
    panel_message_id text,
    updated_at_ms bigint DEFAULT 0 NOT NULL,
    panel_color bigint,
    require_relink_on_rejoin bigint DEFAULT 0 NOT NULL,
    enabled bigint DEFAULT 1 NOT NULL
);

CREATE TABLE public.platform_links (
    guild_id text NOT NULL,
    user_id text NOT NULL,
    platform text NOT NULL,
    platform_id text NOT NULL,
    linked_at_ms bigint NOT NULL,
    manual bigint DEFAULT 0 NOT NULL,
    actioned_by_user_id text,
    metadata_json text,
    active bigint DEFAULT 1 NOT NULL
);

CREATE TABLE public.player_count_servers (
    id text NOT NULL,
    guild_id text NOT NULL,
    name text NOT NULL,
    provider text NOT NULL,
    provider_server_id text NOT NULL,
    channel_id text,
    display_format text DEFAULT '🎮 Players: {count}/{max}'::text NOT NULL,
    offline_format text DEFAULT '🎮 Players: Offline'::text NOT NULL,
    rename_offset_minutes bigint DEFAULT 0 NOT NULL,
    last_renamed_at_ms bigint,
    last_player_count bigint,
    last_max_slots bigint,
    last_queue_size bigint,
    last_fetched_at_ms bigint,
    steam_host text,
    steam_port bigint,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    refresh_interval_minutes bigint DEFAULT 10 NOT NULL,
    consecutive_failure_count bigint DEFAULT 0 NOT NULL,
    last_error_message text,
    last_error_at_ms bigint,
    alert_channel_id text,
    failure_threshold bigint DEFAULT 3 NOT NULL,
    enabled bigint DEFAULT 1 NOT NULL
);

CREATE TABLE public.player_count_streak_reports (
    report_key text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.product_analytics_preferences (
    guild_id text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    updated_at_ms bigint NOT NULL
);

CREATE TABLE public.reaction_limit_breach_counters (
    guild_id text NOT NULL,
    user_id text NOT NULL,
    breach_count bigint DEFAULT 0 NOT NULL
);

CREATE TABLE public.reaction_limit_configs (
    guild_id text NOT NULL,
    limits_enabled boolean DEFAULT false NOT NULL,
    max_reactions_per_message integer,
    max_reactions_per_user_per_message integer,
    breach_threshold integer,
    breach_role_id text,
    breach_role_duration_ms bigint,
    breach_dm_text text,
    channel_mode text DEFAULT 'include'::text NOT NULL,
    channel_ids_json text DEFAULT '[]'::text NOT NULL
);

CREATE TABLE public.reaction_limit_message_reaction_counts (
    guild_id text NOT NULL,
    channel_id text NOT NULL,
    message_id text NOT NULL,
    reaction_count bigint DEFAULT 0 NOT NULL,
    updated_at_ms bigint DEFAULT 0 NOT NULL
);

CREATE TABLE public.reaction_limit_user_message_reaction_counts (
    guild_id text NOT NULL,
    channel_id text NOT NULL,
    message_id text NOT NULL,
    user_id text NOT NULL,
    reaction_count bigint DEFAULT 0 NOT NULL,
    updated_at_ms bigint DEFAULT 0 NOT NULL
);

CREATE TABLE public.reaction_role_leases (
    guild_id text NOT NULL,
    token text NOT NULL,
    expires_at_ms bigint NOT NULL
);

CREATE TABLE public.reaction_role_panels (
    guild_id text NOT NULL,
    id text NOT NULL,
    bot_user_id text NOT NULL,
    channel_id text NOT NULL,
    message_id text,
    title text NOT NULL,
    description text NOT NULL,
    options_json text NOT NULL,
    published_options_json text DEFAULT '[]'::text NOT NULL,
    activated_at_ms bigint,
    enabled bigint DEFAULT 0 NOT NULL,
    sort_order bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    mode text DEFAULT 'multiple'::text NOT NULL,
    required_role_ids_json text DEFAULT '[]'::text NOT NULL,
    blocked_role_ids_json text DEFAULT '[]'::text NOT NULL
);

CREATE TABLE public.reputation_awards (
    guild_id text NOT NULL,
    interaction_id text NOT NULL,
    giver_id text,
    recipient_id text,
    reason text,
    total_score integer DEFAULT 0 NOT NULL,
    created_at_ms bigint NOT NULL,
    CONSTRAINT reputation_awards_reason_check CHECK ((length(reason) <= 300)),
    CONSTRAINT reputation_awards_total_score_check CHECK ((total_score >= 0))
);

CREATE TABLE public.reputation_configs (
    guild_id text NOT NULL,
    settings_json jsonb NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    CONSTRAINT reputation_configs_revision_check CHECK ((revision >= 0))
);

CREATE TABLE public.reputation_cooldowns (
    guild_id text NOT NULL,
    giver_id text NOT NULL,
    next_award_at_ms bigint NOT NULL
);

CREATE TABLE public.reputation_reward_jobs (
    guild_id text NOT NULL,
    user_id text NOT NULL,
    role_id text NOT NULL,
    threshold integer NOT NULL,
    next_attempt_at_ms bigint DEFAULT 0 NOT NULL,
    delivered_at_ms bigint,
    CONSTRAINT reputation_reward_jobs_threshold_check CHECK ((threshold > 0))
);

CREATE TABLE public.reputation_scores (
    guild_id text NOT NULL,
    user_id text NOT NULL,
    score integer DEFAULT 0 NOT NULL,
    current_member boolean DEFAULT true NOT NULL,
    CONSTRAINT reputation_scores_score_check CHECK ((score >= 0))
);

CREATE TABLE public.scheduler_leases (
    name text NOT NULL,
    owner_id text NOT NULL,
    lease_token text NOT NULL,
    fencing_generation bigint NOT NULL,
    lease_expires_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT scheduler_leases_fencing_generation_check CHECK ((fencing_generation > 0))
);

CREATE TABLE public.scheduler_task_state (
    name text NOT NULL,
    last_started_at timestamp with time zone,
    last_completed_at timestamp with time zone,
    last_outcome text,
    last_lease_generation bigint,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.server_level_announcement_outbox (
    announcement_id text NOT NULL,
    guild_id text NOT NULL,
    user_id text NOT NULL,
    channel_id text NOT NULL,
    level integer NOT NULL,
    created_at_ms bigint NOT NULL,
    delivered_at_ms bigint,
    terminal_reason text
);

CREATE TABLE public.server_level_awards (
    award_id text NOT NULL,
    guild_id text NOT NULL,
    user_id text NOT NULL,
    configured_game_server_id text,
    source_inbox_id text,
    kind text NOT NULL,
    interval_started_at_ms bigint,
    interval_ended_at_ms bigint,
    qualifying_seconds integer DEFAULT 0 NOT NULL,
    multiplier integer,
    xp_units bigint NOT NULL,
    scoring_policy_version integer NOT NULL,
    actor_user_id text,
    reason text,
    created_at_ms bigint NOT NULL,
    projection_applied_at_ms bigint
);

CREATE TABLE public.server_level_configs (
    guild_id text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    announcement_channel_id text,
    removed_at_ms bigint,
    updated_at_ms bigint NOT NULL
);

CREATE TABLE public.server_level_credentials (
    credential_id text NOT NULL,
    guild_id text NOT NULL,
    configured_game_server_id text NOT NULL,
    purpose text NOT NULL,
    key_version text NOT NULL,
    nonce text NOT NULL,
    ciphertext text NOT NULL,
    fingerprint text NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT server_level_credentials_purpose_check CHECK ((purpose = ANY (ARRAY['webhook_secret'::text, 'data_api'::text])))
);

CREATE TABLE public.server_level_current_presence (
    configured_game_server_id text NOT NULL,
    steam_id64 text NOT NULL,
    lifecycle_generation integer NOT NULL,
    joined_at_ms bigint NOT NULL,
    last_confirmed_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL
);

CREATE TABLE public.server_level_daily_summaries (
    guild_id text NOT NULL,
    user_id text NOT NULL,
    day_utc text NOT NULL,
    xp_units bigint NOT NULL,
    qualifying_seconds integer NOT NULL,
    scoring_policy_version integer NOT NULL,
    created_at_ms bigint NOT NULL
);

CREATE TABLE public.server_level_earning_sessions (
    session_id text NOT NULL,
    guild_id text NOT NULL,
    configured_game_server_id text NOT NULL,
    steam_id64 text NOT NULL,
    user_id text NOT NULL,
    lifecycle_generation integer NOT NULL,
    started_at_ms bigint NOT NULL,
    last_confirmed_at_ms bigint NOT NULL,
    checkpoint_at_ms bigint NOT NULL,
    closed_at_ms bigint,
    close_reason text,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL
);

CREATE TABLE public.server_level_ingress_outbox (
    inbox_id text NOT NULL,
    guild_id text NOT NULL,
    created_at_ms bigint NOT NULL,
    published_at_ms bigint
);

CREATE TABLE public.server_level_member_totals (
    guild_id text NOT NULL,
    user_id text NOT NULL,
    total_xp_units bigint DEFAULT 0 NOT NULL,
    current_member boolean DEFAULT true NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT server_level_member_totals_total_xp_units_check CHECK ((total_xp_units >= 0))
);

CREATE TABLE public.server_level_processing_cursors (
    configured_game_server_id text NOT NULL,
    latest_seen_at_ms bigint NOT NULL,
    watermark_at_ms bigint NOT NULL,
    last_delivery_id text NOT NULL,
    population integer,
    queue_size integer,
    lifecycle_generation integer DEFAULT 0 NOT NULL,
    updated_at_ms bigint NOT NULL
);

CREATE TABLE public.server_level_processing_leases (
    configured_game_server_id text NOT NULL,
    lease_id text NOT NULL,
    expires_at_ms bigint NOT NULL
);

CREATE TABLE public.server_level_servers (
    id text NOT NULL,
    guild_id text NOT NULL,
    display_name text NOT NULL,
    provider_server_id text NOT NULL,
    max_slots integer NOT NULL,
    endpoint_id text NOT NULL,
    webhook_credential_id text NOT NULL,
    webhook_verified_at_ms bigint,
    subscribed_events_json text DEFAULT '[]'::text NOT NULL,
    capacity_proposal_json text,
    last_roster_reconciled_at_ms bigint,
    last_capacity_checked_at_ms bigint,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT server_level_servers_max_slots_check CHECK (((max_slots >= 1) AND (max_slots <= 10000)))
);

CREATE TABLE public.server_level_webhook_inbox (
    inbox_id text NOT NULL,
    delivery_id text NOT NULL,
    configured_game_server_id text NOT NULL,
    guild_id text NOT NULL,
    event_type text NOT NULL,
    occurred_at_ms bigint NOT NULL,
    steam_id64 text,
    population integer,
    queue_size integer,
    status text DEFAULT 'accepted'::text NOT NULL,
    reason_code text,
    received_at_ms bigint NOT NULL,
    body_sha256 text,
    processed_at_ms bigint,
    CONSTRAINT server_level_webhook_inbox_body_sha256_check CHECK (((body_sha256 IS NULL) OR (length(body_sha256) = 64)))
);

CREATE TABLE public.steam_ban_lookup_cache (
    steam_id64 text NOT NULL,
    entry_json jsonb NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.suggestion_action_rate_limits (
    guild_id text NOT NULL,
    actor_user_id text NOT NULL,
    action text NOT NULL,
    window_start_ms bigint NOT NULL,
    count bigint DEFAULT 1 NOT NULL,
    updated_at_ms bigint NOT NULL
);

CREATE TABLE public.suggestion_digest_runs (
    guild_id text NOT NULL,
    period_key text NOT NULL,
    status text NOT NULL,
    delivered_message_id text,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL
);

CREATE TABLE public.suggestion_revisions (
    id text NOT NULL,
    suggestion_id text NOT NULL,
    guild_id text NOT NULL,
    revision bigint NOT NULL,
    title text NOT NULL,
    answers_json text NOT NULL,
    category text,
    edited_by_user_id text NOT NULL,
    created_at_ms bigint NOT NULL
);

CREATE TABLE public.suggestion_status_events (
    id text NOT NULL,
    suggestion_id text NOT NULL,
    guild_id text NOT NULL,
    from_status text NOT NULL,
    to_status text NOT NULL,
    actor_user_id text NOT NULL,
    reason text,
    created_at_ms bigint NOT NULL,
    outcome_json text
);

CREATE TABLE public.suggestion_votes (
    suggestion_id text NOT NULL,
    guild_id text NOT NULL,
    member_id text NOT NULL,
    value text NOT NULL,
    active bigint DEFAULT 1 NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL
);

CREATE TABLE public.suggestions (
    id text NOT NULL,
    guild_id text NOT NULL,
    author_id text NOT NULL,
    title text NOT NULL,
    normalized_search_text text NOT NULL,
    answers_json text NOT NULL,
    category text,
    status text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    thread_id text,
    starter_message_id text,
    projection_error text,
    support_count bigint DEFAULT 0 NOT NULL,
    oppose_count bigint DEFAULT 0 NOT NULL,
    outcome_json text,
    created_at_ms bigint NOT NULL,
    edited_at_ms bigint,
    updated_at_ms bigint NOT NULL
);

CREATE TABLE public.suggestions_configs (
    guild_id text NOT NULL,
    enabled bigint DEFAULT 0 NOT NULL,
    forum_channel_id text,
    panel_channel_id text,
    panel_message_id text,
    panel_title text NOT NULL,
    panel_body text NOT NULL,
    panel_button_text text NOT NULL,
    prompts_json text NOT NULL,
    categories_json text DEFAULT '[]'::text NOT NULL,
    status_tag_ids_json text DEFAULT '{}'::text NOT NULL,
    category_tag_ids_json text DEFAULT '{}'::text NOT NULL,
    reply_webhook_id text,
    reply_webhook_credential_id text,
    mod_role_ids_json text DEFAULT '[]'::text NOT NULL,
    mod_queue_channel_id text,
    voter_role_id text,
    minimum_tenure_days bigint DEFAULT 0 NOT NULL,
    collapse_threshold bigint DEFAULT 3 NOT NULL,
    submission_cooldown_seconds bigint DEFAULT 300 NOT NULL,
    active_suggestion_limit bigint DEFAULT 3 NOT NULL,
    digest_enabled bigint DEFAULT 0 NOT NULL,
    digest_channel_id text,
    digest_cadence_days bigint DEFAULT 7 NOT NULL,
    updated_at_ms bigint NOT NULL
);

CREATE TABLE public.ticket_claim_deliveries (
    guild_id text NOT NULL,
    channel_id text NOT NULL,
    claimed_by_user_id text NOT NULL,
    claimed_at_ms bigint NOT NULL,
    phase text NOT NULL,
    state text NOT NULL,
    lease_until_ms bigint
);

CREATE TABLE public.ticket_counters (
    guild_id text NOT NULL,
    next_ticket_number bigint NOT NULL
);

CREATE TABLE public.ticket_instances (
    guild_id text NOT NULL,
    channel_id text NOT NULL,
    ticket_type_id text NOT NULL,
    ticket_type_label text NOT NULL,
    opener_user_id text NOT NULL,
    support_role_id text,
    status text NOT NULL,
    answers_json text NOT NULL,
    opened_at_ms bigint NOT NULL,
    closed_at_ms bigint,
    closed_by_user_id text,
    transcript_message_id text,
    staff_thread_id text,
    claimed_by_user_id text,
    claimed_at_ms bigint,
    panel_id text DEFAULT 'main'::text,
    opening_message_id text
);

CREATE TABLE public.ticket_panels (
    guild_id text NOT NULL,
    panel_id text DEFAULT 'main'::text NOT NULL,
    panel_name text DEFAULT 'Main panel'::text NOT NULL,
    panel_channel_id text NOT NULL,
    category_channel_id text NOT NULL,
    transcript_channel_id text NOT NULL,
    panel_message_id text,
    ticket_types_json text NOT NULL,
    ticket_creation_limit bigint,
    ticket_limit_rejection_message text,
    enable_ticket_claiming bigint DEFAULT 0 NOT NULL,
    ai_transcript_summaries_enabled bigint DEFAULT 0 NOT NULL
);

CREATE TABLE public.ticket_participant_events (
    id text NOT NULL,
    guild_id text NOT NULL,
    ticket_channel_id text NOT NULL,
    ticket_type_id text NOT NULL,
    action text NOT NULL,
    target_user_id text NOT NULL,
    actor_user_id text NOT NULL,
    created_at_ms bigint NOT NULL,
    notification_state text DEFAULT 'pending'::text NOT NULL,
    notification_claimed_at_ms bigint,
    CONSTRAINT ticket_participant_events_action_check CHECK ((action = ANY (ARRAY['participant-added'::text, 'participant-removed'::text]))),
    CONSTRAINT ticket_participant_events_notification_state_check CHECK ((notification_state = ANY (ARRAY['pending'::text, 'delivering'::text, 'delivered'::text])))
);

CREATE TABLE public.ticket_participants (
    guild_id text NOT NULL,
    ticket_channel_id text NOT NULL,
    user_id text NOT NULL,
    added_event_id text NOT NULL,
    added_by_user_id text NOT NULL,
    added_at_ms bigint NOT NULL
);

CREATE TABLE public.ticket_staff_messages (
    id bigint NOT NULL,
    guild_id text NOT NULL,
    ticket_channel_id text NOT NULL,
    staff_thread_id text NOT NULL,
    staff_message_id text NOT NULL,
    bot_message_id text NOT NULL,
    staff_user_id text NOT NULL,
    staff_display_name text NOT NULL,
    content text NOT NULL,
    created_at_ms bigint NOT NULL,
    delivery_status text DEFAULT 'sent'::text NOT NULL
);

CREATE SEQUENCE public.ticket_staff_messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.ticket_staff_messages_id_seq OWNED BY public.ticket_staff_messages.id;

CREATE TABLE public.ticket_template_replies (
    interaction_id text NOT NULL,
    guild_id text NOT NULL,
    ticket_channel_id text NOT NULL,
    template_id text NOT NULL,
    template_internal_name text NOT NULL,
    staff_user_id text NOT NULL,
    bot_message_id text,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at_ms bigint NOT NULL
);

CREATE TABLE public.ticket_transcript_capabilities (
    object_id text NOT NULL,
    guild_id text NOT NULL,
    channel_id text NOT NULL,
    access_token_hash text NOT NULL,
    created_at_ms bigint NOT NULL,
    expires_at_ms bigint NOT NULL,
    revoked_at_ms bigint,
    discarded_at_ms bigint,
    retention_expires_at_ms bigint NOT NULL,
    last_accessed_at_ms bigint,
    access_count bigint DEFAULT 0 NOT NULL
);

CREATE TABLE public.timed_role_config_rules (
    guild_id text NOT NULL,
    config_type text NOT NULL,
    role_id text NOT NULL,
    duration_input text NOT NULL,
    dm_message text,
    updated_at_ms bigint NOT NULL,
    suspended_role_ids_json text DEFAULT '[]'::text NOT NULL,
    enabled bigint DEFAULT 1 NOT NULL
);

CREATE TABLE public.timed_roles (
    guild_id text NOT NULL,
    user_id text NOT NULL,
    role_id text NOT NULL,
    duration_input text NOT NULL,
    expires_at_ms bigint NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    target_display_name text,
    suspended_role_ids_json text DEFAULT '[]'::text NOT NULL,
    pending_suspension_role_ids_json text DEFAULT '[]'::text NOT NULL,
    removed_role_ids_json text DEFAULT '[]'::text NOT NULL,
    pending_restoration_role_ids_json text DEFAULT '[]'::text NOT NULL,
    restoration_started_at_ms bigint,
    target_role_removal_completed_at_ms bigint
);

CREATE TABLE public.user_preferences (
    user_id text NOT NULL,
    hidden_guild_ids_json text DEFAULT '[]'::text NOT NULL,
    default_guild_id text,
    email_notifications boolean DEFAULT true NOT NULL,
    push_notifications boolean DEFAULT false NOT NULL,
    compact_mode boolean DEFAULT false NOT NULL,
    theme text DEFAULT 'system'::text NOT NULL,
    language text DEFAULT 'en'::text NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT user_preferences_language_check CHECK ((language = ANY (ARRAY['en'::text, 'es'::text, 'de'::text, 'fr'::text]))),
    CONSTRAINT user_preferences_theme_check CHECK ((theme = ANY (ARRAY['system'::text, 'light'::text, 'dark'::text])))
);

CREATE TABLE public.wardogs_budgets (
    origin text NOT NULL,
    token text NOT NULL,
    lease_until_ms bigint NOT NULL,
    next_at_ms bigint NOT NULL,
    data text NOT NULL
);

CREATE TABLE public.wardogs_targets (
    id text NOT NULL,
    guild_id text NOT NULL,
    slot integer NOT NULL,
    generation integer NOT NULL,
    data text NOT NULL,
    CONSTRAINT wardogs_targets_generation_check CHECK ((generation > 0)),
    CONSTRAINT wardogs_targets_slot_check CHECK (((slot >= 0) AND (slot < 5)))
);

CREATE TABLE public.webhook_credentials (
    credential_id text NOT NULL,
    guild_id text NOT NULL,
    owner_kind text NOT NULL,
    public_id text NOT NULL,
    destination_id text,
    provider text NOT NULL,
    envelope_json text NOT NULL,
    fingerprint text NOT NULL,
    masked_display text NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT webhook_credentials_owner_kind_check CHECK ((owner_kind = ANY (ARRAY['proxy_destination'::text, 'ban_lookup_notification'::text]))),
    CONSTRAINT webhook_credentials_provider_check CHECK ((provider = 'discord'::text))
);

CREATE TABLE public.webhook_guard_buckets (
    scope_key text NOT NULL,
    tokens double precision NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT webhook_guard_buckets_tokens_check CHECK ((tokens >= (0)::double precision))
);

CREATE TABLE public.webhook_guard_counters (
    scope_key text NOT NULL,
    bucket_at timestamp with time zone NOT NULL,
    outcome text NOT NULL,
    count bigint NOT NULL,
    CONSTRAINT webhook_guard_counters_count_check CHECK ((count > 0))
);

CREATE TABLE public.webhook_guard_duplicates (
    scope_key text NOT NULL,
    sha256 text NOT NULL,
    expires_at timestamp with time zone NOT NULL
);

CREATE TABLE public.webhook_guard_leases (
    scope_key text NOT NULL,
    lease_id text NOT NULL,
    expires_at timestamp with time zone NOT NULL
);

CREATE TABLE public.webhook_proxy_configs (
    guild_id text NOT NULL,
    public_id text NOT NULL,
    name text NOT NULL,
    enabled bigint NOT NULL,
    destinations_json text NOT NULL,
    default_destination_ids_json text NOT NULL,
    routing_rules_json text NOT NULL,
    content_replacements_json text DEFAULT '[]'::text NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    ban_lookup_enabled bigint DEFAULT 0 NOT NULL,
    ban_lookup_app_ids_json text DEFAULT '[]'::text NOT NULL,
    ban_lookup_credential_id text
);

CREATE TABLE public.webhook_proxy_forward_logs (
    guild_id text NOT NULL,
    log_id text NOT NULL,
    public_id text NOT NULL,
    destination_id text NOT NULL,
    status bigint,
    ok bigint NOT NULL,
    attempt bigint NOT NULL,
    error text,
    timestamp_ms bigint NOT NULL,
    credential_fingerprint text
);

CREATE TABLE public.white_label_bots (
    guild_id text NOT NULL,
    application_id text NOT NULL,
    bot_user_id text NOT NULL,
    display_name text NOT NULL,
    brand_footer_text text,
    status text NOT NULL,
    token_secret_ref text NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL
);

ALTER TABLE ONLY public.bot_defense_rate_window_events ALTER COLUMN id SET DEFAULT nextval('public.bot_defense_rate_window_events_id_seq'::regclass);

ALTER TABLE ONLY public.ticket_staff_messages ALTER COLUMN id SET DEFAULT nextval('public.ticket_staff_messages_id_seq'::regclass);

ALTER TABLE ONLY public."Account"
    ADD CONSTRAINT "Account_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."Invitation"
    ADD CONSTRAINT "Invitation_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."Member"
    ADD CONSTRAINT "Member_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."Organization"
    ADD CONSTRAINT "Organization_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."Session"
    ADD CONSTRAINT "Session_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."User"
    ADD CONSTRAINT "User_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."Verification"
    ADD CONSTRAINT "Verification_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."WorkspaceEntitlement"
    ADD CONSTRAINT "WorkspaceEntitlement_pkey" PRIMARY KEY ("workspaceId");

ALTER TABLE ONLY public."WorkspaceGuildAuditEvent"
    ADD CONSTRAINT "WorkspaceGuildAuditEvent_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public."WorkspaceGuild"
    ADD CONSTRAINT "WorkspaceGuild_pkey" PRIMARY KEY ("workspaceId", "guildId");

ALTER TABLE ONLY public.admin_feedback
    ADD CONSTRAINT admin_feedback_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.admin_feedback
    ADD CONSTRAINT admin_feedback_reference_key UNIQUE (reference);

ALTER TABLE ONLY public.app_config
    ADD CONSTRAINT app_config_pkey PRIMARY KEY (key);

ALTER TABLE ONLY public.attendance_observation_reports
    ADD CONSTRAINT attendance_observation_reports_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.attendance_observation_runs
    ADD CONSTRAINT attendance_observation_runs_active_target_key UNIQUE (active_target);

ALTER TABLE ONLY public.attendance_observation_runs
    ADD CONSTRAINT attendance_observation_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.attendance_observation_samples
    ADD CONSTRAINT attendance_observation_samples_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.attendance_observation_samples
    ADD CONSTRAINT attendance_observation_samples_target_id_generation_slot_key UNIQUE (target_id, generation, slot);

ALTER TABLE ONLY public.ban_case_configs
    ADD CONSTRAINT ban_case_configs_pkey PRIMARY KEY (guild_id);

ALTER TABLE ONLY public.ban_case_confirmations
    ADD CONSTRAINT ban_case_confirmations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ban_case_operation_projections
    ADD CONSTRAINT ban_case_operation_projections_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ban_case_operational_incident_events
    ADD CONSTRAINT ban_case_operational_incident_ev_incident_id_observation_id_key UNIQUE (incident_id, observation_id);

ALTER TABLE ONLY public.ban_case_operational_incident_events
    ADD CONSTRAINT ban_case_operational_incident_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ban_case_operational_incidents
    ADD CONSTRAINT ban_case_operational_incidents_guild_id_incident_key_key UNIQUE (guild_id, incident_key);

ALTER TABLE ONLY public.ban_case_operational_incidents
    ADD CONSTRAINT ban_case_operational_incidents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ban_case_operations
    ADD CONSTRAINT ban_case_operations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ban_case_sources
    ADD CONSTRAINT ban_case_sources_pkey PRIMARY KEY (guild_id, source_id);

ALTER TABLE ONLY public.ban_cases
    ADD CONSTRAINT ban_cases_pkey PRIMARY KEY (guild_id, case_id);

ALTER TABLE ONLY public.billing_customer_bindings
    ADD CONSTRAINT billing_customer_bindings_pkey PRIMARY KEY (owner_id);

ALTER TABLE ONLY public.billing_customer_bindings
    ADD CONSTRAINT billing_customer_bindings_stripe_customer_id_key UNIQUE (stripe_customer_id);

ALTER TABLE ONLY public.billing_delivery_attempts
    ADD CONSTRAINT billing_delivery_attempts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.billing_delivery_outbox
    ADD CONSTRAINT billing_delivery_outbox_pkey PRIMARY KEY (operation_id);

ALTER TABLE ONLY public.billing_guild_assignments
    ADD CONSTRAINT billing_guild_assignments_pkey PRIMARY KEY (guild_id);

ALTER TABLE ONLY public.billing_operation_delivery
    ADD CONSTRAINT billing_operation_delivery_pkey PRIMARY KEY (operation_id);

ALTER TABLE ONLY public.billing_operations_ledger
    ADD CONSTRAINT billing_operations_ledger_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.billing_owner_sync_state
    ADD CONSTRAINT billing_owner_sync_state_pkey PRIMARY KEY (owner_id);

ALTER TABLE ONLY public.billing_reconciliation_failures
    ADD CONSTRAINT billing_reconciliation_failures_pkey PRIMARY KEY (owner_id);

ALTER TABLE ONLY public.billing_subscriptions
    ADD CONSTRAINT billing_subscriptions_pkey PRIMARY KEY (owner_id);

ALTER TABLE ONLY public.billing_subscriptions
    ADD CONSTRAINT billing_subscriptions_stripe_customer_id_key UNIQUE (stripe_customer_id);

ALTER TABLE ONLY public.billing_subscriptions
    ADD CONSTRAINT billing_subscriptions_stripe_subscription_id_key UNIQUE (stripe_subscription_id);

ALTER TABLE ONLY public.billing_support_cases
    ADD CONSTRAINT billing_support_cases_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.billing_sync_outbox
    ADD CONSTRAINT billing_sync_outbox_pkey PRIMARY KEY (event_id);

ALTER TABLE ONLY public.billing_tester_cutovers
    ADD CONSTRAINT billing_tester_cutovers_pkey PRIMARY KEY (owner_id);

ALTER TABLE ONLY public.billing_webhook_events
    ADD CONSTRAINT billing_webhook_events_pkey PRIMARY KEY (event_id);

ALTER TABLE ONLY public.bot_defense_configs
    ADD CONSTRAINT bot_defense_configs_pkey PRIMARY KEY (guild_id);

ALTER TABLE ONLY public.bot_defense_rate_window_events
    ADD CONSTRAINT bot_defense_rate_window_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.bot_flags
    ADD CONSTRAINT bot_flags_pkey PRIMARY KEY (guild_id, user_id);

ALTER TABLE ONLY public.clan_applications
    ADD CONSTRAINT clan_applications_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.clan_change_requests
    ADD CONSTRAINT clan_change_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.clan_history
    ADD CONSTRAINT clan_history_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.clan_invitations
    ADD CONSTRAINT clan_invitations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.clan_management_configs
    ADD CONSTRAINT clan_management_configs_pkey PRIMARY KEY (guild_id);

ALTER TABLE ONLY public.clan_membership_blocks
    ADD CONSTRAINT clan_membership_blocks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.clan_memberships
    ADD CONSTRAINT clan_memberships_pkey PRIMARY KEY (clan_id, user_id, joined_at_ms);

ALTER TABLE ONLY public.clan_ownership_transfers
    ADD CONSTRAINT clan_ownership_transfers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.clan_requests
    ADD CONSTRAINT clan_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.clans
    ADD CONSTRAINT clans_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.clans
    ADD CONSTRAINT clans_request_id_key UNIQUE (request_id);

ALTER TABLE ONLY public.commerce_authority_grants
    ADD CONSTRAINT commerce_authority_grants_pkey PRIMARY KEY (connected_account_id, discord_user_id, capability);

ALTER TABLE ONLY public.commerce_buyers
    ADD CONSTRAINT commerce_buyers_discord_user_id_key UNIQUE (discord_user_id);

ALTER TABLE ONLY public.commerce_buyers
    ADD CONSTRAINT commerce_buyers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commerce_checkout_attempts
    ADD CONSTRAINT commerce_checkout_attempts_connected_account_id_stripe_chec_key UNIQUE (connected_account_id, stripe_checkout_session_id);

ALTER TABLE ONLY public.commerce_checkout_attempts
    ADD CONSTRAINT commerce_checkout_attempts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commerce_checkout_capacity_claims
    ADD CONSTRAINT commerce_checkout_capacity_claims_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commerce_checkout_rate_limits
    ADD CONSTRAINT commerce_checkout_rate_limits_pkey PRIMARY KEY (buyer_id, offering_id);

ALTER TABLE ONLY public.commerce_connected_accounts
    ADD CONSTRAINT commerce_connected_accounts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commerce_customers
    ADD CONSTRAINT commerce_customers_connected_account_id_buyer_id_key UNIQUE (connected_account_id, buyer_id);

ALTER TABLE ONLY public.commerce_customers
    ADD CONSTRAINT commerce_customers_connected_account_id_stripe_customer_id_key UNIQUE (connected_account_id, stripe_customer_id);

ALTER TABLE ONLY public.commerce_customers
    ADD CONSTRAINT commerce_customers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commerce_delivery_outbox
    ADD CONSTRAINT commerce_delivery_outbox_operation_id_destination_type_dest_key UNIQUE (operation_id, destination_type, destination_id);

ALTER TABLE ONLY public.commerce_delivery_outbox
    ADD CONSTRAINT commerce_delivery_outbox_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commerce_disputes
    ADD CONSTRAINT commerce_disputes_connected_account_id_stripe_dispute_id_key UNIQUE (connected_account_id, stripe_dispute_id);

ALTER TABLE ONLY public.commerce_disputes
    ADD CONSTRAINT commerce_disputes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commerce_entitlements
    ADD CONSTRAINT commerce_entitlements_connected_account_id_source_type_sour_key UNIQUE (connected_account_id, source_type, source_id);

ALTER TABLE ONLY public.commerce_entitlements
    ADD CONSTRAINT commerce_entitlements_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commerce_financial_actions
    ADD CONSTRAINT commerce_financial_actions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commerce_financial_provider_actions
    ADD CONSTRAINT commerce_financial_provider_actions_operation_key_key UNIQUE (operation_key);

ALTER TABLE ONLY public.commerce_financial_provider_actions
    ADD CONSTRAINT commerce_financial_provider_actions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commerce_game_assignments
    ADD CONSTRAINT commerce_game_assignments_physical_target_slot_key UNIQUE (physical_target, slot);

ALTER TABLE ONLY public.commerce_game_assignments
    ADD CONSTRAINT commerce_game_assignments_physical_target_subject_key UNIQUE (physical_target, subject);

ALTER TABLE ONLY public.commerce_game_assignments
    ADD CONSTRAINT commerce_game_assignments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commerce_game_audit
    ADD CONSTRAINT commerce_game_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commerce_game_fulfillments
    ADD CONSTRAINT commerce_game_fulfillments_pkey PRIMARY KEY (offering_id);

ALTER TABLE ONLY public.commerce_game_selections
    ADD CONSTRAINT commerce_game_selections_pkey PRIMARY KEY (checkout_id);

ALTER TABLE ONLY public.commerce_guild_deletion_refund_reviews
    ADD CONSTRAINT commerce_guild_deletion_refun_connected_account_id_subscrip_key UNIQUE (connected_account_id, subscription_id);

ALTER TABLE ONLY public.commerce_guild_deletion_refund_reviews
    ADD CONSTRAINT commerce_guild_deletion_refund_reviews_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commerce_incidents
    ADD CONSTRAINT commerce_incidents_guild_id_incident_key_key UNIQUE (guild_id, incident_key);

ALTER TABLE ONLY public.commerce_incidents
    ADD CONSTRAINT commerce_incidents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commerce_limit_alerts
    ADD CONSTRAINT commerce_limit_alerts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commerce_offering_retirements
    ADD CONSTRAINT commerce_offering_retirements_offering_id_key UNIQUE (offering_id);

ALTER TABLE ONLY public.commerce_offering_retirements
    ADD CONSTRAINT commerce_offering_retirements_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commerce_offerings
    ADD CONSTRAINT commerce_offerings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commerce_operational_controls
    ADD CONSTRAINT commerce_operational_controls_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commerce_operational_controls
    ADD CONSTRAINT commerce_operational_controls_scope_type_scope_id_control_t_key UNIQUE (scope_type, scope_id, control_type);

ALTER TABLE ONLY public.commerce_operations_ledger
    ADD CONSTRAINT commerce_operations_ledger_guild_id_operation_key_key UNIQUE (guild_id, operation_key);

ALTER TABLE ONLY public.commerce_operations_ledger
    ADD CONSTRAINT commerce_operations_ledger_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commerce_paid_role_operations
    ADD CONSTRAINT commerce_paid_role_operations_pkey PRIMARY KEY (operation_key);

ALTER TABLE ONLY public.commerce_paid_role_outbox
    ADD CONSTRAINT commerce_paid_role_outbox_operation_key_key UNIQUE (operation_key);

ALTER TABLE ONLY public.commerce_paid_role_outbox
    ADD CONSTRAINT commerce_paid_role_outbox_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commerce_paid_role_provider_actions
    ADD CONSTRAINT commerce_paid_role_provider_actions_operation_key_key UNIQUE (operation_key);

ALTER TABLE ONLY public.commerce_paid_role_provider_actions
    ADD CONSTRAINT commerce_paid_role_provider_actions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commerce_paid_role_repairs
    ADD CONSTRAINT commerce_paid_role_repairs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commerce_paid_role_states
    ADD CONSTRAINT commerce_paid_role_states_pkey PRIMARY KEY (entitlement_id);

ALTER TABLE ONLY public.commerce_payments
    ADD CONSTRAINT commerce_payments_connected_account_id_stripe_invoice_id_key UNIQUE (connected_account_id, stripe_invoice_id);

ALTER TABLE ONLY public.commerce_payments
    ADD CONSTRAINT commerce_payments_connected_account_id_stripe_payment_inten_key UNIQUE (connected_account_id, stripe_payment_intent_id);

ALTER TABLE ONLY public.commerce_payments
    ADD CONSTRAINT commerce_payments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commerce_prices
    ADD CONSTRAINT commerce_prices_connected_account_id_stripe_price_id_key UNIQUE (connected_account_id, stripe_price_id);

ALTER TABLE ONLY public.commerce_prices
    ADD CONSTRAINT commerce_prices_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commerce_refunds
    ADD CONSTRAINT commerce_refunds_connected_account_id_stripe_refund_id_key UNIQUE (connected_account_id, stripe_refund_id);

ALTER TABLE ONLY public.commerce_refunds
    ADD CONSTRAINT commerce_refunds_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commerce_reporting_ledger
    ADD CONSTRAINT commerce_reporting_ledger_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commerce_reporting_ledger
    ADD CONSTRAINT commerce_reporting_ledger_transaction_type_connected_accoun_key UNIQUE (transaction_type, connected_account_id, source_record_id);

ALTER TABLE ONLY public.commerce_role_assignments
    ADD CONSTRAINT commerce_role_assignments_entitlement_id_key UNIQUE (entitlement_id);

ALTER TABLE ONLY public.commerce_role_assignments
    ADD CONSTRAINT commerce_role_assignments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commerce_sales_panels
    ADD CONSTRAINT commerce_sales_panels_pkey PRIMARY KEY (connected_account_id);

ALTER TABLE ONLY public.commerce_seller_acceptances
    ADD CONSTRAINT commerce_seller_acceptances_connected_account_id_terms_vers_key UNIQUE (connected_account_id, terms_version);

ALTER TABLE ONLY public.commerce_seller_acceptances
    ADD CONSTRAINT commerce_seller_acceptances_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commerce_seller_controls
    ADD CONSTRAINT commerce_seller_controls_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commerce_seller_controls
    ADD CONSTRAINT commerce_seller_controls_scope_type_scope_id_key UNIQUE (scope_type, scope_id);

ALTER TABLE ONLY public.commerce_seller_offboarding
    ADD CONSTRAINT commerce_seller_offboarding_guild_id_key UNIQUE (guild_id);

ALTER TABLE ONLY public.commerce_seller_offboarding
    ADD CONSTRAINT commerce_seller_offboarding_pkey PRIMARY KEY (connected_account_id);

ALTER TABLE ONLY public.commerce_seller_profiles
    ADD CONSTRAINT commerce_seller_profiles_guild_id_key UNIQUE (guild_id);

ALTER TABLE ONLY public.commerce_seller_profiles
    ADD CONSTRAINT commerce_seller_profiles_pkey PRIMARY KEY (connected_account_id);

ALTER TABLE ONLY public.commerce_seller_review_requests
    ADD CONSTRAINT commerce_seller_review_requests_connected_account_id_key UNIQUE (connected_account_id);

ALTER TABLE ONLY public.commerce_seller_review_requests
    ADD CONSTRAINT commerce_seller_review_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commerce_store_branding
    ADD CONSTRAINT commerce_store_branding_connected_account_id_key UNIQUE (connected_account_id);

ALTER TABLE ONLY public.commerce_store_branding
    ADD CONSTRAINT commerce_store_branding_pkey PRIMARY KEY (guild_id);

ALTER TABLE ONLY public.commerce_subscriptions
    ADD CONSTRAINT commerce_subscriptions_connected_account_id_stripe_subscrip_key UNIQUE (connected_account_id, stripe_subscription_id);

ALTER TABLE ONLY public.commerce_subscriptions
    ADD CONSTRAINT commerce_subscriptions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commerce_support_checkout_attempts
    ADD CONSTRAINT commerce_support_checkout_att_connected_account_id_stripe_c_key UNIQUE (connected_account_id, stripe_checkout_session_id);

ALTER TABLE ONLY public.commerce_support_checkout_attempts
    ADD CONSTRAINT commerce_support_checkout_attempts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commerce_support_configs
    ADD CONSTRAINT commerce_support_configs_guild_id_key UNIQUE (guild_id);

ALTER TABLE ONLY public.commerce_support_configs
    ADD CONSTRAINT commerce_support_configs_pkey PRIMARY KEY (connected_account_id);

ALTER TABLE ONLY public.commerce_support_disputes
    ADD CONSTRAINT commerce_support_disputes_connected_account_id_stripe_dispu_key UNIQUE (connected_account_id, stripe_dispute_id);

ALTER TABLE ONLY public.commerce_support_disputes
    ADD CONSTRAINT commerce_support_disputes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commerce_support_payments
    ADD CONSTRAINT commerce_support_payments_connected_account_id_checkout_att_key UNIQUE (connected_account_id, checkout_attempt_id);

ALTER TABLE ONLY public.commerce_support_payments
    ADD CONSTRAINT commerce_support_payments_connected_account_id_stripe_payme_key UNIQUE (connected_account_id, stripe_payment_intent_id);

ALTER TABLE ONLY public.commerce_support_payments
    ADD CONSTRAINT commerce_support_payments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commerce_support_rate_limits
    ADD CONSTRAINT commerce_support_rate_limits_pkey PRIMARY KEY (buyer_id, guild_id);

ALTER TABLE ONLY public.commerce_support_refunds
    ADD CONSTRAINT commerce_support_refunds_connected_account_id_stripe_refund_key UNIQUE (connected_account_id, stripe_refund_id);

ALTER TABLE ONLY public.commerce_support_refunds
    ADD CONSTRAINT commerce_support_refunds_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commerce_sync_outbox
    ADD CONSTRAINT commerce_sync_outbox_connected_account_id_event_id_key UNIQUE (connected_account_id, event_id);

ALTER TABLE ONLY public.commerce_sync_outbox
    ADD CONSTRAINT commerce_sync_outbox_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commerce_sync_state
    ADD CONSTRAINT commerce_sync_state_connected_account_id_resource_type_reso_key UNIQUE (connected_account_id, resource_type, resource_id);

ALTER TABLE ONLY public.commerce_sync_state
    ADD CONSTRAINT commerce_sync_state_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commerce_webhook_events
    ADD CONSTRAINT commerce_webhook_events_connected_account_id_stripe_event_i_key UNIQUE (connected_account_id, stripe_event_id);

ALTER TABLE ONLY public.commerce_webhook_events
    ADD CONSTRAINT commerce_webhook_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.community_feed_state
    ADD CONSTRAINT community_feed_state_pkey PRIMARY KEY (guild_id, feed_id);

ALTER TABLE ONLY public.community_moderation_cases
    ADD CONSTRAINT community_moderation_cases_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.community_tool_claims
    ADD CONSTRAINT community_tool_claims_pkey PRIMARY KEY (claim_key);

ALTER TABLE ONLY public.community_tool_configs
    ADD CONSTRAINT community_tool_configs_pkey PRIMARY KEY (guild_id, feature);

ALTER TABLE ONLY public.community_tool_deliveries
    ADD CONSTRAINT community_tool_deliveries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.configuration_revision_heads
    ADD CONSTRAINT configuration_revision_heads_pkey PRIMARY KEY (guild_id, feature, resource_key);

ALTER TABLE ONLY public.configuration_revisions
    ADD CONSTRAINT configuration_revisions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.considered_replies
    ADD CONSTRAINT considered_replies_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.considered_reply_flags
    ADD CONSTRAINT considered_reply_flags_pkey PRIMARY KEY (reply_id, member_id);

ALTER TABLE ONLY public.discord_ban_appeal_configs
    ADD CONSTRAINT discord_ban_appeal_configs_pkey PRIMARY KEY (guild_id);

ALTER TABLE ONLY public.discord_ban_appeal_cooldowns
    ADD CONSTRAINT discord_ban_appeal_cooldowns_pkey PRIMARY KEY (guild_id, user_id);

ALTER TABLE ONLY public.discord_ban_appeal_operations
    ADD CONSTRAINT discord_ban_appeal_operations_pkey PRIMARY KEY (guild_id, id);

ALTER TABLE ONLY public.discord_ban_appeals
    ADD CONSTRAINT discord_ban_appeals_pkey PRIMARY KEY (guild_id, id);

ALTER TABLE ONLY public.donor_claims
    ADD CONSTRAINT donor_claims_pkey PRIMARY KEY (guild_id);

ALTER TABLE ONLY public.event_lifecycle_history
    ADD CONSTRAINT event_lifecycle_history_pkey PRIMARY KEY (guild_id, event_id, history_id);

ALTER TABLE ONLY public.event_lifecycle_transition_guards
    ADD CONSTRAINT event_lifecycle_transition_guards_pkey PRIMARY KEY (guard_id);

ALTER TABLE ONLY public.event_recurrence_series
    ADD CONSTRAINT event_recurrence_series_guild_id_source_event_id_key UNIQUE (guild_id, source_event_id);

ALTER TABLE ONLY public.event_recurrence_series
    ADD CONSTRAINT event_recurrence_series_pkey PRIMARY KEY (guild_id, series_id);

ALTER TABLE ONLY public.event_signup_mutation_guards
    ADD CONSTRAINT event_signup_mutation_guards_pkey PRIMARY KEY (guard_id);

ALTER TABLE ONLY public.event_signups
    ADD CONSTRAINT event_signups_pkey PRIMARY KEY (guild_id, event_id, user_id, group_id);

ALTER TABLE ONLY public.event_team_audit_records
    ADD CONSTRAINT event_team_audit_records_pkey PRIMARY KEY (guild_id, event_id, audit_id);

ALTER TABLE ONLY public.event_team_bulk_commit_guards
    ADD CONSTRAINT event_team_bulk_commit_guards_pkey PRIMARY KEY (guard_id);

ALTER TABLE ONLY public.event_team_delivery_outbox
    ADD CONSTRAINT event_team_delivery_outbox_guild_id_event_id_dedupe_key_key UNIQUE (guild_id, event_id, dedupe_key);

ALTER TABLE ONLY public.event_team_delivery_outbox
    ADD CONSTRAINT event_team_delivery_outbox_pkey PRIMARY KEY (guild_id, event_id, outbox_id);

ALTER TABLE ONLY public.event_team_invitation_blocks
    ADD CONSTRAINT event_team_invitation_blocks_pkey PRIMARY KEY (guild_id, event_id, team_id, user_id);

ALTER TABLE ONLY public.event_team_memberships
    ADD CONSTRAINT event_team_memberships_pkey PRIMARY KEY (guild_id, event_id, membership_id);

ALTER TABLE ONLY public.event_team_proposal_acceptance_guards
    ADD CONSTRAINT event_team_proposal_acceptance_guards_pkey PRIMARY KEY (guild_id, event_id, proposal_id);

ALTER TABLE ONLY public.event_team_proposals
    ADD CONSTRAINT event_team_proposals_pkey PRIMARY KEY (guild_id, event_id, proposal_id);

ALTER TABLE ONLY public.event_team_rate_limits
    ADD CONSTRAINT event_team_rate_limits_pkey PRIMARY KEY (guild_id, event_id, action, scope_type, scope_id);

ALTER TABLE ONLY public.event_team_roster_snapshots
    ADD CONSTRAINT event_team_roster_snapshots_pkey PRIMARY KEY (guild_id, event_id, team_id);

ALTER TABLE ONLY public.event_team_state_versions
    ADD CONSTRAINT event_team_state_versions_pkey PRIMARY KEY (guild_id, event_id);

ALTER TABLE ONLY public.event_teams
    ADD CONSTRAINT event_teams_pkey PRIMARY KEY (guild_id, event_id, team_id);

ALTER TABLE ONLY public.event_templates
    ADD CONSTRAINT event_templates_pkey PRIMARY KEY (guild_id, template_id);

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (guild_id, event_id);

ALTER TABLE ONLY public.evidence_vault_configs
    ADD CONSTRAINT evidence_vault_configs_pkey PRIMARY KEY (guild_id);

ALTER TABLE ONLY public.evidence_vault_records
    ADD CONSTRAINT evidence_vault_records_pkey PRIMARY KEY (record_id);

ALTER TABLE ONLY public.feature_setup_resolutions
    ADD CONSTRAINT feature_setup_resolutions_pkey PRIMARY KEY (run_id, dependency_key);

ALTER TABLE ONLY public.feature_setup_runs
    ADD CONSTRAINT feature_setup_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.gateway_event_operations
    ADD CONSTRAINT gateway_event_operations_pkey PRIMARY KEY (event_key, handler_key);

ALTER TABLE ONLY public.gateway_member_nicks
    ADD CONSTRAINT gateway_member_nicks_pkey PRIMARY KEY (identity_id, guild_id, user_id);

ALTER TABLE ONLY public.gateway_member_roles
    ADD CONSTRAINT gateway_member_roles_pkey PRIMARY KEY (identity_id, guild_id, user_id);

ALTER TABLE ONLY public.gateway_message_audit_context
    ADD CONSTRAINT gateway_message_audit_context_pkey PRIMARY KEY (identity_id, message_id);

ALTER TABLE ONLY public.gateway_reaction_limit_mutations
    ADD CONSTRAINT gateway_reaction_limit_mutations_pkey PRIMARY KEY (event_key, mutation_kind);

ALTER TABLE ONLY public.gateway_sessions
    ADD CONSTRAINT gateway_sessions_pkey PRIMARY KEY (identity_id);

ALTER TABLE ONLY public.gateway_voice_states
    ADD CONSTRAINT gateway_voice_states_pkey PRIMARY KEY (identity_id, guild_id, user_id);

ALTER TABLE ONLY public.guild_audit_log_configs
    ADD CONSTRAINT guild_audit_log_configs_pkey PRIMARY KEY (guild_id);

ALTER TABLE ONLY public.guild_blocked_emojis
    ADD CONSTRAINT guild_blocked_emojis_pkey PRIMARY KEY (guild_id, normalized_emoji);

ALTER TABLE ONLY public.guild_entitlements
    ADD CONSTRAINT guild_entitlements_pkey PRIMARY KEY (guild_id);

ALTER TABLE ONLY public.guild_notification_channels
    ADD CONSTRAINT guild_notification_channels_pkey PRIMARY KEY (guild_id, feature);

ALTER TABLE ONLY public.guild_object_accounting
    ADD CONSTRAINT guild_object_accounting_pkey PRIMARY KEY (guild_id, object_key);

ALTER TABLE ONLY public.guild_object_reconciliation_state
    ADD CONSTRAINT guild_object_reconciliation_state_pkey PRIMARY KEY (bucket_id);

ALTER TABLE ONLY public.guild_rbac_settings
    ADD CONSTRAINT guild_rbac_settings_pkey PRIMARY KEY (guild_id);

ALTER TABLE ONLY public.guild_service_suspension_audit
    ADD CONSTRAINT guild_service_suspension_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.guild_service_suspensions
    ADD CONSTRAINT guild_service_suspensions_pkey PRIMARY KEY (guild_id);

ALTER TABLE ONLY public.guild_settings
    ADD CONSTRAINT guild_settings_pkey PRIMARY KEY (guild_id);

ALTER TABLE ONLY public.identity_patterns
    ADD CONSTRAINT identity_patterns_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.image_rules_configs
    ADD CONSTRAINT image_rules_configs_pkey PRIMARY KEY (guild_id);

ALTER TABLE ONLY public.image_rules_mod_queue_items
    ADD CONSTRAINT image_rules_mod_queue_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_queue_name_dedupe_key_key UNIQUE (queue_name, dedupe_key);

ALTER TABLE ONLY public.known_guilds
    ADD CONSTRAINT known_guilds_pkey PRIMARY KEY (guild_id);

ALTER TABLE ONLY public.lfg_applications
    ADD CONSTRAINT lfg_applications_pkey PRIMARY KEY (guild_id, post_id, applicant_id);

ALTER TABLE ONLY public.lfg_configs
    ADD CONSTRAINT lfg_configs_pkey PRIMARY KEY (guild_id);

ALTER TABLE ONLY public.lfg_posts
    ADD CONSTRAINT lfg_posts_pkey PRIMARY KEY (guild_id, post_id);

ALTER TABLE ONLY public.lfg_voice_channels
    ADD CONSTRAINT lfg_voice_channels_pkey PRIMARY KEY (guild_id, post_id);

ALTER TABLE ONLY public.managed_message_audit_outbox
    ADD CONSTRAINT managed_message_audit_outbox_pkey PRIMARY KEY (event_key);

ALTER TABLE ONLY public.managed_message_drafts
    ADD CONSTRAINT managed_message_drafts_guild_id_internal_name_key UNIQUE (guild_id, internal_name);

ALTER TABLE ONLY public.managed_message_drafts
    ADD CONSTRAINT managed_message_drafts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.managed_message_media_assets
    ADD CONSTRAINT managed_message_media_assets_pkey PRIMARY KEY (guild_id, filename);

ALTER TABLE ONLY public.managed_message_media_refs
    ADD CONSTRAINT managed_message_media_refs_pkey PRIMARY KEY (guild_id, filename, owner_type, owner_id);

ALTER TABLE ONLY public.managed_messages
    ADD CONSTRAINT managed_messages_guild_id_channel_id_message_id_key UNIQUE (guild_id, channel_id, message_id);

ALTER TABLE ONLY public.managed_messages
    ADD CONSTRAINT managed_messages_guild_id_internal_name_key UNIQUE (guild_id, internal_name);

ALTER TABLE ONLY public.managed_messages
    ADD CONSTRAINT managed_messages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.marketplace_configs
    ADD CONSTRAINT marketplace_configs_pkey PRIMARY KEY (guild_id);

ALTER TABLE ONLY public.marketplace_posts
    ADD CONSTRAINT marketplace_posts_pkey PRIMARY KEY (guild_id, post_id);

ALTER TABLE ONLY public.marketplace_trade_logs
    ADD CONSTRAINT marketplace_trade_logs_pkey PRIMARY KEY (guild_id, log_id);

ALTER TABLE ONLY public.member_verification_attempts
    ADD CONSTRAINT member_verification_attempts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.member_verification_configs
    ADD CONSTRAINT member_verification_configs_pkey PRIMARY KEY (guild_id);

ALTER TABLE ONLY public.member_verification_manual_dm_rate_limits
    ADD CONSTRAINT member_verification_manual_dm_rate_limits_pkey PRIMARY KEY (guild_id, scope_type, scope_id);

ALTER TABLE ONLY public.member_verification_states
    ADD CONSTRAINT member_verification_states_pkey PRIMARY KEY (guild_id, user_id);

ALTER TABLE ONLY public.mention_protection_action_outcomes
    ADD CONSTRAINT mention_protection_action_outcomes_pkey PRIMARY KEY (guild_id, message_id, action);

ALTER TABLE ONLY public.mention_protection_breaches
    ADD CONSTRAINT mention_protection_breaches_pkey PRIMARY KEY (guild_id, message_id, protection);

ALTER TABLE ONLY public.mention_protection_burst_events
    ADD CONSTRAINT mention_protection_burst_events_pkey PRIMARY KEY (guild_id, user_id, message_id);

ALTER TABLE ONLY public.mention_protection_configs
    ADD CONSTRAINT mention_protection_configs_pkey PRIMARY KEY (guild_id);

ALTER TABLE ONLY public.mention_protection_escalations
    ADD CONSTRAINT mention_protection_escalations_pkey PRIMARY KEY (guild_id, user_id, protection);

ALTER TABLE ONLY public.message_templates
    ADD CONSTRAINT message_templates_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.one_time_tokens
    ADD CONSTRAINT one_time_tokens_pkey PRIMARY KEY (nonce);

ALTER TABLE ONLY public.operational_incident_events
    ADD CONSTRAINT operational_incident_events_incident_id_observation_id_key UNIQUE (incident_id, observation_id);

ALTER TABLE ONLY public.operational_incident_events
    ADD CONSTRAINT operational_incident_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.operational_incidents
    ADD CONSTRAINT operational_incidents_guild_id_incident_key_key UNIQUE (guild_id, incident_key);

ALTER TABLE ONLY public.operational_incidents
    ADD CONSTRAINT operational_incidents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pending_platform_links
    ADD CONSTRAINT pending_platform_links_pkey PRIMARY KEY (state);

ALTER TABLE ONLY public.pending_suggestion_submissions
    ADD CONSTRAINT pending_suggestion_submissions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.platform_link_configs
    ADD CONSTRAINT platform_link_configs_pkey PRIMARY KEY (guild_id, platform);

ALTER TABLE ONLY public.platform_links
    ADD CONSTRAINT platform_links_pkey PRIMARY KEY (guild_id, user_id, platform, platform_id);

ALTER TABLE ONLY public.player_count_servers
    ADD CONSTRAINT player_count_servers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.player_count_streak_reports
    ADD CONSTRAINT player_count_streak_reports_pkey PRIMARY KEY (report_key);

ALTER TABLE ONLY public.product_analytics_preferences
    ADD CONSTRAINT product_analytics_preferences_pkey PRIMARY KEY (guild_id);

ALTER TABLE ONLY public.reaction_limit_breach_counters
    ADD CONSTRAINT reaction_limit_breach_counters_pkey PRIMARY KEY (guild_id, user_id);

ALTER TABLE ONLY public.reaction_limit_configs
    ADD CONSTRAINT reaction_limit_configs_pkey PRIMARY KEY (guild_id);

ALTER TABLE ONLY public.reaction_limit_message_reaction_counts
    ADD CONSTRAINT reaction_limit_message_reaction_counts_pkey PRIMARY KEY (guild_id, channel_id, message_id);

ALTER TABLE ONLY public.reaction_limit_user_message_reaction_counts
    ADD CONSTRAINT reaction_limit_user_message_reaction_counts_pkey PRIMARY KEY (guild_id, channel_id, message_id, user_id);

ALTER TABLE ONLY public.reaction_role_leases
    ADD CONSTRAINT reaction_role_leases_pkey PRIMARY KEY (guild_id);

ALTER TABLE ONLY public.reaction_role_panels
    ADD CONSTRAINT reaction_role_panels_guild_id_channel_id_message_id_key UNIQUE (guild_id, channel_id, message_id);

ALTER TABLE ONLY public.reaction_role_panels
    ADD CONSTRAINT reaction_role_panels_pkey PRIMARY KEY (guild_id, id);

ALTER TABLE ONLY public.reputation_awards
    ADD CONSTRAINT reputation_awards_pkey PRIMARY KEY (guild_id, interaction_id);

ALTER TABLE ONLY public.reputation_configs
    ADD CONSTRAINT reputation_configs_pkey PRIMARY KEY (guild_id);

ALTER TABLE ONLY public.reputation_cooldowns
    ADD CONSTRAINT reputation_cooldowns_pkey PRIMARY KEY (guild_id, giver_id);

ALTER TABLE ONLY public.reputation_reward_jobs
    ADD CONSTRAINT reputation_reward_jobs_pkey PRIMARY KEY (guild_id, user_id, role_id);

ALTER TABLE ONLY public.reputation_scores
    ADD CONSTRAINT reputation_scores_pkey PRIMARY KEY (guild_id, user_id);

ALTER TABLE ONLY public.scheduler_leases
    ADD CONSTRAINT scheduler_leases_pkey PRIMARY KEY (name);

ALTER TABLE ONLY public.scheduler_task_state
    ADD CONSTRAINT scheduler_task_state_pkey PRIMARY KEY (name);

ALTER TABLE ONLY public.server_level_announcement_outbox
    ADD CONSTRAINT server_level_announcement_outbox_guild_id_user_id_level_key UNIQUE (guild_id, user_id, level);

ALTER TABLE ONLY public.server_level_announcement_outbox
    ADD CONSTRAINT server_level_announcement_outbox_pkey PRIMARY KEY (announcement_id);

ALTER TABLE ONLY public.server_level_awards
    ADD CONSTRAINT server_level_awards_pkey PRIMARY KEY (award_id);

ALTER TABLE ONLY public.server_level_configs
    ADD CONSTRAINT server_level_configs_pkey PRIMARY KEY (guild_id);

ALTER TABLE ONLY public.server_level_credentials
    ADD CONSTRAINT server_level_credentials_configured_game_server_id_purpose_key UNIQUE (configured_game_server_id, purpose);

ALTER TABLE ONLY public.server_level_credentials
    ADD CONSTRAINT server_level_credentials_pkey PRIMARY KEY (credential_id);

ALTER TABLE ONLY public.server_level_current_presence
    ADD CONSTRAINT server_level_current_presence_pkey PRIMARY KEY (configured_game_server_id, steam_id64);

ALTER TABLE ONLY public.server_level_daily_summaries
    ADD CONSTRAINT server_level_daily_summaries_pkey PRIMARY KEY (guild_id, user_id, day_utc, scoring_policy_version);

ALTER TABLE ONLY public.server_level_earning_sessions
    ADD CONSTRAINT server_level_earning_sessions_pkey PRIMARY KEY (session_id);

ALTER TABLE ONLY public.server_level_ingress_outbox
    ADD CONSTRAINT server_level_ingress_outbox_pkey PRIMARY KEY (inbox_id);

ALTER TABLE ONLY public.server_level_member_totals
    ADD CONSTRAINT server_level_member_totals_pkey PRIMARY KEY (guild_id, user_id);

ALTER TABLE ONLY public.server_level_processing_cursors
    ADD CONSTRAINT server_level_processing_cursors_pkey PRIMARY KEY (configured_game_server_id);

ALTER TABLE ONLY public.server_level_processing_leases
    ADD CONSTRAINT server_level_processing_leases_pkey PRIMARY KEY (configured_game_server_id);

ALTER TABLE ONLY public.server_level_servers
    ADD CONSTRAINT server_level_servers_endpoint_id_key UNIQUE (endpoint_id);

ALTER TABLE ONLY public.server_level_servers
    ADD CONSTRAINT server_level_servers_guild_id_provider_server_id_key UNIQUE (guild_id, provider_server_id);

ALTER TABLE ONLY public.server_level_servers
    ADD CONSTRAINT server_level_servers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.server_level_webhook_inbox
    ADD CONSTRAINT server_level_webhook_inbox_configured_game_server_id_delive_key UNIQUE (configured_game_server_id, delivery_id);

ALTER TABLE ONLY public.server_level_webhook_inbox
    ADD CONSTRAINT server_level_webhook_inbox_pkey PRIMARY KEY (inbox_id);

ALTER TABLE ONLY public.steam_ban_lookup_cache
    ADD CONSTRAINT steam_ban_lookup_cache_pkey PRIMARY KEY (steam_id64);

ALTER TABLE ONLY public.suggestion_action_rate_limits
    ADD CONSTRAINT suggestion_action_rate_limits_pkey PRIMARY KEY (guild_id, actor_user_id, action, window_start_ms);

ALTER TABLE ONLY public.suggestion_digest_runs
    ADD CONSTRAINT suggestion_digest_runs_pkey PRIMARY KEY (guild_id, period_key);

ALTER TABLE ONLY public.suggestion_revisions
    ADD CONSTRAINT suggestion_revisions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.suggestion_status_events
    ADD CONSTRAINT suggestion_status_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.suggestion_votes
    ADD CONSTRAINT suggestion_votes_pkey PRIMARY KEY (suggestion_id, member_id);

ALTER TABLE ONLY public.suggestions_configs
    ADD CONSTRAINT suggestions_configs_pkey PRIMARY KEY (guild_id);

ALTER TABLE ONLY public.suggestions
    ADD CONSTRAINT suggestions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ticket_claim_deliveries
    ADD CONSTRAINT ticket_claim_deliveries_pkey PRIMARY KEY (guild_id, channel_id, claimed_by_user_id, claimed_at_ms, phase);

ALTER TABLE ONLY public.ticket_counters
    ADD CONSTRAINT ticket_counters_pkey PRIMARY KEY (guild_id);

ALTER TABLE ONLY public.ticket_instances
    ADD CONSTRAINT ticket_instances_pkey PRIMARY KEY (guild_id, channel_id);

ALTER TABLE ONLY public.ticket_panels
    ADD CONSTRAINT ticket_panels_pkey PRIMARY KEY (guild_id, panel_id);

ALTER TABLE ONLY public.ticket_participant_events
    ADD CONSTRAINT ticket_participant_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ticket_participants
    ADD CONSTRAINT ticket_participants_pkey PRIMARY KEY (guild_id, ticket_channel_id, user_id);

ALTER TABLE ONLY public.ticket_staff_messages
    ADD CONSTRAINT ticket_staff_messages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ticket_template_replies
    ADD CONSTRAINT ticket_template_replies_pkey PRIMARY KEY (interaction_id);

ALTER TABLE ONLY public.ticket_transcript_capabilities
    ADD CONSTRAINT ticket_transcript_capabilities_pkey PRIMARY KEY (object_id);

ALTER TABLE ONLY public.timed_role_config_rules
    ADD CONSTRAINT timed_role_config_rules_pkey PRIMARY KEY (guild_id, config_type, role_id);

ALTER TABLE ONLY public.timed_roles
    ADD CONSTRAINT timed_roles_pkey PRIMARY KEY (guild_id, user_id, role_id);

ALTER TABLE ONLY public.user_preferences
    ADD CONSTRAINT user_preferences_pkey PRIMARY KEY (user_id);

ALTER TABLE ONLY public.wardogs_budgets
    ADD CONSTRAINT wardogs_budgets_pkey PRIMARY KEY (origin);

ALTER TABLE ONLY public.wardogs_targets
    ADD CONSTRAINT wardogs_targets_guild_id_slot_key UNIQUE (guild_id, slot);

ALTER TABLE ONLY public.wardogs_targets
    ADD CONSTRAINT wardogs_targets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.webhook_credentials
    ADD CONSTRAINT webhook_credentials_pkey PRIMARY KEY (credential_id);

ALTER TABLE ONLY public.webhook_guard_buckets
    ADD CONSTRAINT webhook_guard_buckets_pkey PRIMARY KEY (scope_key);

ALTER TABLE ONLY public.webhook_guard_counters
    ADD CONSTRAINT webhook_guard_counters_pkey PRIMARY KEY (scope_key, bucket_at, outcome);

ALTER TABLE ONLY public.webhook_guard_duplicates
    ADD CONSTRAINT webhook_guard_duplicates_pkey PRIMARY KEY (scope_key, sha256);

ALTER TABLE ONLY public.webhook_guard_leases
    ADD CONSTRAINT webhook_guard_leases_pkey PRIMARY KEY (scope_key, lease_id);

ALTER TABLE ONLY public.webhook_proxy_configs
    ADD CONSTRAINT webhook_proxy_configs_pkey PRIMARY KEY (guild_id, public_id);

ALTER TABLE ONLY public.webhook_proxy_configs
    ADD CONSTRAINT webhook_proxy_configs_public_id_key UNIQUE (public_id);

ALTER TABLE ONLY public.webhook_proxy_forward_logs
    ADD CONSTRAINT webhook_proxy_forward_logs_pkey PRIMARY KEY (guild_id, log_id);

ALTER TABLE ONLY public.white_label_bots
    ADD CONSTRAINT white_label_bots_pkey PRIMARY KEY (guild_id, bot_user_id);

CREATE UNIQUE INDEX "Organization_slug_key" ON public."Organization" USING btree (slug);

CREATE UNIQUE INDEX "Session_token_key" ON public."Session" USING btree (token);

CREATE UNIQUE INDEX "User_discordUserId_key" ON public."User" USING btree ("discordUserId");

CREATE UNIQUE INDEX "User_email_key" ON public."User" USING btree (email);

CREATE INDEX "WorkspaceGuildAuditEvent_guild_time_idx" ON public."WorkspaceGuildAuditEvent" USING btree ("guildId", "occurredAtMs");

CREATE INDEX "WorkspaceGuildAuditEvent_workspace_time_idx" ON public."WorkspaceGuildAuditEvent" USING btree ("workspaceId", "occurredAtMs");

CREATE UNIQUE INDEX "WorkspaceGuild_guildId_key" ON public."WorkspaceGuild" USING btree ("guildId");

CREATE INDEX admin_feedback_created ON public.admin_feedback USING btree (created_at_ms);

CREATE INDEX admin_feedback_notification_state ON public.admin_feedback USING btree (notification_state);

CREATE INDEX admin_feedback_reporter_created ON public.admin_feedback USING btree (reporter_user_id, created_at_ms);

CREATE INDEX attendance_observation_due ON public.attendance_observation_runs USING btree (active_target, next_at_ms);

CREATE INDEX attendance_observation_guild ON public.attendance_observation_runs USING btree (guild_id);

CREATE INDEX attendance_observation_reports_guild ON public.attendance_observation_reports USING btree (guild_id);

CREATE INDEX attendance_observation_samples_expiry ON public.attendance_observation_samples USING btree (delete_at_ms);

CREATE INDEX attendance_observation_samples_guild ON public.attendance_observation_samples USING btree (guild_id);

CREATE INDEX attendance_observation_samples_run ON public.attendance_observation_samples USING btree (run_id, slot);

CREATE UNIQUE INDEX ban_case_operation_active ON public.ban_case_operations USING btree (physical_target, subject) WHERE (active = 1);

CREATE INDEX ban_case_operation_due ON public.ban_case_operations USING btree (active, next_at_ms);

CREATE INDEX ban_case_operation_guild ON public.ban_case_operations USING btree (guild_id);

CREATE INDEX ban_case_operational_incident_events_incident_created ON public.ban_case_operational_incident_events USING btree (incident_id, created_at_ms DESC);

CREATE INDEX ban_case_operational_incident_events_retention ON public.ban_case_operational_incident_events USING btree (created_at_ms);

CREATE INDEX ban_case_operational_incidents_guild_feature_status ON public.ban_case_operational_incidents USING btree (guild_id, feature, status);

CREATE INDEX ban_case_operational_incidents_guild_status_severity ON public.ban_case_operational_incidents USING btree (guild_id, status, severity, last_seen_at_ms DESC);

CREATE INDEX ban_case_operational_incidents_retention ON public.ban_case_operational_incidents USING btree (status, resolved_at_ms);

CREATE INDEX ban_case_projection_due ON public.ban_case_operation_projections USING btree (next_at_ms);

CREATE INDEX ban_case_sources_by_guild ON public.ban_case_sources USING btree (guild_id, updated_at_ms DESC);

CREATE UNIQUE INDEX ban_case_sources_public_id_unique ON public.ban_case_sources USING btree (public_id);

CREATE INDEX ban_cases_by_source ON public.ban_cases USING btree (guild_id, source_id);

CREATE UNIQUE INDEX ban_cases_subject_unique ON public.ban_cases USING btree (guild_id, subject_platform, subject_id);

CREATE INDEX billing_assignments_by_owner ON public.billing_guild_assignments USING btree (owner_id, assigned_at_ms);

CREATE INDEX billing_assignments_by_subscription ON public.billing_guild_assignments USING btree (stripe_subscription_id, assigned_at_ms);

CREATE INDEX billing_operations_by_owner_created ON public.billing_operations_ledger USING btree (owner_id, created_at_ms DESC);

CREATE INDEX billing_webhooks_by_object ON public.billing_webhook_events USING btree (event_type, object_id, stripe_created_at_ms);

CREATE INDEX bot_defense_rate_window_by_guild_user_channel ON public.bot_defense_rate_window_events USING btree (guild_id, user_id, channel_id);

CREATE INDEX bot_defense_rate_window_by_guild_user_time ON public.bot_defense_rate_window_events USING btree (guild_id, user_id, message_timestamp_ms);

CREATE INDEX bot_defense_rate_window_by_message ON public.bot_defense_rate_window_events USING btree (guild_id, user_id, message_fingerprint, message_timestamp_ms, channel_id);

CREATE INDEX bot_flags_by_guild_status ON public.bot_flags USING btree (guild_id, status, created_at_ms);

CREATE INDEX clan_applications_due ON public.clan_applications USING btree (expires_at_ms) WHERE (status = 'pending'::text);

CREATE UNIQUE INDEX clan_applications_one_pending ON public.clan_applications USING btree (clan_id, applicant_id) WHERE (status = 'pending'::text);

CREATE UNIQUE INDEX clan_change_requests_one_pending_kind ON public.clan_change_requests USING btree (clan_id, kind) WHERE (status = 'pending'::text);

CREATE INDEX clan_history_by_clan ON public.clan_history USING btree (guild_id, clan_id, created_at_ms DESC);

CREATE INDEX clan_history_retention ON public.clan_history USING btree (retention_expires_at_ms);

CREATE INDEX clan_invitations_due ON public.clan_invitations USING btree (expires_at_ms) WHERE (status = 'pending'::text);

CREATE UNIQUE INDEX clan_invitations_one_pending ON public.clan_invitations USING btree (clan_id, invitee_id) WHERE (status = 'pending'::text);

CREATE INDEX clan_membership_blocks_active ON public.clan_membership_blocks USING btree (clan_id, user_id, expires_at_ms) WHERE (lifted_at_ms IS NULL);

CREATE INDEX clan_memberships_active_by_clan ON public.clan_memberships USING btree (clan_id, rank, joined_at_ms) WHERE (left_at_ms IS NULL);

CREATE UNIQUE INDEX clan_memberships_one_active_per_guild ON public.clan_memberships USING btree (guild_id, user_id) WHERE (left_at_ms IS NULL);

CREATE UNIQUE INDEX clan_memberships_one_owner ON public.clan_memberships USING btree (clan_id) WHERE ((rank = 'owner'::text) AND (left_at_ms IS NULL));

CREATE UNIQUE INDEX clan_ownership_transfers_one_pending ON public.clan_ownership_transfers USING btree (clan_id) WHERE (status = 'pending'::text);

CREATE INDEX clan_requests_by_guild_status ON public.clan_requests USING btree (guild_id, status, created_at_ms);

CREATE UNIQUE INDEX clan_requests_one_pending_per_member ON public.clan_requests USING btree (guild_id, requester_id) WHERE (status = ANY (ARRAY['pending'::text, 'changes-requested'::text]));

CREATE INDEX clan_requests_retention ON public.clan_requests USING btree (retention_expires_at_ms) WHERE (retention_expires_at_ms IS NOT NULL);

CREATE INDEX clan_requests_review_ticket_recovery ON public.clan_requests USING btree (review_ticket_state, updated_at_ms) WHERE (review_ticket_state = ANY (ARRAY['pending'::text, 'creating'::text, 'decision-pending'::text]));

CREATE INDEX clans_by_guild_lifecycle ON public.clans USING btree (guild_id, lifecycle_state, created_at_ms);

CREATE INDEX clans_due_deletion ON public.clans USING btree (deletion_due_at_ms) WHERE (lifecycle_state = 'deletion-recovery'::text);

CREATE INDEX clans_due_inactivity ON public.clans USING btree (latest_activity_at_ms) WHERE (lifecycle_state = 'active'::text);

CREATE UNIQUE INDEX clans_unique_active_name ON public.clans USING btree (guild_id, normalized_name) WHERE (lifecycle_state <> 'permanently-deleted'::text);

CREATE UNIQUE INDEX clans_unique_active_tag ON public.clans USING btree (guild_id, normalized_tag) WHERE (lifecycle_state <> 'permanently-deleted'::text);

CREATE INDEX commerce_authority_grants_active_user ON public.commerce_authority_grants USING btree (connected_account_id, discord_user_id, revoked_at_ms);

CREATE UNIQUE INDEX commerce_checkout_attempts_active_buyer_offering ON public.commerce_checkout_attempts USING btree (connected_account_id, buyer_id, offering_id) WHERE (status = ANY (ARRAY['creating'::text, 'open'::text, 'returned'::text]));

CREATE INDEX commerce_checkout_attempts_expiry ON public.commerce_checkout_attempts USING btree (status, expires_at_ms);

CREATE INDEX commerce_checkout_capacity_claims_usage ON public.commerce_checkout_capacity_claims USING btree (connected_account_id, currency, month_started_at_ms, expires_at_ms);

CREATE UNIQUE INDEX commerce_connected_accounts_current_guild ON public.commerce_connected_accounts USING btree (guild_id) WHERE (status <> 'archived'::text);

CREATE INDEX commerce_connected_accounts_guild_status ON public.commerce_connected_accounts USING btree (guild_id, status);

CREATE UNIQUE INDEX commerce_connected_accounts_provider ON public.commerce_connected_accounts USING btree (stripe_account_id);

CREATE INDEX commerce_delivery_outbox_due ON public.commerce_delivery_outbox USING btree (status, available_at_ms, created_at_ms);

CREATE INDEX commerce_disputes_payment ON public.commerce_disputes USING btree (payment_id, created_at_ms);

CREATE INDEX commerce_entitlements_buyer_status ON public.commerce_entitlements USING btree (buyer_id, status);

CREATE INDEX commerce_entitlements_offering_status ON public.commerce_entitlements USING btree (offering_id, status);

CREATE INDEX commerce_financial_actions_due ON public.commerce_financial_actions USING btree (status, available_at_ms, lease_expires_at_ms);

CREATE INDEX commerce_financial_actions_entity_time ON public.commerce_financial_actions USING btree (entity_type, entity_id, created_at_ms);

CREATE INDEX commerce_financial_actions_seller_time ON public.commerce_financial_actions USING btree (connected_account_id, created_at_ms);

CREATE INDEX commerce_financial_provider_actions_due ON public.commerce_financial_provider_actions USING btree (status, available_at_ms, lease_expires_at_ms);

CREATE INDEX commerce_financial_provider_actions_workflow ON public.commerce_financial_provider_actions USING btree (workflow_type, workflow_id, status);

CREATE INDEX commerce_game_audit_guild ON public.commerce_game_audit USING btree (guild_id, created_at_ms);

CREATE INDEX commerce_game_due ON public.commerce_game_assignments USING btree (next_at_ms);

CREATE INDEX commerce_game_guild ON public.commerce_game_assignments USING btree (guild_id);

CREATE INDEX commerce_game_selection_assignment ON public.commerce_game_selections USING btree (assignment_id);

CREATE INDEX commerce_guild_deletion_refund_reviews_pending ON public.commerce_guild_deletion_refund_reviews USING btree (status, created_at_ms);

CREATE INDEX commerce_incidents_guild_status ON public.commerce_incidents USING btree (guild_id, status, severity, last_seen_at_ms);

CREATE INDEX commerce_limit_alerts_open ON public.commerce_limit_alerts USING btree (guild_id, status, updated_at_ms);

CREATE INDEX commerce_offering_retirements_status ON public.commerce_offering_retirements USING btree (status, updated_at_ms);

CREATE UNIQUE INDEX commerce_offerings_published_role ON public.commerce_offerings USING btree (guild_id, discord_role_id) WHERE ((state = 'published'::text) OR ((state = 'repair_required'::text) AND (repair_previous_state = 'published'::text)));

CREATE INDEX commerce_offerings_seller_state ON public.commerce_offerings USING btree (connected_account_id, state);

CREATE INDEX commerce_operational_controls_active ON public.commerce_operational_controls USING btree (enabled, control_type, expires_at_ms);

CREATE INDEX commerce_operations_ledger_entity ON public.commerce_operations_ledger USING btree (entity_type, entity_id, created_at_ms);

CREATE INDEX commerce_operations_ledger_seller_time ON public.commerce_operations_ledger USING btree (connected_account_id, created_at_ms);

CREATE INDEX commerce_paid_role_operations_entitlement ON public.commerce_paid_role_operations USING btree (entitlement_id, created_at_ms);

CREATE INDEX commerce_paid_role_outbox_due ON public.commerce_paid_role_outbox USING btree (status, available_at_ms, created_at_ms);

CREATE INDEX commerce_paid_role_provider_actions_due ON public.commerce_paid_role_provider_actions USING btree (status, available_at_ms, lease_expires_at_ms);

CREATE INDEX commerce_paid_role_repairs_due ON public.commerce_paid_role_repairs USING btree (status, deadline_at_ms);

CREATE INDEX commerce_paid_role_states_guild_role ON public.commerce_paid_role_states USING btree (guild_id, discord_role_id);

CREATE INDEX commerce_payments_buyer_created ON public.commerce_payments USING btree (buyer_id, created_at_ms);

CREATE UNIQUE INDEX commerce_payments_charge ON public.commerce_payments USING btree (connected_account_id, stripe_charge_id) WHERE (stripe_charge_id IS NOT NULL);

CREATE UNIQUE INDEX commerce_payments_checkout ON public.commerce_payments USING btree (connected_account_id, stripe_checkout_session_id) WHERE (stripe_checkout_session_id IS NOT NULL);

CREATE INDEX commerce_payments_subscription_period ON public.commerce_payments USING btree (connected_account_id, stripe_subscription_id, invoice_period_end_ms);

CREATE INDEX commerce_prices_offering_status ON public.commerce_prices USING btree (offering_id, status);

CREATE INDEX commerce_refunds_payment ON public.commerce_refunds USING btree (payment_id, created_at_ms);

CREATE INDEX commerce_reporting_ledger_buyer ON public.commerce_reporting_ledger USING btree (buyer_id, occurred_at_ms);

CREATE INDEX commerce_reporting_ledger_period ON public.commerce_reporting_ledger USING btree (reporting_period, currency, transaction_type);

CREATE INDEX commerce_reporting_ledger_seller ON public.commerce_reporting_ledger USING btree (connected_account_id, occurred_at_ms);

CREATE INDEX commerce_role_assignments_due ON public.commerce_role_assignments USING btree (status, next_attempt_at_ms);

CREATE INDEX commerce_role_assignments_member ON public.commerce_role_assignments USING btree (guild_id, discord_user_id);

CREATE UNIQUE INDEX commerce_sales_panels_guild ON public.commerce_sales_panels USING btree (guild_id);

CREATE INDEX commerce_sales_panels_lease ON public.commerce_sales_panels USING btree (publication_lease_expires_at_ms);

CREATE INDEX commerce_sales_panels_message ON public.commerce_sales_panels USING btree (channel_id, message_id);

CREATE INDEX commerce_seller_acceptances_account_time ON public.commerce_seller_acceptances USING btree (connected_account_id, accepted_at_ms);

CREATE INDEX commerce_seller_controls_active ON public.commerce_seller_controls USING btree (suspended, scope_type, updated_at_ms);

CREATE INDEX commerce_seller_profiles_lifecycle ON public.commerce_seller_profiles USING btree (lifecycle_state, approval_state, updated_at_ms);

CREATE INDEX commerce_seller_profiles_owner ON public.commerce_seller_profiles USING btree (seller_owner_user_id, guild_id);

CREATE INDEX commerce_seller_review_requests_lease ON public.commerce_seller_review_requests USING btree (notification_lease_expires_at_ms);

CREATE INDEX commerce_seller_review_requests_pending ON public.commerce_seller_review_requests USING btree (state, created_at_ms);

CREATE INDEX commerce_store_branding_updated ON public.commerce_store_branding USING btree (updated_at_ms);

CREATE UNIQUE INDEX commerce_subscriptions_active_buyer_offering ON public.commerce_subscriptions USING btree (connected_account_id, buyer_id, offering_id) WHERE (status <> ALL (ARRAY['canceled'::text, 'ended'::text]));

CREATE INDEX commerce_subscriptions_customer_status ON public.commerce_subscriptions USING btree (customer_id, status);

CREATE UNIQUE INDEX commerce_support_checkout_active_buyer_guild ON public.commerce_support_checkout_attempts USING btree (connected_account_id, buyer_id, guild_id) WHERE (status = ANY (ARRAY['creating'::text, 'open'::text, 'returned'::text]));

CREATE INDEX commerce_support_checkout_expiry ON public.commerce_support_checkout_attempts USING btree (status, expires_at_ms);

CREATE INDEX commerce_support_disputes_payment_time ON public.commerce_support_disputes USING btree (support_payment_id, created_at_ms);

CREATE INDEX commerce_support_payments_buyer_time ON public.commerce_support_payments USING btree (buyer_id, created_at_ms);

CREATE INDEX commerce_support_payments_seller_time ON public.commerce_support_payments USING btree (connected_account_id, created_at_ms);

CREATE INDEX commerce_support_refunds_payment_time ON public.commerce_support_refunds USING btree (support_payment_id, created_at_ms);

CREATE INDEX commerce_sync_outbox_pending ON public.commerce_sync_outbox USING btree (sent_at_ms, created_at_ms);

CREATE INDEX commerce_sync_state_status ON public.commerce_sync_state USING btree (status, updated_at_ms);

CREATE INDEX commerce_webhook_events_pending ON public.commerce_webhook_events USING btree (status, received_at_ms);

CREATE INDEX community_moderation_history ON public.community_moderation_cases USING btree (guild_id, user_id, created_at_ms DESC);

CREATE INDEX community_tool_claims_expiry ON public.community_tool_claims USING btree (expires_at_ms);

CREATE INDEX community_tool_deliveries_pending ON public.community_tool_deliveries USING btree (status, created_at_ms);

CREATE INDEX configuration_revisions_by_guild ON public.configuration_revisions USING btree (guild_id, created_at_ms DESC, id DESC);

CREATE INDEX configuration_revisions_by_resource ON public.configuration_revisions USING btree (guild_id, feature, resource_key, created_at_ms DESC, id DESC);

CREATE INDEX configuration_revisions_previous_idx ON public.configuration_revisions USING btree (previous_revision_id);

CREATE INDEX configuration_revisions_restored_from_idx ON public.configuration_revisions USING btree (restored_from_revision_id);

CREATE INDEX considered_replies_by_suggestion ON public.considered_replies USING btree (suggestion_id, created_at_ms);

CREATE UNIQUE INDEX considered_replies_webhook_message_unique ON public.considered_replies USING btree (webhook_message_id);

CREATE UNIQUE INDEX discord_ban_appeals_one_open ON public.discord_ban_appeals USING btree (guild_id, user_id) WHERE (status = ANY (ARRAY['pending'::text, 'unban_pending'::text]));

CREATE INDEX discord_ban_appeals_user_history ON public.discord_ban_appeals USING btree (guild_id, user_id, created_at_ms DESC);

CREATE INDEX donor_claims_by_suspended_at ON public.donor_claims USING btree (suspended_at_ms);

CREATE INDEX donor_claims_by_user ON public.donor_claims USING btree (claimed_by_user_id);

CREATE INDEX event_lifecycle_history_by_event ON public.event_lifecycle_history USING btree (guild_id, event_id, occurred_at_ms DESC);

CREATE INDEX event_lifecycle_history_retention ON public.event_lifecycle_history USING btree (retention_expires_at_ms);

CREATE INDEX event_recurrence_due ON public.event_recurrence_series USING btree (status, next_publishes_at_ms);

CREATE INDEX event_signups_by_event ON public.event_signups USING btree (guild_id, event_id, status, created_at_ms);

CREATE INDEX event_signups_by_user ON public.event_signups USING btree (guild_id, event_id, user_id);

CREATE INDEX event_team_audit_by_event_time ON public.event_team_audit_records USING btree (guild_id, event_id, occurred_at_ms DESC);

CREATE INDEX event_team_delivery_outbox_due ON public.event_team_delivery_outbox USING btree (guild_id, event_id, status, next_attempt_at_ms);

CREATE INDEX event_team_delivery_outbox_global_due ON public.event_team_delivery_outbox USING btree (status, next_attempt_at_ms);

CREATE INDEX event_team_invitation_blocks_by_event_user ON public.event_team_invitation_blocks USING btree (guild_id, event_id, user_id);

CREATE UNIQUE INDEX event_team_memberships_active_user_unique ON public.event_team_memberships USING btree (guild_id, event_id, user_id) WHERE (left_at_ms IS NULL);

CREATE INDEX event_team_memberships_by_team ON public.event_team_memberships USING btree (guild_id, event_id, team_id, left_at_ms);

CREATE INDEX event_team_proposals_by_event_status ON public.event_team_proposals USING btree (guild_id, event_id, status, created_at_ms);

CREATE INDEX event_team_proposals_by_team ON public.event_team_proposals USING btree (guild_id, event_id, team_id);

CREATE UNIQUE INDEX event_team_proposals_pending_invite_unique ON public.event_team_proposals USING btree (guild_id, event_id, team_id, target_user_id) WHERE ((kind = 'invitation'::text) AND (status = 'pending'::text));

CREATE UNIQUE INDEX event_team_proposals_pending_join_unique ON public.event_team_proposals USING btree (guild_id, event_id, requester_user_id) WHERE ((kind = 'join_request'::text) AND (status = 'pending'::text));

CREATE INDEX event_team_rate_limits_expiry ON public.event_team_rate_limits USING btree (updated_at_ms);

CREATE INDEX event_team_roster_snapshots_by_event ON public.event_team_roster_snapshots USING btree (guild_id, event_id);

CREATE INDEX event_teams_by_event_group ON public.event_teams USING btree (guild_id, event_id, group_id);

CREATE UNIQUE INDEX event_teams_name_unique ON public.event_teams USING btree (guild_id, event_id, normalized_name);

CREATE INDEX event_templates_by_guild_updated ON public.event_templates USING btree (guild_id, updated_at_ms DESC);

CREATE INDEX events_by_guild_status_start ON public.events USING btree (guild_id, status, starts_at_ms);

CREATE INDEX events_by_lifecycle_due ON public.events USING btree (status, starts_at_ms, ends_at_ms);

CREATE INDEX events_recurrence_series ON public.events USING btree (guild_id, recurrence_series_id);

CREATE INDEX evidence_vault_records_guild_idx ON public.evidence_vault_records USING btree (guild_id, hidden_at_ms);

CREATE INDEX feature_setup_resolutions_by_resource ON public.feature_setup_resolutions USING btree (resource_id);

CREATE INDEX feature_setup_runs_by_feature ON public.feature_setup_runs USING btree (guild_id, feature_key, created_at_ms DESC);

CREATE UNIQUE INDEX feature_setup_runs_one_active ON public.feature_setup_runs USING btree (guild_id, feature_key) WHERE (status = ANY (ARRAY['planned'::text, 'running'::text, 'incomplete'::text]));

CREATE INDEX gateway_event_operations_by_completion ON public.gateway_event_operations USING btree (completed_at_ms) WHERE (state = ANY (ARRAY['completed'::text, 'terminal'::text]));

CREATE INDEX gateway_message_audit_context_retention_idx ON public.gateway_message_audit_context USING btree (identity_id, updated_at DESC, message_id DESC);

CREATE INDEX gateway_reaction_limit_mutations_by_completion ON public.gateway_reaction_limit_mutations USING btree (created_at_ms) WHERE (result_one IS NOT NULL);

CREATE INDEX gateway_voice_channel_members_idx ON public.gateway_voice_states USING btree (identity_id, guild_id, channel_id);

CREATE INDEX guild_object_accounting_expiry_idx ON public.guild_object_accounting USING btree (reservation_expires_at_ms, guild_id, object_key) WHERE (status = 'reserved'::text);

CREATE INDEX guild_object_accounting_guild_idx ON public.guild_object_accounting USING btree (guild_id);

CREATE UNIQUE INDEX guild_object_accounting_operation_idx ON public.guild_object_accounting USING btree (operation_key) WHERE (operation_key IS NOT NULL);

CREATE INDEX guild_service_suspension_audit_guild_time_idx ON public.guild_service_suspension_audit USING btree (guild_id, occurred_at_ms);

CREATE INDEX guild_service_suspensions_created_idx ON public.guild_service_suspensions USING btree (created_at_ms DESC);

CREATE INDEX identity_patterns_position_idx ON public.identity_patterns USING btree ("position");

CREATE INDEX idx_staff_messages_lookup ON public.ticket_staff_messages USING btree (guild_id, ticket_channel_id, bot_message_id);

CREATE UNIQUE INDEX idx_staff_messages_staff_lookup ON public.ticket_staff_messages USING btree (guild_id, staff_thread_id, staff_message_id);

CREATE INDEX image_rules_mod_queue_items_by_guild_status ON public.image_rules_mod_queue_items USING btree (guild_id, status, created_at_ms);

CREATE UNIQUE INDEX image_rules_mod_queue_items_by_source_message ON public.image_rules_mod_queue_items USING btree (guild_id, channel_id, message_id);

CREATE INDEX image_rules_mod_queue_items_restore_claim ON public.image_rules_mod_queue_items USING btree (restore_claim_expires_at_ms);

CREATE INDEX jobs_claim_idx ON public.jobs USING btree (queue_name, available_at, created_at) WHERE (state = 'queued'::text);

CREATE INDEX jobs_expired_lease_idx ON public.jobs USING btree (lease_expires_at) WHERE (state = 'running'::text);

CREATE INDEX jobs_terminal_inspection_idx ON public.jobs USING btree (queue_name, updated_at DESC) WHERE (state = 'terminal'::text);

CREATE INDEX lfg_applications_by_post_status ON public.lfg_applications USING btree (guild_id, post_id, status, created_at_ms DESC);

CREATE INDEX lfg_posts_by_expiry ON public.lfg_posts USING btree (active, expires_at_ms);

CREATE INDEX lfg_posts_by_guild_clan_active ON public.lfg_posts USING btree (guild_id, clan_id, active);

CREATE INDEX lfg_posts_by_owner_active ON public.lfg_posts USING btree (guild_id, owner_id, active);

CREATE INDEX lfg_voice_channels_by_channel ON public.lfg_voice_channels USING btree (channel_id);

CREATE UNIQUE INDEX managed_message_audit_outbox_by_canonical_message ON public.managed_message_audit_outbox USING btree (guild_id, channel_id, message_id);

CREATE INDEX managed_message_drafts_by_guild_updated ON public.managed_message_drafts USING btree (guild_id, updated_at_ms DESC);

CREATE INDEX managed_message_drafts_due ON public.managed_message_drafts USING btree (status, scheduled_at_ms);

CREATE INDEX managed_message_media_assets_pending ON public.managed_message_media_assets USING btree (guild_id, status);

CREATE INDEX managed_message_media_refs_by_owner ON public.managed_message_media_refs USING btree (guild_id, owner_type, owner_id);

CREATE INDEX managed_messages_by_guild_updated ON public.managed_messages USING btree (guild_id, updated_at_ms DESC);

CREATE INDEX marketplace_logs_by_timestamp ON public.marketplace_trade_logs USING btree (guild_id, timestamp_ms DESC);

CREATE INDEX marketplace_posts_by_owner_active ON public.marketplace_posts USING btree (guild_id, owner_id, active);

CREATE INDEX member_verification_attempts_by_expires ON public.member_verification_attempts USING btree (expires_at_ms);

CREATE INDEX member_verification_attempts_by_guild_user ON public.member_verification_attempts USING btree (guild_id, user_id);

CREATE INDEX member_verification_manual_dm_rate_limits_expiry ON public.member_verification_manual_dm_rate_limits USING btree (updated_at_ms);

CREATE INDEX member_verification_states_by_guild ON public.member_verification_states USING btree (guild_id, verified_at_ms DESC);

CREATE INDEX mention_protection_breaches_by_member ON public.mention_protection_breaches USING btree (guild_id, user_id, breached_at_ms);

CREATE INDEX mention_protection_burst_by_member_time ON public.mention_protection_burst_events USING btree (guild_id, user_id, message_timestamp_ms);

CREATE UNIQUE INDEX message_templates_by_guild_name ON public.message_templates USING btree (guild_id, internal_name);

CREATE INDEX message_templates_by_guild_updated ON public.message_templates USING btree (guild_id, updated_at_ms DESC);

CREATE INDEX one_time_tokens_expires_at ON public.one_time_tokens USING btree (expires_at_ms);

CREATE INDEX operational_incident_events_incident_created ON public.operational_incident_events USING btree (incident_id, created_at_ms DESC);

CREATE INDEX operational_incident_events_retention ON public.operational_incident_events USING btree (created_at_ms);

CREATE INDEX operational_incidents_guild_feature_status ON public.operational_incidents USING btree (guild_id, feature, status);

CREATE INDEX operational_incidents_guild_status_severity ON public.operational_incidents USING btree (guild_id, status, severity, last_seen_at_ms DESC);

CREATE INDEX operational_incidents_retention ON public.operational_incidents USING btree (status, resolved_at_ms);

CREATE UNIQUE INDEX platform_links_by_platform_id ON public.platform_links USING btree (guild_id, platform, platform_id);

CREATE INDEX platform_links_by_user ON public.platform_links USING btree (guild_id, user_id, platform);

CREATE INDEX player_count_servers_by_guild ON public.player_count_servers USING btree (guild_id);

CREATE INDEX player_count_servers_by_provider ON public.player_count_servers USING btree (provider, provider_server_id);

CREATE INDEX player_count_streak_reports_expiry_idx ON public.player_count_streak_reports USING btree (expires_at);

CREATE INDEX reaction_limit_message_counts_updated_at ON public.reaction_limit_message_reaction_counts USING btree (updated_at_ms);

CREATE INDEX reaction_limit_user_message_counts_updated_at ON public.reaction_limit_user_message_reaction_counts USING btree (updated_at_ms);

CREATE INDEX reputation_awards_giver ON public.reputation_awards USING btree (guild_id, giver_id);

CREATE INDEX reputation_awards_recipient ON public.reputation_awards USING btree (guild_id, recipient_id);

CREATE INDEX reputation_leaders ON public.reputation_scores USING btree (guild_id, score DESC, user_id) WHERE current_member;

CREATE INDEX reputation_reward_jobs_due ON public.reputation_reward_jobs USING btree (next_attempt_at_ms) WHERE (delivered_at_ms IS NULL);

CREATE INDEX server_level_announcement_pending ON public.server_level_announcement_outbox USING btree (delivered_at_ms, created_at_ms);

CREATE UNIQUE INDEX server_level_awards_interval_once ON public.server_level_awards USING btree (source_inbox_id, user_id, configured_game_server_id, interval_started_at_ms, interval_ended_at_ms);

CREATE INDEX server_level_awards_member_time ON public.server_level_awards USING btree (guild_id, user_id, interval_started_at_ms, interval_ended_at_ms);

CREATE INDEX server_level_earning_sessions_member_open ON public.server_level_earning_sessions USING btree (guild_id, user_id, closed_at_ms, checkpoint_at_ms);

CREATE INDEX server_level_earning_sessions_server_open ON public.server_level_earning_sessions USING btree (configured_game_server_id, closed_at_ms, checkpoint_at_ms);

CREATE INDEX server_level_ingress_outbox_pending ON public.server_level_ingress_outbox USING btree (published_at_ms, created_at_ms);

CREATE INDEX server_level_member_totals_leaderboard ON public.server_level_member_totals USING btree (guild_id, current_member, total_xp_units DESC);

CREATE INDEX server_level_servers_guild ON public.server_level_servers USING btree (guild_id);

CREATE INDEX server_level_webhook_inbox_processing ON public.server_level_webhook_inbox USING btree (configured_game_server_id, status, occurred_at_ms);

CREATE INDEX steam_ban_lookup_cache_expiry_idx ON public.steam_ban_lookup_cache USING btree (expires_at);

CREATE INDEX suggestion_action_limits_expiry ON public.suggestion_action_rate_limits USING btree (updated_at_ms);

CREATE UNIQUE INDEX suggestion_revisions_unique ON public.suggestion_revisions USING btree (suggestion_id, revision);

CREATE INDEX suggestion_status_history ON public.suggestion_status_events USING btree (suggestion_id, created_at_ms);

CREATE INDEX suggestion_votes_by_member ON public.suggestion_votes USING btree (guild_id, member_id, active);

CREATE INDEX suggestions_by_author ON public.suggestions USING btree (guild_id, author_id, created_at_ms);

CREATE INDEX suggestions_by_guild_status ON public.suggestions USING btree (guild_id, status, updated_at_ms);

CREATE UNIQUE INDEX suggestions_thread_unique ON public.suggestions USING btree (thread_id);

CREATE INDEX ticket_instances_by_opener_opened_at ON public.ticket_instances USING btree (guild_id, opener_user_id, opened_at_ms DESC);

CREATE INDEX ticket_instances_by_opener_status ON public.ticket_instances USING btree (guild_id, opener_user_id, status);

CREATE INDEX ticket_instances_by_status ON public.ticket_instances USING btree (guild_id, status, opened_at_ms DESC);

CREATE UNIQUE INDEX ticket_panels_unique_name ON public.ticket_panels USING btree (guild_id, panel_name);

CREATE INDEX ticket_participant_events_by_ticket ON public.ticket_participant_events USING btree (guild_id, ticket_channel_id, created_at_ms);

CREATE INDEX ticket_participants_by_user ON public.ticket_participants USING btree (guild_id, user_id);

CREATE INDEX ticket_template_replies_by_ticket ON public.ticket_template_replies USING btree (guild_id, ticket_channel_id, created_at_ms DESC);

CREATE UNIQUE INDEX ticket_transcript_capabilities_active_guild_channel ON public.ticket_transcript_capabilities USING btree (guild_id, channel_id) WHERE (discarded_at_ms IS NULL);

CREATE INDEX ticket_transcript_capabilities_retention ON public.ticket_transcript_capabilities USING btree (retention_expires_at_ms);

CREATE INDEX timed_roles_by_expiry ON public.timed_roles USING btree (expires_at_ms);

CREATE INDEX webhook_credentials_guild_public_idx ON public.webhook_credentials USING btree (guild_id, public_id);

CREATE UNIQUE INDEX webhook_credentials_owner_unique ON public.webhook_credentials USING btree (guild_id, owner_kind, public_id, COALESCE(destination_id, ''::text));

CREATE INDEX webhook_guard_counters_retention_idx ON public.webhook_guard_counters USING btree (bucket_at, scope_key);

CREATE INDEX webhook_guard_duplicates_expiry_idx ON public.webhook_guard_duplicates USING btree (expires_at, scope_key);

CREATE INDEX webhook_guard_leases_expiry_idx ON public.webhook_guard_leases USING btree (expires_at, scope_key);

CREATE INDEX webhook_proxy_configs_by_guild ON public.webhook_proxy_configs USING btree (guild_id, updated_at_ms DESC);

CREATE INDEX webhook_proxy_logs_by_webhook ON public.webhook_proxy_forward_logs USING btree (guild_id, public_id, timestamp_ms DESC);

CREATE INDEX white_label_bots_guild_idx ON public.white_label_bots USING btree (guild_id);

CREATE TRIGGER commerce_connected_accounts_retain_financial_history BEFORE DELETE ON public.commerce_connected_accounts FOR EACH ROW EXECUTE FUNCTION public.haf_retain_connected_account_history();

CREATE TRIGGER commerce_disputes_retained BEFORE DELETE ON public.commerce_disputes FOR EACH ROW EXECUTE FUNCTION public.haf_reject_mutation('commerce disputes are retained');

CREATE TRIGGER commerce_offerings_retain_financial_history BEFORE DELETE ON public.commerce_offerings FOR EACH ROW EXECUTE FUNCTION public.haf_retain_offering_history();

CREATE TRIGGER commerce_operations_ledger_immutable_delete BEFORE DELETE ON public.commerce_operations_ledger FOR EACH ROW EXECUTE FUNCTION public.haf_reject_mutation('commerce operations ledger is retained');

CREATE TRIGGER commerce_operations_ledger_immutable_update BEFORE UPDATE ON public.commerce_operations_ledger FOR EACH ROW EXECUTE FUNCTION public.haf_reject_mutation('commerce operations ledger is append-only');

CREATE TRIGGER commerce_payments_retained BEFORE DELETE ON public.commerce_payments FOR EACH ROW EXECUTE FUNCTION public.haf_reject_mutation('commerce payments are retained');

CREATE TRIGGER commerce_prices_economic_fields_immutable BEFORE UPDATE OF connected_account_id, offering_id, stripe_product_id, stripe_price_id, currency, unit_amount_minor, price_type, recurring_interval, provider_created_at_ms, created_at_ms ON public.commerce_prices FOR EACH ROW EXECUTE FUNCTION public.haf_reject_mutation('commerce prices are immutable; create a new price');

CREATE TRIGGER commerce_refunds_retained BEFORE DELETE ON public.commerce_refunds FOR EACH ROW EXECUTE FUNCTION public.haf_reject_mutation('commerce refunds are retained');

CREATE TRIGGER commerce_reporting_ledger_immutable_delete BEFORE DELETE ON public.commerce_reporting_ledger FOR EACH ROW EXECUTE FUNCTION public.haf_reject_mutation('commerce reporting ledger is immutable');

CREATE TRIGGER commerce_reporting_ledger_immutable_update BEFORE UPDATE ON public.commerce_reporting_ledger FOR EACH ROW EXECUTE FUNCTION public.haf_reject_mutation('commerce reporting ledger is immutable');

CREATE TRIGGER commerce_seller_acceptances_immutable_delete BEFORE DELETE ON public.commerce_seller_acceptances FOR EACH ROW EXECUTE FUNCTION public.haf_reject_mutation('commerce seller acceptances are retained');

CREATE TRIGGER commerce_seller_acceptances_immutable_update BEFORE UPDATE ON public.commerce_seller_acceptances FOR EACH ROW EXECUTE FUNCTION public.haf_reject_mutation('commerce seller acceptances are immutable');

CREATE TRIGGER configuration_revisions_advance_head AFTER INSERT ON public.configuration_revisions FOR EACH ROW EXECUTE FUNCTION public.haf_advance_configuration_revision_head();

CREATE TRIGGER configuration_revisions_validate_head BEFORE INSERT ON public.configuration_revisions FOR EACH ROW EXECUTE FUNCTION public.haf_validate_configuration_revision_head();

CREATE TRIGGER event_lifecycle_transition_guard BEFORE INSERT ON public.event_lifecycle_transition_guards FOR EACH ROW EXECUTE FUNCTION public.haf_guard_event_lifecycle_transition();

CREATE TRIGGER event_signup_mutation_guard BEFORE INSERT ON public.event_signup_mutation_guards FOR EACH ROW EXECUTE FUNCTION public.haf_guard_event_signup_mutation();

CREATE TRIGGER event_team_bulk_commit_guard BEFORE INSERT ON public.event_team_bulk_commit_guards FOR EACH ROW EXECUTE FUNCTION public.haf_guard_event_team_bulk_commit();

CREATE TRIGGER event_team_memberships_group_guard BEFORE INSERT ON public.event_team_memberships FOR EACH ROW EXECUTE FUNCTION public.haf_guard_event_team_membership_group();

CREATE TRIGGER event_team_memberships_signup_guard BEFORE INSERT ON public.event_team_memberships FOR EACH ROW EXECUTE FUNCTION public.haf_guard_event_team_membership_signup();

CREATE TRIGGER event_team_memberships_size_guard BEFORE INSERT ON public.event_team_memberships FOR EACH ROW EXECUTE FUNCTION public.haf_guard_event_team_membership_size();

CREATE TRIGGER event_team_proposal_acceptance_guard BEFORE INSERT ON public.event_team_proposal_acceptance_guards FOR EACH ROW EXECUTE FUNCTION public.haf_guard_event_team_proposal_acceptance();

CREATE TRIGGER managed_message_deleted_out_of_band_outbox AFTER UPDATE OF status ON public.managed_messages FOR EACH ROW WHEN (((old.status = 'published'::text) AND (new.status = 'missing'::text))) EXECUTE FUNCTION public.haf_enqueue_missing_managed_message();

CREATE TRIGGER server_level_servers_limit_before_insert BEFORE INSERT ON public.server_level_servers FOR EACH ROW EXECUTE FUNCTION public.enforce_server_level_server_limit();

ALTER TABLE ONLY public."Account"
    ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."Invitation"
    ADD CONSTRAINT "Invitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."Member"
    ADD CONSTRAINT "Member_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."Member"
    ADD CONSTRAINT "Member_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."Session"
    ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."WorkspaceEntitlement"
    ADD CONSTRAINT "WorkspaceEntitlement_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."WorkspaceGuildAuditEvent"
    ADD CONSTRAINT "WorkspaceGuildAuditEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES public."Organization"(id) ON DELETE CASCADE;

ALTER TABLE ONLY public."WorkspaceGuild"
    ADD CONSTRAINT "WorkspaceGuild_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.ban_case_operation_projections
    ADD CONSTRAINT ban_case_operation_projections_id_fkey FOREIGN KEY (id) REFERENCES public.ban_case_operations(id);

ALTER TABLE ONLY public.billing_delivery_attempts
    ADD CONSTRAINT billing_delivery_attempts_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.billing_operations_ledger(id);

ALTER TABLE ONLY public.billing_delivery_outbox
    ADD CONSTRAINT billing_delivery_outbox_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.billing_operations_ledger(id);

ALTER TABLE ONLY public.billing_guild_assignments
    ADD CONSTRAINT billing_guild_assignments_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.billing_subscriptions(owner_id);

ALTER TABLE ONLY public.billing_operation_delivery
    ADD CONSTRAINT billing_operation_delivery_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.billing_operations_ledger(id);

ALTER TABLE ONLY public.billing_subscriptions
    ADD CONSTRAINT billing_subscriptions_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.billing_customer_bindings(owner_id);

ALTER TABLE ONLY public.billing_sync_outbox
    ADD CONSTRAINT billing_sync_outbox_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.billing_webhook_events(event_id);

ALTER TABLE ONLY public.clan_applications
    ADD CONSTRAINT clan_applications_clan_id_fkey FOREIGN KEY (clan_id) REFERENCES public.clans(id);

ALTER TABLE ONLY public.clan_change_requests
    ADD CONSTRAINT clan_change_requests_clan_id_fkey FOREIGN KEY (clan_id) REFERENCES public.clans(id);

ALTER TABLE ONLY public.clan_invitations
    ADD CONSTRAINT clan_invitations_clan_id_fkey FOREIGN KEY (clan_id) REFERENCES public.clans(id);

ALTER TABLE ONLY public.clan_membership_blocks
    ADD CONSTRAINT clan_membership_blocks_clan_id_fkey FOREIGN KEY (clan_id) REFERENCES public.clans(id);

ALTER TABLE ONLY public.clan_memberships
    ADD CONSTRAINT clan_memberships_clan_id_fkey FOREIGN KEY (clan_id) REFERENCES public.clans(id);

ALTER TABLE ONLY public.clan_ownership_transfers
    ADD CONSTRAINT clan_ownership_transfers_clan_id_fkey FOREIGN KEY (clan_id) REFERENCES public.clans(id);

ALTER TABLE ONLY public.clans
    ADD CONSTRAINT clans_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.clan_requests(id);

ALTER TABLE ONLY public.discord_ban_appeal_cooldowns
    ADD CONSTRAINT discord_ban_appeal_cooldowns_guild_id_fkey FOREIGN KEY (guild_id) REFERENCES public.discord_ban_appeal_configs(guild_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.discord_ban_appeal_operations
    ADD CONSTRAINT discord_ban_appeal_operations_guild_id_appeal_id_fkey FOREIGN KEY (guild_id, appeal_id) REFERENCES public.discord_ban_appeals(guild_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.discord_ban_appeals
    ADD CONSTRAINT discord_ban_appeals_guild_id_fkey FOREIGN KEY (guild_id) REFERENCES public.discord_ban_appeal_configs(guild_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.feature_setup_resolutions
    ADD CONSTRAINT feature_setup_resolutions_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.feature_setup_runs(id);

ALTER TABLE ONLY public.reputation_awards
    ADD CONSTRAINT reputation_awards_guild_id_fkey FOREIGN KEY (guild_id) REFERENCES public.reputation_configs(guild_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.reputation_cooldowns
    ADD CONSTRAINT reputation_cooldowns_guild_id_fkey FOREIGN KEY (guild_id) REFERENCES public.reputation_configs(guild_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.reputation_reward_jobs
    ADD CONSTRAINT reputation_reward_jobs_guild_id_fkey FOREIGN KEY (guild_id) REFERENCES public.reputation_configs(guild_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.reputation_scores
    ADD CONSTRAINT reputation_scores_guild_id_fkey FOREIGN KEY (guild_id) REFERENCES public.reputation_configs(guild_id) ON DELETE CASCADE;

-- Current built-in identity recognizers.
INSERT INTO public.identity_patterns
  (id, platform, pattern, capture_group, "position", disabled, created_at_ms)
VALUES
  ('seed-steam-profile-url', 'steam', 'steamcommunity\.com/profiles/(\d{17})', 1, 10, 0, 0),
  ('seed-steam-id64', 'steam', '\b(7656119\d{10})\b', 1, 20, 0, 0),
  ('seed-discord-mention', 'discord', '<@!?(\d{17,20})>', 1, 30, 0, 0),
  ('seed-discord-id', 'discord', '\b(\d{17,20})\b', 1, 40, 0, 0),
  ('seed-xbox-xuid', 'xbox', '\b(\d{16})\b', 1, 50, 0, 0),
  ('seed-cftools-url', 'cftools', 'cftools\.(?:cloud|com)/(?:profile|users?)/(?:steam/)?([A-Za-z0-9_-]+)', 1, 60, 0, 0);
