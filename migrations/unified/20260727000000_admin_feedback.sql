-- hafbot:migration {"phase":"expand"}

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
);

CREATE INDEX admin_feedback_reporter_created ON admin_feedback (reporter_user_id, created_at_ms);
CREATE INDEX admin_feedback_created ON admin_feedback (created_at_ms);
CREATE INDEX admin_feedback_notification_state ON admin_feedback (notification_state);
