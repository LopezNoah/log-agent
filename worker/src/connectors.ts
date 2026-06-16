import type { Hono } from "hono";
import type { Env } from "./env";
import { decryptSecret, encryptSecret } from "./crypto";
import { isMachineStarted } from "./fly";
import { pushGithubCredential, pushLlmCredential } from "./box";

// After saving an LLM/GitHub connector, push it to the box if it's up, so the credential applies
// without a restart. Best-effort and backgrounded via waitUntil — never blocks the response.
async function syncToBox(env: Env, type: string): Promise<void> {
  try {
    if (!(await isMachineStarted(env))) return;
    if (type === "llm") await pushLlmCredential(env);
    else if (type === "github") await pushGithubCredential(env);
  } catch {
    /* box unreachable — it'll sync on next machine start */
  }
}

// ---------------------------------------------------------------------------
// Connectors: bring-your-own credentials for LLM providers, GitHub, Fly.io, and
// notification sinks. Secrets are AES-GCM encrypted at rest; the API never returns
// plaintext (only the last 4 chars, for display). Non-secret config is plain JSON.
// ---------------------------------------------------------------------------

type ConnectorType = "llm" | "github" | "fly" | "notification";

const PROVIDERS: Record<ConnectorType, string[]> = {
  // "openai-chatgpt" is connected via the OAuth device-flow endpoints, not the manual POST form,
  // but it's listed here so listing/PATCH/default validation accept it.
  llm: ["anthropic", "openai", "openrouter", "google", "groq", "openai-chatgpt"],
  github: ["github"],
  fly: ["fly"],
  notification: ["slack", "discord", "webhook"],
};

// Whether a connector of this type must carry a secret to be valid. Notifications keep the
// webhook URL as their secret; Fly/GitHub need a token; LLM needs an API key.
const SECRET_REQUIRED: Record<ConnectorType, boolean> = { llm: true, github: true, fly: true, notification: true };

interface ConnectorRow {
  id: string;
  type: string;
  provider: string;
  label: string | null;
  config: string | null;
  secret_ciphertext: string | null;
  secret_iv: string | null;
  secret_last4: string | null;
  is_default: number;
  created_at: string;
  updated_at: string;
}

function isType(t: string): t is ConnectorType {
  return t === "llm" || t === "github" || t === "fly" || t === "notification";
}

