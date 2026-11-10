-- hafbot:migration {"phase":"expand"}

ALTER TABLE reaction_limit_message_reaction_counts ADD COLUMN updated_at_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reaction_limit_user_message_reaction_counts ADD COLUMN updated_at_ms INTEGER NOT NULL DEFAULT 0;

CREATE INDEX reaction_limit_message_counts_updated_at
  ON reaction_limit_message_reaction_counts(updated_at_ms);
CREATE INDEX reaction_limit_user_message_counts_updated_at
  ON reaction_limit_user_message_reaction_counts(updated_at_ms);
