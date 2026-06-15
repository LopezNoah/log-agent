interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  CONTROL_PASSWORD: string;
  FLY_API_TOKEN: string;
  FLY_APP_NAME: string;
  FLY_MACHINE_ID: string;
  FLY_BASE_URL: string;
  FLY_UPSTREAM_AUTHORIZATION?: string;
  IDLE_STOP_SECONDS?: string;
  NOTIFY_WEBHOOK_URL?: string;
  SETTINGS_ENC_KEY?: string; // base64 32-byte AES-GCM key for encrypting the BYO API key
}

const MACHINE_API = "https://api.machines.dev/v1";

// How long to wait for a cold-started machine to answer /healthz before giving up.
const START_WAIT_MS = 45_000;
const HEALTH_POLL_MS = 1_500;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!isAuthorized(request, env)) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="opencode-phone"' },
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Transparent proxy to the Fly box. No Machines API call on this hot path — the box
    // is auto-started only if the proxy actually fails to connect.
    if (path === "/opencode" || path.startsWith("/opencode/") ||
        path === "/terminal" || path.startsWith("/terminal/")) {
      ctx.waitUntil(touchActivity(env));
      return proxyToFly(request, env);
    }

    if (path === "/api/machine" && request.method === "GET") return machineStatusResponse(env);
    if (path === "/api/machine/start" && request.method === "POST") return startMachineResponse(env);
    if (path === "/api/machine/stop" && request.method === "POST") return stopMachineResponse(env);

    if (path === "/api/sessions" && request.method === "GET") return listSessionsCached(env);
    const msgMatch = path.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (msgMatch && request.method === "GET") return listMessagesCached(env, msgMatch[1]);

    if (path === "/api/settings" && request.method === "GET") return getSettings(env);
    if (path === "/api/settings" && request.method === "POST") return saveSettings(request, env);
    if (path === "/api/settings" && request.method === "DELETE") return deleteSettings(env);

    if (path.startsWith("/api/")) return json({ error: "not_found" }, 404);

    // Everything else is the single-page app (served from Static Assets).
    return env.ASSETS.fetch(request);
  },

  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    await reconcile(env);
  },
};

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function isAuthorized(request: Request, env: Env): boolean {
  if (!env.CONTROL_PASSWORD) return false;
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Basic ")) return false;
  try {
    const decoded = atob(header.slice("Basic ".length));
    const separator = decoded.indexOf(":");
    const password = separator === -1 ? decoded : decoded.slice(separator + 1);
    return password === env.CONTROL_PASSWORD;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Proxy to Fly (streaming; auto-start on connect failure)
// ---------------------------------------------------------------------------

async function proxyToFly(request: Request, env: Env): Promise<Response> {
  const target = buildUpstreamUrl(request, env);
  const init = buildUpstreamInit(request, env);

  try {
    return await fetch(target, init);
  } catch {
    // Connection failed — the machine is probably stopped. Start it once and retry.
  }

  await ensureFlyMachineStarted(env);
  const healthy = await waitForHealth(env);
  if (!healthy) {
    return json({ error: "machine_unavailable", message: "machine did not become ready in time" }, 503);
  }
  // The box just (re)started, so opencode lost any runtime credential — re-push it.
  await pushCredential(env).catch(() => {});

  // Rebuild init because the body stream may have been consumed by the failed attempt.
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
  return {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
  };
}

async function waitForHealth(env: Env): Promise<boolean> {
  const deadline = Date.now() + START_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(new URL("/healthz", env.FLY_BASE_URL), { headers: upstreamHeaders(env) });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(HEALTH_POLL_MS);
  }
  return false;
}

function upstreamHeaders(env: Env): Headers {
  const headers = new Headers();
  if (env.FLY_UPSTREAM_AUTHORIZATION) headers.set("Authorization", env.FLY_UPSTREAM_AUTHORIZATION);
  return headers;
}

// ---------------------------------------------------------------------------
// Machine lifecycle routes
// ---------------------------------------------------------------------------

async function machineStatusResponse(env: Env): Promise<Response> {
  const machine = await flyMachineStatus(env).catch((error) => ({ state: "unknown", error: stringifyError(error) }));
  return json({ machine });
}

async function startMachineResponse(env: Env): Promise<Response> {
  await ensureFlyMachineStarted(env);
  await touchActivity(env);
  if (await waitForHealth(env)) await pushCredential(env).catch(() => {});
  return json({ ok: true });
}

async function stopMachineResponse(env: Env): Promise<Response> {
  await ensureFlyMachineStopped(env);
  await notify(env, "opencode-phone machine stopped from the UI");
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Cron reconcile (idle stop)
// ---------------------------------------------------------------------------

async function reconcile(env: Env): Promise<void> {
  const machine = await flyMachineStatus(env).catch(() => null);
  const state = String(machine?.state || "");
  if (state !== "started") return;

  // Keep the D1 session cache fresh while the box is up (best-effort).
  const live = await fetchUpstreamJson<any[]>(env, "/opencode/session");
  if (Array.isArray(live)) await cacheSessions(env, live);

  const lastActive = await readActivity(env);
  // No activity timestamp yet (fresh DB, or machine started outside the proxy). Don't treat
  // "unknown" as "infinitely idle" — seed the clock now and give it a full idle window.
  if (!lastActive) {
    await touchActivity(env);
    return;
  }

  const limitSeconds = Number(env.IDLE_STOP_SECONDS || "3600");
  const idleSeconds = (Date.now() - lastActive) / 1000;
  if (idleSeconds > limitSeconds) {
    await ensureFlyMachineStopped(env);
    await notify(env, `opencode-phone machine stopped: idle ${Math.round(idleSeconds)}s`);
  }
}

// ---------------------------------------------------------------------------
// Activity tracking (D1, single row)
// ---------------------------------------------------------------------------

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
// Session cache (D1) — lets the dashboard be browsed with the box stopped
// ---------------------------------------------------------------------------

// The Fly machine has autostart=true, so any request to FLY_BASE_URL wakes it. We therefore
// only read live data when the machine is ALREADY started; otherwise we serve the D1 cache
// and leave the box asleep.
async function isMachineStarted(env: Env): Promise<boolean> {
  const machine = await flyMachineStatus(env).catch(() => null);
  return String(machine?.state || "") === "started";
}

async function fetchUpstreamJson<T>(env: Env, path: string): Promise<T | null> {
  try {
    const res = await fetch(new URL(path, env.FLY_BASE_URL), { headers: upstreamHeaders(env) });
    if (!res.ok) return null;
    return await res.json<T>();
  } catch {
    return null;
  }
}

async function listSessionsCached(env: Env): Promise<Response> {
  if (await isMachineStarted(env)) {
    const live = await fetchUpstreamJson<any[]>(env, "/opencode/session");
    if (Array.isArray(live)) {
      await cacheSessions(env, live);
      return json({ source: "live", machine: "started", sessions: live });
    }
  }
  return json({ source: "cache", machine: "stopped", sessions: await readCachedSessions(env) });
}

async function listMessagesCached(env: Env, sessionId: string): Promise<Response> {
  if (await isMachineStarted(env)) {
    const live = await fetchUpstreamJson<any[]>(env, `/opencode/session/${encodeURIComponent(sessionId)}/message`);
    if (Array.isArray(live)) {
      await cacheMessages(env, sessionId, live);
      return json({ source: "live", messages: live });
    }
  }
  return json({ source: "cache", messages: await readCachedMessages(env, sessionId) });
}

async function cacheSessions(env: Env, list: any[]): Promise<void> {
  if (!list.length) return;
  const now = isoNow();
  const stmts = list.map((s) =>
    env.DB.prepare(
      `INSERT INTO sessions (id, title, created_at, updated_at, data, synced_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at,
         data = excluded.data, synced_at = excluded.synced_at`,
    ).bind(s.id, s.title ?? null, msToIso(s.time?.created), msToIso(s.time?.updated) || now, JSON.stringify(s), now),
  );
  await env.DB.batch(stmts);
}

async function readCachedSessions(env: Env): Promise<unknown[]> {
  const rows = await env.DB.prepare("SELECT data FROM sessions ORDER BY updated_at DESC LIMIT 200").all<{ data: string }>();
  return rows.results.map((r) => JSON.parse(r.data));
}

async function cacheMessages(env: Env, sessionId: string, messages: any[]): Promise<void> {
  await env.DB.prepare("DELETE FROM session_messages WHERE session_id = ?").bind(sessionId).run();
  if (!messages.length) return;
  const stmts = messages.map((m, i) =>
    env.DB.prepare(
      "INSERT INTO session_messages (session_id, message_id, idx, data) VALUES (?, ?, ?, ?)",
    ).bind(sessionId, m.info?.id ?? String(i), i, JSON.stringify(m)),
  );
  await env.DB.batch(stmts);
}

async function readCachedMessages(env: Env, sessionId: string): Promise<unknown[]> {
  const rows = await env.DB.prepare(
    "SELECT data FROM session_messages WHERE session_id = ? ORDER BY idx ASC",
  )
    .bind(sessionId)
    .all<{ data: string }>();
  return rows.results.map((r) => JSON.parse(r.data));
}

function msToIso(ms: unknown): string | null {
  return typeof ms === "number" ? new Date(ms).toISOString() : null;
}

// ---------------------------------------------------------------------------
// Fly Machines API
// ---------------------------------------------------------------------------

async function flyMachineStatus(env: Env): Promise<Record<string, unknown>> {
  return flyRequest(env, `/apps/${env.FLY_APP_NAME}/machines/${env.FLY_MACHINE_ID}`);
}

async function flyMachineAction(env: Env, action: "start" | "stop"): Promise<Record<string, unknown>> {
  return flyRequest(env, `/apps/${env.FLY_APP_NAME}/machines/${env.FLY_MACHINE_ID}/${action}`, { method: "POST" });
}

async function ensureFlyMachineStarted(env: Env): Promise<void> {
  const machine = await flyMachineStatus(env);
  const state = String(machine.state || "");
  if (state === "started" || state === "starting") return;
  await flyMachineAction(env, "start");
}

async function ensureFlyMachineStopped(env: Env): Promise<void> {
  const machine = await flyMachineStatus(env);
  const state = String(machine.state || "");
  if (state === "stopped" || state === "suspended") return;
  await flyMachineAction(env, "stop");
}

async function flyRequest(env: Env, path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  if (!env.FLY_API_TOKEN) throw new Error("FLY_API_TOKEN is not configured");

  const response = await fetch(`${MACHINE_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.FLY_API_TOKEN}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });

  if (!response.ok) {
    throw new Error(`Fly API ${response.status}: ${await response.text()}`);
  }
  if (response.status === 204) return {};
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

// ---------------------------------------------------------------------------
// Settings — bring-your-own provider key (encrypted at rest, AES-GCM)
// ---------------------------------------------------------------------------

interface SettingsRow {
  provider: string | null;
  model: string | null;
  key_ciphertext: string | null;
  key_iv: string | null;
  updated_at: string | null;
}

async function getSettings(env: Env): Promise<Response> {
  const row = await readSettings(env);
  return json({ provider: row?.provider || null, model: row?.model || null, hasKey: !!row?.key_ciphertext });
}

async function saveSettings(request: Request, env: Env): Promise<Response> {
  if (!env.SETTINGS_ENC_KEY) return json({ error: "encryption_key_not_configured" }, 500);

  const body = (await request.json().catch(() => ({}))) as { provider?: string; apiKey?: string; model?: string };
  const provider = (body.provider || "").trim();
  const apiKey = (body.apiKey || "").trim();
  const model = (body.model || "").trim() || null;
  if (!provider || !apiKey) return json({ error: "missing_provider_or_key" }, 400);

  const { ct, iv } = await encryptSecret(env, apiKey);
  await env.DB.prepare(
    `INSERT INTO settings (id, provider, model, key_ciphertext, key_iv, updated_at)
     VALUES ('default', ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, model = excluded.model,
       key_ciphertext = excluded.key_ciphertext, key_iv = excluded.key_iv,
       updated_at = excluded.updated_at`,
  )
    .bind(provider, model, ct, iv, isoNow())
    .run();

  // Push to opencode now if the box is up; otherwise it is pushed on next start.
  const pushed = await pushCredential(env).then(() => true).catch(() => false);
  return json({ ok: true, provider, model, hasKey: true, pushedToMachine: pushed });
}

async function deleteSettings(env: Env): Promise<Response> {
  await env.DB.prepare("DELETE FROM settings WHERE id = 'default'").run();
  return json({ ok: true });
}

async function readSettings(env: Env): Promise<SettingsRow | null> {
  return env.DB.prepare(
    "SELECT provider, model, key_ciphertext, key_iv, updated_at FROM settings WHERE id = 'default'",
  ).first<SettingsRow>();
}

// Decrypt the stored key in memory and push it to opencode (PUT /auth/:provider). The
// plaintext key is never written to the Fly disk.
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
  const buf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(ivB64) },
    key,
    base64ToBytes(ctB64),
  );
  return new TextDecoder().decode(buf);
}

async function importEncKey(env: Env): Promise<CryptoKey> {
  if (!env.SETTINGS_ENC_KEY) throw new Error("SETTINGS_ENC_KEY is not configured");
  return crypto.subtle.importKey("raw", base64ToBytes(env.SETTINGS_ENC_KEY), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
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

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}
