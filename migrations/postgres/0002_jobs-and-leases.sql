CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  queue_name TEXT NOT NULL,
  dedupe_key TEXT,
  payload_json JSONB NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'running', 'completed', 'terminal')),
  available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 4 CHECK (max_attempts > 0),
  lease_owner TEXT,
  lease_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  terminal_reason_code TEXT,
  CONSTRAINT jobs_lease_shape CHECK (
    (state = 'running' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (state <> 'running' AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
  ),
  UNIQUE (queue_name, dedupe_key)
);

CREATE INDEX jobs_claim_idx
  ON jobs (queue_name, available_at, created_at)
  WHERE state = 'queued';

CREATE INDEX jobs_expired_lease_idx
  ON jobs (lease_expires_at)
  WHERE state = 'running';

CREATE INDEX jobs_terminal_inspection_idx
  ON jobs (queue_name, updated_at DESC)
  WHERE state = 'terminal';

CREATE TABLE scheduler_leases (
  name TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  fencing_generation BIGINT NOT NULL CHECK (fencing_generation > 0),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE scheduler_task_state (
  name TEXT PRIMARY KEY,
  last_started_at TIMESTAMPTZ,
  last_completed_at TIMESTAMPTZ,
  last_outcome TEXT,
  last_lease_generation BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
