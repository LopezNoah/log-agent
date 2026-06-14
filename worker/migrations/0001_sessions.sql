CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('starting', 'running', 'complete', 'failed', 'stopped')),
  title TEXT,
  fly_app_name TEXT NOT NULL,
  fly_machine_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  stopped_at TEXT,
  last_seen_at TEXT,
  last_status_at TEXT,
  last_error TEXT,
  exit_code INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sessions_state_updated_at ON sessions (state, updated_at);
