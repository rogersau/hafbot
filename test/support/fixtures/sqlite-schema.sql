-- SQLite fixture for adapter tests. Production uses schema/postgres.sql.

CREATE TABLE "Account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" DATETIME,
    "refreshTokenExpiresAt" DATETIME,
    "scope" TEXT,
    "password" TEXT,
    "createdAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT,
    "status" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "inviterId" TEXT NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
    CONSTRAINT "Invitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "Member" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL,
    CONSTRAINT "Member_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "Organization" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logo" TEXT,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL
);

CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "token" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL, "activeOrganizationId" TEXT,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL,
    "image" TEXT,
    "discordUserId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "Verification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME,
    "updatedAt" DATETIME
);

CREATE TABLE "WorkspaceEntitlement" (
    "workspaceId" TEXT NOT NULL PRIMARY KEY,
    "plan" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "enabledFlagsJson" TEXT NOT NULL,
    "updatedAtMs" INTEGER NOT NULL,
    CONSTRAINT "WorkspaceEntitlement_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "WorkspaceGuild" (
    "workspaceId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "linkedByUserId" TEXT NOT NULL,
    "linkedAtMs" INTEGER NOT NULL,

    PRIMARY KEY ("workspaceId", "guildId"),
    CONSTRAINT "WorkspaceGuild_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "WorkspaceGuildAuditEvent" (
    "id" TEXT PRIMARY KEY NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "action" TEXT NOT NULL CHECK ("action" IN ('linked', 'unlinked')),
    "actorUserId" TEXT NOT NULL,
    "occurredAtMs" INTEGER NOT NULL,
    "previousWorkspaceId" TEXT,
    CONSTRAINT "WorkspaceGuildAuditEvent_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "Organization" ("id")
      ON DELETE CASCADE
);

CREATE TABLE admin_feedback (
  id TEXT PRIMARY KEY NOT NULL,
  reference TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL CHECK (category IN ('problem', 'suggestion', 'other')),
  summary TEXT NOT NULL,
  description TEXT NOT NULL,
  reporter_user_id TEXT NOT NULL,
  guild_id TEXT,
  workspace_id TEXT,
  route TEXT NOT NULL,
  correlation_id TEXT,
  ray_id TEXT,
  worker_version TEXT NOT NULL,
  environment TEXT NOT NULL,
  diagnostics_included INTEGER NOT NULL CHECK (diagnostics_included IN (0, 1)),
  browser TEXT,
  os TEXT,
  notification_state TEXT NOT NULL DEFAULT 'pending' CHECK (notification_state IN ('pending', 'sent', 'failed')),
  notification_error_code TEXT,
  created_at_ms INTEGER NOT NULL
, page_label TEXT, error_code TEXT);

CREATE TABLE app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE attendance_observation_reports (id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,data TEXT NOT NULL);

CREATE TABLE attendance_observation_runs (
 id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, target_id TEXT NOT NULL, generation INTEGER NOT NULL,
 active_target TEXT UNIQUE, revision INTEGER NOT NULL, lease TEXT, next_at_ms INTEGER NOT NULL,
 expires_at_ms INTEGER NOT NULL, delete_at_ms INTEGER NOT NULL, duplicates INTEGER NOT NULL DEFAULT 0,
 late INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL
);

CREATE TABLE attendance_observation_samples (
 id TEXT PRIMARY KEY,run_id TEXT NOT NULL,guild_id TEXT NOT NULL,target_id TEXT NOT NULL,
 generation INTEGER NOT NULL,slot INTEGER NOT NULL,claim_token TEXT NOT NULL,next_allowed_at_ms INTEGER NOT NULL,delete_at_ms INTEGER NOT NULL,data TEXT NOT NULL,
 UNIQUE(target_id,generation,slot)
);

CREATE TABLE ban_case_configs (
  guild_id TEXT PRIMARY KEY NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  forum_channel_id TEXT,
  mod_role_ids_json TEXT NOT NULL DEFAULT '[]',
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE ban_case_confirmations (
  id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, actor_id TEXT NOT NULL, expires_at_ms BIGINT NOT NULL, operation_id TEXT, data TEXT NOT NULL
);

CREATE TABLE ban_case_operation_projections (
  id TEXT PRIMARY KEY REFERENCES ban_case_operations(id),
  token TEXT NOT NULL, next_at_ms BIGINT NOT NULL, delivered_revision INTEGER NOT NULL,
  data TEXT NOT NULL
);

CREATE TABLE ban_case_operational_incident_events (
  id TEXT PRIMARY KEY NOT NULL,
  incident_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('opened', 'observed', 'severity_changed', 'remediation_started', 'remediation_succeeded', 'remediation_failed', 'resolved', 'reopened')),
  observation_id TEXT,
  reason_code TEXT,
  safe_args_json TEXT NOT NULL,
  correlation_id TEXT,
  actor_user_id TEXT,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (incident_id, observation_id)
);

CREATE TABLE ban_case_operational_incidents (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  incident_key TEXT NOT NULL,
  feature TEXT NOT NULL CHECK (feature IN ('ban-cases')),
  resource_kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  condition TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'error', 'critical')),
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  summary_code TEXT NOT NULL,
  safe_args_json TEXT NOT NULL,
  remediation_code TEXT NOT NULL,
  first_seen_at_ms INTEGER NOT NULL,
  open_since_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL,
  resolved_at_ms INTEGER,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  last_correlation_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (guild_id, incident_key)
);

CREATE TABLE ban_case_operations (
  id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, physical_target TEXT NOT NULL,
  subject TEXT NOT NULL, action TEXT NOT NULL, active INTEGER NOT NULL, revision INTEGER NOT NULL,
  next_at_ms BIGINT NOT NULL, data TEXT NOT NULL
);

CREATE TABLE ban_case_sources (
  guild_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  public_id TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  platform TEXT NOT NULL,
  pattern TEXT NOT NULL,
  flags TEXT NOT NULL DEFAULT '',
  subject_id_group TEXT NOT NULL DEFAULT 'subjectId',
  name_group TEXT NOT NULL DEFAULT 'username',
  reason_group TEXT NOT NULL DEFAULT 'reason',
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (guild_id, source_id)
);

CREATE TABLE ban_cases (
  guild_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  public_id TEXT NOT NULL,
  subject_platform TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  username TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  thread_channel_id TEXT NOT NULL,
  thread_message_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (guild_id, case_id)
);

CREATE TABLE billing_customer_bindings (
  owner_id TEXT PRIMARY KEY NOT NULL,
  stripe_customer_id TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE billing_delivery_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  operation_id TEXT NOT NULL,
  destination TEXT NOT NULL,
  outcome TEXT NOT NULL,
  provider_correlation_id TEXT,
  attempted_at_ms INTEGER NOT NULL,
  FOREIGN KEY(operation_id) REFERENCES billing_operations_ledger(id)
);

CREATE TABLE billing_delivery_outbox (
  operation_id TEXT PRIMARY KEY NOT NULL,
  created_at_ms INTEGER NOT NULL,
  sent_at_ms INTEGER,
  FOREIGN KEY(operation_id) REFERENCES billing_operations_ledger(id)
);

CREATE TABLE billing_guild_assignments (
  guild_id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  stripe_subscription_id TEXT NOT NULL,
  assigned_at_ms INTEGER NOT NULL,
  FOREIGN KEY(owner_id) REFERENCES billing_subscriptions(owner_id)
);

CREATE TABLE billing_operation_delivery (
  operation_id TEXT PRIMARY KEY NOT NULL,
  owner_dm_status TEXT NOT NULL DEFAULT 'pending',
  audit_status TEXT NOT NULL DEFAULT 'pending',
  next_attempt_at_ms INTEGER,
  terminal_reason TEXT,
  updated_at_ms INTEGER NOT NULL, owner_dm_message_id TEXT, audit_message_id TEXT, owner_attempt_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(operation_id) REFERENCES billing_operations_ledger(id)
);

