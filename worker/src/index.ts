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

  const lastActive = await readActivity(env);
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