function serialize(row: ConnectorRow) {
  return {
    id: row.id,
    type: row.type,
    provider: row.provider,
    label: row.label,
    config: row.config ? safeParse(row.config) : {},
    hasSecret: !!row.secret_ciphertext,
    secretLast4: row.secret_last4,
    isDefault: !!row.is_default,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function last4(secret: string): string {
  return secret.length <= 4 ? secret : secret.slice(-4);
}

function isoNow(): string {
  return new Date().toISOString();
}

async function getRow(env: Env, id: string): Promise<ConnectorRow | null> {
  return env.DB.prepare("SELECT * FROM connectors WHERE id = ?").bind(id).first<ConnectorRow>();
}

// ---------------------------------------------------------------- routes

export function registerConnectorRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get("/api/connectors", async (c) => {
    const { results } = await c.env.DB.prepare(
      "SELECT * FROM connectors ORDER BY type, is_default DESC, updated_at DESC",
    ).all<ConnectorRow>();
    // `env` surfaces deployment-level credentials the UI should reflect but can't read back —
    // notably the Fly token, which powers machine start/stop today (see fly.ts).
    return c.json({
      connectors: (results || []).map(serialize),
      env: { flyToken: !!c.env.FLY_API_TOKEN, flyOrgSlug: c.env.FLY_ORG_SLUG || null },
    });
  });

  app.post("/api/connectors", async (c) => {
    if (!c.env.SETTINGS_ENC_KEY) return c.json({ error: "encryption_key_not_configured" }, 500);
    const body = (await c.req.json().catch(() => ({}))) as {
      type?: string; provider?: string; label?: string; config?: Record<string, unknown>; secret?: string;
    };
    const type = String(body.type || "");
    const provider = String(body.provider || "").trim();
    if (!isType(type)) return c.json({ error: "invalid_type" }, 400);
    if (!PROVIDERS[type].includes(provider)) return c.json({ error: "invalid_provider" }, 400);

    const secret = (body.secret || "").trim();
    if (SECRET_REQUIRED[type] && !secret) return c.json({ error: "missing_secret" }, 400);

    let cipher: { ct: string; iv: string } | null = null;
    if (secret) cipher = await encryptSecret(c.env, secret);

    const id = crypto.randomUUID();
    const now = isoNow();
    // First connector of a type becomes the default automatically.
    const existing = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM connectors WHERE type = ?").bind(type).first<{ n: number }>();
    const isDefault = (existing?.n || 0) === 0 ? 1 : 0;

    await c.env.DB.prepare(
      `INSERT INTO connectors (id, type, provider, label, config, secret_ciphertext, secret_iv, secret_last4, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, type, provider, body.label?.trim() || null, JSON.stringify(body.config || {}),
        cipher?.ct ?? null, cipher?.iv ?? null, secret ? last4(secret) : null, isDefault, now, now)
      .run();

    c.executionCtx.waitUntil(syncToBox(c.env, type));
    return c.json({ connector: serialize((await getRow(c.env, id))!) });
  });

  app.patch("/api/connectors/:id", async (c) => {
    if (!c.env.SETTINGS_ENC_KEY) return c.json({ error: "encryption_key_not_configured" }, 500);
    const row = await getRow(c.env, c.req.param("id"));
    if (!row) return c.json({ error: "not_found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      provider?: string; label?: string; config?: Record<string, unknown>; secret?: string;
    };

    const provider = body.provider != null ? String(body.provider).trim() : row.provider;
    if (!PROVIDERS[row.type as ConnectorType].includes(provider)) return c.json({ error: "invalid_provider" }, 400);

    let ct = row.secret_ciphertext;
    let iv = row.secret_iv;
    let l4 = row.secret_last4;
    // Only rotate the secret when a non-empty one is supplied; otherwise keep the stored one.
    const secret = body.secret != null ? String(body.secret).trim() : "";
    if (secret) {
      const cipher = await encryptSecret(c.env, secret);
      ct = cipher.ct;
      iv = cipher.iv;
      l4 = last4(secret);
    }

    const config = body.config != null ? JSON.stringify(body.config) : row.config;
    const label = body.label != null ? (body.label.trim() || null) : row.label;

    await c.env.DB.prepare(
      `UPDATE connectors SET provider = ?, label = ?, config = ?, secret_ciphertext = ?, secret_iv = ?, secret_last4 = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(provider, label, config, ct, iv, l4, isoNow(), row.id)
      .run();

    c.executionCtx.waitUntil(syncToBox(c.env, row.type));
    return c.json({ connector: serialize((await getRow(c.env, row.id))!) });
  });

  app.delete("/api/connectors/:id", async (c) => {
    const row = await getRow(c.env, c.req.param("id"));
    if (!row) return c.json({ error: "not_found" }, 404);
    await c.env.DB.prepare("DELETE FROM connectors WHERE id = ?").bind(row.id).run();
    // If we removed the default, promote the most recently updated sibling.
    if (row.is_default) {
      const next = await c.env.DB.prepare(
        "SELECT id FROM connectors WHERE type = ? ORDER BY updated_at DESC LIMIT 1",
      ).bind(row.type).first<{ id: string }>();
      if (next) await c.env.DB.prepare("UPDATE connectors SET is_default = 1 WHERE id = ?").bind(next.id).run();
    }
    return c.json({ ok: true });
  });

  // Mark a connector as the default for its type (e.g. which LLM key sessions use).
  app.post("/api/connectors/:id/default", async (c) => {
    const row = await getRow(c.env, c.req.param("id"));
    if (!row) return c.json({ error: "not_found" }, 404);
    await c.env.DB.prepare("UPDATE connectors SET is_default = 0 WHERE type = ?").bind(row.type).run();
    await c.env.DB.prepare("UPDATE connectors SET is_default = 1 WHERE id = ?").bind(row.id).run();
    c.executionCtx.waitUntil(syncToBox(c.env, row.type));
    return c.json({ ok: true });
  });

  // Fire a test notification through a stored notification connector.
  app.post("/api/connectors/:id/test", async (c) => {
    const row = await getRow(c.env, c.req.param("id"));
    if (!row || row.type !== "notification") return c.json({ error: "not_found" }, 404);
    if (!row.secret_ciphertext || !row.secret_iv) return c.json({ error: "missing_secret" }, 400);
    const url = await decryptSecret(c.env, row.secret_ciphertext, row.secret_iv);
    const ok = await postNotification(row.provider, url, "✅ opencode phone test notification").catch(() => false);
    return c.json({ ok });
  });
}

// ---------------------------------------------------------------- ChatGPT OAuth connector

// The ChatGPT-subscription connector stores the OAuth bundle (access/refresh/expires/accountId)
// as its encrypted secret (JSON → encryptSecret), with provider "openai-chatgpt" and config
// { model }. resolveModel (provider.ts) reads it back and drives the codex fetch wrapper.
export const OPENAI_CHATGPT_PROVIDER = "openai-chatgpt";
// Codex-backend models available to ChatGPT subscribers (per opencode's ALLOWED_MODELS). The client
// can pick any of these per request; this is the fallback when none is chosen.
export const DEFAULT_CHATGPT_MODEL = "gpt-5.5";
export const CHATGPT_MODELS = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"];

interface ChatGptBundle {
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
}

// Find the openai-chatgpt LLM connector row, if one exists.
async function getChatGptRow(env: Env): Promise<ConnectorRow | null> {
  return env.DB.prepare(
    "SELECT * FROM connectors WHERE type = 'llm' AND provider = ? LIMIT 1",
  )
    .bind(OPENAI_CHATGPT_PROVIDER)
    .first<ConnectorRow>();
}

// Upsert the ChatGPT OAuth connector after a successful device-flow connect. Encrypts the bundle
// and makes it the default LLM connector (so sessions use it immediately).
export async function storeChatGptConnector(env: Env, bundle: ChatGptBundle, model?: string): Promise<void> {
  const cipher = await encryptSecret(env, JSON.stringify(bundle));
  const now = isoNow();
  const existing = await getChatGptRow(env);
  // Clear other defaults of this type first; this connector becomes the default.
  await env.DB.prepare("UPDATE connectors SET is_default = 0 WHERE type = 'llm'").run();

  if (existing) {
    const config = JSON.stringify({ model: model || (parseConfigOf(existing).model as string) || DEFAULT_CHATGPT_MODEL });
    await env.DB.prepare(
      `UPDATE connectors SET config = ?, secret_ciphertext = ?, secret_iv = ?, secret_last4 = ?, is_default = 1, updated_at = ?
       WHERE id = ?`,
    )
      .bind(config, cipher.ct, cipher.iv, last4(bundle.access), now, existing.id)
      .run();
    return;
  }

  await env.DB.prepare(
    `INSERT INTO connectors (id, type, provider, label, config, secret_ciphertext, secret_iv, secret_last4, is_default, created_at, updated_at)
     VALUES (?, 'llm', ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      OPENAI_CHATGPT_PROVIDER,
      "ChatGPT subscription",
      JSON.stringify({ model: model || DEFAULT_CHATGPT_MODEL }),
      cipher.ct,
      cipher.iv,
      last4(bundle.access),
      now,
      now,
    )
    .run();
}

// Read + decrypt the stored ChatGPT OAuth bundle. Throws if absent/corrupt.
export async function readChatGptBundle(env: Env): Promise<ChatGptBundle> {
  const row = await getChatGptRow(env);
  if (!row?.secret_ciphertext || !row.secret_iv) throw new Error("chatgpt_connector_missing");
  const json = await decryptSecret(env, row.secret_ciphertext, row.secret_iv);
  const bundle = JSON.parse(json) as ChatGptBundle;
  if (!bundle || typeof bundle.access !== "string") throw new Error("chatgpt_bundle_corrupt");
  return bundle;
}

// Re-encrypt + persist a refreshed ChatGPT OAuth bundle (used by the codex fetch wrapper on
// token refresh). Updates last4 to the new access token; leaves config/default flag untouched.
export async function updateChatGptBundle(env: Env, bundle: ChatGptBundle): Promise<void> {
  const row = await getChatGptRow(env);
  if (!row) throw new Error("chatgpt_connector_missing");
  const cipher = await encryptSecret(env, JSON.stringify(bundle));
  await env.DB.prepare(
    "UPDATE connectors SET secret_ciphertext = ?, secret_iv = ?, secret_last4 = ?, updated_at = ? WHERE id = ?",
  )
    .bind(cipher.ct, cipher.iv, last4(bundle.access), isoNow(), row.id)
    .run();
}

function parseConfigOf(row: ConnectorRow): Record<string, unknown> {
  return row.config ? safeParse(row.config) : {};
}

// ---------------------------------------------------------------- helpers used by the Worker

// Fan a message out to every stored notification connector (Slack/Discord/webhook).
export async function fanOutNotification(env: Env, text: string): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM connectors WHERE type = 'notification'",
  ).all<ConnectorRow>();
  await Promise.all(
    (results || []).map(async (row) => {
      if (!row.secret_ciphertext || !row.secret_iv) return;
      const url = await decryptSecret(env, row.secret_ciphertext, row.secret_iv).catch(() => null);
      if (url) await postNotification(row.provider, url, text).catch(() => {});
    }),
  );
}

// Each sink wants a slightly different JSON body for the same webhook-style POST.
async function postNotification(provider: string, url: string, text: string): Promise<boolean> {
  const body =
    provider === "slack" ? { text } :
    provider === "discord" ? { content: text } :
    { text };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.ok;
}