CREATE TABLE billing_operations_ledger (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  correlation_id TEXT,
  summary_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE billing_owner_sync_state (
  owner_id TEXT PRIMARY KEY NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  lease_until_ms INTEGER,
  completed_generation INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE billing_reconciliation_failures (
  owner_id TEXT PRIMARY KEY NOT NULL,
  reason TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  first_failed_at_ms INTEGER NOT NULL,
  last_failed_at_ms INTEGER NOT NULL,
  terminal_at_ms INTEGER
);

CREATE TABLE billing_subscriptions (
  owner_id TEXT PRIMARY KEY NOT NULL,
  stripe_customer_id TEXT NOT NULL UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  stripe_price_id TEXT,
  stripe_product_id TEXT,
  plan TEXT NOT NULL CHECK(plan IN ('free', 'premium', 'premium_plus')),
  frequency TEXT CHECK(frequency IS NULL OR frequency IN ('monthly', 'yearly')),
  status TEXT NOT NULL,
  current_period_start_ms INTEGER,
  current_period_end_ms INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  cancelled_at_ms INTEGER,
  latest_invoice_id TEXT,
  schedule_id TEXT,
  observed_at_ms INTEGER NOT NULL,
  quarantine_reason TEXT, grace_started_at_ms INTEGER, grace_ends_at_ms INTEGER, grace_expired_at_ms INTEGER,
  FOREIGN KEY(owner_id) REFERENCES billing_customer_bindings(owner_id)
);

CREATE TABLE billing_support_cases (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  safe_provider_ids_json TEXT NOT NULL DEFAULT '[]',
  opened_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  resolved_at_ms INTEGER
);

CREATE TABLE billing_sync_outbox (
  event_id TEXT PRIMARY KEY NOT NULL,
  stripe_customer_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  sent_at_ms INTEGER,
  FOREIGN KEY(event_id) REFERENCES billing_webhook_events(event_id)
);

CREATE TABLE billing_tester_cutovers (
  owner_id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL,
  inventory_json TEXT NOT NULL,
  promotion_code_id TEXT,
  deadline_ms INTEGER NOT NULL,
  rolled_back_at_ms INTEGER,
  completed_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE billing_webhook_events (
  event_id TEXT PRIMARY KEY NOT NULL,
  event_type TEXT NOT NULL,
  object_id TEXT,
  stripe_customer_id TEXT NOT NULL,
  stripe_created_at_ms INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  received_at_ms INTEGER NOT NULL,
  processing_status TEXT NOT NULL CHECK(processing_status IN ('pending', 'processed', 'terminal')),
  processed_at_ms INTEGER,
  terminal_reason TEXT
);

CREATE TABLE bot_defense_configs (
  guild_id TEXT PRIMARY KEY NOT NULL,
  honeypot_enabled INTEGER NOT NULL DEFAULT 0,
  rate_enabled INTEGER NOT NULL DEFAULT 0,
  honeypot_channel_ids_json TEXT NOT NULL DEFAULT '[]',
  rate_channel_threshold INTEGER NOT NULL DEFAULT 5,
  rate_window_seconds INTEGER NOT NULL DEFAULT 60,
  excluded_role_ids_json TEXT NOT NULL DEFAULT '[]',
  mod_role_ids_json TEXT NOT NULL DEFAULT '[]',
  mod_queue_channel_id TEXT,
  ping_on_queue_post INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
, honeypot_warn_user INTEGER NOT NULL DEFAULT 0, honeypot_delete_message INTEGER NOT NULL DEFAULT 0, rate_warn_user INTEGER NOT NULL DEFAULT 0, rate_delete_message INTEGER NOT NULL DEFAULT 0);

CREATE TABLE bot_defense_rate_window_events (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_timestamp_ms INTEGER NOT NULL
, message_fingerprint TEXT NOT NULL DEFAULT '');

CREATE TABLE bot_flags (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  detector_type TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  queue_message_id TEXT,
  resolved_by_discord_user_id TEXT,
  resolved_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE clan_applications (
  id TEXT PRIMARY KEY NOT NULL,
  clan_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  applicant_id TEXT NOT NULL,
  message TEXT NOT NULL,
  experience TEXT,
  availability TEXT,
  play_style TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepting', 'accepted', 'rejected', 'expired', 'cancelled')),
  decided_by_user_id TEXT,
  decision_reason TEXT,
  expires_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  FOREIGN KEY (clan_id) REFERENCES clans(id)
);

CREATE TABLE clan_change_requests (
  id TEXT PRIMARY KEY NOT NULL,
  clan_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('identity', 'deletion', 'restoration', 'owner-recovery')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  payload_json TEXT NOT NULL,
  requested_by_user_id TEXT NOT NULL,
  reviewed_by_user_id TEXT,
  review_reason TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  retention_expires_at_ms INTEGER,
  FOREIGN KEY (clan_id) REFERENCES clans(id)
);

CREATE TABLE clan_history (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  clan_id TEXT,
  request_id TEXT,
  event TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  reason TEXT,
  before_json TEXT,
  after_json TEXT,
  created_at_ms INTEGER NOT NULL,
  retention_expires_at_ms INTEGER NOT NULL
);

CREATE TABLE clan_invitations (
  id TEXT PRIMARY KEY NOT NULL,
  clan_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  invitee_id TEXT NOT NULL,
  invited_by_user_id TEXT NOT NULL,
  intended_rank TEXT NOT NULL CHECK (intended_rank IN ('officer', 'member')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepting', 'accepted', 'rejected', 'expired', 'cancelled')),
  expires_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  FOREIGN KEY (clan_id) REFERENCES clans(id)
);

CREATE TABLE clan_management_configs (
  guild_id TEXT PRIMARY KEY NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  reviewer_role_ids_json TEXT NOT NULL DEFAULT '[]',
  staff_access_role_ids_json TEXT NOT NULL DEFAULT '[]',
  eligibility_allowed_role_ids_json TEXT NOT NULL DEFAULT '[]',
  eligibility_required_role_ids_json TEXT NOT NULL DEFAULT '[]',
  minimum_account_age_days INTEGER NOT NULL DEFAULT 0 CHECK (minimum_account_age_days >= 0),
  minimum_guild_tenure_days INTEGER NOT NULL DEFAULT 0 CHECK (minimum_guild_tenure_days >= 0),
  request_cooldown_days INTEGER NOT NULL DEFAULT 7 CHECK (request_cooldown_days >= 0),
  invitation_expiry_days INTEGER NOT NULL DEFAULT 7 CHECK (invitation_expiry_days > 0),
  application_expiry_days INTEGER NOT NULL DEFAULT 7 CHECK (application_expiry_days > 0),
  local_clans_max INTEGER CHECK (local_clans_max IS NULL OR local_clans_max > 0),
  local_members_max INTEGER CHECK (local_members_max IS NULL OR local_members_max > 0),
  local_officers_max INTEGER CHECK (local_officers_max IS NULL OR local_officers_max >= 0),
  category_id TEXT,
  request_panel_channel_id TEXT,
  request_panel_message_id TEXT,
  board_enabled INTEGER NOT NULL DEFAULT 0 CHECK (board_enabled IN (0, 1)),
  board_channel_id TEXT,
  board_channel_type TEXT CHECK (board_channel_type IS NULL OR board_channel_type IN ('forum', 'text')),
  role_name_template TEXT NOT NULL DEFAULT '[{tag}] {name}',
  text_channel_name_template TEXT NOT NULL DEFAULT '{tag}-chat',
  voice_channel_name_template TEXT NOT NULL DEFAULT '{tag} Voice',
  inactivity_enabled INTEGER NOT NULL DEFAULT 0 CHECK (inactivity_enabled IN (0, 1)),
  inactivity_warning_days INTEGER NOT NULL DEFAULT 60 CHECK (inactivity_warning_days > 0),
  inactivity_archive_days INTEGER NOT NULL DEFAULT 90 CHECK (inactivity_archive_days > inactivity_warning_days),
  public_lfg_attribution_enabled INTEGER NOT NULL DEFAULT 1 CHECK (public_lfg_attribution_enabled IN (0, 1)),
  updated_at_ms INTEGER NOT NULL
, request_review_category_id TEXT, request_panel_title TEXT NOT NULL DEFAULT 'Create a Clan', request_panel_description TEXT NOT NULL DEFAULT 'Submit a Clan creation request for staff review. A private review ticket will be created for you and the Clan review team.', request_panel_button_label TEXT NOT NULL DEFAULT 'Create Clan', request_panel_color INTEGER NOT NULL DEFAULT 5793266 CHECK (request_panel_color BETWEEN 0 AND 16777215));

CREATE TABLE clan_membership_blocks (
  id TEXT PRIMARY KEY NOT NULL,
  clan_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  lifted_at_ms INTEGER,
  lifted_by_user_id TEXT,
  FOREIGN KEY (clan_id) REFERENCES clans(id)
);

CREATE TABLE clan_memberships (
  clan_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  rank TEXT NOT NULL CHECK (rank IN ('owner', 'officer', 'member')),
  joined_at_ms INTEGER NOT NULL,
  left_at_ms INTEGER,
  PRIMARY KEY (clan_id, user_id, joined_at_ms),
  FOREIGN KEY (clan_id) REFERENCES clans(id)
);

CREATE TABLE clan_ownership_transfers (
  id TEXT PRIMARY KEY NOT NULL,
  clan_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  from_user_id TEXT NOT NULL,
  to_user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'cancelled', 'expired')),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  resolved_at_ms INTEGER,
  FOREIGN KEY (clan_id) REFERENCES clans(id)
);

CREATE TABLE clan_requests (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  tag TEXT NOT NULL,
  normalized_tag TEXT NOT NULL,
  description TEXT NOT NULL,
  focus TEXT NOT NULL,
  recruitment_state TEXT NOT NULL CHECK (recruitment_state IN ('applications-open', 'invite-only', 'closed')),
  proposed_officer_ids_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('pending', 'changes-requested', 'approved', 'rejected', 'cancelled')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  reviewer_id TEXT,
  review_reason TEXT,
  clan_id TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  terminal_at_ms INTEGER,
  retention_expires_at_ms INTEGER
, review_channel_id TEXT, review_message_id TEXT, review_ticket_state TEXT NOT NULL DEFAULT 'pending' CHECK (review_ticket_state IN ('pending', 'creating', 'open', 'decision-pending', 'closed')), review_ticket_error TEXT);

CREATE TABLE clans (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  tag TEXT NOT NULL,
  normalized_tag TEXT NOT NULL,
  description TEXT NOT NULL,
  focus TEXT NOT NULL,
  icon TEXT,
  recruitment_state TEXT NOT NULL CHECK (recruitment_state IN ('applications-open', 'invite-only', 'closed')),
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('provisioning', 'active', 'degraded', 'archived', 'deletion-recovery', 'plan-dormant', 'permanently-deleted')),
  role_id TEXT,
  text_channel_id TEXT,
  voice_channel_id TEXT,
  board_projection_id TEXT,
  board_projection_channel_id TEXT,
  operation TEXT,
  degraded_reason TEXT,
  sensitive_management_frozen INTEGER NOT NULL DEFAULT 0 CHECK (sensitive_management_frozen IN (0, 1)),
  clan_lfg_leadership_only INTEGER NOT NULL DEFAULT 0 CHECK (clan_lfg_leadership_only IN (0, 1)),
  latest_activity_at_ms INTEGER,
  latest_activity_type TEXT CHECK (latest_activity_type IS NULL OR latest_activity_type IN ('text', 'voice', 'clan-lfg', 'membership', 'management')),
  inactivity_warned_at_ms INTEGER,
  deletion_due_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  permanently_deleted_at_ms INTEGER,
  FOREIGN KEY (request_id) REFERENCES clan_requests(id)
);

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

CREATE TABLE commerce_buyers (
  id TEXT PRIMARY KEY NOT NULL,
  discord_user_id TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

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
  updated_at_ms INTEGER NOT NULL, provider_terminal_at_ms BIGINT, pre_session_failed_at_ms BIGINT,
  UNIQUE (connected_account_id, stripe_checkout_session_id)
);

CREATE TABLE commerce_checkout_capacity_claims (
  id TEXT PRIMARY KEY NOT NULL,
  checkout_kind TEXT NOT NULL CHECK (checkout_kind IN ('subscription', 'support')),
  connected_account_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  offering_id TEXT,
  currency TEXT NOT NULL CHECK (currency IN ('AUD', 'USD')),
  amount_minor INTEGER NOT NULL,
  month_started_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE commerce_checkout_rate_limits (
  buyer_id TEXT NOT NULL,
  offering_id TEXT NOT NULL,
  window_started_at_ms INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (buyer_id, offering_id)
);

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

CREATE TABLE commerce_financial_actions (
  id TEXT PRIMARY KEY NOT NULL,
  connected_account_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  amount_minor INTEGER,
  currency TEXT,
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  provider_result_id TEXT,
  access_action TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  last_error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER
, lease_token TEXT, claimed_at_ms INTEGER, lease_expires_at_ms INTEGER, available_at_ms INTEGER NOT NULL DEFAULT 0, provider_completed_at_ms INTEGER, reconciliation_requested_at_ms INTEGER, quarantined_at_ms INTEGER);

CREATE TABLE commerce_financial_provider_actions (
  id TEXT PRIMARY KEY NOT NULL,
  operation_key TEXT NOT NULL UNIQUE,
  parent_action_id TEXT NOT NULL,
  workflow_type TEXT NOT NULL CHECK (
    workflow_type IN (
      'offering_retirement', 'seller_offboarding', 'renewal_shutdown', 'refund_followup'
    )
  ),
  workflow_id TEXT NOT NULL,
  connected_account_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  offering_id TEXT,
  subscription_id TEXT NOT NULL,
  stripe_subscription_id TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK (
    action_type IN ('subscription.cancel_at_period_end', 'subscription.cancel_immediately')
  ),
  reason_code TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'processing', 'completed', 'failed', 'quarantined')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at_ms INTEGER NOT NULL,
  lease_token TEXT,
  claimed_at_ms INTEGER,
  lease_expires_at_ms INTEGER,
  provider_completed_at_ms INTEGER,
  reconciliation_requested_at_ms INTEGER,
  completed_at_ms INTEGER,
  last_error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE commerce_game_assignments (
 id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
 physical_target TEXT NOT NULL, subject TEXT NOT NULL, slot INTEGER,
 generation INTEGER NOT NULL, revision INTEGER NOT NULL, next_at_ms BIGINT NOT NULL, data TEXT NOT NULL,
 UNIQUE(physical_target, subject), UNIQUE(physical_target, slot)
);

CREATE TABLE commerce_game_audit(id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,created_at_ms BIGINT NOT NULL,data TEXT NOT NULL);

CREATE TABLE commerce_game_fulfillments (offering_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, target_id TEXT NOT NULL, physical_target TEXT NOT NULL, origin TEXT NOT NULL, data TEXT NOT NULL);

CREATE TABLE commerce_game_selections (checkout_id TEXT PRIMARY KEY, offering_id TEXT NOT NULL, buyer_id TEXT NOT NULL, assignment_id TEXT NOT NULL, data TEXT NOT NULL);

CREATE TABLE commerce_guild_deletion_refund_reviews (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  connected_account_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  buyer_id TEXT NOT NULL,
  payment_id TEXT,
  payment_paid_at_ms INTEGER,
  paid_through_at_ms INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending', 'reviewed', 'waived')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (connected_account_id, subscription_id)
);

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

CREATE TABLE commerce_limit_alerts (
  id TEXT PRIMARY KEY NOT NULL,
  connected_account_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  currency TEXT,
  threshold_percent INTEGER NOT NULL,
  observed_value INTEGER NOT NULL,
  limit_value INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  first_seen_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL,
  resolved_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE commerce_offering_retirements (
  id TEXT PRIMARY KEY NOT NULL,
  connected_account_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  offering_id TEXT NOT NULL UNIQUE,
  requested_by_user_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'requested',
      'stopping_sales',
      'scheduling_cancellations',
      'waiting_for_period_end',
      'complete',
      'failed'
    )
  ),
  active_subscription_count INTEGER NOT NULL DEFAULT 0,
  scheduled_cancellation_count INTEGER NOT NULL DEFAULT 0,
  failed_cancellation_count INTEGER NOT NULL DEFAULT 0,
  latest_period_end_ms INTEGER,
  last_error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER
);

CREATE TABLE commerce_offerings (
  id TEXT PRIMARY KEY NOT NULL,
  connected_account_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  discord_role_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  purchase_type TEXT NOT NULL CHECK (purchase_type IN ('subscription', 'one_time')),
  state TEXT NOT NULL CHECK (
    state IN ('draft', 'published', 'unpublished', 'repair_required', 'retiring', 'archived', 'suspended')
  ),
  terms_version TEXT,
  included_benefits_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(included_benefits_json)),
  support_contact TEXT,
  role_manageable INTEGER NOT NULL DEFAULT 0 CHECK (role_manageable IN (0, 1)),
  repair_deadline_at_ms INTEGER,
  repair_previous_state TEXT CHECK (
    repair_previous_state IS NULL OR repair_previous_state IN ('draft', 'published', 'unpublished', 'retiring', 'suspended')
  ),
  retire_at_ms INTEGER,
  published_at_ms INTEGER,
  archived_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK ((state = 'archived') = (archived_at_ms IS NOT NULL)),
  CHECK (state <> 'retiring' OR retire_at_ms IS NOT NULL),
  CHECK ((state = 'repair_required') = (repair_previous_state IS NOT NULL))
);

CREATE TABLE commerce_operational_controls (
  id TEXT PRIMARY KEY NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'guild', 'seller', 'offering')),
  scope_id TEXT NOT NULL,
  control_type TEXT NOT NULL CHECK (control_type IN (
    'commerce_kill', 'new_checkout', 'sales_suspension', 'offering_suspension',
    'renewal_shutdown', 'support_shutdown', 'webhook_quarantine'
  )),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  reason_code TEXT,
  actor_user_id TEXT NOT NULL,
  expires_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (scope_type, scope_id, control_type)
);

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

CREATE TABLE commerce_paid_role_operations (
  operation_key TEXT PRIMARY KEY NOT NULL,
  entitlement_id TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing','committed')),
  created_at_ms INTEGER NOT NULL,
  claimed_at_ms INTEGER NOT NULL,
  lease_expires_at_ms INTEGER NOT NULL,
  committed_at_ms INTEGER,
  CHECK (
    (status = 'processing' AND committed_at_ms IS NULL) OR
    (status = 'committed' AND committed_at_ms IS NOT NULL)
  )
);

CREATE TABLE commerce_paid_role_outbox (
  id TEXT PRIMARY KEY NOT NULL,
  operation_key TEXT NOT NULL UNIQUE,
  entitlement_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  discord_user_id TEXT NOT NULL,
  discord_role_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('assign','remove','repair')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL CHECK (status IN ('pending','sent','dead_letter')),
  available_at_ms INTEGER NOT NULL,
  sent_at_ms INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK ((status = 'pending' AND sent_at_ms IS NULL) OR status <> 'pending')
);

CREATE TABLE commerce_paid_role_provider_actions (
  id TEXT PRIMARY KEY NOT NULL,
  operation_key TEXT NOT NULL UNIQUE,
  assignment_id TEXT,
  connected_account_id TEXT NOT NULL,
  stripe_subscription_id TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK (
    action_type IN ('subscription.cancel_at_period_end', 'subscription.cancel_immediately')
  ),
  reason_code TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at_ms INTEGER NOT NULL,
  claimed_at_ms INTEGER,
  lease_expires_at_ms INTEGER,
  completed_at_ms INTEGER,
  last_error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE commerce_paid_role_repairs (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  old_role_id TEXT NOT NULL,
  replacement_role_id TEXT,
  started_at_ms INTEGER NOT NULL,
  deadline_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','complete','quarantined')),
  repaired_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL, offering_id TEXT,
  CHECK (deadline_at_ms > started_at_ms)
);

CREATE TABLE commerce_paid_role_states (
  entitlement_id TEXT PRIMARY KEY NOT NULL,
  connected_account_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  discord_user_id TEXT NOT NULL,
  discord_role_id TEXT NOT NULL,
  subscription_id TEXT,
  subscription_status TEXT NOT NULL CHECK (subscription_status IN ('incomplete','trialing','active','past_due','paused','unpaid','canceled','ended')),
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0,1)),
  current_period_end_ms INTEGER,
  payment_status TEXT CHECK (payment_status IS NULL OR payment_status IN ('requires_action','processing','succeeded','failed','canceled')),
  amount_minor INTEGER,
  amount_refunded_minor INTEGER NOT NULL DEFAULT 0,
  dispute_status TEXT CHECK (dispute_status IS NULL OR dispute_status IN ('warning_needs_response','warning_under_review','warning_closed','needs_response','under_review','won','lost')),
  failed_payment_at_ms INTEGER,
  admin_action TEXT CHECK (admin_action IS NULL OR admin_action IN ('suspend','revoke')),
  member_state TEXT NOT NULL CHECK (member_state IN ('present','left','kicked','rejoined','banned')),
  updated_at_ms INTEGER NOT NULL,
  CHECK (amount_minor IS NULL OR amount_minor >= 0),
  CHECK (amount_refunded_minor >= 0),
  CHECK (amount_minor IS NULL OR amount_refunded_minor <= amount_minor)
);

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
  updated_at_ms INTEGER NOT NULL, application_fee_minor INTEGER
  CHECK (application_fee_minor IS NULL OR application_fee_minor >= 0), stripe_fee_minor INTEGER
  CHECK (stripe_fee_minor IS NULL OR stripe_fee_minor >= 0), stripe_fee_tax_minor INTEGER
  CHECK (stripe_fee_tax_minor IS NULL OR stripe_fee_tax_minor >= 0),
  UNIQUE (connected_account_id, stripe_payment_intent_id),
  UNIQUE (connected_account_id, stripe_invoice_id),
  CHECK (amount_received_minor <= amount_minor),
  CHECK (amount_refunded_minor <= amount_received_minor)
);

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

