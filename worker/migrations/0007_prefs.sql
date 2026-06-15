-- Small key/value store for Worker-managed preferences pushed to the Fly box on start.
-- First use: a custom system prompt (AGENTS.md) override, so edits survive machine reboots
-- (the box writes a default AGENTS.md each boot; the Worker re-pushes the override after start).
CREATE TABLE IF NOT EXISTS prefs (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT
);
