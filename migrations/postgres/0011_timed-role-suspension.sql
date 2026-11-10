ALTER TABLE timed_role_config_rules
  ADD COLUMN suspended_role_ids_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE timed_roles
  ADD COLUMN suspended_role_ids_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE timed_roles
  ADD COLUMN pending_suspension_role_ids_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE timed_roles
  ADD COLUMN removed_role_ids_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE timed_roles
  ADD COLUMN pending_restoration_role_ids_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE timed_roles
  ADD COLUMN restoration_started_at_ms BIGINT;

ALTER TABLE timed_roles
  ADD COLUMN target_role_removal_completed_at_ms BIGINT;