CREATE TABLE commerce_role_assignments (
  id TEXT PRIMARY KEY NOT NULL,
  entitlement_id TEXT NOT NULL UNIQUE,
  guild_id TEXT NOT NULL,
  discord_user_id TEXT NOT NULL,
  discord_role_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'assigned', 'withheld', 'removing', 'removed', 'failed')),
  withheld_reason TEXT CHECK (
    withheld_reason IS NULL OR withheld_reason IN ('member_absent', 'guild_ban', 'dispute', 'admin_suspension')
  ),
  provider_cancellation_state TEXT NOT NULL DEFAULT 'none' CHECK (
    provider_cancellation_state IN ('none', 'pending', 'scheduled', 'completed', 'failed')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code TEXT,
  next_attempt_at_ms INTEGER,
  assigned_at_ms INTEGER,
  removed_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK ((status = 'withheld' AND withheld_reason IS NOT NULL) OR status <> 'withheld')
);

CREATE TABLE commerce_sales_panels (
  connected_account_id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  last_error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
, pending_channel_id TEXT, publication_nonce TEXT, publication_lease_token TEXT, publication_lease_expires_at_ms INTEGER, title TEXT NOT NULL DEFAULT 'Support this Discord server', description TEXT NOT NULL DEFAULT 'Discover paid Discord role access from this server.', pending_title TEXT, pending_description TEXT);

CREATE TABLE commerce_seller_acceptances (
  id TEXT PRIMARY KEY NOT NULL,
  connected_account_id TEXT NOT NULL,
  terms_version TEXT NOT NULL,
  accepted_by_user_id TEXT NOT NULL,
  accepted_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (connected_account_id, terms_version)
);

CREATE TABLE commerce_seller_controls (
  id TEXT PRIMARY KEY NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'guild')),
  scope_id TEXT NOT NULL,
  suspended INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0, 1)),
  reason_code TEXT,
  actor_user_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (scope_type, scope_id),
  CHECK (
    (scope_type = 'global' AND scope_id = 'commerce') OR
    (scope_type = 'guild' AND length(scope_id) > 0)
  ),
  CHECK ((suspended = 1 AND reason_code IS NOT NULL) OR suspended = 0)
);

CREATE TABLE commerce_seller_offboarding (
  connected_account_id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('canceling', 'waiting', 'ready', 'completed', 'unexpected_deauthorization')),
  reason_code TEXT NOT NULL,
  actor_user_id TEXT,
  active_subscription_count INTEGER NOT NULL DEFAULT 0,
  latest_paid_through_at_ms INTEGER,
  started_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE commerce_seller_profiles (
  connected_account_id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL UNIQUE,
  lifecycle_state TEXT NOT NULL CHECK (
    lifecycle_state IN (
      'onboarding_incomplete',
      'pending_review',
      'active',
      'restricted',
      'repair_required',
      'offboarding',
      'disconnected',
      'suspended'
    )
  ),
  approval_state TEXT NOT NULL CHECK (approval_state IN ('pending', 'approved', 'rejected')),
  support_contact TEXT NOT NULL,
  adult_attested_at_ms INTEGER NOT NULL,
  two_factor_evidence TEXT NOT NULL CHECK (
    two_factor_evidence IN ('discord_verified', 'seller_attested')
  ),
  guild_created_at_ms INTEGER NOT NULL,
  ownership_transferred_at_ms INTEGER,
  guild_good_standing INTEGER NOT NULL DEFAULT 0 CHECK (guild_good_standing IN (0, 1)),
  seller_good_standing INTEGER NOT NULL DEFAULT 0 CHECK (seller_good_standing IN (0, 1)),
  requirements_currently_due_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(requirements_currently_due_json)),
  requirements_eventually_due_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(requirements_eventually_due_json)),
  requirements_pending_verification_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(requirements_pending_verification_json)),
  disabled_reason TEXT,
  reviewed_by_user_id TEXT,
  reviewed_at_ms INTEGER,
  capabilities_updated_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL, seller_owner_user_id TEXT NOT NULL DEFAULT '',
  CHECK (
    (approval_state = 'pending' AND reviewed_at_ms IS NULL AND reviewed_by_user_id IS NULL) OR
    (approval_state IN ('approved', 'rejected') AND reviewed_at_ms IS NOT NULL
      AND reviewed_by_user_id IS NOT NULL)
  )
);

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
, guild_created_at_ms INTEGER);

CREATE TABLE commerce_store_branding (
  guild_id TEXT PRIMARY KEY NOT NULL,
  connected_account_id TEXT NOT NULL UNIQUE,
  accent_color INTEGER NOT NULL DEFAULT 5793266 CHECK (
    accent_color BETWEEN 0 AND 16777215 AND accent_color = CAST(accent_color AS INTEGER)
  ),
  tagline TEXT NOT NULL DEFAULT '' CHECK (length(tagline) <= 160),
  created_by_user_id TEXT NOT NULL,
  updated_by_user_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
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
  updated_at_ms INTEGER NOT NULL, checkout_attempt_id TEXT,
  UNIQUE (connected_account_id, stripe_subscription_id)
);

CREATE TABLE commerce_support_checkout_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  connected_account_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  buyer_id TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('AUD', 'USD')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor BETWEEN 200 AND 50000),
  application_fee_minor INTEGER NOT NULL CHECK (application_fee_minor >= 0),
  stripe_checkout_session_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('creating', 'open', 'returned', 'expired', 'failed')),
  expires_at_ms INTEGER NOT NULL,
  returned_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (connected_account_id, stripe_checkout_session_id)
);

CREATE TABLE commerce_support_configs (
  connected_account_id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  explanation TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('AUD', 'USD')),
  suggested_amounts_json TEXT NOT NULL,
  support_contact TEXT NOT NULL,
  terms_version TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE commerce_support_disputes (
  id TEXT PRIMARY KEY NOT NULL,
  connected_account_id TEXT NOT NULL,
  support_payment_id TEXT NOT NULL,
  stripe_dispute_id TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('AUD', 'USD')),
  amount_minor INTEGER NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  provider_created_at_ms INTEGER,
  closed_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (connected_account_id, stripe_dispute_id)
);

CREATE TABLE commerce_support_payments (
  id TEXT PRIMARY KEY NOT NULL,
  connected_account_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  buyer_id TEXT NOT NULL,
  checkout_attempt_id TEXT NOT NULL,
  stripe_payment_intent_id TEXT NOT NULL,
  stripe_charge_id TEXT,
  stripe_checkout_session_id TEXT,
  currency TEXT NOT NULL CHECK (currency IN ('AUD', 'USD')),
  amount_minor INTEGER NOT NULL,
  amount_received_minor INTEGER NOT NULL DEFAULT 0,
  amount_refunded_minor INTEGER NOT NULL DEFAULT 0,
  application_fee_minor INTEGER NOT NULL,
  stripe_fee_tax_minor INTEGER CHECK (stripe_fee_tax_minor IS NULL OR stripe_fee_tax_minor >= 0),
  stripe_fee_minor INTEGER,
  status TEXT NOT NULL,
  provider_created_at_ms INTEGER,
  paid_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (connected_account_id, stripe_payment_intent_id),
  UNIQUE (connected_account_id, checkout_attempt_id)
);

CREATE TABLE commerce_support_rate_limits (
  buyer_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  window_started_at_ms INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (buyer_id, guild_id)
);

CREATE TABLE commerce_support_refunds (
  id TEXT PRIMARY KEY NOT NULL,
  connected_account_id TEXT NOT NULL,
  support_payment_id TEXT NOT NULL,
  stripe_refund_id TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('AUD', 'USD')),
  amount_minor INTEGER NOT NULL,
  application_fee_refunded_minor INTEGER,
  status TEXT NOT NULL,
  reason TEXT,
  provider_created_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (connected_account_id, stripe_refund_id)
);

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
  updated_at_ms INTEGER NOT NULL, generation INTEGER NOT NULL DEFAULT 0, applied_generation INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_expires_at_ms INTEGER,
  UNIQUE (connected_account_id, resource_type, resource_id)
);

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
  updated_at_ms INTEGER NOT NULL, object_id TEXT, payload_hash TEXT, generation INTEGER NOT NULL DEFAULT 0,
  UNIQUE (connected_account_id, stripe_event_id)
);

CREATE TABLE configuration_revision_heads (
  guild_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  current_revision_id TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (guild_id, feature, resource_key)
);

CREATE TABLE configuration_revisions (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  operation TEXT NOT NULL,
  source TEXT NOT NULL,
  actor_user_id TEXT,
  operation_id TEXT NOT NULL,
  correlation_id TEXT,
  previous_revision_id TEXT,
  restored_from_revision_id TEXT,
  snapshot_json TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE considered_replies (
  id TEXT PRIMARY KEY NOT NULL, suggestion_id TEXT NOT NULL, thread_id TEXT, guild_id TEXT NOT NULL,
  author_id TEXT NOT NULL, perspective TEXT NOT NULL, reasoning TEXT NOT NULL, improvement TEXT,
  state TEXT NOT NULL, flag_count INTEGER DEFAULT 0 NOT NULL, webhook_message_id TEXT,
  queue_message_id TEXT, collapsed_at_ms INTEGER, resolved_at_ms INTEGER,
  resolved_by_user_id TEXT, resolution_reason TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
);

CREATE TABLE considered_reply_flags (
  reply_id TEXT NOT NULL, guild_id TEXT NOT NULL, member_id TEXT NOT NULL,
  active INTEGER DEFAULT 1 NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(reply_id,member_id)
);

CREATE TABLE donor_claims (
  guild_id TEXT PRIMARY KEY,
  claimed_by_user_id TEXT NOT NULL,
  claimed_at_ms INTEGER NOT NULL,
  suspended_at_ms INTEGER
);

CREATE TABLE event_lifecycle_history (
  guild_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  history_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  retention_expires_at_ms INTEGER,
  PRIMARY KEY (guild_id, event_id, history_id)
);

CREATE TABLE event_lifecycle_transition_guards (
  guard_id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  expected_status TEXT NOT NULL,
  expected_state_version INTEGER NOT NULL
);

CREATE TABLE event_recurrence_series (
  guild_id TEXT NOT NULL,
  series_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  frequency TEXT NOT NULL,
  until_at_ms INTEGER,
  next_starts_at_ms INTEGER NOT NULL,
  next_publishes_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  pending_event_id TEXT,
  publication_attempted_at_ms INTEGER,
  last_event_id TEXT NOT NULL,
  failure_reason TEXT,
  created_by_user_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  lease_token TEXT,
  lease_until_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, series_id),
  UNIQUE (guild_id, source_event_id)
);

CREATE TABLE event_signup_mutation_guards (
  guard_id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete'))
);

CREATE TABLE event_signups (
  guild_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (guild_id, event_id, user_id, group_id)
);

CREATE TABLE event_team_audit_records (
  guild_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  audit_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  prior_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  PRIMARY KEY (guild_id, event_id, audit_id)
);

CREATE TABLE event_team_bulk_commit_guards (
  guard_id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  expected_state_version INTEGER NOT NULL
);

CREATE TABLE event_team_delivery_outbox (
  guild_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  outbox_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('notification', 'canonical_refresh')),
  dedupe_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'delivered', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  last_error TEXT,
  terminal_failure_reason TEXT,
  next_attempt_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  delivered_at_ms INTEGER,
  PRIMARY KEY (guild_id, event_id, outbox_id),
  UNIQUE (guild_id, event_id, dedupe_key)
);

CREATE TABLE event_team_invitation_blocks (
  guild_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (guild_id, event_id, team_id, user_id)
);

CREATE TABLE event_team_memberships (
  guild_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at_ms INTEGER NOT NULL,
  left_at_ms INTEGER,
  PRIMARY KEY (guild_id, event_id, membership_id)
);

CREATE TABLE event_team_proposal_acceptance_guards (
  guild_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  expected_updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (guild_id, event_id, proposal_id)
);

CREATE TABLE event_team_proposals (
  guild_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('join_request', 'invitation')),
  requester_user_id TEXT NOT NULL,
  target_user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'rejected', 'withdrawn', 'cancelled', 'expired')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  resolved_at_ms INTEGER,
  PRIMARY KEY (guild_id, event_id, proposal_id)
);

CREATE TABLE event_team_rate_limits (
  guild_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  action TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('user', 'event')),
  scope_id TEXT NOT NULL,
  window_started_at_ms INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (guild_id, event_id, action, scope_type, scope_id)
);

CREATE TABLE event_team_roster_snapshots (
  guild_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  required_team_size INTEGER NOT NULL,
  members_json TEXT NOT NULL,
  captured_at_ms INTEGER NOT NULL,
  PRIMARY KEY (guild_id, event_id, team_id)
);

CREATE TABLE event_team_state_versions (
  guild_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, event_id)
);

CREATE TABLE event_teams (
  guild_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  captain_user_id TEXT NOT NULL,
  open_to_requests INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('active', 'disbanded')),
  created_by_user_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  disbanded_at_ms INTEGER,
  PRIMARY KEY (guild_id, event_id, team_id)
);

CREATE TABLE event_templates (
  guild_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  signup_mode TEXT NOT NULL,
  thread_enabled INTEGER NOT NULL DEFAULT 0,
  waitlisted_members_join_thread INTEGER NOT NULL DEFAULT 0,
  groups_json TEXT NOT NULL,
  reminders_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL, participation_mode TEXT NOT NULL
CHECK (participation_mode IN ('individual', 'team')) DEFAULT 'individual', required_team_size INTEGER
CHECK (required_team_size IS NULL OR required_team_size BETWEEN 2 AND 50),
  PRIMARY KEY (guild_id, template_id)
);

CREATE TABLE events (
  guild_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  template_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  thread_id TEXT,
  starts_at_ms INTEGER NOT NULL,
  ends_at_ms INTEGER,
  signup_cutoff_at_ms INTEGER NOT NULL,
  signup_mode TEXT NOT NULL,
  thread_enabled INTEGER NOT NULL DEFAULT 0,
  waitlisted_members_join_thread INTEGER NOT NULL DEFAULT 0,
  groups_json TEXT NOT NULL,
  reminders_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  published_at_ms INTEGER,
  cancelled_at_ms INTEGER,
  ended_at_ms INTEGER,
  archived_at_ms INTEGER, participation_mode TEXT NOT NULL
CHECK (participation_mode IN ('individual', 'team')) DEFAULT 'individual', required_team_size INTEGER
CHECK (required_team_size IS NULL OR required_team_size BETWEEN 2 AND 50), recurrence_series_id TEXT,
  PRIMARY KEY (guild_id, event_id)
);

CREATE TABLE evidence_vault_configs (
  guild_id TEXT PRIMARY KEY,
  audit_channel_id TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
, access_role_ids_json TEXT NOT NULL DEFAULT '[]', subjects_enabled INTEGER NOT NULL DEFAULT 0, fields_json TEXT NOT NULL DEFAULT '[]', enabled INTEGER NOT NULL DEFAULT 1);

