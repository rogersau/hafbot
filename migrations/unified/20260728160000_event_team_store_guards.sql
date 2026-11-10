-- hafbot:migration {"phase":"data","previousWorkerCompatible":true}

-- Monotonic fences let transactional writes reject roster changes that happened
-- after a service built a bulk allocation or start snapshot.
CREATE TABLE event_team_state_versions (
  guild_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, event_id)
);

INSERT INTO event_team_state_versions (guild_id, event_id, version)
SELECT guild_id, event_id, 0 FROM events;

-- Guard rows live only for a D1 batch. Triggers on these new tables convert a
-- failed predicate into a transaction-aborting error.
CREATE TABLE event_team_proposal_acceptance_guards (
  guild_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  expected_updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (guild_id, event_id, proposal_id)
);

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

CREATE TABLE event_team_bulk_commit_guards (
  guard_id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  expected_state_version INTEGER NOT NULL
);

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

CREATE TABLE event_lifecycle_transition_guards (
  guard_id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  expected_status TEXT NOT NULL,
  expected_state_version INTEGER NOT NULL
);

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

CREATE TABLE event_signup_mutation_guards (
  guard_id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete'))
);

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
