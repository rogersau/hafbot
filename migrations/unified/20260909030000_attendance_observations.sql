-- hafbot:migration {"phase":"expand"}
CREATE TABLE attendance_observation_runs (
 id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, target_id TEXT NOT NULL, generation INTEGER NOT NULL,
 active_target TEXT UNIQUE, revision INTEGER NOT NULL, lease TEXT, next_at_ms INTEGER NOT NULL,
 expires_at_ms INTEGER NOT NULL, delete_at_ms INTEGER NOT NULL, duplicates INTEGER NOT NULL DEFAULT 0,
 late INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL
);
CREATE INDEX attendance_observation_due ON attendance_observation_runs(active_target,next_at_ms);
CREATE INDEX attendance_observation_guild ON attendance_observation_runs(guild_id);
CREATE TABLE attendance_observation_samples (
 id TEXT PRIMARY KEY,run_id TEXT NOT NULL,guild_id TEXT NOT NULL,target_id TEXT NOT NULL,
 generation INTEGER NOT NULL,slot INTEGER NOT NULL,claim_token TEXT NOT NULL,next_allowed_at_ms INTEGER NOT NULL,delete_at_ms INTEGER NOT NULL,data TEXT NOT NULL,
 UNIQUE(target_id,generation,slot)
);
CREATE INDEX attendance_observation_samples_run ON attendance_observation_samples(run_id,slot);
CREATE INDEX attendance_observation_samples_guild ON attendance_observation_samples(guild_id);
CREATE INDEX attendance_observation_samples_expiry ON attendance_observation_samples(delete_at_ms);
CREATE TABLE attendance_observation_reports (id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,data TEXT NOT NULL);
CREATE INDEX attendance_observation_reports_guild ON attendance_observation_reports(guild_id);