CREATE TABLE evidence_vault_records (
  record_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  hidden_at_ms INTEGER NOT NULL
);

CREATE TABLE "feature_setup_resolutions" (
  run_id TEXT NOT NULL,
  dependency_key TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  resource_name TEXT NOT NULL,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('text_channel', 'voice_channel', 'forum_channel', 'category', 'role')),
  relationship TEXT NOT NULL CHECK (relationship IN ('referenced', 'haf_configured', 'haf_managed')),
  template_version INTEGER NOT NULL CHECK (template_version > 0),
  validation_status TEXT NOT NULL CHECK (validation_status IN ('valid', 'needs_attention')),
  validation_detail TEXT,
  applied_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (run_id, dependency_key),
  FOREIGN KEY (run_id) REFERENCES feature_setup_runs(id)
);

CREATE TABLE feature_setup_runs (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  feature_key TEXT NOT NULL,
  definition_version INTEGER NOT NULL CHECK (definition_version > 0),
  status TEXT NOT NULL CHECK (status IN ('planned', 'running', 'incomplete', 'completed', 'cancelled')),
  actor_user_id TEXT NOT NULL,
  choices_json TEXT NOT NULL,
  failure_dependency_key TEXT,
  failure_message TEXT,
  pending_creation_dependency_key TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER
);

CREATE TABLE gateway_event_operations (
  event_key TEXT NOT NULL,
  handler_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('processing', 'completed', 'terminal')),
  lease_token TEXT,
  lease_expires_at_ms INTEGER,
  attempts INTEGER NOT NULL DEFAULT 1,
  outcome_code TEXT,
  outcome_json TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  PRIMARY KEY (event_key, handler_key)
);

CREATE TABLE gateway_reaction_limit_mutations (
  event_key TEXT NOT NULL,
  mutation_kind TEXT NOT NULL,
  result_one INTEGER,
  result_two INTEGER,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (event_key, mutation_kind)
);

CREATE TABLE guild_audit_log_configs (
  guild_id TEXT PRIMARY KEY NOT NULL,
  audit_channel_id TEXT NOT NULL DEFAULT '',
  event_states_json TEXT NOT NULL DEFAULT '{}',
  updated_at_ms INTEGER NOT NULL
, group_channel_ids_json TEXT NOT NULL DEFAULT '{}', excluded_channel_ids_json TEXT NOT NULL DEFAULT '[]', excluded_role_ids_json TEXT NOT NULL DEFAULT '[]');

CREATE TABLE guild_blocked_emojis (
  guild_id TEXT NOT NULL,
  normalized_emoji TEXT NOT NULL,
  PRIMARY KEY (guild_id, normalized_emoji)
);

CREATE TABLE guild_entitlements (
  guild_id TEXT PRIMARY KEY,
  plan TEXT NOT NULL CHECK (plan IN ('free', 'premium', 'premium_plus')),
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE guild_notification_channels (
  guild_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  notification_channel_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, feature)
);

CREATE TABLE guild_r2_objects (
  guild_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'committed', reserved_bytes INTEGER NOT NULL DEFAULT 0, reservation_expires_at_ms INTEGER, operation_key TEXT, updated_at_ms INTEGER NOT NULL DEFAULT 0, reconciliation_generation INTEGER, had_committed_object INTEGER NOT NULL DEFAULT 1, upload_started_at_ms INTEGER, tombstoned_at_ms INTEGER,
  PRIMARY KEY (guild_id, object_key)
);

CREATE TABLE guild_r2_reconciliation_state (
  bucket_id TEXT PRIMARY KEY NOT NULL,
  cursor TEXT,
  generation INTEGER NOT NULL DEFAULT 1,
  started_at_ms INTEGER,
  last_reconciled_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE guild_rbac_settings (
  guild_id TEXT PRIMARY KEY,
  guild_admin_role_id TEXT
, manage_server_admin_enabled INTEGER CHECK (manage_server_admin_enabled IN (0, 1)) NOT NULL DEFAULT 1);

CREATE TABLE guild_service_suspension_audit (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  actor_user_id TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL
);

CREATE TABLE guild_service_suspensions (
  guild_id TEXT PRIMARY KEY NOT NULL,
  reason TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  created_by_user_id TEXT NOT NULL,
  removed_at_ms INTEGER,
  removed_by_user_id TEXT
);

CREATE TABLE guild_settings (
  guild_id TEXT PRIMARY KEY,
  moderation_enabled INTEGER NOT NULL DEFAULT 1,
  channel_mode TEXT NOT NULL DEFAULT 'include',
  channel_ids_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE identity_patterns (
  id TEXT PRIMARY KEY NOT NULL,
  platform TEXT NOT NULL,
  pattern TEXT NOT NULL,
  capture_group INTEGER NOT NULL,
  position INTEGER NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE image_rules_configs (
  guild_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  topic_description TEXT NOT NULL DEFAULT '',
  auto_delete_threshold REAL NOT NULL DEFAULT 0.85,
  mod_review_threshold REAL NOT NULL DEFAULT 0.65,
  target_channel_ids_json TEXT NOT NULL DEFAULT '[]',
  excluded_role_ids_json TEXT NOT NULL DEFAULT '[]',
  mod_queue_channel_id TEXT,
  mod_role_ids_json TEXT NOT NULL DEFAULT '[]',
  ping_on_queue_post INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
, react_on_topic INTEGER NOT NULL DEFAULT 0, audit_on_topic INTEGER NOT NULL DEFAULT 0, dry_run INTEGER NOT NULL DEFAULT 0);

CREATE TABLE image_rules_mod_queue_items (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  image_url TEXT NOT NULL,
  topic_description TEXT NOT NULL,
  off_topic_confidence REAL NOT NULL,
  on_topic_confidence REAL NOT NULL,
  status TEXT NOT NULL,
  queue_channel_id TEXT,
  queue_message_id TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  decided_by_user_id TEXT,
  decided_at_ms INTEGER,
  failure_reason TEXT
, restore_claim_token TEXT, restore_claim_expires_at_ms INTEGER, restored_message_id TEXT);

CREATE TABLE known_guilds (
  guild_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  member_count INTEGER NOT NULL DEFAULT 0,
  owner_id TEXT NOT NULL DEFAULT '',
  icon TEXT,
  installed_at_ms INTEGER NOT NULL,
  removed_at_ms INTEGER
);

CREATE TABLE lfg_applications (
  guild_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  applicant_id TEXT NOT NULL,
  applicant_display_name TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  reviewed_by_user_id TEXT,
  reviewed_at_ms INTEGER,
  PRIMARY KEY (guild_id, post_id, applicant_id)
);

CREATE TABLE lfg_configs (
  guild_id TEXT PRIMARY KEY,
  notice_channel_id TEXT,
  notice_message_id TEXT,
  notification_role_id TEXT,
  counter_voice_channel_id TEXT,
  counter_display_format TEXT NOT NULL DEFAULT 'LFG ({count})',
  expiry_action TEXT NOT NULL DEFAULT 'close',
  expiry_duration_hours INTEGER NOT NULL DEFAULT 24,
  server_options_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
, approval_flow_enabled INTEGER NOT NULL DEFAULT 0, approval_audit_channel_id TEXT, approval_voice_category_id TEXT, notice_color INTEGER NOT NULL DEFAULT 2829617, enabled INTEGER NOT NULL DEFAULT 1);

CREATE TABLE lfg_posts (
  guild_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  owner_display_name TEXT NOT NULL,
  server_id TEXT NOT NULL,
  server_label TEXT NOT NULL,
  when_play TEXT NOT NULL,
  looking_for TEXT NOT NULL,
  extra_info TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  active INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER,
  reminder_sent_at_ms INTEGER,
  renewed_at_ms INTEGER,
  renewals_count INTEGER NOT NULL DEFAULT 0,
  closed_at_ms INTEGER,
  closed_by_user_id TEXT, scope TEXT NOT NULL DEFAULT 'public' CHECK (scope IN ('public', 'clan')), clan_id TEXT, clan_tag TEXT, persistent_voice_channel_id TEXT,
  PRIMARY KEY (guild_id, post_id)
);

CREATE TABLE lfg_voice_channels (
  guild_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (guild_id, post_id)
);

CREATE TABLE managed_message_audit_outbox (
  event_key TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  internal_name TEXT NOT NULL,
  claimed_at_ms INTEGER,
  delivered_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE managed_message_drafts (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  internal_name TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  embeds_json TEXT NOT NULL,
  announcement_json TEXT NOT NULL,
  status TEXT NOT NULL,
  scheduled_at_ms INTEGER,
  failure_reason TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  publication_claimed_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL, buttons_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE (guild_id, internal_name)
);

CREATE TABLE managed_message_media_assets (
  guild_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active',
  PRIMARY KEY (guild_id, filename)
);

CREATE TABLE managed_message_media_refs (
  guild_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('draft', 'message')),
  owner_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, filename, owner_type, owner_id)
);

CREATE TABLE managed_messages (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  internal_name TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  embeds_json TEXT NOT NULL,
  announcement_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL, buttons_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE (guild_id, internal_name),
  UNIQUE (guild_id, channel_id, message_id)
);

CREATE TABLE marketplace_configs (
  guild_id TEXT PRIMARY KEY,
  notice_channel_id TEXT,
  notice_message_id TEXT,
  log_channel_id TEXT,
  server_options_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
, notice_embed_json TEXT NOT NULL DEFAULT '{"title":"💼 Marketplace Noticeboard","description":"Create a Marketplace Post. Click the button below to start.","color":3447003,"buttonLabel":"Create Marketplace Post","buttonEmoji":"💼"}', server_choice_enabled INTEGER NOT NULL DEFAULT 1, additional_choices_enabled INTEGER NOT NULL DEFAULT 0, additional_choices_json TEXT NOT NULL DEFAULT '[]', flow_updated_at_ms INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1);

CREATE TABLE marketplace_posts (
  guild_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  owner_display_name TEXT NOT NULL,
  trade_type TEXT NOT NULL,
  server_id TEXT NOT NULL,
  server_label TEXT NOT NULL,
  have TEXT NOT NULL,
  want TEXT NOT NULL,
  extra TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  active INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  closed_at_ms INTEGER,
  closed_by_user_id TEXT, additional_choices_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (guild_id, post_id)
);

CREATE TABLE marketplace_trade_logs (
  guild_id TEXT NOT NULL,
  log_id TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  buyer_id TEXT NOT NULL,
  buyer_display_name TEXT NOT NULL,
  seller_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  trade_type TEXT NOT NULL,
  server_label TEXT NOT NULL,
  dm_sent INTEGER NOT NULL,
  dm_error TEXT,
  have TEXT NOT NULL,
  want TEXT NOT NULL,
  PRIMARY KEY (guild_id, log_id)
);

CREATE TABLE member_verification_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  message_id TEXT,
  channel_id TEXT,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  used_at_ms INTEGER
);

CREATE TABLE member_verification_configs (
  guild_id TEXT PRIMARY KEY NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  verified_role_id TEXT,
  title TEXT NOT NULL DEFAULT 'Welcome',
  description TEXT NOT NULL DEFAULT 'Welcome to the Guild! Please verify to gain access.',
  color INTEGER NOT NULL DEFAULT 5793266,
  image_url TEXT,
  thumbnail_url TEXT,
  rules_url TEXT,
  updated_at_ms INTEGER NOT NULL
, delivery_mode TEXT NOT NULL DEFAULT 'dm', welcome_channel_id TEXT, panel_message_id TEXT, verify_button_emoji TEXT, verification_method TEXT NOT NULL DEFAULT 'discord-button');

CREATE TABLE member_verification_manual_dm_rate_limits (
  guild_id TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('guild', 'actor', 'target')),
  scope_id TEXT NOT NULL,
  window_started_at_ms INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (guild_id, scope_type, scope_id)
);

CREATE TABLE member_verification_states (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  verified_at_ms INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE mention_protection_action_outcomes (
  guild_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  retryable INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (guild_id, message_id, action)
);

CREATE TABLE mention_protection_breaches (
  guild_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  protection TEXT NOT NULL,
  condition TEXT NOT NULL,
  stage TEXT NOT NULL,
  response_policy_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  content_snapshot TEXT NOT NULL,
  message_created_at_ms INTEGER NOT NULL,
  breached_at_ms INTEGER NOT NULL,
  PRIMARY KEY (guild_id, message_id, protection)
);

CREATE TABLE mention_protection_burst_events (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  message_timestamp_ms INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id, message_id)
);

CREATE TABLE mention_protection_configs (
  guild_id TEXT PRIMARY KEY NOT NULL,
  admin_enabled INTEGER NOT NULL DEFAULT 0,
  spam_enabled INTEGER NOT NULL DEFAULT 0,
  protected_admin_role_ids_json TEXT NOT NULL DEFAULT '[]',
  channel_mode TEXT NOT NULL DEFAULT 'exclude',
  channel_ids_json TEXT NOT NULL DEFAULT '[]',
  excluded_role_ids_json TEXT NOT NULL DEFAULT '[]',
  mass_mention_threshold INTEGER NOT NULL DEFAULT 5,
  burst_message_threshold INTEGER NOT NULL DEFAULT 5,
  burst_window_seconds INTEGER NOT NULL DEFAULT 10,
  admin_repeat_period_ms INTEGER NOT NULL DEFAULT 86400000,
  spam_repeat_period_ms INTEGER NOT NULL DEFAULT 86400000,
  admin_initial_response_json TEXT NOT NULL,
  admin_repeat_response_json TEXT NOT NULL,
  spam_initial_response_json TEXT NOT NULL,
  spam_repeat_response_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE mention_protection_escalations (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  protection TEXT NOT NULL,
  last_breach_at_ms INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id, protection)
);

CREATE TABLE message_templates (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  internal_name TEXT NOT NULL,
  embeds_json TEXT NOT NULL,
  available_for_ticket_replies INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE one_time_tokens (
  nonce TEXT PRIMARY KEY NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  consumed_at_ms INTEGER NOT NULL
);

CREATE TABLE operational_incident_events (
  id TEXT PRIMARY KEY NOT NULL,
  incident_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('opened', 'observed', 'severity_changed', 'remediation_started', 'remediation_succeeded', 'remediation_failed', 'resolved', 'reopened')),
  observation_id TEXT,
  reason_code TEXT,
  safe_args_json TEXT NOT NULL,
  correlation_id TEXT,
  actor_user_id TEXT,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (incident_id, observation_id)
);

CREATE TABLE operational_incidents (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  incident_key TEXT NOT NULL,
  feature TEXT NOT NULL CHECK (feature IN ('managed-messages', 'webhooks', 'player-count')),
  resource_kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  condition TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'error', 'critical')),
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  summary_code TEXT NOT NULL,
  safe_args_json TEXT NOT NULL,
  remediation_code TEXT NOT NULL,
  first_seen_at_ms INTEGER NOT NULL,
  open_since_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL,
  resolved_at_ms INTEGER,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  last_correlation_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (guild_id, incident_key)
);

