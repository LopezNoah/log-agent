import { Hono } from "hono";
import type { Env } from "./env";
import {
  ensureFlyMachineStarted,
  ensureFlyMachineStopped,
  flyMachineStatus,
  upstreamHeaders,
} from "./fly";

export { SyncHub } from "./sync-hub";

const START_WAIT_MS = 45_000;
const HEALTH_POLL_MS = 1_500;

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Auth (Basic) on everything
// ---------------------------------------------------------------------------

app.use("*", async (c, next) => {
  if (!isAuthorized(c.req.raw, c.env)) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="opencode-phone"' },
    });
  }
  await next();
});

function isAuthorized(request: Request, env: Env): boolean {
  if (!env.CONTROL_PASSWORD) return false;
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Basic ")) return false;
  try {
    const decoded = atob(header.slice("Basic ".length));
    const sep = decoded.indexOf(":");
    return (sep === -1 ? decoded : decoded.slice(sep + 1)) === env.CONTROL_PASSWORD;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Sync WebSocket -> the SyncHub Durable Object
// ---------------------------------------------------------------------------

app.get("/sync", (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") return c.text("expected websocket", 426);
  return c.env.SYNC.getByName("hub").fetch(c.req.raw);
});

// ---------------------------------------------------------------------------
// Transparent proxy to the Fly box (REST mutations, terminal, WS)
// ---------------------------------------------------------------------------

const proxy = (c: any) => {
  c.executionCtx.waitUntil(touchActivity(c.env));
  return proxyToFly(c.req.raw, c.env);
};
app.all("/opencode", proxy);
app.all("/opencode/*", proxy);
app.all("/terminal", proxy);
app.all("/terminal/*", proxy);

// ---------------------------------------------------------------------------
// Machine lifecycle
// ---------------------------------------------------------------------------

app.get("/api/machine", async (c) => {
  const machine = await flyMachineStatus(c.env).catch((e) => ({ state: "unknown", error: stringifyError(e) }));
  return c.json({ machine });
});

app.post("/api/machine/start", async (c) => {
  await ensureFlyMachineStarted(c.env);
  await touchActivity(c.env);
  if (await waitForHealth(c.env)) await pushCredential(c.env).catch(() => {});
  return c.json({ ok: true });
});

app.post("/api/machine/stop", async (c) => {
  await ensureFlyMachineStopped(c.env);
  await notify(c.env, "opencode-phone machine stopped from the UI");
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Settings: bring-your-own provider key (AES-GCM at rest)
// ---------------------------------------------------------------------------

app.get("/api/settings", async (c) => {
  const row = await readSettings(c.env);
  return c.json({ provider: row?.provider || null, model: row?.model || null, hasKey: !!row?.key_ciphertext });
});

app.post("/api/settings", async (c) => {
  if (!c.env.SETTINGS_ENC_KEY) return c.json({ error: "encryption_key_not_configured" }, 500);
  const body = (await c.req.json().catch(() => ({}))) as { provider?: string; apiKey?: string; model?: string };
  const provider = (body.provider || "").trim();
  const apiKey = (body.apiKey || "").trim();
  const model = (body.model || "").trim() || null;
  if (!provider || !apiKey) return c.json({ error: "missing_provider_or_key" }, 400);

  const { ct, iv } = await encryptSecret(c.env, apiKey);
  await c.env.DB.prepare(
    `INSERT INTO settings (id, provider, model, key_ciphertext, key_iv, updated_at)
     VALUES ('default', ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, model = excluded.model,
       key_ciphertext = excluded.key_ciphertext, key_iv = excluded.key_iv, updated_at = excluded.updated_at`,
  )
    .bind(provider, model, ct, iv, isoNow())
    .run();

  const pushed = await pushCredential(c.env).then(() => true).catch(() => false);
  return c.json({ ok: true, provider, model, hasKey: true, pushedToMachine: pushed });
});

app.delete("/api/settings", async (c) => {
  await c.env.DB.prepare("DELETE FROM settings WHERE id = 'default'").run();
  return c.json({ ok: true });
});

// Unmatched API routes are 404 JSON; everything else is the static SPA.
app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

// ---------------------------------------------------------------------------
// Worker entry: Hono fetch + scheduled idle-stop; export the DO
// ---------------------------------------------------------------------------

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await reconcile(env);
  },
};

// ---------------------------------------------------------------------------
// Proxy helpers
// ---------------------------------------------------------------------------

async function proxyToFly(request: Request, env: Env): Promise<Response> {
  try {
    return await fetch(buildUpstreamUrl(request, env), buildUpstreamInit(request, env));
  } catch {
    // Box is probably stopped — start it once and retry.
  }
  await ensureFlyMachineStarted(env);
  if (!(await waitForHealth(env))) {
    return Response.json({ error: "machine_unavailable" }, { status: 503 });
  }
  await pushCredential(env).catch(() => {});
  return fetch(buildUpstreamUrl(request, env), buildUpstreamInit(request, env));
}

function buildUpstreamUrl(request: Request, env: Env): string {
  const source = new URL(request.url);
  const target = new URL(env.FLY_BASE_URL);
  target.pathname = source.pathname;
  target.search = source.search;
  return target.toString();
}

function buildUpstreamInit(request: Request, env: Env): RequestInit {
  const headers = new Headers(request.headers);
  headers.delete("Host");
  headers.delete("Cookie");
  if (env.FLY_UPSTREAM_AUTHORIZATION) headers.set("Authorization", env.FLY_UPSTREAM_AUTHORIZATION);
  return { method: request.method, headers, body: request.body, redirect: "manual" };
}

async function waitForHealth(env: Env): Promise<boolean> {
  const deadline = Date.now() + START_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(new URL("/healthz", env.FLY_BASE_URL), { headers: upstreamHeaders(env) });
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await sleep(HEALTH_POLL_MS);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Cron idle-stop
// ---------------------------------------------------------------------------

async function reconcile(env: Env): Promise<void> {
  const machine = await flyMachineStatus(env).catch(() => null);
  if (String(machine?.state || "") !== "started") return;

  const lastActive = await readActivity(env);
  if (!lastActive) { await touchActivity(env); return; }

  const limitSeconds = Number(env.IDLE_STOP_SECONDS || "3600");
  const idleSeconds = (Date.now() - lastActive) / 1000;
  if (idleSeconds > limitSeconds) {
    await ensureFlyMachineStopped(env);
    await notify(env, `opencode-phone machine stopped: idle ${Math.round(idleSeconds)}s`);
  }
}

async function touchActivity(env: Env): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO activity (id, last_active_at) VALUES ('machine', ?)
     ON CONFLICT(id) DO UPDATE SET last_active_at = excluded.last_active_at`,
  )
    .bind(isoNow())
    .run();
}

async function readActivity(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT last_active_at FROM activity WHERE id = 'machine'").first<{ last_active_at: string }>();
  return row?.last_active_at ? new Date(row.last_active_at).getTime() : 0;
}

// ---------------------------------------------------------------------------
// Settings storage + provider credential push + crypto
// ---------------------------------------------------------------------------

interface SettingsRow {
  provider: string | null;
  model: string | null;
  key_ciphertext: string | null;
  key_iv: string | null;
  updated_at: string | null;
}

async function readSettings(env: Env): Promise<SettingsRow | null> {
  return env.DB.prepare(
    "SELECT provider, model, key_ciphertext, key_iv, updated_at FROM settings WHERE id = 'default'",
  ).first<SettingsRow>();
}

async function pushCredential(env: Env): Promise<void> {
  const row = await readSettings(env);
  if (!row?.provider || !row.key_ciphertext || !row.key_iv) return;
  const key = await decryptSecret(env, row.key_ciphertext, row.key_iv);

  const headers = upstreamHeaders(env);
  headers.set("Content-Type", "application/json");
  const res = await fetch(new URL(`/opencode/auth/${encodeURIComponent(row.provider)}`, env.FLY_BASE_URL), {
    method: "PUT",
    headers,
    body: JSON.stringify({ type: "api", key }),
  });
  if (!res.ok) throw new Error(`auth push failed: ${res.status}`);
}

async function encryptSecret(env: Env, plaintext: string): Promise<{ ct: string; iv: string }> {
  const key = await importEncKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const buf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  return { ct: bytesToBase64(new Uint8Array(buf)), iv: bytesToBase64(iv) };
}

async function decryptSecret(env: Env, ctB64: string, ivB64: string): Promise<string> {
  const key = await importEncKey(env);
  const buf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(ivB64) }, key, base64ToBytes(ctB64));
  return new TextDecoder().decode(buf);
}

async function importEncKey(env: Env): Promise<CryptoKey> {
  if (!env.SETTINGS_ENC_KEY) throw new Error("SETTINGS_ENC_KEY is not configured");
  return crypto.subtle.importKey("raw", base64ToBytes(env.SETTINGS_ENC_KEY), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

async function notify(env: Env, text: string): Promise<void> {
  if (!env.NOTIFY_WEBHOOK_URL) return;
  await fetch(env.NOTIFY_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isoNow(): string {
  return new Date().toISOString();
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
