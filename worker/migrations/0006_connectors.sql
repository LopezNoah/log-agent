-- Connectors: BYOK credentials for LLM providers, GitHub, Fly.io, and notification sinks.
-- Secrets are AES-GCM encrypted (ciphertext + iv); non-secret settings live in `config` JSON.
-- This generalizes the old single-row `settings` table into a multi-connector model.
CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY,                 -- uuid
  type TEXT NOT NULL,                  -- 'llm' | 'github' | 'fly' | 'notification'
  provider TEXT NOT NULL,              -- 'anthropic'|'openai'|...|'github'|'fly'|'slack'|'discord'|'webhook'
  label TEXT,                          -- optional friendly name
  config TEXT,                         -- non-secret JSON (model, org slug, repo perms, vm size, ...)
  secret_ciphertext TEXT,              -- AES-GCM encrypted secret (api key / token / webhook url)
  secret_iv TEXT,
  secret_last4 TEXT,                   -- last 4 chars, for display only
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_connectors_type ON connectors (type, is_default DESC);

-- Carry over any existing single BYO key from `settings` as the default LLM connector. The
-- last4 can't be recovered without decrypting, so it stays NULL until the key is next edited.
INSERT OR IGNORE INTO connectors (id, type, provider, label, config, secret_ciphertext, secret_iv, secret_last4, is_default, created_at, updated_at)
SELECT 'llm-imported', 'llm', provider, 'Imported key', json_object('model', model),
       key_ciphertext, key_iv, NULL, 1, COALESCE(updated_at, datetime('now')), COALESCE(updated_at, datetime('now'))
FROM settings
WHERE id = 'default' AND provider IS NOT NULL AND key_ciphertext IS NOT NULL;