CREATE TABLE pending_platform_links (
  state TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE pending_suggestion_submissions (
  id TEXT PRIMARY KEY NOT NULL, guild_id TEXT NOT NULL, author_id TEXT NOT NULL, title TEXT NOT NULL,
  answers_json TEXT NOT NULL, category TEXT, likely_duplicate_ids_json TEXT NOT NULL, expires_at_ms INTEGER NOT NULL
);

CREATE TABLE platform_link_configs (
  guild_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  linked_role_id TEXT,
  log_channel_id TEXT,
  game_app_ids_json TEXT NOT NULL DEFAULT '[]',
  panel_title TEXT NOT NULL DEFAULT 'Link your account',
  panel_description TEXT NOT NULL DEFAULT 'Click the button below to securely link your Discord account.',
  panel_button_label TEXT NOT NULL DEFAULT 'Link',
  panel_button_style TEXT NOT NULL DEFAULT 'Primary',
  allow_relink INTEGER NOT NULL DEFAULT 1,
  allow_multiple_links INTEGER NOT NULL DEFAULT 0,
  whois_fields_json TEXT NOT NULL DEFAULT '[]',
  custom_links_json TEXT,
  panel_channel_id TEXT,
  panel_message_id TEXT,
  updated_at_ms INTEGER NOT NULL DEFAULT 0, panel_color INTEGER, require_relink_on_rejoin INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (guild_id, platform)
);

CREATE TABLE platform_links (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  platform_id TEXT NOT NULL,
  linked_at_ms INTEGER NOT NULL,
  manual INTEGER NOT NULL DEFAULT 0,
  actioned_by_user_id TEXT,
  metadata_json TEXT, active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (guild_id, user_id, platform, platform_id)
);

CREATE TABLE player_count_servers (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_server_id TEXT NOT NULL,
  channel_id TEXT,
  display_format TEXT NOT NULL DEFAULT '🎮 Players: {count}/{max}',
  offline_format TEXT NOT NULL DEFAULT '🎮 Players: Offline',
  rename_offset_minutes INTEGER NOT NULL DEFAULT 0,
  last_renamed_at_ms INTEGER,
  last_player_count INTEGER,
  last_max_slots INTEGER,
  last_queue_size INTEGER,
  last_fetched_at_ms INTEGER,
  steam_host TEXT,
  steam_port INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
, refresh_interval_minutes INTEGER NOT NULL DEFAULT 10, consecutive_failure_count INTEGER NOT NULL DEFAULT 0, last_error_message TEXT, last_error_at_ms INTEGER, alert_channel_id TEXT, failure_threshold INTEGER NOT NULL DEFAULT 3, enabled INTEGER NOT NULL DEFAULT 1);

CREATE TABLE product_analytics_preferences (
  guild_id TEXT PRIMARY KEY NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE reaction_limit_breach_counters (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  breach_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE reaction_limit_configs (
  guild_id TEXT PRIMARY KEY,
  limits_enabled INTEGER NOT NULL DEFAULT 0,
  max_reactions_per_message INTEGER,
  max_reactions_per_user_per_message INTEGER,
  breach_threshold INTEGER,
  breach_role_id TEXT,
  breach_role_duration_ms INTEGER,
  breach_dm_text TEXT,
  channel_mode TEXT NOT NULL DEFAULT 'include',
  channel_ids_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE reaction_limit_message_reaction_counts (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  reaction_count INTEGER NOT NULL DEFAULT 0, updated_at_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, channel_id, message_id)
);

CREATE TABLE reaction_limit_user_message_reaction_counts (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  reaction_count INTEGER NOT NULL DEFAULT 0, updated_at_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, channel_id, message_id, user_id)
);

CREATE TABLE reaction_role_leases (
  guild_id TEXT PRIMARY KEY NOT NULL,
  token TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL
);

CREATE TABLE reaction_role_panels (
  guild_id TEXT NOT NULL,
  id TEXT NOT NULL,
  bot_user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  options_json TEXT NOT NULL,
  published_options_json TEXT NOT NULL DEFAULT '[]',
  activated_at_ms INTEGER,
  enabled INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  mode TEXT NOT NULL DEFAULT 'multiple',
  required_role_ids_json TEXT NOT NULL DEFAULT '[]',
  blocked_role_ids_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (guild_id, id),
  UNIQUE (guild_id, channel_id, message_id)
);

CREATE TABLE server_level_announcement_outbox (
  announcement_id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  level INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  delivered_at_ms INTEGER,
  terminal_reason TEXT
);

CREATE TABLE server_level_awards (
  award_id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  configured_game_server_id TEXT,
  source_inbox_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('interval', 'overlap_delta', 'support_adjustment')),
  interval_started_at_ms INTEGER,
  interval_ended_at_ms INTEGER,
  qualifying_seconds INTEGER NOT NULL DEFAULT 0,
  multiplier INTEGER,
  xp_units INTEGER NOT NULL,
  scoring_policy_version INTEGER NOT NULL,
  actor_user_id TEXT,
  reason TEXT,
  created_at_ms INTEGER NOT NULL,
  projection_applied_at_ms INTEGER
);

CREATE TABLE server_level_configs (
  guild_id TEXT PRIMARY KEY NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  announcement_channel_id TEXT,
  removed_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE server_level_credentials (
  credential_id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  configured_game_server_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('webhook_secret', 'data_api')),
  key_version TEXT NOT NULL,
  nonce TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE server_level_current_presence (
  configured_game_server_id TEXT NOT NULL,
  steam_id64 TEXT NOT NULL,
  lifecycle_generation INTEGER NOT NULL,
  joined_at_ms INTEGER NOT NULL,
  last_confirmed_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (configured_game_server_id, steam_id64)
);

CREATE TABLE server_level_daily_summaries (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  day_utc TEXT NOT NULL,
  xp_units INTEGER NOT NULL,
  qualifying_seconds INTEGER NOT NULL,
  scoring_policy_version INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id, day_utc, scoring_policy_version)
);

CREATE TABLE server_level_earning_sessions (
  session_id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  configured_game_server_id TEXT NOT NULL,
  steam_id64 TEXT NOT NULL,
  user_id TEXT NOT NULL,
  lifecycle_generation INTEGER NOT NULL,
  started_at_ms INTEGER NOT NULL,
  last_confirmed_at_ms INTEGER NOT NULL,
  checkpoint_at_ms INTEGER NOT NULL,
  closed_at_ms INTEGER,
  close_reason TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE server_level_ingress_outbox (
  inbox_id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  published_at_ms INTEGER
);

CREATE TABLE server_level_member_totals (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  total_xp_units INTEGER NOT NULL DEFAULT 0 CHECK (total_xp_units >= 0),
  current_member INTEGER NOT NULL DEFAULT 1 CHECK (current_member IN (0, 1)),
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE server_level_processing_cursors (
  configured_game_server_id TEXT PRIMARY KEY NOT NULL,
  latest_seen_at_ms INTEGER NOT NULL,
  watermark_at_ms INTEGER NOT NULL,
  last_delivery_id TEXT NOT NULL,
  population INTEGER,
  queue_size INTEGER,
  lifecycle_generation INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE server_level_processing_leases (
  configured_game_server_id TEXT PRIMARY KEY NOT NULL,
  lease_id TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL
);

CREATE TABLE server_level_servers (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
  provider_server_id TEXT NOT NULL CHECK (length(provider_server_id) BETWEEN 1 AND 200),
  max_slots INTEGER NOT NULL CHECK (max_slots BETWEEN 1 AND 10000),
  endpoint_id TEXT NOT NULL,
  webhook_credential_id TEXT NOT NULL,
  webhook_verified_at_ms INTEGER,
  subscribed_events_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(subscribed_events_json)),
  capacity_proposal_json TEXT CHECK (capacity_proposal_json IS NULL OR json_valid(capacity_proposal_json)),
  last_roster_reconciled_at_ms INTEGER,
  last_capacity_checked_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE server_level_webhook_inbox (
  inbox_id TEXT PRIMARY KEY NOT NULL,
  delivery_id TEXT NOT NULL,
  configured_game_server_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (
    event_type IN ('player.join', 'player.leave', 'server.restart', 'server.shutdown')
  ),
  occurred_at_ms INTEGER NOT NULL,
  steam_id64 TEXT,
  population INTEGER,
  queue_size INTEGER,
  status TEXT NOT NULL DEFAULT 'accepted' CHECK (
    status IN ('accepted', 'processed', 'late', 'rejected', 'failed')
  ),
  reason_code TEXT,
  received_at_ms INTEGER NOT NULL,
  body_sha256 TEXT CHECK (body_sha256 IS NULL OR length(body_sha256) = 64),
  processed_at_ms INTEGER
);

CREATE TABLE suggestion_action_rate_limits (
  guild_id TEXT NOT NULL, actor_user_id TEXT NOT NULL, action TEXT NOT NULL,
  window_start_ms INTEGER NOT NULL, count INTEGER DEFAULT 1 NOT NULL, updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(guild_id,actor_user_id,action,window_start_ms)
);

CREATE TABLE suggestion_digest_runs (
  guild_id TEXT NOT NULL, period_key TEXT NOT NULL, status TEXT NOT NULL, delivered_message_id TEXT,
  created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, PRIMARY KEY(guild_id,period_key)
);

CREATE TABLE suggestion_revisions (
  id TEXT PRIMARY KEY NOT NULL, suggestion_id TEXT NOT NULL, guild_id TEXT NOT NULL,
  revision INTEGER NOT NULL, title TEXT NOT NULL, answers_json TEXT NOT NULL, category TEXT,
  edited_by_user_id TEXT NOT NULL, created_at_ms INTEGER NOT NULL
);

CREATE TABLE suggestion_status_events (
  id TEXT PRIMARY KEY NOT NULL, suggestion_id TEXT NOT NULL, guild_id TEXT NOT NULL,
  from_status TEXT NOT NULL, to_status TEXT NOT NULL, actor_user_id TEXT NOT NULL,
  reason TEXT, created_at_ms INTEGER NOT NULL
, outcome_json TEXT);

CREATE TABLE suggestion_votes (
  suggestion_id TEXT NOT NULL, guild_id TEXT NOT NULL, member_id TEXT NOT NULL, value TEXT NOT NULL,
  active INTEGER DEFAULT 1 NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(suggestion_id,member_id)
);

CREATE TABLE suggestions (
  id TEXT PRIMARY KEY NOT NULL, guild_id TEXT NOT NULL, author_id TEXT NOT NULL, title TEXT NOT NULL,
  normalized_search_text TEXT NOT NULL, answers_json TEXT NOT NULL, category TEXT, status TEXT NOT NULL,
  revision INTEGER DEFAULT 1 NOT NULL, thread_id TEXT, starter_message_id TEXT, projection_error TEXT,
  support_count INTEGER DEFAULT 0 NOT NULL, oppose_count INTEGER DEFAULT 0 NOT NULL, outcome_json TEXT,
  created_at_ms INTEGER NOT NULL, edited_at_ms INTEGER, updated_at_ms INTEGER NOT NULL
);

CREATE TABLE suggestions_configs (
  guild_id TEXT PRIMARY KEY NOT NULL, enabled INTEGER DEFAULT 0 NOT NULL,
  forum_channel_id TEXT, panel_channel_id TEXT, panel_message_id TEXT,
  panel_title TEXT NOT NULL, panel_body TEXT NOT NULL, panel_button_text TEXT NOT NULL,
  prompts_json TEXT NOT NULL, categories_json TEXT DEFAULT '[]' NOT NULL,
  status_tag_ids_json TEXT DEFAULT '{}' NOT NULL, category_tag_ids_json TEXT DEFAULT '{}' NOT NULL,
  reply_webhook_id TEXT, reply_webhook_credential_id TEXT,
  mod_role_ids_json TEXT DEFAULT '[]' NOT NULL, mod_queue_channel_id TEXT, voter_role_id TEXT,
  minimum_tenure_days INTEGER DEFAULT 0 NOT NULL, collapse_threshold INTEGER DEFAULT 3 NOT NULL,
  submission_cooldown_seconds INTEGER DEFAULT 300 NOT NULL,
  active_suggestion_limit INTEGER DEFAULT 3 NOT NULL, digest_enabled INTEGER DEFAULT 0 NOT NULL,
  digest_channel_id TEXT, digest_cadence_days INTEGER DEFAULT 7 NOT NULL, updated_at_ms INTEGER NOT NULL
);

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

CREATE TABLE ticket_counters (
  guild_id TEXT PRIMARY KEY,
  next_ticket_number INTEGER NOT NULL
);

CREATE TABLE ticket_instances (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  ticket_type_id TEXT NOT NULL,
  ticket_type_label TEXT NOT NULL,
  opener_user_id TEXT NOT NULL,
  support_role_id TEXT,
  status TEXT NOT NULL,
  answers_json TEXT NOT NULL,
  opened_at_ms INTEGER NOT NULL,
  closed_at_ms INTEGER,
  closed_by_user_id TEXT,
  transcript_message_id TEXT,
  staff_thread_id TEXT, claimed_by_user_id TEXT, claimed_at_ms INTEGER, panel_id TEXT DEFAULT 'main', opening_message_id TEXT,
  PRIMARY KEY (guild_id, channel_id)
);

CREATE TABLE "ticket_panels" (
  guild_id TEXT NOT NULL,
  panel_id TEXT NOT NULL DEFAULT 'main',
  panel_name TEXT NOT NULL DEFAULT 'Main panel',
  panel_channel_id TEXT NOT NULL,
  category_channel_id TEXT NOT NULL,
  transcript_channel_id TEXT NOT NULL,
  panel_message_id TEXT,
  ticket_types_json TEXT NOT NULL,
  ticket_creation_limit INTEGER,
  ticket_limit_rejection_message TEXT,
  enable_ticket_claiming INTEGER NOT NULL DEFAULT 0, ai_transcript_summaries_enabled INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, panel_id)
);

CREATE TABLE ticket_participant_events (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  ticket_channel_id TEXT NOT NULL,
  ticket_type_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('participant-added', 'participant-removed')),
  target_user_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  notification_state TEXT NOT NULL DEFAULT 'pending' CHECK (notification_state IN ('pending', 'delivering', 'delivered')),
  notification_claimed_at_ms INTEGER
);

CREATE TABLE ticket_participants (
  guild_id TEXT NOT NULL,
  ticket_channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  added_event_id TEXT NOT NULL,
  added_by_user_id TEXT NOT NULL,
  added_at_ms INTEGER NOT NULL,
  PRIMARY KEY (guild_id, ticket_channel_id, user_id)
);

CREATE TABLE ticket_staff_messages (
  guild_id TEXT NOT NULL,
  ticket_channel_id TEXT NOT NULL,
  staff_thread_id TEXT NOT NULL,
  staff_message_id TEXT NOT NULL,
  bot_message_id TEXT NOT NULL,
  staff_user_id TEXT NOT NULL,
  staff_display_name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
, delivery_status TEXT NOT NULL DEFAULT 'sent');

CREATE TABLE ticket_template_replies (
  interaction_id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  ticket_channel_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_internal_name TEXT NOT NULL,
  staff_user_id TEXT NOT NULL,
  bot_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE ticket_transcript_capabilities (
  object_id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  access_token_hash TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER,
  discarded_at_ms INTEGER,
  retention_expires_at_ms INTEGER NOT NULL,
  last_accessed_at_ms INTEGER,
  access_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE timed_role_config_rules (
  guild_id TEXT NOT NULL,
  config_type TEXT NOT NULL,
  role_id TEXT NOT NULL,
  duration_input TEXT NOT NULL,
  dm_message TEXT,
  updated_at_ms INTEGER NOT NULL, suspended_role_ids_json TEXT NOT NULL DEFAULT '[]', enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (guild_id, config_type, role_id)
);

CREATE TABLE timed_roles (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  duration_input TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL, target_display_name TEXT, suspended_role_ids_json TEXT NOT NULL DEFAULT '[]', pending_suspension_role_ids_json TEXT NOT NULL DEFAULT '[]', removed_role_ids_json TEXT NOT NULL DEFAULT '[]', pending_restoration_role_ids_json TEXT NOT NULL DEFAULT '[]', restoration_started_at_ms INTEGER, target_role_removal_completed_at_ms INTEGER,
  PRIMARY KEY (guild_id, user_id, role_id)
);

CREATE TABLE user_preferences (
  user_id TEXT PRIMARY KEY NOT NULL,
  hidden_guild_ids_json TEXT NOT NULL DEFAULT '[]',
  default_guild_id TEXT,
  email_notifications INTEGER NOT NULL DEFAULT 1,
  push_notifications INTEGER NOT NULL DEFAULT 0,
  compact_mode INTEGER NOT NULL DEFAULT 0,
  theme TEXT NOT NULL DEFAULT 'system',
  language TEXT NOT NULL DEFAULT 'en',
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE wardogs_budgets (
  origin TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  lease_until_ms INTEGER NOT NULL,
  next_at_ms INTEGER NOT NULL,
  data TEXT NOT NULL
);

CREATE TABLE wardogs_targets (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK (slot >= 0 AND slot < 5),
  generation INTEGER NOT NULL CHECK (generation > 0),
  data TEXT NOT NULL,
  UNIQUE (guild_id, slot)
);

CREATE TABLE webhook_credentials (
  credential_id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('proxy_destination', 'ban_lookup_notification')),
  public_id TEXT NOT NULL,
  destination_id TEXT,
  provider TEXT NOT NULL CHECK (provider = 'discord'),
  envelope_json TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  masked_display TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE webhook_proxy_configs (
  guild_id TEXT NOT NULL,
  public_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  destinations_json TEXT NOT NULL,
  default_destination_ids_json TEXT NOT NULL,
  routing_rules_json TEXT NOT NULL,
  content_replacements_json TEXT NOT NULL DEFAULT '[]',
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL, ban_lookup_enabled INTEGER NOT NULL DEFAULT 0, ban_lookup_app_ids_json TEXT NOT NULL DEFAULT '[]', ban_lookup_credential_id TEXT,
  PRIMARY KEY (guild_id, public_id)
);

CREATE TABLE webhook_proxy_forward_logs (
  guild_id TEXT NOT NULL,
  log_id TEXT NOT NULL,
  public_id TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  status INTEGER,
  ok INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  error TEXT,
  timestamp_ms INTEGER NOT NULL, credential_fingerprint TEXT,
  PRIMARY KEY (guild_id, log_id)
);

CREATE TABLE white_label_bots (
  guild_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  bot_user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  brand_footer_text TEXT,
  status TEXT NOT NULL,
  token_secret_ref TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (guild_id, bot_user_id)
);

CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

CREATE UNIQUE INDEX "Session_token_key" ON "Session"("token");

CREATE UNIQUE INDEX "User_discordUserId_key" ON "User"("discordUserId");

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

CREATE INDEX "WorkspaceGuildAuditEvent_guild_time_idx"
  ON "WorkspaceGuildAuditEvent" ("guildId", "occurredAtMs");

CREATE INDEX "WorkspaceGuildAuditEvent_workspace_time_idx"
  ON "WorkspaceGuildAuditEvent" ("workspaceId", "occurredAtMs");

CREATE UNIQUE INDEX "WorkspaceGuild_guildId_key" ON "WorkspaceGuild"("guildId");

CREATE INDEX admin_feedback_created ON admin_feedback (created_at_ms);

CREATE INDEX admin_feedback_notification_state ON admin_feedback (notification_state);

CREATE INDEX admin_feedback_reporter_created ON admin_feedback (reporter_user_id, created_at_ms);

CREATE INDEX attendance_observation_due ON attendance_observation_runs(active_target,next_at_ms);

CREATE INDEX attendance_observation_guild ON attendance_observation_runs(guild_id);

CREATE INDEX attendance_observation_reports_guild ON attendance_observation_reports(guild_id);

CREATE INDEX attendance_observation_samples_expiry ON attendance_observation_samples(delete_at_ms);

CREATE INDEX attendance_observation_samples_guild ON attendance_observation_samples(guild_id);

CREATE INDEX attendance_observation_samples_run ON attendance_observation_samples(run_id,slot);

CREATE UNIQUE INDEX ban_case_operation_active ON ban_case_operations(physical_target, subject) WHERE active = 1;

CREATE INDEX ban_case_operation_due ON ban_case_operations(active, next_at_ms);

CREATE INDEX ban_case_operation_guild ON ban_case_operations(guild_id);

CREATE INDEX ban_case_operational_incident_events_incident_created
  ON ban_case_operational_incident_events (incident_id, created_at_ms DESC);

CREATE INDEX ban_case_operational_incident_events_retention
  ON ban_case_operational_incident_events (created_at_ms);

CREATE INDEX ban_case_operational_incidents_guild_feature_status
  ON ban_case_operational_incidents (guild_id, feature, status);

CREATE INDEX ban_case_operational_incidents_guild_status_severity
  ON ban_case_operational_incidents (guild_id, status, severity, last_seen_at_ms DESC);

CREATE INDEX ban_case_operational_incidents_retention
  ON ban_case_operational_incidents (status, resolved_at_ms);

CREATE INDEX ban_case_projection_due ON ban_case_operation_projections(next_at_ms);

CREATE INDEX ban_case_sources_by_guild
  ON ban_case_sources (guild_id, updated_at_ms DESC);

CREATE UNIQUE INDEX ban_case_sources_public_id_unique
  ON ban_case_sources (public_id);

CREATE INDEX ban_cases_by_source
  ON ban_cases (guild_id, source_id);

CREATE UNIQUE INDEX ban_cases_subject_unique
  ON ban_cases (guild_id, subject_platform, subject_id);

CREATE INDEX billing_assignments_by_owner
  ON billing_guild_assignments(owner_id, assigned_at_ms);

CREATE INDEX billing_assignments_by_subscription
  ON billing_guild_assignments(stripe_subscription_id, assigned_at_ms);

CREATE INDEX billing_operations_by_owner_created
  ON billing_operations_ledger(owner_id, created_at_ms DESC);

CREATE INDEX billing_webhooks_by_object
  ON billing_webhook_events(event_type, object_id, stripe_created_at_ms);

CREATE INDEX bot_defense_rate_window_by_guild_user_channel
  ON bot_defense_rate_window_events (guild_id, user_id, channel_id);

CREATE INDEX bot_defense_rate_window_by_guild_user_time
  ON bot_defense_rate_window_events (guild_id, user_id, message_timestamp_ms);

CREATE INDEX bot_defense_rate_window_by_message
  ON bot_defense_rate_window_events (
    guild_id,
    user_id,
    message_fingerprint,
    message_timestamp_ms,
    channel_id
  );

CREATE INDEX bot_flags_by_guild_status
  ON bot_flags (guild_id, status, created_at_ms);

CREATE INDEX clan_applications_due ON clan_applications (expires_at_ms) WHERE status = 'pending';

CREATE UNIQUE INDEX clan_applications_one_pending ON clan_applications (clan_id, applicant_id) WHERE status = 'pending';

CREATE UNIQUE INDEX clan_change_requests_one_pending_kind ON clan_change_requests (clan_id, kind) WHERE status = 'pending';

CREATE INDEX clan_history_by_clan ON clan_history (guild_id, clan_id, created_at_ms DESC);

CREATE INDEX clan_history_retention ON clan_history (retention_expires_at_ms);

CREATE INDEX clan_invitations_due ON clan_invitations (expires_at_ms) WHERE status = 'pending';

CREATE UNIQUE INDEX clan_invitations_one_pending ON clan_invitations (clan_id, invitee_id) WHERE status = 'pending';

CREATE INDEX clan_membership_blocks_active ON clan_membership_blocks (clan_id, user_id, expires_at_ms) WHERE lifted_at_ms IS NULL;

CREATE INDEX clan_memberships_active_by_clan ON clan_memberships (clan_id, rank, joined_at_ms) WHERE left_at_ms IS NULL;

CREATE UNIQUE INDEX clan_memberships_one_active_per_guild ON clan_memberships (guild_id, user_id) WHERE left_at_ms IS NULL;

CREATE UNIQUE INDEX clan_memberships_one_owner ON clan_memberships (clan_id) WHERE rank = 'owner' AND left_at_ms IS NULL;

CREATE UNIQUE INDEX clan_ownership_transfers_one_pending ON clan_ownership_transfers (clan_id) WHERE status = 'pending';

CREATE INDEX clan_requests_by_guild_status ON clan_requests (guild_id, status, created_at_ms);

CREATE UNIQUE INDEX clan_requests_one_pending_per_member
  ON clan_requests (guild_id, requester_id)
  WHERE status IN ('pending', 'changes-requested');

CREATE INDEX clan_requests_retention ON clan_requests (retention_expires_at_ms) WHERE retention_expires_at_ms IS NOT NULL;

CREATE INDEX clan_requests_review_ticket_recovery
  ON clan_requests (review_ticket_state, updated_at_ms)
  WHERE review_ticket_state IN ('pending', 'creating', 'decision-pending');

CREATE INDEX clans_by_guild_lifecycle ON clans (guild_id, lifecycle_state, created_at_ms);

CREATE INDEX clans_due_deletion ON clans (deletion_due_at_ms) WHERE lifecycle_state = 'deletion-recovery';

CREATE INDEX clans_due_inactivity ON clans (latest_activity_at_ms) WHERE lifecycle_state = 'active';

CREATE UNIQUE INDEX clans_unique_active_name ON clans (guild_id, normalized_name) WHERE lifecycle_state != 'permanently-deleted';

CREATE UNIQUE INDEX clans_unique_active_tag ON clans (guild_id, normalized_tag) WHERE lifecycle_state != 'permanently-deleted';

CREATE INDEX commerce_authority_grants_active_user
  ON commerce_authority_grants (connected_account_id, discord_user_id, revoked_at_ms);

CREATE UNIQUE INDEX commerce_checkout_attempts_active_buyer_offering
  ON commerce_checkout_attempts (connected_account_id, buyer_id, offering_id)
  WHERE status IN ('creating', 'open', 'returned');

CREATE INDEX commerce_checkout_attempts_expiry
  ON commerce_checkout_attempts (status, expires_at_ms);

CREATE INDEX commerce_checkout_capacity_claims_usage
  ON commerce_checkout_capacity_claims
    (connected_account_id, currency, month_started_at_ms, expires_at_ms);

CREATE UNIQUE INDEX commerce_connected_accounts_current_guild
  ON commerce_connected_accounts (guild_id) WHERE status <> 'archived';

CREATE INDEX commerce_connected_accounts_guild_status
  ON commerce_connected_accounts (guild_id, status);

CREATE UNIQUE INDEX commerce_connected_accounts_provider
  ON commerce_connected_accounts (stripe_account_id);

CREATE INDEX commerce_delivery_outbox_due
  ON commerce_delivery_outbox (status, available_at_ms, created_at_ms);

CREATE INDEX commerce_disputes_payment ON commerce_disputes (payment_id, created_at_ms);

CREATE INDEX commerce_entitlements_buyer_status
  ON commerce_entitlements (buyer_id, status);

CREATE INDEX commerce_entitlements_offering_status
  ON commerce_entitlements (offering_id, status);

CREATE INDEX commerce_financial_actions_due
  ON commerce_financial_actions (status, available_at_ms, lease_expires_at_ms);

CREATE INDEX commerce_financial_actions_entity_time
  ON commerce_financial_actions (entity_type, entity_id, created_at_ms);

CREATE INDEX commerce_financial_actions_seller_time
  ON commerce_financial_actions (connected_account_id, created_at_ms);

CREATE INDEX commerce_financial_provider_actions_due
  ON commerce_financial_provider_actions (status, available_at_ms, lease_expires_at_ms);

CREATE INDEX commerce_financial_provider_actions_workflow
  ON commerce_financial_provider_actions (workflow_type, workflow_id, status);

CREATE INDEX commerce_game_audit_guild ON commerce_game_audit(guild_id,created_at_ms);

CREATE INDEX commerce_game_due ON commerce_game_assignments(next_at_ms);

CREATE INDEX commerce_game_guild ON commerce_game_assignments(guild_id);

CREATE INDEX commerce_game_selection_assignment ON commerce_game_selections(assignment_id);

CREATE INDEX commerce_guild_deletion_refund_reviews_pending
  ON commerce_guild_deletion_refund_reviews (status, created_at_ms);

CREATE INDEX commerce_incidents_guild_status
  ON commerce_incidents (guild_id, status, severity, last_seen_at_ms);

CREATE INDEX commerce_limit_alerts_open
  ON commerce_limit_alerts (guild_id, status, updated_at_ms);

CREATE INDEX commerce_offering_retirements_status
  ON commerce_offering_retirements (status, updated_at_ms);

CREATE UNIQUE INDEX commerce_offerings_published_role
  ON commerce_offerings (guild_id, discord_role_id)
  WHERE state = 'published' OR (state = 'repair_required' AND repair_previous_state = 'published');

CREATE INDEX commerce_offerings_seller_state
  ON commerce_offerings (connected_account_id, state);

CREATE INDEX commerce_operational_controls_active
  ON commerce_operational_controls (enabled, control_type, expires_at_ms);

CREATE INDEX commerce_operations_ledger_entity
  ON commerce_operations_ledger (entity_type, entity_id, created_at_ms);

CREATE INDEX commerce_operations_ledger_seller_time
  ON commerce_operations_ledger (connected_account_id, created_at_ms);

CREATE INDEX commerce_paid_role_operations_entitlement ON commerce_paid_role_operations (entitlement_id, created_at_ms);

CREATE INDEX commerce_paid_role_outbox_due ON commerce_paid_role_outbox (status, available_at_ms, created_at_ms);

CREATE INDEX commerce_paid_role_provider_actions_due
  ON commerce_paid_role_provider_actions (status, available_at_ms, lease_expires_at_ms);

CREATE INDEX commerce_paid_role_repairs_due ON commerce_paid_role_repairs (status, deadline_at_ms);

CREATE INDEX commerce_paid_role_states_guild_role ON commerce_paid_role_states (guild_id, discord_role_id);

CREATE INDEX commerce_payments_buyer_created
  ON commerce_payments (buyer_id, created_at_ms);

CREATE UNIQUE INDEX commerce_payments_charge
  ON commerce_payments (connected_account_id, stripe_charge_id)
  WHERE stripe_charge_id IS NOT NULL;

CREATE UNIQUE INDEX commerce_payments_checkout
  ON commerce_payments (connected_account_id, stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;

CREATE INDEX commerce_payments_subscription_period
  ON commerce_payments (connected_account_id, stripe_subscription_id, invoice_period_end_ms);

CREATE INDEX commerce_prices_offering_status ON commerce_prices (offering_id, status);

CREATE INDEX commerce_refunds_payment ON commerce_refunds (payment_id, created_at_ms);

CREATE INDEX commerce_reporting_ledger_buyer
  ON commerce_reporting_ledger (buyer_id, occurred_at_ms);

CREATE INDEX commerce_reporting_ledger_period
  ON commerce_reporting_ledger (reporting_period, currency, transaction_type);

CREATE INDEX commerce_reporting_ledger_seller
  ON commerce_reporting_ledger (connected_account_id, occurred_at_ms);

CREATE INDEX commerce_role_assignments_due
  ON commerce_role_assignments (status, next_attempt_at_ms);

CREATE INDEX commerce_role_assignments_member
  ON commerce_role_assignments (guild_id, discord_user_id);

CREATE UNIQUE INDEX commerce_sales_panels_guild ON commerce_sales_panels (guild_id);

CREATE INDEX commerce_sales_panels_lease
  ON commerce_sales_panels (publication_lease_expires_at_ms);

CREATE INDEX commerce_sales_panels_message ON commerce_sales_panels (channel_id, message_id);

CREATE INDEX commerce_seller_acceptances_account_time
  ON commerce_seller_acceptances (connected_account_id, accepted_at_ms);

CREATE INDEX commerce_seller_controls_active
  ON commerce_seller_controls (suspended, scope_type, updated_at_ms);

CREATE INDEX commerce_seller_profiles_lifecycle
  ON commerce_seller_profiles (lifecycle_state, approval_state, updated_at_ms);

CREATE INDEX commerce_seller_profiles_owner
  ON commerce_seller_profiles (seller_owner_user_id, guild_id);

CREATE INDEX commerce_seller_review_requests_lease
  ON commerce_seller_review_requests (notification_lease_expires_at_ms);

CREATE INDEX commerce_seller_review_requests_pending
  ON commerce_seller_review_requests (state, created_at_ms);

CREATE INDEX commerce_store_branding_updated ON commerce_store_branding (updated_at_ms);

CREATE UNIQUE INDEX commerce_subscriptions_active_buyer_offering
  ON commerce_subscriptions (connected_account_id, buyer_id, offering_id)
  WHERE status NOT IN ('canceled', 'ended');

CREATE INDEX commerce_subscriptions_customer_status
  ON commerce_subscriptions (customer_id, status);

CREATE UNIQUE INDEX commerce_support_checkout_active_buyer_guild
  ON commerce_support_checkout_attempts (connected_account_id, buyer_id, guild_id)
  WHERE status IN ('creating', 'open', 'returned');

CREATE INDEX commerce_support_checkout_expiry
  ON commerce_support_checkout_attempts (status, expires_at_ms);

CREATE INDEX commerce_support_disputes_payment_time
  ON commerce_support_disputes (support_payment_id, created_at_ms);

CREATE INDEX commerce_support_payments_buyer_time
  ON commerce_support_payments (buyer_id, created_at_ms);

CREATE INDEX commerce_support_payments_seller_time
  ON commerce_support_payments (connected_account_id, created_at_ms);

CREATE INDEX commerce_support_refunds_payment_time
  ON commerce_support_refunds (support_payment_id, created_at_ms);

CREATE INDEX commerce_sync_outbox_pending
  ON commerce_sync_outbox (sent_at_ms, created_at_ms);

CREATE INDEX commerce_sync_state_status ON commerce_sync_state (status, updated_at_ms);

CREATE INDEX commerce_webhook_events_pending
  ON commerce_webhook_events (status, received_at_ms);

CREATE INDEX configuration_revisions_by_guild
  ON configuration_revisions (guild_id, created_at_ms DESC, id DESC);

CREATE INDEX configuration_revisions_by_resource
  ON configuration_revisions (guild_id, feature, resource_key, created_at_ms DESC, id DESC);

CREATE INDEX configuration_revisions_previous_idx
  ON configuration_revisions (previous_revision_id);

CREATE INDEX configuration_revisions_restored_from_idx
  ON configuration_revisions (restored_from_revision_id);

CREATE INDEX considered_replies_by_suggestion ON considered_replies(suggestion_id,created_at_ms);

CREATE UNIQUE INDEX considered_replies_webhook_message_unique ON considered_replies(webhook_message_id);

CREATE INDEX donor_claims_by_suspended_at
  ON donor_claims(suspended_at_ms);

CREATE INDEX donor_claims_by_user
  ON donor_claims(claimed_by_user_id);

CREATE INDEX event_lifecycle_history_by_event
ON event_lifecycle_history (guild_id, event_id, occurred_at_ms DESC);

CREATE INDEX event_lifecycle_history_retention
ON event_lifecycle_history (retention_expires_at_ms);

CREATE INDEX event_recurrence_due ON event_recurrence_series(status, next_publishes_at_ms);

CREATE INDEX event_signups_by_event
  ON event_signups (guild_id, event_id, status, created_at_ms);

CREATE INDEX event_signups_by_user
  ON event_signups (guild_id, event_id, user_id);

CREATE INDEX event_team_audit_by_event_time
ON event_team_audit_records (guild_id, event_id, occurred_at_ms DESC);

CREATE INDEX event_team_delivery_outbox_due
ON event_team_delivery_outbox (guild_id, event_id, status, next_attempt_at_ms);

CREATE INDEX event_team_delivery_outbox_global_due
ON event_team_delivery_outbox (status, next_attempt_at_ms);

CREATE INDEX event_team_invitation_blocks_by_event_user
ON event_team_invitation_blocks (guild_id, event_id, user_id);

CREATE UNIQUE INDEX event_team_memberships_active_user_unique
ON event_team_memberships (guild_id, event_id, user_id)
WHERE left_at_ms IS NULL;

CREATE INDEX event_team_memberships_by_team
ON event_team_memberships (guild_id, event_id, team_id, left_at_ms);

CREATE INDEX event_team_proposals_by_event_status
ON event_team_proposals (guild_id, event_id, status, created_at_ms);

CREATE INDEX event_team_proposals_by_team
ON event_team_proposals (guild_id, event_id, team_id);

CREATE UNIQUE INDEX event_team_proposals_pending_invite_unique
ON event_team_proposals (guild_id, event_id, team_id, target_user_id)
WHERE kind = 'invitation' AND status = 'pending';

CREATE UNIQUE INDEX event_team_proposals_pending_join_unique
ON event_team_proposals (guild_id, event_id, requester_user_id)
WHERE kind = 'join_request' AND status = 'pending';

CREATE INDEX event_team_rate_limits_expiry
ON event_team_rate_limits (updated_at_ms);

CREATE INDEX event_team_roster_snapshots_by_event
ON event_team_roster_snapshots (guild_id, event_id);

CREATE INDEX event_teams_by_event_group
ON event_teams (guild_id, event_id, group_id);

CREATE UNIQUE INDEX event_teams_name_unique
ON event_teams (guild_id, event_id, normalized_name);

CREATE INDEX event_templates_by_guild_updated
  ON event_templates (guild_id, updated_at_ms DESC);

CREATE INDEX events_by_guild_status_start
  ON events (guild_id, status, starts_at_ms);

CREATE INDEX events_by_lifecycle_due
  ON events (status, starts_at_ms, ends_at_ms);

CREATE INDEX events_recurrence_series ON events(guild_id, recurrence_series_id);

CREATE INDEX evidence_vault_records_guild_idx
  ON evidence_vault_records(guild_id, hidden_at_ms);

CREATE INDEX feature_setup_resolutions_by_resource
  ON feature_setup_resolutions (resource_id);

CREATE INDEX feature_setup_runs_by_feature
  ON feature_setup_runs (guild_id, feature_key, created_at_ms DESC);

CREATE UNIQUE INDEX feature_setup_runs_one_active
  ON feature_setup_runs (guild_id, feature_key)
  WHERE status IN ('planned', 'running', 'incomplete');

CREATE INDEX gateway_event_operations_by_completion
  ON gateway_event_operations (completed_at_ms)
  WHERE state IN ('completed', 'terminal');

CREATE INDEX gateway_reaction_limit_mutations_by_completion
  ON gateway_reaction_limit_mutations (created_at_ms)
  WHERE result_one IS NOT NULL;

CREATE INDEX guild_service_suspension_audit_by_guild
  ON guild_service_suspension_audit (guild_id, occurred_at_ms DESC);

CREATE INDEX guild_service_suspensions_active
  ON guild_service_suspensions (removed_at_ms, created_at_ms DESC);

CREATE INDEX identity_patterns_position_idx ON identity_patterns(position);

CREATE INDEX idx_guild_r2_objects_expiry
  ON guild_r2_objects(status, reservation_expires_at_ms);

CREATE INDEX idx_guild_r2_objects_guild
  ON guild_r2_objects(guild_id);

CREATE UNIQUE INDEX idx_guild_r2_objects_operation
  ON guild_r2_objects(operation_key)
  WHERE operation_key IS NOT NULL;

CREATE INDEX idx_staff_messages_lookup
  ON ticket_staff_messages(guild_id, ticket_channel_id, bot_message_id);

CREATE UNIQUE INDEX idx_staff_messages_staff_lookup
  ON ticket_staff_messages(guild_id, staff_thread_id, staff_message_id);

CREATE INDEX image_rules_mod_queue_items_by_guild_status
ON image_rules_mod_queue_items (guild_id, status, created_at_ms);

CREATE UNIQUE INDEX image_rules_mod_queue_items_by_source_message
  ON image_rules_mod_queue_items (guild_id, channel_id, message_id);

CREATE INDEX image_rules_mod_queue_items_restore_claim
  ON image_rules_mod_queue_items (restore_claim_expires_at_ms);

CREATE INDEX lfg_applications_by_post_status
  ON lfg_applications(guild_id, post_id, status, created_at_ms DESC);

CREATE INDEX lfg_posts_by_expiry
  ON lfg_posts(active, expires_at_ms);

CREATE INDEX lfg_posts_by_guild_clan_active ON lfg_posts (guild_id, clan_id, active);

CREATE INDEX lfg_posts_by_owner_active
  ON lfg_posts(guild_id, owner_id, active);

CREATE INDEX lfg_voice_channels_by_channel
  ON lfg_voice_channels(channel_id);

CREATE UNIQUE INDEX managed_message_audit_outbox_by_canonical_message
  ON managed_message_audit_outbox (guild_id, channel_id, message_id);

CREATE INDEX managed_message_drafts_by_guild_updated
  ON managed_message_drafts (guild_id, updated_at_ms DESC);

CREATE INDEX managed_message_drafts_due
  ON managed_message_drafts (status, scheduled_at_ms);

CREATE INDEX managed_message_media_assets_pending
  ON managed_message_media_assets (guild_id, status);

CREATE INDEX managed_message_media_refs_by_owner
  ON managed_message_media_refs (guild_id, owner_type, owner_id);

CREATE INDEX managed_messages_by_guild_updated
  ON managed_messages (guild_id, updated_at_ms DESC);

CREATE INDEX marketplace_logs_by_timestamp
  ON marketplace_trade_logs(guild_id, timestamp_ms DESC);

CREATE INDEX marketplace_posts_by_owner_active
  ON marketplace_posts(guild_id, owner_id, active);

CREATE INDEX member_verification_attempts_by_expires
ON member_verification_attempts(expires_at_ms);

CREATE INDEX member_verification_attempts_by_guild_user
ON member_verification_attempts(guild_id, user_id);

CREATE INDEX member_verification_manual_dm_rate_limits_expiry
ON member_verification_manual_dm_rate_limits (updated_at_ms);

CREATE INDEX member_verification_states_by_guild
  ON member_verification_states (guild_id, verified_at_ms DESC);

CREATE INDEX mention_protection_breaches_by_member
  ON mention_protection_breaches (guild_id, user_id, breached_at_ms);

CREATE INDEX mention_protection_burst_by_member_time
  ON mention_protection_burst_events (guild_id, user_id, message_timestamp_ms);

CREATE UNIQUE INDEX message_templates_by_guild_name
  ON message_templates (guild_id, internal_name);

CREATE INDEX message_templates_by_guild_updated
  ON message_templates (guild_id, updated_at_ms DESC);

CREATE INDEX one_time_tokens_expires_at ON one_time_tokens(expires_at_ms);

CREATE INDEX operational_incident_events_incident_created
  ON operational_incident_events (incident_id, created_at_ms DESC);

CREATE INDEX operational_incident_events_retention
  ON operational_incident_events (created_at_ms);

CREATE INDEX operational_incidents_guild_feature_status
  ON operational_incidents (guild_id, feature, status);

CREATE INDEX operational_incidents_guild_status_severity
  ON operational_incidents (guild_id, status, severity, last_seen_at_ms DESC);

CREATE INDEX operational_incidents_retention
  ON operational_incidents (status, resolved_at_ms);

CREATE UNIQUE INDEX platform_links_by_platform_id ON platform_links(guild_id, platform, platform_id);

CREATE INDEX platform_links_by_user ON platform_links(guild_id, user_id, platform);

CREATE INDEX player_count_servers_by_guild
  ON player_count_servers(guild_id);

CREATE INDEX player_count_servers_by_provider
  ON player_count_servers(provider, provider_server_id);

CREATE INDEX reaction_limit_message_counts_updated_at
  ON reaction_limit_message_reaction_counts(updated_at_ms);

CREATE INDEX reaction_limit_user_message_counts_updated_at
  ON reaction_limit_user_message_reaction_counts(updated_at_ms);

CREATE UNIQUE INDEX server_level_announcement_once
  ON server_level_announcement_outbox(guild_id, user_id, level);

CREATE INDEX server_level_announcement_pending
  ON server_level_announcement_outbox(delivered_at_ms, created_at_ms);

CREATE INDEX server_level_awards_compaction
  ON server_level_awards(kind, created_at_ms);

CREATE UNIQUE INDEX server_level_awards_interval_once
  ON server_level_awards(source_inbox_id, user_id, configured_game_server_id, interval_started_at_ms, interval_ended_at_ms);

CREATE INDEX server_level_awards_member_time
  ON server_level_awards(guild_id, user_id, interval_started_at_ms, interval_ended_at_ms);

CREATE UNIQUE INDEX server_level_credentials_owner
  ON server_level_credentials(configured_game_server_id, purpose);

CREATE INDEX server_level_earning_sessions_member_open
  ON server_level_earning_sessions(guild_id, user_id, closed_at_ms, checkpoint_at_ms);

CREATE INDEX server_level_earning_sessions_server_open
  ON server_level_earning_sessions(configured_game_server_id, closed_at_ms, checkpoint_at_ms);

CREATE INDEX server_level_ingress_outbox_pending
  ON server_level_ingress_outbox(published_at_ms, created_at_ms);

CREATE INDEX server_level_member_totals_leaderboard
  ON server_level_member_totals(guild_id, current_member, total_xp_units DESC);

CREATE UNIQUE INDEX server_level_servers_endpoint
  ON server_level_servers(endpoint_id);

CREATE INDEX server_level_servers_guild
  ON server_level_servers(guild_id);

CREATE UNIQUE INDEX server_level_servers_guild_provider
  ON server_level_servers(guild_id, provider_server_id);

CREATE UNIQUE INDEX server_level_webhook_inbox_delivery
  ON server_level_webhook_inbox(configured_game_server_id, delivery_id);

CREATE INDEX server_level_webhook_inbox_processing
  ON server_level_webhook_inbox(configured_game_server_id, status, occurred_at_ms);

CREATE INDEX suggestion_action_limits_expiry ON suggestion_action_rate_limits(updated_at_ms);

CREATE UNIQUE INDEX suggestion_revisions_unique ON suggestion_revisions(suggestion_id,revision);

CREATE INDEX suggestion_status_history ON suggestion_status_events(suggestion_id,created_at_ms);

CREATE INDEX suggestion_votes_by_member ON suggestion_votes(guild_id,member_id,active);

CREATE INDEX suggestions_by_author ON suggestions(guild_id,author_id,created_at_ms);

CREATE INDEX suggestions_by_guild_status ON suggestions(guild_id,status,updated_at_ms);

CREATE UNIQUE INDEX suggestions_thread_unique ON suggestions(thread_id);

CREATE INDEX ticket_instances_by_opener_opened_at
ON ticket_instances (guild_id, opener_user_id, opened_at_ms DESC);

CREATE INDEX ticket_instances_by_opener_status
  ON ticket_instances(guild_id, opener_user_id, status);

CREATE INDEX ticket_instances_by_status
  ON ticket_instances(guild_id, status, opened_at_ms DESC);

CREATE UNIQUE INDEX ticket_panels_unique_name ON ticket_panels (guild_id, panel_name);

CREATE INDEX ticket_participant_events_by_ticket
  ON ticket_participant_events (guild_id, ticket_channel_id, created_at_ms);

CREATE INDEX ticket_participants_by_user
  ON ticket_participants (guild_id, user_id);

CREATE INDEX ticket_template_replies_by_ticket
  ON ticket_template_replies (guild_id, ticket_channel_id, created_at_ms DESC);

CREATE UNIQUE INDEX ticket_transcript_capabilities_active_guild_channel
  ON ticket_transcript_capabilities (guild_id, channel_id)
  WHERE discarded_at_ms IS NULL;

CREATE INDEX ticket_transcript_capabilities_retention
  ON ticket_transcript_capabilities (retention_expires_at_ms);

CREATE INDEX timed_roles_by_expiry
  ON timed_roles(expires_at_ms ASC);

CREATE INDEX webhook_credentials_guild_public_idx ON webhook_credentials(guild_id, public_id);

CREATE UNIQUE INDEX webhook_credentials_owner_unique
  ON webhook_credentials(guild_id, owner_kind, public_id, COALESCE(destination_id, ''));

CREATE INDEX webhook_proxy_configs_by_guild
  ON webhook_proxy_configs(guild_id, updated_at_ms DESC);

CREATE INDEX webhook_proxy_logs_by_webhook
  ON webhook_proxy_forward_logs(guild_id, public_id, timestamp_ms DESC);

CREATE INDEX white_label_bots_guild_idx ON white_label_bots (guild_id);

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

CREATE TRIGGER commerce_disputes_retained
BEFORE DELETE ON commerce_disputes
BEGIN
  SELECT RAISE(ABORT, 'commerce disputes are retained');
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

CREATE TRIGGER commerce_operations_ledger_immutable_delete
BEFORE DELETE ON commerce_operations_ledger
BEGIN
  SELECT RAISE(ABORT, 'commerce operations ledger is retained');
END;

CREATE TRIGGER commerce_operations_ledger_immutable_update
BEFORE UPDATE ON commerce_operations_ledger
BEGIN
  SELECT RAISE(ABORT, 'commerce operations ledger is append-only');
END;

CREATE TRIGGER commerce_payments_retained
BEFORE DELETE ON commerce_payments
BEGIN
  SELECT RAISE(ABORT, 'commerce payments are retained');
END;

CREATE TRIGGER commerce_prices_economic_fields_immutable
BEFORE UPDATE OF connected_account_id, offering_id, stripe_product_id, stripe_price_id,
  currency, unit_amount_minor, price_type, recurring_interval, provider_created_at_ms, created_at_ms
ON commerce_prices
BEGIN
  SELECT RAISE(ABORT, 'commerce prices are immutable; create a new price');
END;

CREATE TRIGGER commerce_refunds_retained
BEFORE DELETE ON commerce_refunds
BEGIN
  SELECT RAISE(ABORT, 'commerce refunds are retained');
END;

CREATE TRIGGER commerce_reporting_ledger_immutable_delete
BEFORE DELETE ON commerce_reporting_ledger
BEGIN
  SELECT RAISE(ABORT, 'commerce reporting ledger is immutable');
END;

CREATE TRIGGER commerce_reporting_ledger_immutable_update
BEFORE UPDATE ON commerce_reporting_ledger
BEGIN
  SELECT RAISE(ABORT, 'commerce reporting ledger is immutable');
END;

CREATE TRIGGER commerce_seller_acceptances_immutable_delete
BEFORE DELETE ON commerce_seller_acceptances
BEGIN
  SELECT RAISE(ABORT, 'commerce seller acceptances are retained');
END;

CREATE TRIGGER commerce_seller_acceptances_immutable_update
BEFORE UPDATE ON commerce_seller_acceptances
BEGIN
  SELECT RAISE(ABORT, 'commerce seller acceptances are immutable');
END;

CREATE TRIGGER configuration_revisions_advance_head
AFTER INSERT ON configuration_revisions
BEGIN
  INSERT INTO configuration_revision_heads (
    guild_id, feature, resource_key, current_revision_id, updated_at_ms
  ) VALUES (
    NEW.guild_id, NEW.feature, NEW.resource_key, NEW.id, NEW.created_at_ms
  )
  ON CONFLICT(guild_id, feature, resource_key) DO UPDATE SET
    current_revision_id = excluded.current_revision_id,
    updated_at_ms = excluded.updated_at_ms;
END;

CREATE TRIGGER configuration_revisions_validate_head
BEFORE INSERT ON configuration_revisions
BEGIN
  SELECT RAISE(ABORT, 'configuration revision head conflict')
  WHERE EXISTS (
    SELECT 1 FROM configuration_revision_heads
    WHERE guild_id = NEW.guild_id
      AND feature = NEW.feature
      AND resource_key = NEW.resource_key
  ) AND NEW.previous_revision_id IS NOT (
    SELECT current_revision_id FROM configuration_revision_heads
    WHERE guild_id = NEW.guild_id
      AND feature = NEW.feature
      AND resource_key = NEW.resource_key
  );

  SELECT RAISE(ABORT, 'configuration revision head conflict')
  WHERE NOT EXISTS (
    SELECT 1 FROM configuration_revision_heads
    WHERE guild_id = NEW.guild_id
      AND feature = NEW.feature
      AND resource_key = NEW.resource_key
  ) AND NEW.previous_revision_id IS NOT NULL;
END;

CREATE TRIGGER event_lifecycle_transition_guard
BEFORE INSERT ON event_lifecycle_transition_guards
WHEN NOT EXISTS (
  SELECT 1 FROM events
  JOIN event_team_state_versions
    ON event_team_state_versions.guild_id = events.guild_id
   AND event_team_state_versions.event_id = events.event_id
  WHERE events.guild_id = NEW.guild_id
    AND events.event_id = NEW.event_id
    AND events.status = NEW.expected_status
    AND event_team_state_versions.version = NEW.expected_state_version
)
BEGIN
  SELECT RAISE(ABORT, 'Event lifecycle state or Team roster changed concurrently');
END;

CREATE TRIGGER event_signup_mutation_guard
BEFORE INSERT ON event_signup_mutation_guards
WHEN (
  NEW.operation = 'delete'
  AND EXISTS (
    SELECT 1 FROM event_team_memberships
    WHERE event_team_memberships.guild_id = NEW.guild_id
      AND event_team_memberships.event_id = NEW.event_id
      AND event_team_memberships.user_id = NEW.user_id
      AND event_team_memberships.group_id = NEW.group_id
      AND event_team_memberships.left_at_ms IS NULL
  )
) OR (
  NEW.operation = 'upsert'
  AND EXISTS (
    SELECT 1 FROM event_team_memberships
    WHERE event_team_memberships.guild_id = NEW.guild_id
      AND event_team_memberships.event_id = NEW.event_id
      AND event_team_memberships.user_id = NEW.user_id
      AND event_team_memberships.group_id <> NEW.group_id
      AND event_team_memberships.left_at_ms IS NULL
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Active Event Team membership requires its compatible signup');
END;

CREATE TRIGGER event_team_bulk_commit_guard
BEFORE INSERT ON event_team_bulk_commit_guards
WHEN NOT EXISTS (
  SELECT 1 FROM events
  JOIN event_team_state_versions
    ON event_team_state_versions.guild_id = events.guild_id
   AND event_team_state_versions.event_id = events.event_id
  WHERE events.guild_id = NEW.guild_id
    AND events.event_id = NEW.event_id
    AND events.status NOT IN ('ended', 'cancelled', 'archived')
    AND event_team_state_versions.version = NEW.expected_state_version
)
BEGIN
  SELECT RAISE(ABORT, 'Event Team bulk state is stale or terminal');
END;

CREATE TRIGGER event_team_memberships_group_guard
BEFORE INSERT ON event_team_memberships
WHEN NOT EXISTS (
  SELECT 1
  FROM event_teams
  WHERE event_teams.guild_id = NEW.guild_id
    AND event_teams.event_id = NEW.event_id
    AND event_teams.team_id = NEW.team_id
    AND event_teams.group_id = NEW.group_id
)
BEGIN
  SELECT RAISE(ABORT, 'incompatible Event Team membership');
END;

CREATE TRIGGER event_team_memberships_signup_guard
BEFORE INSERT ON event_team_memberships
WHEN NEW.left_at_ms IS NULL AND NOT EXISTS (
  SELECT 1
  FROM event_signups
  WHERE event_signups.guild_id = NEW.guild_id
    AND event_signups.event_id = NEW.event_id
    AND event_signups.user_id = NEW.user_id
    AND event_signups.group_id = NEW.group_id
)
BEGIN
  SELECT RAISE(ABORT, 'Event Team membership requires a compatible signup');
END;

CREATE TRIGGER event_team_memberships_size_guard
BEFORE INSERT ON event_team_memberships
WHEN NEW.left_at_ms IS NULL AND (
  SELECT COUNT(*)
  FROM event_team_memberships
  WHERE event_team_memberships.guild_id = NEW.guild_id
    AND event_team_memberships.event_id = NEW.event_id
    AND event_team_memberships.team_id = NEW.team_id
    AND event_team_memberships.left_at_ms IS NULL
) >= COALESCE((
  SELECT required_team_size
  FROM events
  WHERE events.guild_id = NEW.guild_id
    AND events.event_id = NEW.event_id
    AND events.participation_mode = 'team'
), 0)
BEGIN
  SELECT RAISE(ABORT, 'Event Team roster is full');
END;

CREATE TRIGGER event_team_proposal_acceptance_guard
BEFORE INSERT ON event_team_proposal_acceptance_guards
WHEN NOT EXISTS (
  SELECT 1 FROM event_team_proposals
  WHERE event_team_proposals.guild_id = NEW.guild_id
    AND event_team_proposals.event_id = NEW.event_id
    AND event_team_proposals.proposal_id = NEW.proposal_id
    AND event_team_proposals.status = 'pending'
    AND event_team_proposals.updated_at_ms = NEW.expected_updated_at_ms
)
BEGIN
  SELECT RAISE(ABORT, 'Event Team proposal is no longer pending at the expected version');
END;

CREATE TRIGGER managed_message_deleted_out_of_band_outbox
AFTER UPDATE OF status ON managed_messages
WHEN OLD.status = 'published' AND NEW.status = 'missing'
BEGIN
  INSERT OR IGNORE INTO managed_message_audit_outbox (
    event_key,
    guild_id,
    channel_id,
    message_id,
    internal_name,
    claimed_at_ms,
    delivered_at_ms,
    created_at_ms
  ) VALUES (
    'managed-message.deleted-out-of-band:' || NEW.guild_id || ':' || NEW.message_id,
    NEW.guild_id,
    NEW.channel_id,
    NEW.message_id,
    NEW.internal_name,
    NULL,
    NULL,
    NEW.updated_at_ms
  );
END;

CREATE TRIGGER server_level_servers_limit_before_insert
BEFORE INSERT ON server_level_servers
WHEN (SELECT COUNT(*) FROM server_level_servers WHERE guild_id = NEW.guild_id) >= 5
BEGIN
  SELECT RAISE(ABORT, 'A Guild may configure at most five Configured Game Servers.');
END;

INSERT INTO identity_patterns
  (id, platform, pattern, capture_group, "position", disabled, created_at_ms)
VALUES
  ('seed-steam-profile-url', 'steam', 'steamcommunity\.com/profiles/(\d{17})', 1, 10, 0, 0),
  ('seed-steam-id64', 'steam', '\b(7656119\d{10})\b', 1, 20, 0, 0),
  ('seed-discord-mention', 'discord', '<@!?(\d{17,20})>', 1, 30, 0, 0),
  ('seed-discord-id', 'discord', '\b(\d{17,20})\b', 1, 40, 0, 0),
  ('seed-xbox-xuid', 'xbox', '\b(\d{16})\b', 1, 50, 0, 0),
  ('seed-cftools-url', 'cftools', 'cftools\.(?:cloud|com)/(?:profile|users?)/(?:steam/)?([A-Za-z0-9_-]+)', 1, 60, 0, 0);
