-- opencode now owns sessions and message history (via `opencode serve`), so the Worker no
-- longer mirrors chat into D1. Drop the old tables and keep only what the Worker needs:
-- a single-row activity timestamp for idle-stop, and an encrypted BYO key (Phase 2).

DROP TABLE IF EXISTS session_messages;
DROP TABLE IF EXISTS sessions;

CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  last_active_at TEXT NOT NULL
);

-- Phase 2: bring-your-own provider key, stored encrypted (AES-GCM). The plaintext key is
-- never persisted on the Fly box; the Worker decrypts in memory and pushes it to opencode
-- via PUT /auth/:provider when a session needs it.
CREATE TABLE IF NOT EXISTS settings (
  id TEXT PRIMARY KEY,
  provider TEXT,
  key_ciphertext TEXT,
  key_iv TEXT,
  updated_at TEXT
);
