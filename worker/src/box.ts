import type { Env } from "./env";
import { upstreamHeaders } from "./fly";
import { decryptSecret } from "./crypto";

// ---------------------------------------------------------------------------
// Credentials & config pushed to the Fly box at runtime. Secrets live encrypted in D1 and are
// decrypted here in memory, then sent to the box's control server — never written to its disk
// by us (the box persists only what it needs for git/gh auth). Everything is best-effort: a
// stopped or unhealthy box just means we retry on the next start.
// ---------------------------------------------------------------------------

interface ConnectorRow {
  provider: string;
  config: string | null;
  secret_ciphertext: string | null;
  secret_iv: string | null;
}

async function defaultConnector(env: Env, type: string): Promise<ConnectorRow | null> {
  return env.DB.prepare(
    "SELECT provider, config, secret_ciphertext, secret_iv FROM connectors WHERE type = ? AND is_default = 1 LIMIT 1",
  )
    .bind(type)
    .first<ConnectorRow>();
}

function parseConfig(row: ConnectorRow | null): Record<string, unknown> {
  if (!row?.config) return {};
  try {
    const v = JSON.parse(row.config);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

async function boxFetch(env: Env, path: string, body: unknown): Promise<boolean> {
  const headers = upstreamHeaders(env);
  headers.set("Content-Type", "application/json");
  const res = await fetch(new URL(path, env.FLY_BASE_URL), {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return true;
}

// Default LLM key → opencode's auth store (so sessions can use the provider). opencode cannot use
// the ChatGPT-subscription connector (it's an encrypted OAuth bundle consumed worker-side by
// resolveModel, not an API key), so we explicitly pick the best NON-chatgpt LLM connector — the
// default one if it's pushable, else the newest key-bearing one. If only the chatgpt connector
// exists we push nothing and opencode falls back to its own configured provider (e.g. Ollama).
export async function pushLlmCredential(env: Env): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT provider, config, secret_ciphertext, secret_iv FROM connectors
     WHERE type = 'llm' AND provider != 'openai-chatgpt' AND secret_ciphertext IS NOT NULL AND secret_iv IS NOT NULL
     ORDER BY is_default DESC, updated_at DESC LIMIT 1`,
  ).first<ConnectorRow>();
  if (!row?.secret_ciphertext || !row.secret_iv) return;
  const key = await decryptSecret(env, row.secret_ciphertext, row.secret_iv);
  await boxFetch(env, `/opencode/auth/${encodeURIComponent(row.provider)}`, { type: "api", key });
}

// Default GitHub PAT → box git credential store + gh CLI auth (so the agent can clone/push and
// run `gh issue create`, etc.).
export async function pushGithubCredential(env: Env): Promise<void> {
  const row = await defaultConnector(env, "github");
  if (!row?.secret_ciphertext || !row.secret_iv) return;
  const token = await decryptSecret(env, row.secret_ciphertext, row.secret_iv);
  const username = (parseConfig(row).username as string) || "";
  await boxFetch(env, "/github/auth", { token, username });
}

// Custom system prompt (AGENTS.md) override, if the user set one.
export async function pushSystemPrompt(env: Env): Promise<void> {
  const content = await getSystemPromptOverride(env);
  if (content == null) return;
  await boxFetch(env, "/agents", { content });
}

// Push everything the box needs after it comes up. Best-effort; failures are swallowed so one
// missing credential never blocks the others.
export async function pushAllToBox(env: Env): Promise<void> {
  await Promise.allSettled([pushLlmCredential(env), pushGithubCredential(env), pushSystemPrompt(env)]);
}

// ---- system prompt override storage (D1 prefs) ----

const SYSTEM_PROMPT_KEY = "system_prompt";

export async function getSystemPromptOverride(env: Env): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM prefs WHERE key = ?")
    .bind(SYSTEM_PROMPT_KEY)
    .first<{ value: string | null }>();
  return row?.value ?? null;
}

export async function setSystemPromptOverride(env: Env, value: string | null): Promise<void> {
  if (value == null) {
    await env.DB.prepare("DELETE FROM prefs WHERE key = ?").bind(SYSTEM_PROMPT_KEY).run();
    return;
  }
  await env.DB.prepare(
    `INSERT INTO prefs (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(SYSTEM_PROMPT_KEY, value, new Date().toISOString())
    .run();
}
