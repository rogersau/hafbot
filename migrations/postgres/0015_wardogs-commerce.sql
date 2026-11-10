-- hafbot:migration {"phase":"expand"}
ALTER TABLE commerce_checkout_attempts ADD COLUMN provider_terminal_at_ms BIGINT;
ALTER TABLE commerce_checkout_attempts ADD COLUMN pre_session_failed_at_ms BIGINT;
ALTER TABLE commerce_subscriptions ADD COLUMN checkout_attempt_id TEXT;
CREATE TABLE commerce_game_fulfillments (offering_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, target_id TEXT NOT NULL, physical_target TEXT NOT NULL, origin TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE commerce_game_selections (checkout_id TEXT PRIMARY KEY, offering_id TEXT NOT NULL, buyer_id TEXT NOT NULL, assignment_id TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX commerce_game_selection_assignment ON commerce_game_selections(assignment_id);
CREATE TABLE commerce_game_assignments (
 id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
 physical_target TEXT NOT NULL, subject TEXT NOT NULL, slot INTEGER,
 generation INTEGER NOT NULL, revision INTEGER NOT NULL, next_at_ms BIGINT NOT NULL, data TEXT NOT NULL,
 UNIQUE(physical_target, subject), UNIQUE(physical_target, slot)
);
CREATE INDEX commerce_game_due ON commerce_game_assignments(next_at_ms);
CREATE INDEX commerce_game_guild ON commerce_game_assignments(guild_id);
CREATE TABLE commerce_game_audit(id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,created_at_ms BIGINT NOT NULL,data TEXT NOT NULL);
CREATE INDEX commerce_game_audit_guild ON commerce_game_audit(guild_id,created_at_ms);
