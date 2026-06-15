-- Cache opencode session metadata (and the messages of sessions you've opened) in D1, so the
-- dashboard is browsable with the Fly machine stopped. opencode remains the source of truth;
-- these are refreshed whenever the box is on. The box is never woken just to read the cache.

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  created_at TEXT,
  updated_at TEXT,
  data TEXT NOT NULL,        -- full opencode session JSON
  synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions (updated_at DESC);

CREATE TABLE IF NOT EXISTS session_messages (
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  data TEXT NOT NULL,        -- full { info, parts } JSON, as returned by opencode
  PRIMARY KEY (session_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_session_messages_order ON session_messages (session_id, idx);
