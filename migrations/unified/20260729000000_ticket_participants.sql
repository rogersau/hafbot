-- hafbot:migration {"phase":"expand"}

CREATE TABLE ticket_participants (
  guild_id TEXT NOT NULL,
  ticket_channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  added_event_id TEXT NOT NULL,
  added_by_user_id TEXT NOT NULL,
  added_at_ms INTEGER NOT NULL,
  PRIMARY KEY (guild_id, ticket_channel_id, user_id)
);

CREATE INDEX ticket_participants_by_user
  ON ticket_participants (guild_id, user_id);

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

CREATE INDEX ticket_participant_events_by_ticket
  ON ticket_participant_events (guild_id, ticket_channel_id, created_at_ms);
