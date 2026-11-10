-- hafbot:migration {"phase":"expand"}

ALTER TABLE event_templates
ADD COLUMN participation_mode TEXT NOT NULL
CHECK (participation_mode IN ('individual', 'team')) DEFAULT 'individual';

ALTER TABLE event_templates
ADD COLUMN required_team_size INTEGER
CHECK (required_team_size IS NULL OR required_team_size BETWEEN 2 AND 50);

ALTER TABLE events
ADD COLUMN participation_mode TEXT NOT NULL
CHECK (participation_mode IN ('individual', 'team')) DEFAULT 'individual';

ALTER TABLE events
ADD COLUMN required_team_size INTEGER
CHECK (required_team_size IS NULL OR required_team_size BETWEEN 2 AND 50);

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

CREATE UNIQUE INDEX event_teams_name_unique
ON event_teams (guild_id, event_id, normalized_name);

CREATE INDEX event_teams_by_event_group
ON event_teams (guild_id, event_id, group_id);

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

CREATE UNIQUE INDEX event_team_memberships_active_user_unique
ON event_team_memberships (guild_id, event_id, user_id)
WHERE left_at_ms IS NULL;

CREATE INDEX event_team_memberships_by_team
ON event_team_memberships (guild_id, event_id, team_id, left_at_ms);

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

CREATE INDEX event_team_proposals_by_event_status
ON event_team_proposals (guild_id, event_id, status, created_at_ms);
CREATE INDEX event_team_proposals_by_team
ON event_team_proposals (guild_id, event_id, team_id);
CREATE UNIQUE INDEX event_team_proposals_pending_join_unique
ON event_team_proposals (guild_id, event_id, requester_user_id)
WHERE kind = 'join_request' AND status = 'pending';
CREATE UNIQUE INDEX event_team_proposals_pending_invite_unique
ON event_team_proposals (guild_id, event_id, team_id, target_user_id)
WHERE kind = 'invitation' AND status = 'pending';

CREATE TABLE event_team_invitation_blocks (
  guild_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (guild_id, event_id, team_id, user_id)
);
CREATE INDEX event_team_invitation_blocks_by_event_user
ON event_team_invitation_blocks (guild_id, event_id, user_id);

-- Event Team operations remain queryable after the current roster changes. These records are
-- append-only at the store boundary; no update path is exposed for audit or start snapshots.
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
CREATE INDEX event_team_audit_by_event_time
ON event_team_audit_records (guild_id, event_id, occurred_at_ms DESC);

CREATE TABLE event_team_roster_snapshots (
  guild_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  required_team_size INTEGER NOT NULL,
  members_json TEXT NOT NULL,
  captured_at_ms INTEGER NOT NULL,
  PRIMARY KEY (guild_id, event_id, team_id)
);
CREATE INDEX event_team_roster_snapshots_by_event
ON event_team_roster_snapshots (guild_id, event_id);

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
CREATE INDEX event_team_delivery_outbox_due
ON event_team_delivery_outbox (guild_id, event_id, status, next_attempt_at_ms);
CREATE INDEX event_team_delivery_outbox_global_due
ON event_team_delivery_outbox (status, next_attempt_at_ms);

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
CREATE INDEX event_lifecycle_history_by_event
ON event_lifecycle_history (guild_id, event_id, occurred_at_ms DESC);
CREATE INDEX event_lifecycle_history_retention
ON event_lifecycle_history (retention_expires_at_ms);
