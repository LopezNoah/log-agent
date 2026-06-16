import { Hono } from "hono";
import astroHandler from "@astrojs/cloudflare/entrypoints/server";
import type { Env } from "./env";
import {
  ensureFlyMachineStarted,
  ensureFlyMachineStopped,
  fetchUpstreamJson,
  flyMachineStatus,
  isMachineStarted,
  upstreamHeaders,
} from "./fly";
import { registerAuthRoutes, requireSession } from "./auth";
import { runAgentChat } from "./agent/runtime";
import { fanOutNotification, registerConnectorRoutes } from "./connectors";
import {
  getSystemPromptOverride,
  pushAllToBox,
  pushGithubCredential,
  pushSystemPrompt,
  setSystemPromptOverride,
} from "./box";

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
app.all("/fs", proxy);
app.all("/fs/*", proxy);
app.all("/exec", proxy);
app.all("/exec/*", proxy);
app.all("/preview", proxy);
app.all("/preview/*", proxy);
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
  if (await waitForHealth(c.env)) await pushAllToBox(c.env);
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

// Push the stored GitHub PAT to the box now (used by the Settings "Sync now" button). Only
// meaningful while the machine is up; otherwise it's a no-op that reports not-synced.
app.post("/api/github/sync", async (c) => {
  if (!(await isMachineStarted(c.env))) return c.json({ ok: false, reason: "machine_off" });
  const ok = await pushGithubCredential(c.env).then(() => true).catch(() => false);
  return c.json({ ok });
});

// ---------------------------------------------------------------------------
// System prompt (AGENTS.md) — view the current prompt, save an override, or reset to default
// ---------------------------------------------------------------------------

app.get("/api/system-prompt", async (c) => {
  const override = await getSystemPromptOverride(c.env);
  // Show the live box AGENTS.md as the "default" when no override and the box is reachable.
  let boxContent: string | null = null;
  if (await isMachineStarted(c.env)) {
    const res = await fetchUpstreamJson<{ content?: string }>(c.env, "/agents");
    boxContent = res?.content ?? null;
  }
  return c.json({
    content: override ?? boxContent ?? "",
    source: override != null ? "custom" : "default",
    boxReachable: boxContent != null,
  });
});

app.put("/api/system-prompt", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { content?: string };
  const content = typeof body.content === "string" ? body.content : "";
  await setSystemPromptOverride(c.env, content);
  // Apply immediately if the box is up; otherwise it lands on next start.
  let applied = false;
  if (await isMachineStarted(c.env)) {
    applied = await pushSystemPrompt(c.env).then(() => true).catch(() => false);
  }
  return c.json({ ok: true, applied });
});

app.delete("/api/system-prompt", async (c) => {
  await setSystemPromptOverride(c.env, null);
  return c.json({ ok: true });
});

// Agent v2 (opt-in "worker brain"): run the AI SDK agent loop in the Worker. Tools (fs/exec) run
// on the Fly box; provider keys are decrypted from connectors here and never sent to the box. The
// streamText + stopWhen loop keeps calling tools across steps until the model is done.
app.post("/api/agent/chat", async (c) => {
  c.executionCtx.waitUntil(ensureFlyMachineStarted(c.env).catch(() => {})); // tools need the box up
  const body = (await c.req.json().catch(() => ({}))) as { prompt?: string; messages?: any[]; system?: string };
  try {
    const result = await runAgentChat(c.env, body);
    return result.toUIMessageStreamResponse();
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

// Unmatched API routes are 404 JSON.
app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));

// Everything else flows into Astro via the adapter's default server handler: it matches static
// assets (the client bundle, CSS, vendor), falls back to the ASSETS binding, then renders the
// matched page (index.astro / login.astro) through app.render(). Auth already ran above via
// requireSession, so only authenticated requests (or the public /login page) reach a render.
app.all("*", (c) => astroHandler.fetch(c.req.raw, c.env, c.executionCtx));

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
  await pushAllToBox(env);
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
  const source = new URL(request.url);
  headers.delete("Host");
  headers.delete("Cookie");
  headers.set("X-Forwarded-Host", source.host);
  headers.set("X-Forwarded-Proto", source.protocol.replace(":", ""));
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
