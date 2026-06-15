import { Hono } from "hono";
import type { Env } from "./env";
import {
  ensureFlyMachineStarted,
  ensureFlyMachineStopped,
  flyMachineStatus,
  upstreamHeaders,
} from "./fly";
import { registerAuthRoutes, requireSession } from "./auth";
import { fanOutNotification, getDefaultLlmCredential, registerConnectorRoutes } from "./connectors";

export { SyncHub } from "./sync-hub";

const START_WAIT_MS = 45_000;
const HEALTH_POLL_MS = 1_500;

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Auth: signed session cookie on everything except the login page + its assets
// ---------------------------------------------------------------------------

app.use("*", requireSession);
registerAuthRoutes(app);

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
// Connectors: BYOK credentials (LLM providers, GitHub, Fly.io, notifications)
// ---------------------------------------------------------------------------

registerConnectorRoutes(app);

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
// Provider credential push to opencode (default LLM connector)
// ---------------------------------------------------------------------------

async function pushCredential(env: Env): Promise<void> {
  const cred = await getDefaultLlmCredential(env);
  if (!cred) return;

  const headers = upstreamHeaders(env);
  headers.set("Content-Type", "application/json");
  const res = await fetch(new URL(`/opencode/auth/${encodeURIComponent(cred.provider)}`, env.FLY_BASE_URL), {
    method: "PUT",
    headers,
    body: JSON.stringify({ type: "api", key: cred.key }),
  });
  if (!res.ok) throw new Error(`auth push failed: ${res.status}`);
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

// Fan out to every configured notification connector, plus the legacy env webhook if set.
async function notify(env: Env, text: string): Promise<void> {
  await fanOutNotification(env, text).catch(() => {});
  if (!env.NOTIFY_WEBHOOK_URL) return;
  await fetch(env.NOTIFY_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  }).catch(() => {});
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
