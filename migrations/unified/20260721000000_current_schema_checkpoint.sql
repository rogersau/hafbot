-- hafbot:migration {"phase":"expand"}
-- Unified D1 schema checkpoint for fresh and reconciled existing databases.
-- Source reconciliation manifest SHA-256: 761fcf2d9bfdcc10036502086ffa42dc185414b91a7601c61b54e87fed9c06fc
-- Archived migration provenance SHA-256: 52213f32f0bab615c7b765b9b196b4f5a8b4778a4a5f18865b9e861ac0214404
-- Generated from the archived auth/app tracks; do not edit by hand.

CREATE TABLE IF NOT EXISTS "Account" (
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

CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ban_case_configs (
  guild_id TEXT PRIMARY KEY NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  forum_channel_id TEXT,
  mod_role_ids_json TEXT NOT NULL DEFAULT '[]',
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ban_case_sources (
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

CREATE TABLE IF NOT EXISTS ban_cases (
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

CREATE TABLE IF NOT EXISTS billing_customer_bindings (
  owner_id TEXT PRIMARY KEY NOT NULL,
  stripe_customer_id TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS billing_delivery_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  operation_id TEXT NOT NULL,
  destination TEXT NOT NULL,
  outcome TEXT NOT NULL,
  provider_correlation_id TEXT,
  attempted_at_ms INTEGER NOT NULL,
  FOREIGN KEY(operation_id) REFERENCES billing_operations_ledger(id)
);

CREATE TABLE IF NOT EXISTS billing_delivery_outbox (
  operation_id TEXT PRIMARY KEY NOT NULL,
  created_at_ms INTEGER NOT NULL,
  sent_at_ms INTEGER,
  FOREIGN KEY(operation_id) REFERENCES billing_operations_ledger(id)
);

CREATE TABLE IF NOT EXISTS billing_founder_places (
  stripe_subscription_id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  awarded_at_ms INTEGER NOT NULL,
  FOREIGN KEY(owner_id) REFERENCES billing_customer_bindings(owner_id)
);

CREATE TABLE IF NOT EXISTS billing_guild_assignments (
  guild_id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  stripe_subscription_id TEXT NOT NULL,
  assigned_at_ms INTEGER NOT NULL,
  FOREIGN KEY(owner_id) REFERENCES billing_subscriptions(owner_id)
);

CREATE TABLE IF NOT EXISTS billing_operation_delivery (
  operation_id TEXT PRIMARY KEY NOT NULL,
  owner_dm_status TEXT NOT NULL DEFAULT 'pending',
  audit_status TEXT NOT NULL DEFAULT 'pending',
  next_attempt_at_ms INTEGER,
  terminal_reason TEXT,
  updated_at_ms INTEGER NOT NULL, owner_dm_message_id TEXT, audit_message_id TEXT, owner_attempt_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(operation_id) REFERENCES billing_operations_ledger(id)
);

CREATE TABLE IF NOT EXISTS billing_operations_ledger (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  correlation_id TEXT,
  summary_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS billing_owner_sync_state (
  owner_id TEXT PRIMARY KEY NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  lease_until_ms INTEGER,
  completed_generation INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS billing_reconciliation_failures (
  owner_id TEXT PRIMARY KEY NOT NULL,
  reason TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  first_failed_at_ms INTEGER NOT NULL,
  last_failed_at_ms INTEGER NOT NULL,
  terminal_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS billing_subscriptions (
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
  quarantine_reason TEXT, grace_started_at_ms INTEGER, grace_ends_at_ms INTEGER, grace_expired_at_ms INTEGER, pricing_cohort TEXT
  CHECK(pricing_cohort IS NULL OR pricing_cohort IN ('founder', 'standard')), founder_awarded_at_ms INTEGER,
  FOREIGN KEY(owner_id) REFERENCES billing_customer_bindings(owner_id)
);

CREATE TABLE IF NOT EXISTS billing_support_cases (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  safe_provider_ids_json TEXT NOT NULL DEFAULT '[]',
  opened_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  resolved_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS billing_sync_outbox (
  event_id TEXT PRIMARY KEY NOT NULL,
  stripe_customer_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  sent_at_ms INTEGER,
  FOREIGN KEY(event_id) REFERENCES billing_webhook_events(event_id)
);

CREATE TABLE IF NOT EXISTS billing_tester_cutovers (
  owner_id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL,
  inventory_json TEXT NOT NULL,
  promotion_code_id TEXT,
  deadline_ms INTEGER NOT NULL,
  legacy_authority_removed_at_ms INTEGER,
  rolled_back_at_ms INTEGER,
  completed_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS billing_webhook_events (
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

CREATE TABLE IF NOT EXISTS bot_defense_configs (
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

CREATE TABLE IF NOT EXISTS bot_defense_rate_window_events (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_timestamp_ms INTEGER NOT NULL
, message_fingerprint TEXT NOT NULL DEFAULT '');

CREATE TABLE IF NOT EXISTS bot_flags (
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

CREATE TABLE IF NOT EXISTS clan_applications (
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

CREATE TABLE IF NOT EXISTS clan_change_requests (
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

CREATE TABLE IF NOT EXISTS clan_history (
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

CREATE TABLE IF NOT EXISTS clan_invitations (
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

CREATE TABLE IF NOT EXISTS clan_management_configs (
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

CREATE TABLE IF NOT EXISTS clan_membership_blocks (
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

CREATE TABLE IF NOT EXISTS clan_memberships (
  clan_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  rank TEXT NOT NULL CHECK (rank IN ('owner', 'officer', 'member')),
  joined_at_ms INTEGER NOT NULL,
  left_at_ms INTEGER,
  PRIMARY KEY (clan_id, user_id, joined_at_ms),
  FOREIGN KEY (clan_id) REFERENCES clans(id)
);

CREATE TABLE IF NOT EXISTS clan_ownership_transfers (
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

CREATE TABLE IF NOT EXISTS clan_requests (
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

CREATE TABLE IF NOT EXISTS clans (
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

CREATE TABLE IF NOT EXISTS donor_claims (
  guild_id TEXT PRIMARY KEY,
  claimed_by_user_id TEXT NOT NULL,
  claimed_at_ms INTEGER NOT NULL,
  suspended_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS event_signups (
  guild_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (guild_id, event_id, user_id, group_id)
);

CREATE TABLE IF NOT EXISTS event_templates (
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
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (guild_id, template_id)
);

CREATE TABLE IF NOT EXISTS events (
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
  archived_at_ms INTEGER,
  PRIMARY KEY (guild_id, event_id)
);

CREATE TABLE IF NOT EXISTS evidence_vault_configs (
  guild_id TEXT PRIMARY KEY,
  audit_channel_id TEXT NOT NULL,
  access_role_id TEXT,
  updated_at_ms INTEGER NOT NULL
, access_role_ids_json TEXT NOT NULL DEFAULT '[]', subjects_enabled INTEGER NOT NULL DEFAULT 0, fields_json TEXT NOT NULL DEFAULT '[]');

CREATE TABLE IF NOT EXISTS evidence_vault_records (
  record_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  hidden_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS "feature_setup_resolutions" (
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

CREATE TABLE IF NOT EXISTS feature_setup_runs (
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

CREATE TABLE IF NOT EXISTS gateway_event_operations (
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

CREATE TABLE IF NOT EXISTS gateway_reaction_limit_mutations (
  event_key TEXT NOT NULL,
  mutation_kind TEXT NOT NULL,
  result_one INTEGER,
  result_two INTEGER,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (event_key, mutation_kind)
);

CREATE TABLE IF NOT EXISTS guild_audit_log_configs (
  guild_id TEXT PRIMARY KEY NOT NULL,
  audit_channel_id TEXT NOT NULL DEFAULT '',
  event_states_json TEXT NOT NULL DEFAULT '{}',
  updated_at_ms INTEGER NOT NULL
, group_channel_ids_json TEXT NOT NULL DEFAULT '{}', excluded_channel_ids_json TEXT NOT NULL DEFAULT '[]', excluded_role_ids_json TEXT NOT NULL DEFAULT '[]');

CREATE TABLE IF NOT EXISTS guild_blocked_emojis (
  guild_id TEXT NOT NULL,
  normalized_emoji TEXT NOT NULL,
  PRIMARY KEY (guild_id, normalized_emoji)
);

CREATE TABLE IF NOT EXISTS guild_entitlements (
  guild_id TEXT PRIMARY KEY,
  tier TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
, plan TEXT);

CREATE TABLE IF NOT EXISTS guild_notification_channels (
  guild_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  notification_channel_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, feature)
);

CREATE TABLE IF NOT EXISTS guild_r2_objects (
  guild_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'committed', reserved_bytes INTEGER NOT NULL DEFAULT 0, reservation_expires_at_ms INTEGER, operation_key TEXT, updated_at_ms INTEGER NOT NULL DEFAULT 0, reconciliation_generation INTEGER, had_committed_object INTEGER NOT NULL DEFAULT 1, upload_started_at_ms INTEGER, tombstoned_at_ms INTEGER,
  PRIMARY KEY (guild_id, object_key)
);

CREATE TABLE IF NOT EXISTS guild_r2_reconciliation_state (
  bucket_id TEXT PRIMARY KEY NOT NULL,
  cursor TEXT,
  generation INTEGER NOT NULL DEFAULT 1,
  started_at_ms INTEGER,
  last_reconciled_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS guild_rbac_settings (
  guild_id TEXT PRIMARY KEY,
  guild_admin_role_id TEXT
);

CREATE TABLE IF NOT EXISTS guild_service_suspension_audit (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  actor_user_id TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS guild_service_suspensions (
  guild_id TEXT PRIMARY KEY NOT NULL,
  reason TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  created_by_user_id TEXT NOT NULL,
  removed_at_ms INTEGER,
  removed_by_user_id TEXT
);

CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id TEXT PRIMARY KEY,
  moderation_enabled INTEGER NOT NULL DEFAULT 1,
  channel_mode TEXT NOT NULL DEFAULT 'include',
  channel_ids_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS identity_patterns (
  id TEXT PRIMARY KEY NOT NULL,
  platform TEXT NOT NULL,
  pattern TEXT NOT NULL,
  capture_group INTEGER NOT NULL,
  position INTEGER NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS image_rules_configs (
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

CREATE TABLE IF NOT EXISTS image_rules_mod_queue_items (
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
);

CREATE TABLE IF NOT EXISTS "Invitation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT,
    "status" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "inviterId" TEXT NOT NULL,
    CONSTRAINT "Invitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS known_guilds (
  guild_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  member_count INTEGER NOT NULL DEFAULT 0,
  owner_id TEXT NOT NULL DEFAULT '',
  icon TEXT,
  installed_at_ms INTEGER NOT NULL,
  removed_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS legacy_paid_role_claims_archive (
  guild_id TEXT PRIMARY KEY NOT NULL,
  claimed_by_user_id TEXT NOT NULL,
  claimed_at_ms INTEGER NOT NULL,
  suspended_at_ms INTEGER,
  archived_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS lfg_applications (
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

CREATE TABLE IF NOT EXISTS lfg_configs (
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
, approval_flow_enabled INTEGER NOT NULL DEFAULT 0, approval_audit_channel_id TEXT, approval_voice_category_id TEXT, notice_color INTEGER NOT NULL DEFAULT 2829617);

CREATE TABLE IF NOT EXISTS lfg_posts (
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

CREATE TABLE IF NOT EXISTS lfg_voice_channels (
  guild_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (guild_id, post_id)
);

CREATE TABLE IF NOT EXISTS managed_message_audit_outbox (
  event_key TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  internal_name TEXT NOT NULL,
  claimed_at_ms INTEGER,
  delivered_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS managed_message_drafts (
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
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (guild_id, internal_name)
);

CREATE TABLE IF NOT EXISTS managed_messages (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  internal_name TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  embeds_json TEXT NOT NULL,
  announcement_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (guild_id, internal_name),
  UNIQUE (guild_id, channel_id, message_id)
);

CREATE TABLE IF NOT EXISTS marketplace_configs (
  guild_id TEXT PRIMARY KEY,
  notice_channel_id TEXT,
  notice_message_id TEXT,
  log_channel_id TEXT,
  server_options_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
, notice_embed_json TEXT NOT NULL DEFAULT '{"title":"💼 Marketplace Noticeboard","description":"Create a Marketplace Post. Click the button below to start.","color":3447003,"buttonLabel":"Create Marketplace Post","buttonEmoji":"💼"}', server_choice_enabled INTEGER NOT NULL DEFAULT 1, additional_choices_enabled INTEGER NOT NULL DEFAULT 0, additional_choices_json TEXT NOT NULL DEFAULT '[]', flow_updated_at_ms INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS marketplace_posts (
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

CREATE TABLE IF NOT EXISTS marketplace_trade_logs (
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

CREATE TABLE IF NOT EXISTS "Member" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL,
    CONSTRAINT "Member_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS member_verification_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  message_id TEXT,
  channel_id TEXT,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  used_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS member_verification_configs (
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

CREATE TABLE IF NOT EXISTS member_verification_states (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  verified_at_ms INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS mention_protection_action_outcomes (
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

CREATE TABLE IF NOT EXISTS mention_protection_breaches (
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

CREATE TABLE IF NOT EXISTS mention_protection_burst_events (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  message_timestamp_ms INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id, message_id)
);

CREATE TABLE IF NOT EXISTS mention_protection_configs (
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

CREATE TABLE IF NOT EXISTS mention_protection_escalations (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  protection TEXT NOT NULL,
  last_breach_at_ms INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id, protection)
);

CREATE TABLE IF NOT EXISTS message_templates (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  internal_name TEXT NOT NULL,
  embeds_json TEXT NOT NULL,
  available_for_ticket_replies INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS "Organization" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logo" TEXT,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_platform_links (
  state TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_steam_links (
  state TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_link_configs (
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
  updated_at_ms INTEGER NOT NULL DEFAULT 0, panel_color INTEGER,
  PRIMARY KEY (guild_id, platform)
);

CREATE TABLE IF NOT EXISTS platform_link_migration_reports (
  report_id TEXT PRIMARY KEY NOT NULL,
  generated_at_ms INTEGER NOT NULL,
  legacy_config_count INTEGER NOT NULL,
  platform_config_count INTEGER NOT NULL,
  legacy_pending_count INTEGER NOT NULL,
  platform_pending_count INTEGER NOT NULL,
  legacy_link_count INTEGER NOT NULL,
  platform_link_count INTEGER NOT NULL,
  missing_config_count INTEGER NOT NULL,
  missing_pending_count INTEGER NOT NULL,
  missing_link_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_links (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  platform_id TEXT NOT NULL,
  linked_at_ms INTEGER NOT NULL,
  manual INTEGER NOT NULL DEFAULT 0,
  actioned_by_user_id TEXT,
  metadata_json TEXT,
  PRIMARY KEY (guild_id, user_id, platform, platform_id)
);

CREATE TABLE IF NOT EXISTS player_count_servers (
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
, refresh_interval_minutes INTEGER NOT NULL DEFAULT 10, consecutive_failure_count INTEGER NOT NULL DEFAULT 0, last_error_message TEXT, last_error_at_ms INTEGER, alert_channel_id TEXT, failure_threshold INTEGER NOT NULL DEFAULT 3);

CREATE TABLE IF NOT EXISTS reaction_limit_breach_counters (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  breach_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS reaction_limit_configs (
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

CREATE TABLE IF NOT EXISTS reaction_limit_message_reaction_counts (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  reaction_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, channel_id, message_id)
);

CREATE TABLE IF NOT EXISTS reaction_limit_user_message_reaction_counts (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  reaction_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, channel_id, message_id, user_id)
);

CREATE TABLE IF NOT EXISTS "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "token" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS steam_link_configs (
  guild_id TEXT PRIMARY KEY,
  steam_linked_role_id TEXT,
  log_channel_id TEXT,
  game_app_ids_json TEXT NOT NULL DEFAULT '[]',
  panel_title TEXT NOT NULL DEFAULT 'Link your Steam account',
  panel_description TEXT NOT NULL DEFAULT 'Click the button below to securely link your Discord account to your Steam account.',
  panel_button_label TEXT NOT NULL DEFAULT 'Link Steam',
  panel_button_style TEXT NOT NULL DEFAULT 'Primary',
  allow_relink INTEGER NOT NULL DEFAULT 1,
  whois_fields_json TEXT NOT NULL DEFAULT '[]',
  updated_at_ms INTEGER NOT NULL DEFAULT 0,
  custom_links_json TEXT,
  panel_channel_id TEXT,
  panel_message_id TEXT
, allow_multiple_links INTEGER NOT NULL DEFAULT 0, panel_color INTEGER NOT NULL DEFAULT 5793266);

CREATE TABLE IF NOT EXISTS "steam_links" (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  steam_id64 TEXT NOT NULL,
  linked_at_ms INTEGER NOT NULL,
  manual INTEGER NOT NULL DEFAULT 0,
  actioned_by_user_id TEXT,
  game_ownership_json TEXT,
  PRIMARY KEY (guild_id, user_id, steam_id64)
);

CREATE TABLE IF NOT EXISTS ticket_counters (
  guild_id TEXT PRIMARY KEY,
  next_ticket_number INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ticket_instances (
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
  staff_thread_id TEXT, claimed_by_user_id TEXT, claimed_at_ms INTEGER, panel_id TEXT DEFAULT 'main',
  PRIMARY KEY (guild_id, channel_id)
);

CREATE TABLE IF NOT EXISTS "ticket_panels" (
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

CREATE TABLE IF NOT EXISTS ticket_staff_messages (
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

CREATE TABLE IF NOT EXISTS ticket_template_replies (
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

CREATE TABLE IF NOT EXISTS timed_role_config_rules (
  guild_id TEXT NOT NULL,
  config_type TEXT NOT NULL,
  role_id TEXT NOT NULL,
  duration_input TEXT NOT NULL,
  dm_message TEXT,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (guild_id, config_type, role_id)
);

CREATE TABLE IF NOT EXISTS timed_roles (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  duration_input TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL, target_display_name TEXT,
  PRIMARY KEY (guild_id, user_id, role_id)
);

CREATE TABLE IF NOT EXISTS "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL,
    "image" TEXT,
    "discordUserId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS user_preferences (
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

CREATE TABLE IF NOT EXISTS "Verification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME,
    "updatedAt" DATETIME
);

CREATE TABLE IF NOT EXISTS webhook_credentials (
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

CREATE TABLE IF NOT EXISTS webhook_proxy_configs (
  guild_id TEXT NOT NULL,
  public_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  destinations_json TEXT NOT NULL,
  default_destination_ids_json TEXT NOT NULL,
  routing_rules_json TEXT NOT NULL,
  content_replacements_json TEXT NOT NULL DEFAULT '[]',
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL, ban_lookup_enabled INTEGER NOT NULL DEFAULT 0, ban_lookup_notification_url TEXT, ban_lookup_app_ids_json TEXT NOT NULL DEFAULT '[]', destinations_v2_json TEXT, ban_lookup_credential_id TEXT, credential_migrated_at_ms INTEGER,
  PRIMARY KEY (guild_id, public_id)
);

CREATE TABLE IF NOT EXISTS webhook_proxy_forward_logs (
  guild_id TEXT NOT NULL,
  log_id TEXT NOT NULL,
  public_id TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  destination_url TEXT NOT NULL,
  status INTEGER,
  ok INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  error TEXT,
  timestamp_ms INTEGER NOT NULL, credential_fingerprint TEXT,
  PRIMARY KEY (guild_id, log_id)
);

CREATE TABLE IF NOT EXISTS white_label_bots (
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

CREATE TABLE IF NOT EXISTS "WorkspaceEntitlement" (
    "workspaceId" TEXT NOT NULL PRIMARY KEY,
    "plan" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "enabledFlagsJson" TEXT NOT NULL,
    "updatedAtMs" INTEGER NOT NULL,
    CONSTRAINT "WorkspaceEntitlement_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "WorkspaceGuild" (
    "workspaceId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "linkedByUserId" TEXT NOT NULL,
    "linkedAtMs" INTEGER NOT NULL,

    PRIMARY KEY ("workspaceId", "guildId"),
    CONSTRAINT "WorkspaceGuild_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS ban_case_sources_by_guild
  ON ban_case_sources (guild_id, updated_at_ms DESC);

CREATE UNIQUE INDEX IF NOT EXISTS ban_case_sources_public_id_unique
  ON ban_case_sources (public_id);

CREATE INDEX IF NOT EXISTS ban_cases_by_source
  ON ban_cases (guild_id, source_id);

CREATE UNIQUE INDEX IF NOT EXISTS ban_cases_subject_unique
  ON ban_cases (guild_id, subject_platform, subject_id);

CREATE INDEX IF NOT EXISTS billing_assignments_by_owner
  ON billing_guild_assignments(owner_id, assigned_at_ms);

CREATE INDEX IF NOT EXISTS billing_assignments_by_subscription
  ON billing_guild_assignments(stripe_subscription_id, assigned_at_ms);

CREATE INDEX IF NOT EXISTS billing_founder_places_by_awarded
  ON billing_founder_places(awarded_at_ms, stripe_subscription_id);

CREATE INDEX IF NOT EXISTS billing_operations_by_owner_created
  ON billing_operations_ledger(owner_id, created_at_ms DESC);

CREATE INDEX IF NOT EXISTS billing_webhooks_by_object
  ON billing_webhook_events(event_type, object_id, stripe_created_at_ms);

CREATE INDEX IF NOT EXISTS bot_defense_rate_window_by_guild_user_channel
  ON bot_defense_rate_window_events (guild_id, user_id, channel_id);

CREATE INDEX IF NOT EXISTS bot_defense_rate_window_by_guild_user_time
  ON bot_defense_rate_window_events (guild_id, user_id, message_timestamp_ms);

CREATE INDEX IF NOT EXISTS bot_defense_rate_window_by_message
  ON bot_defense_rate_window_events (
    guild_id,
    user_id,
    message_fingerprint,
    message_timestamp_ms,
    channel_id
  );

CREATE INDEX IF NOT EXISTS bot_flags_by_guild_status
  ON bot_flags (guild_id, status, created_at_ms);

CREATE INDEX IF NOT EXISTS clan_applications_due ON clan_applications (expires_at_ms) WHERE status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS clan_applications_one_pending ON clan_applications (clan_id, applicant_id) WHERE status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS clan_change_requests_one_pending_kind ON clan_change_requests (clan_id, kind) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS clan_history_by_clan ON clan_history (guild_id, clan_id, created_at_ms DESC);

CREATE INDEX IF NOT EXISTS clan_history_retention ON clan_history (retention_expires_at_ms);

CREATE INDEX IF NOT EXISTS clan_invitations_due ON clan_invitations (expires_at_ms) WHERE status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS clan_invitations_one_pending ON clan_invitations (clan_id, invitee_id) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS clan_membership_blocks_active ON clan_membership_blocks (clan_id, user_id, expires_at_ms) WHERE lifted_at_ms IS NULL;

CREATE INDEX IF NOT EXISTS clan_memberships_active_by_clan ON clan_memberships (clan_id, rank, joined_at_ms) WHERE left_at_ms IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS clan_memberships_one_active_per_guild ON clan_memberships (guild_id, user_id) WHERE left_at_ms IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS clan_memberships_one_owner ON clan_memberships (clan_id) WHERE rank = 'owner' AND left_at_ms IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS clan_ownership_transfers_one_pending ON clan_ownership_transfers (clan_id) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS clan_requests_by_guild_status ON clan_requests (guild_id, status, created_at_ms);

CREATE UNIQUE INDEX IF NOT EXISTS clan_requests_one_pending_per_member
  ON clan_requests (guild_id, requester_id)
  WHERE status IN ('pending', 'changes-requested');

CREATE INDEX IF NOT EXISTS clan_requests_retention ON clan_requests (retention_expires_at_ms) WHERE retention_expires_at_ms IS NOT NULL;

CREATE INDEX IF NOT EXISTS clan_requests_review_ticket_recovery
  ON clan_requests (review_ticket_state, updated_at_ms)
  WHERE review_ticket_state IN ('pending', 'creating', 'decision-pending');

CREATE INDEX IF NOT EXISTS clans_by_guild_lifecycle ON clans (guild_id, lifecycle_state, created_at_ms);

CREATE INDEX IF NOT EXISTS clans_due_deletion ON clans (deletion_due_at_ms) WHERE lifecycle_state = 'deletion-recovery';

CREATE INDEX IF NOT EXISTS clans_due_inactivity ON clans (latest_activity_at_ms) WHERE lifecycle_state = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS clans_unique_active_name ON clans (guild_id, normalized_name) WHERE lifecycle_state != 'permanently-deleted';

CREATE UNIQUE INDEX IF NOT EXISTS clans_unique_active_tag ON clans (guild_id, normalized_tag) WHERE lifecycle_state != 'permanently-deleted';

CREATE INDEX IF NOT EXISTS donor_claims_by_suspended_at
  ON donor_claims(suspended_at_ms);

CREATE INDEX IF NOT EXISTS donor_claims_by_user
  ON donor_claims(claimed_by_user_id);

CREATE INDEX IF NOT EXISTS event_signups_by_event
  ON event_signups (guild_id, event_id, status, created_at_ms);

CREATE INDEX IF NOT EXISTS event_signups_by_user
  ON event_signups (guild_id, event_id, user_id);

CREATE INDEX IF NOT EXISTS event_templates_by_guild_updated
  ON event_templates (guild_id, updated_at_ms DESC);

CREATE INDEX IF NOT EXISTS events_by_guild_status_start
  ON events (guild_id, status, starts_at_ms);

CREATE INDEX IF NOT EXISTS events_by_lifecycle_due
  ON events (status, starts_at_ms, ends_at_ms);

CREATE INDEX IF NOT EXISTS evidence_vault_records_guild_idx
  ON evidence_vault_records(guild_id, hidden_at_ms);

CREATE INDEX IF NOT EXISTS feature_setup_resolutions_by_resource
  ON feature_setup_resolutions (resource_id);

CREATE INDEX IF NOT EXISTS feature_setup_runs_by_feature
  ON feature_setup_runs (guild_id, feature_key, created_at_ms DESC);

CREATE UNIQUE INDEX IF NOT EXISTS feature_setup_runs_one_active
  ON feature_setup_runs (guild_id, feature_key)
  WHERE status IN ('planned', 'running', 'incomplete');

CREATE INDEX IF NOT EXISTS gateway_event_operations_by_completion
  ON gateway_event_operations (completed_at_ms)
  WHERE state IN ('completed', 'terminal');

CREATE INDEX IF NOT EXISTS gateway_reaction_limit_mutations_by_completion
  ON gateway_reaction_limit_mutations (created_at_ms)
  WHERE result_one IS NOT NULL;

CREATE INDEX IF NOT EXISTS guild_service_suspension_audit_by_guild
  ON guild_service_suspension_audit (guild_id, occurred_at_ms DESC);

CREATE INDEX IF NOT EXISTS guild_service_suspensions_active
  ON guild_service_suspensions (removed_at_ms, created_at_ms DESC);

CREATE INDEX IF NOT EXISTS identity_patterns_position_idx ON identity_patterns(position);

CREATE INDEX IF NOT EXISTS idx_guild_r2_objects_expiry
  ON guild_r2_objects(status, reservation_expires_at_ms);

CREATE INDEX IF NOT EXISTS idx_guild_r2_objects_guild
  ON guild_r2_objects(guild_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_guild_r2_objects_operation
  ON guild_r2_objects(operation_key)
  WHERE operation_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_staff_messages_lookup
  ON ticket_staff_messages(guild_id, ticket_channel_id, bot_message_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_messages_staff_lookup
  ON ticket_staff_messages(guild_id, staff_thread_id, staff_message_id);

CREATE INDEX IF NOT EXISTS image_rules_mod_queue_items_by_guild_status
ON image_rules_mod_queue_items (guild_id, status, created_at_ms);

CREATE UNIQUE INDEX IF NOT EXISTS image_rules_mod_queue_items_by_source_message
  ON image_rules_mod_queue_items (guild_id, channel_id, message_id);

CREATE INDEX IF NOT EXISTS lfg_applications_by_post_status
  ON lfg_applications(guild_id, post_id, status, created_at_ms DESC);

CREATE INDEX IF NOT EXISTS lfg_posts_by_expiry
  ON lfg_posts(active, expires_at_ms);

CREATE INDEX IF NOT EXISTS lfg_posts_by_guild_clan_active ON lfg_posts (guild_id, clan_id, active);

CREATE INDEX IF NOT EXISTS lfg_posts_by_owner_active
  ON lfg_posts(guild_id, owner_id, active);

CREATE INDEX IF NOT EXISTS lfg_voice_channels_by_channel
  ON lfg_voice_channels(channel_id);

CREATE UNIQUE INDEX IF NOT EXISTS managed_message_audit_outbox_by_canonical_message
  ON managed_message_audit_outbox (guild_id, channel_id, message_id);

CREATE INDEX IF NOT EXISTS managed_message_drafts_by_guild_updated
  ON managed_message_drafts (guild_id, updated_at_ms DESC);

CREATE INDEX IF NOT EXISTS managed_message_drafts_due
  ON managed_message_drafts (status, scheduled_at_ms);

CREATE INDEX IF NOT EXISTS managed_messages_by_guild_updated
  ON managed_messages (guild_id, updated_at_ms DESC);

CREATE INDEX IF NOT EXISTS marketplace_logs_by_timestamp
  ON marketplace_trade_logs(guild_id, timestamp_ms DESC);

CREATE INDEX IF NOT EXISTS marketplace_posts_by_owner_active
  ON marketplace_posts(guild_id, owner_id, active);

CREATE INDEX IF NOT EXISTS member_verification_attempts_by_expires
ON member_verification_attempts(expires_at_ms);

CREATE INDEX IF NOT EXISTS member_verification_attempts_by_guild_user
ON member_verification_attempts(guild_id, user_id);

CREATE INDEX IF NOT EXISTS member_verification_states_by_guild
  ON member_verification_states (guild_id, verified_at_ms DESC);

CREATE INDEX IF NOT EXISTS mention_protection_breaches_by_member
  ON mention_protection_breaches (guild_id, user_id, breached_at_ms);

CREATE INDEX IF NOT EXISTS mention_protection_burst_by_member_time
  ON mention_protection_burst_events (guild_id, user_id, message_timestamp_ms);

CREATE UNIQUE INDEX IF NOT EXISTS message_templates_by_guild_name
  ON message_templates (guild_id, internal_name);

CREATE INDEX IF NOT EXISTS message_templates_by_guild_updated
  ON message_templates (guild_id, updated_at_ms DESC);

CREATE UNIQUE INDEX IF NOT EXISTS "Organization_slug_key" ON "Organization"("slug");

CREATE UNIQUE INDEX IF NOT EXISTS platform_links_by_platform_id ON platform_links(guild_id, platform, platform_id);

CREATE INDEX IF NOT EXISTS platform_links_by_user ON platform_links(guild_id, user_id, platform);

CREATE INDEX IF NOT EXISTS player_count_servers_by_guild
  ON player_count_servers(guild_id);

CREATE INDEX IF NOT EXISTS player_count_servers_by_provider
  ON player_count_servers(provider, provider_server_id);

CREATE UNIQUE INDEX IF NOT EXISTS "Session_token_key" ON "Session"("token");

CREATE UNIQUE INDEX IF NOT EXISTS steam_links_by_steam_id ON steam_links(guild_id, steam_id64);

CREATE INDEX IF NOT EXISTS steam_links_by_user ON steam_links(guild_id, user_id);

CREATE INDEX IF NOT EXISTS ticket_instances_by_opener_opened_at
ON ticket_instances (guild_id, opener_user_id, opened_at_ms DESC);

CREATE INDEX IF NOT EXISTS ticket_instances_by_opener_status
  ON ticket_instances(guild_id, opener_user_id, status);

CREATE INDEX IF NOT EXISTS ticket_instances_by_status
  ON ticket_instances(guild_id, status, opened_at_ms DESC);

CREATE UNIQUE INDEX IF NOT EXISTS ticket_panels_unique_name ON ticket_panels (guild_id, panel_name);

CREATE INDEX IF NOT EXISTS ticket_template_replies_by_ticket
  ON ticket_template_replies (guild_id, ticket_channel_id, created_at_ms DESC);

CREATE INDEX IF NOT EXISTS timed_roles_by_expiry
  ON timed_roles(expires_at_ms ASC);

CREATE UNIQUE INDEX IF NOT EXISTS "User_discordUserId_key" ON "User"("discordUserId");

CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "User"("email");

CREATE INDEX IF NOT EXISTS webhook_credentials_guild_public_idx ON webhook_credentials(guild_id, public_id);

CREATE UNIQUE INDEX IF NOT EXISTS webhook_credentials_owner_unique
  ON webhook_credentials(guild_id, owner_kind, public_id, COALESCE(destination_id, ''));

CREATE INDEX IF NOT EXISTS webhook_proxy_configs_by_guild
  ON webhook_proxy_configs(guild_id, updated_at_ms DESC);

CREATE INDEX IF NOT EXISTS webhook_proxy_logs_by_webhook
  ON webhook_proxy_forward_logs(guild_id, public_id, timestamp_ms DESC);

CREATE INDEX IF NOT EXISTS white_label_bots_guild_idx ON white_label_bots (guild_id);

CREATE UNIQUE INDEX IF NOT EXISTS "WorkspaceGuild_guildId_key" ON "WorkspaceGuild"("guildId");

CREATE TRIGGER IF NOT EXISTS managed_message_deleted_out_of_band_outbox
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
