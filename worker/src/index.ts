interface Env {
  DB: D1Database;
  CONTROL_PASSWORD: string;
  FLY_API_TOKEN: string;
  FLY_APP_NAME: string;
  FLY_MACHINE_ID: string;
  FLY_BASE_URL: string;
  FLY_UPSTREAM_AUTHORIZATION?: string;
  IDLE_STOP_SECONDS?: string;
  AGENT_STATUS_PATH?: string;
  NOTIFY_WEBHOOK_URL?: string;
}

interface SessionRow {
  id: string;
  state: SessionState;
  title: string | null;
  fly_app_name: string;
  fly_machine_id: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  stopped_at: string | null;
  last_seen_at: string | null;
  last_status_at: string | null;
  last_error: string | null;
  exit_code: number | null;
}

interface SessionMessageRow {
  id: string;
  session_id: string;
  role: "user" | "terminal" | "system";
  kind: "input" | "output" | "status" | "error";
  content: string;
  created_at: string;
}

type SessionState = "starting" | "running" | "complete" | "failed" | "stopped";

type AgentStatus = {
  state?: string;
  exitCode?: number | null;
  error?: string | null;
  message?: string | null;
  updatedAt?: string;
};

type SessionOutput = {
  ok: boolean;
  output: string;
  error: string | null;
};

type FlyInputResponse = {
  ok: boolean;
  error?: string;
  output?: SessionOutput;
};

const MACHINE_API = "https://api.machines.dev/v1";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!isAuthorized(request, env)) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="opencode-phone"' },
      });
    }

    const url = new URL(request.url);

    if (url.pathname === "/" && request.method === "GET") return dashboard(env);
    const pageMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
    if (pageMatch && request.method === "GET") return sessionPage(pageMatch[1], env);

    if (url.pathname === "/terminal" || url.pathname.startsWith("/terminal/") || shouldProxyToTerminal(request, url)) {
      ctx.waitUntil(touchLatestRunningSession(env));
      return proxyToFly(request, env);
    }

    if (url.pathname === "/api/sessions" && request.method === "GET") return listSessions(env);
    if (url.pathname === "/api/sessions" && request.method === "POST") return createSession(request, env);
    if (url.pathname === "/api/session/output" && request.method === "GET") return sessionOutputResponse(env, url);
    if (url.pathname === "/api/fly" && request.method === "GET") return flyMachineStatusResponse(env);

    const match = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/([^/]+))?$/);
    if (match) {
      const [, id, action] = match;
      if (!action && request.method === "GET") return getSession(id, env);
      if (action === "seen" && request.method === "POST") return markSeen(id, env);
      if (action === "complete" && request.method === "POST") return completeSession(id, env);
      if (action === "stop" && request.method === "POST") return stopSession(id, env);
      if (action === "fly" && request.method === "GET") return flyMachineStatusResponse(env);
      if (action === "messages" && request.method === "GET") return listSessionMessages(id, env);
      if (action === "messages" && request.method === "POST") return sendSessionMessage(id, request, env, ctx);
      if (action === "output" && request.method === "GET") return sessionOutputResponse(env, url, id);
    }

    return json({ error: "not_found" }, 404);
  },

  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    await reconcileSessions(env);
  },
};

function shouldProxyToTerminal(request: Request, url: URL): boolean {
  if (url.pathname.startsWith("/api/")) return false;
  if (url.pathname.startsWith("/sessions/")) return false;
  if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") return true;
  return url.pathname !== "/";
}

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

async function dashboard(env: Env): Promise<Response> {
  const sessions = await env.DB.prepare(
    "SELECT * FROM sessions ORDER BY created_at DESC LIMIT 20",
  ).all<SessionRow>();
  const latestRunning = sessions.results.find((session) => session.state === "running" || session.state === "starting");
  const flyStatus = await flyMachineStatus(env).catch((error) => ({ state: "unknown", error: stringifyError(error) }));
  const machineState = escapeHtml(String(flyStatus.state || "unknown"));

  const cards = sessions.results
    .map((session) => {
      const title = escapeHtml(session.title || session.id);
      const updated = escapeHtml(session.updated_at);
      const state = escapeHtml(session.state);
      const id = escapeHtml(session.id);
      const message = session.last_error ? `<p class="error">${escapeHtml(session.last_error)}</p>` : "";
      const completeButton = session.state === "running" || session.state === "starting"
        ? `<button data-action="complete" data-id="${id}">Mark Complete</button>`
        : "";
      const stopButton = session.state === "running" || session.state === "starting"
        ? `<button data-action="stop" data-id="${id}">Stop Machine</button>`
        : "";
      return `<article class="card">
        <div>
          <strong>${title}</strong>
          <span class="pill ${state}">${state}</span>
        </div>
        <p class="muted">Updated ${updated}</p>
        ${message}
        <div class="row">
          <a href="/sessions/${id}">Open Session</a>
          ${completeButton}
          ${stopButton}
          <a href="/api/sessions/${id}">JSON</a>
        </div>
      </article>`;
    })
    .join("");
  const latestRunningId = latestRunning?.id || "";

  return html(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OpenCode Phone</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { color: #e5e7eb; background: radial-gradient(circle at top left, #1e3a8a 0, #0f172a 36rem); font: 16px ui-sans-serif, system-ui, sans-serif; margin: 0; }
    main { max-width: 1100px; margin: 0 auto; padding: 2rem; }
    a { color: #93c5fd; text-decoration: none; }
    a:hover { text-decoration: underline; }
    button, input { border: 1px solid #475569; border-radius: .8rem; font: inherit; padding: .65rem .85rem; }
    button { background: #2563eb; color: white; cursor: pointer; }
    button.secondary { background: #334155; }
    input { background: #020617; color: #e5e7eb; min-width: min(100%, 22rem); }
    h1 { font-size: clamp(2rem, 8vw, 4.5rem); line-height: .95; margin: 0; letter-spacing: -.06em; }
    .hero { display: grid; gap: 1rem; margin-bottom: 1.5rem; }
    .panel, .card { background: color-mix(in oklab, #020617 82%, transparent); border: 1px solid #334155; border-radius: 1.25rem; box-shadow: 0 20px 70px rgb(0 0 0 / .28); padding: 1rem; }
    .grid { display: grid; gap: 1rem; grid-template-columns: 1fr; }
    @media (min-width: 850px) { .grid { grid-template-columns: 22rem 1fr; } }
    .actions, .row { align-items: center; display: flex; flex-wrap: wrap; gap: .75rem; }
    .muted { color: #94a3b8; }
    .error { color: #fca5a5; }
    .pill { border-radius: 999px; display: inline-flex; font-size: .78rem; margin-left: .5rem; padding: .2rem .55rem; text-transform: uppercase; }
    .running, .starting { background: #14532d; color: #bbf7d0; }
    .complete { background: #1e3a8a; color: #bfdbfe; }
    .failed { background: #7f1d1d; color: #fecaca; }
    .stopped { background: #334155; color: #cbd5e1; }
    .cards { display: grid; gap: .85rem; }
    pre { background: #020617; border: 1px solid #334155; border-radius: 1rem; color: #d1fae5; margin: 0; min-height: 22rem; overflow: auto; padding: 1rem; white-space: pre-wrap; }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <p class="muted">Fly machine: <strong id="machine-state">${machineState}</strong></p>
      <h1>OpenCode Phone</h1>
      <p>Start a session, use the browser terminal, and let the Worker stop Fly when the task is complete.</p>
    </section>

    <section class="grid">
      <aside class="panel">
        <form class="actions" method="post" action="/api/sessions">
          <input name="title" placeholder="Session title" autocomplete="off">
          <button type="submit">Start Session</button>
        </form>
        <div class="actions">
          <a href="/terminal/">Open Raw Terminal</a>
          <a href="/api/sessions">Sessions JSON</a>
          <a href="/api/session/output">Output JSON</a>
        </div>
        <p class="muted">Inside terminal: run <code>opencode</code>. Use <code>agent-done</code> when finished, or <code>agent-run &lt;command&gt;</code> for automatic completion.</p>
      </aside>

      <section class="panel">
        <div class="row" style="justify-content: space-between; margin-bottom: .75rem;">
          <h2 style="margin: 0;">Terminal Output</h2>
          <button class="secondary" id="refresh-output">Refresh</button>
        </div>
        <pre id="terminal-output">Loading terminal output...</pre>
      </section>
    </section>

    <section style="margin-top: 1rem;" class="cards">
      ${cards || "<article class=\"card\"><p>No sessions yet.</p></article>"}
    </section>
  </main>
  <script>
    const latestRunningId = ${JSON.stringify(latestRunningId)};
    async function post(path) {
      const response = await fetch(path, { method: 'POST', credentials: 'same-origin' });
      if (!response.ok) alert(await response.text());
      location.reload();
    }
    document.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const action = button.dataset.action;
      const id = button.dataset.id;
      post('/api/sessions/' + id + '/' + action);
    });
    async function refreshOutput() {
      const pre = document.getElementById('terminal-output');
      const state = document.getElementById('machine-state');
      try {
        const fly = await fetch('/api/fly', { credentials: 'same-origin' }).then((res) => res.json());
        state.textContent = fly.machine?.state || 'unknown';
        if (fly.machine?.state !== 'started') {
          pre.textContent = 'Machine is ' + (fly.machine?.state || 'not started') + '. Start a session to see output.';
          return;
        }
        const body = await fetch('/api/session/output?lines=160', { credentials: 'same-origin' }).then((res) => res.json());
        pre.textContent = body.output || body.error || 'No terminal output yet.';
      } catch (error) {
        pre.textContent = String(error);
      }
    }
    document.getElementById('refresh-output').addEventListener('click', refreshOutput);
    refreshOutput();
    setInterval(refreshOutput, latestRunningId ? 10000 : 30000);
  </script>
</body>
</html>`);
}

async function sessionPage(id: string, env: Env): Promise<Response> {
  const session = await findSession(env, id);
  if (!session) return html("<h1>Session not found</h1>", 404);

  const messages = await env.DB.prepare(
    "SELECT * FROM session_messages WHERE session_id = ? ORDER BY created_at ASC LIMIT 200",
  )
    .bind(id)
    .all<SessionMessageRow>();
  const flyStatus = await flyMachineStatus(env).catch((error) => ({ state: "unknown", error: stringifyError(error) }));

  const renderedMessages = messages.results
    .map((message) => `<article class="message ${escapeHtml(message.role)}">
      <div><strong>${escapeHtml(message.role)}</strong> <span>${escapeHtml(message.kind)}</span> <time>${escapeHtml(message.created_at)}</time></div>
      <pre>${escapeHtml(message.content)}</pre>
    </article>`)
    .join("");

  const title = escapeHtml(session.title || session.id);
  const state = escapeHtml(session.state);
  const machineState = escapeHtml(String(flyStatus.state || "unknown"));

  return html(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} - OpenCode Phone</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { background: #030712; color: #e5e7eb; font: 16px ui-sans-serif, system-ui, sans-serif; margin: 0; }
    main { display: grid; gap: 1rem; grid-template-columns: 1fr; margin: 0 auto; max-width: 1180px; padding: 1rem; }
    @media (min-width: 900px) { main { grid-template-columns: minmax(0, 1fr) 28rem; } }
    a { color: #93c5fd; }
    button, textarea { border: 1px solid #475569; border-radius: .85rem; font: inherit; }
    button { background: #2563eb; color: white; cursor: pointer; padding: .7rem .9rem; }
    button.secondary { background: #334155; }
    textarea { background: #020617; color: #e5e7eb; min-height: 7rem; padding: .85rem; resize: vertical; width: 100%; }
    header, section, aside { background: #0f172a; border: 1px solid #334155; border-radius: 1.25rem; padding: 1rem; }
    header { grid-column: 1 / -1; }
    h1 { margin: 0 0 .35rem; }
    .muted, time, span { color: #94a3b8; }
    .row { align-items: center; display: flex; flex-wrap: wrap; gap: .75rem; }
    .pill { background: #1e293b; border-radius: 999px; display: inline-flex; padding: .2rem .55rem; }
    pre { background: #020617; border: 1px solid #1e293b; border-radius: .8rem; color: #d1fae5; margin: .5rem 0 0; overflow: auto; padding: .75rem; white-space: pre-wrap; }
    .message { border-left: 4px solid #475569; margin-bottom: .75rem; }
    .message.user { border-left-color: #60a5fa; }
    .message.terminal { border-left-color: #34d399; }
    .message.system { border-left-color: #fbbf24; }
    #live-output { min-height: 18rem; max-height: 40rem; }
  </style>
</head>
<body>
  <main>
    <header>
      <p><a href="/">Dashboard</a> / <span>${escapeHtml(session.id)}</span></p>
      <h1>${title}</h1>
      <div class="row">
        <span class="pill">Session: ${state}</span>
        <span class="pill">Fly: <span id="machine-state">${machineState}</span></span>
        <a href="/terminal/">Raw Terminal</a>
        <a href="/api/sessions/${escapeHtml(session.id)}">JSON</a>
      </div>
    </header>

    <section>
      <h2>Send To Machine</h2>
      <p class="muted">Examples: <code>opencode</code>, a prompt for OpenCode, <code>git clone ...</code>, or <code>agent-done</code>.</p>
      <form id="send-form">
        <textarea id="text" name="text" placeholder="Type a command or prompt..."></textarea>
        <div class="row" style="margin-top: .75rem;">
          <button type="submit">Send</button>
          <button class="secondary" type="button" id="complete">Mark Complete</button>
          <button class="secondary" type="button" id="stop">Stop Machine</button>
        </div>
      </form>

      <h2>Session Log</h2>
      <div id="messages">${renderedMessages || "<p class=\"muted\">No logged messages yet.</p>"}</div>
    </section>

    <aside>
      <div class="row" style="justify-content: space-between;">
        <h2>Live Output</h2>
        <button class="secondary" type="button" id="refresh">Refresh</button>
      </div>
      <pre id="live-output">Loading...</pre>
    </aside>
  </main>
  <script>
    const sessionId = ${JSON.stringify(session.id)};
    async function post(path, body) {
      const response = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    }
    async function refreshOutput() {
      const pre = document.getElementById('live-output');
      const state = document.getElementById('machine-state');
      try {
        const fly = await fetch('/api/fly', { credentials: 'same-origin' }).then((res) => res.json());
        state.textContent = fly.machine?.state || 'unknown';
        const body = await fetch('/api/sessions/' + sessionId + '/output?lines=220', { credentials: 'same-origin' }).then((res) => res.json());
        pre.textContent = body.output || body.error || 'No output yet.';
      } catch (error) {
        pre.textContent = String(error);
      }
    }
    document.getElementById('send-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const text = document.getElementById('text').value;
      if (!text.trim()) return;
      await post('/api/sessions/' + sessionId + '/messages', { text });
      location.reload();
    });
    document.getElementById('complete').addEventListener('click', () => post('/api/sessions/' + sessionId + '/complete').then(() => location.reload()).catch(alert));
    document.getElementById('stop').addEventListener('click', () => post('/api/sessions/' + sessionId + '/stop').then(() => location.reload()).catch(alert));
    document.getElementById('refresh').addEventListener('click', refreshOutput);
    refreshOutput();
    setInterval(refreshOutput, 10000);
  </script>
</body>
</html>`);
}

async function listSessions(env: Env): Promise<Response> {
  const sessions = await env.DB.prepare(
    "SELECT * FROM sessions ORDER BY created_at DESC LIMIT 50",
  ).all<SessionRow>();

  await touchLatestRunningSession(env);
  return json({ sessions: sessions.results });
}

async function createSession(request: Request, env: Env): Promise<Response> {
  const now = isoNow();
  const id = crypto.randomUUID();
  const title = await readTitle(request);

  await env.DB.prepare(
    `INSERT INTO sessions (
      id, state, title, fly_app_name, fly_machine_id, created_at, updated_at, started_at, last_seen_at
    ) VALUES (?, 'starting', ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, title, env.FLY_APP_NAME, env.FLY_MACHINE_ID, now, now, now, now)
    .run();

  try {
    await ensureFlyMachineStarted(env);
    await env.DB.prepare(
      "UPDATE sessions SET state = 'running', updated_at = ?, started_at = COALESCE(started_at, ?) WHERE id = ?",
    )
      .bind(isoNow(), now, id)
      .run();
  } catch (error) {
    await env.DB.prepare(
      "UPDATE sessions SET state = 'failed', updated_at = ?, last_error = ? WHERE id = ?",
    )
      .bind(isoNow(), stringifyError(error), id)
      .run();
    throw error;
  }

  await addSessionMessage(env, id, "system", "status", "Session started. Send `opencode` to launch the CLI, then send prompts or commands from this page.");
  return redirect(`/sessions/${encodeURIComponent(id)}`);
}

async function getSession(id: string, env: Env): Promise<Response> {
  const session = await findSession(env, id);
  if (!session) return json({ error: "session_not_found" }, 404);
  return json({ session });
}

async function markSeen(id: string, env: Env): Promise<Response> {
  const now = isoNow();
  const result = await env.DB.prepare(
    "UPDATE sessions SET last_seen_at = ?, updated_at = ? WHERE id = ? AND state IN ('starting', 'running')",
  )
    .bind(now, now, id)
    .run();

  return json({ ok: result.meta.changes > 0 });
}

async function completeSession(id: string, env: Env): Promise<Response> {
  const now = isoNow();
  const session = await findSession(env, id);
  if (!session) return json({ error: "session_not_found" }, 404);

  await env.DB.prepare(
    "UPDATE sessions SET state = 'complete', completed_at = ?, updated_at = ? WHERE id = ?",
  )
    .bind(now, now, id)
    .run();
  await addSessionMessage(env, id, "system", "status", "Session marked complete from Worker UI.");
  await stopFlyMachineForSession(env, id, "completed");

  return json({ ok: true, state: "complete" });
}

async function stopSession(id: string, env: Env): Promise<Response> {
  const session = await findSession(env, id);
  if (!session) return json({ error: "session_not_found" }, 404);

  await addSessionMessage(env, id, "system", "status", "Stop requested from Worker UI.");
  await stopFlyMachineForSession(env, id, "manual_stop");
  return json({ ok: true, state: "stopped" });
}

async function listSessionMessages(id: string, env: Env): Promise<Response> {
  const session = await findSession(env, id);
  if (!session) return json({ error: "session_not_found" }, 404);

  const messages = await env.DB.prepare(
    "SELECT * FROM session_messages WHERE session_id = ? ORDER BY created_at ASC LIMIT 500",
  )
    .bind(id)
    .all<SessionMessageRow>();

  return json({ messages: messages.results });
}

async function sendSessionMessage(id: string, request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const session = await findSession(env, id);
  if (!session) return json({ error: "session_not_found" }, 404);

  const text = await readMessageText(request);
  if (!text) return json({ error: "missing_text" }, 400);

  await addSessionMessage(env, id, "user", "input", text);
  await ensureFlyMachineStarted(env);

  const sent = await sendInputToFly(env, text);
  if (!sent.ok) {
    await addSessionMessage(env, id, "system", "error", sent.error || "failed to send input");
    return json(sent, 502);
  }

  if (sent.output?.output) {
    await storeOutputSnapshot(env, id, sent.output.output);
  }

  ctx.waitUntil(captureAndStoreOutput(env, id));
  return json({ ok: true });
}

async function sessionOutputResponse(env: Env, url: URL, sessionId?: string): Promise<Response> {
  const machine = await flyMachineStatus(env);
  if (String(machine.state || "") !== "started") {
    return json({ ok: false, output: "", error: `machine is ${String(machine.state || "unknown")}` });
  }

  const lines = url.searchParams.get("lines") || "120";
  const response = await fetch(new URL(`/api/session/output?lines=${encodeURIComponent(lines)}`, env.FLY_BASE_URL), {
    headers: upstreamHeaders(env),
  });

  if (!response.ok) {
    return json({ ok: false, output: "", error: `upstream returned ${response.status}` }, 502);
  }

  const output = await response.json<SessionOutput>();
  if (sessionId && output.output) await storeOutputSnapshot(env, sessionId, output.output);
  return json(output);
}

async function reconcileSessions(env: Env): Promise<void> {
  const sessions = await env.DB.prepare(
    "SELECT * FROM sessions WHERE state IN ('starting', 'running') ORDER BY updated_at ASC LIMIT 25",
  ).all<SessionRow>();

  for (const session of sessions.results) {
    try {
      const status = await readAgentStatus(env);
      if (status?.state === "complete" || status?.state === "failed") {
        const state: SessionState = status.state === "failed" ? "failed" : "complete";
        const now = isoNow();
        await env.DB.prepare(
          `UPDATE sessions
           SET state = ?, exit_code = ?, last_error = ?, last_status_at = ?, completed_at = ?, updated_at = ?
           WHERE id = ?`,
        )
          .bind(state, status.exitCode ?? null, status.error ?? null, now, now, now, session.id)
          .run();
        await addSessionMessage(env, session.id, "system", state === "complete" ? "status" : "error", status.message || status.error || `Session ${state}`);
        await stopFlyMachineForSession(env, session.id, state);
        continue;
      }

      if (status?.state === "running") {
        const now = isoNow();
        await env.DB.prepare(
          "UPDATE sessions SET last_status_at = ?, updated_at = ? WHERE id = ?",
        )
          .bind(status.updatedAt || now, now, session.id)
          .run();
      }

      const machine = await flyMachineStatus(env);
      const machineState = String(machine.state || "");
      if (["stopped", "destroyed"].includes(machineState)) {
        const now = isoNow();
        await env.DB.prepare(
          "UPDATE sessions SET state = 'stopped', stopped_at = ?, updated_at = ? WHERE id = ?",
        )
          .bind(now, now, session.id)
          .run();
        continue;
      }

      if (machineState === "started") {
        await captureAndStoreOutput(env, session.id);
      }

      if (isIdlePastLimit(session, env)) {
        await stopFlyMachineForSession(env, session.id, "idle_timeout");
      }
    } catch (error) {
      await env.DB.prepare(
        "UPDATE sessions SET last_error = ?, updated_at = ? WHERE id = ?",
      )
        .bind(stringifyError(error), isoNow(), session.id)
        .run();
    }
  }
}

async function addSessionMessage(
  env: Env,
  sessionId: string,
  role: SessionMessageRow["role"],
  kind: SessionMessageRow["kind"],
  content: string,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO session_messages (id, session_id, role, kind, content, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(crypto.randomUUID(), sessionId, role, kind, content, isoNow())
    .run();
}

async function storeOutputSnapshot(env: Env, sessionId: string, output: string): Promise<void> {
  const normalized = output.trimEnd();
  if (!normalized) return;

  const last = await env.DB.prepare(
    "SELECT content FROM session_messages WHERE session_id = ? AND role = 'terminal' AND kind = 'output' ORDER BY created_at DESC LIMIT 1",
  )
    .bind(sessionId)
    .first<{ content: string }>();

  if (last?.content === normalized) return;
  await addSessionMessage(env, sessionId, "terminal", "output", normalized);
}

async function captureAndStoreOutput(env: Env, sessionId: string): Promise<void> {
  const machine = await flyMachineStatus(env).catch(() => null);
  if (String(machine?.state || "") !== "started") return;

  const response = await fetch(new URL("/api/session/output?lines=220", env.FLY_BASE_URL), {
    headers: upstreamHeaders(env),
  });
  if (!response.ok) return;

  const output = await response.json<SessionOutput>();
  if (output.output) await storeOutputSnapshot(env, sessionId, output.output);
}

async function sendInputToFly(env: Env, text: string): Promise<FlyInputResponse> {
  const headers = upstreamHeaders(env);
  headers.set("Content-Type", "application/json");

  const response = await fetch(new URL("/api/session/input", env.FLY_BASE_URL), {
    method: "POST",
    headers,
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    return { ok: false, error: await response.text() };
  }

  return response.json<FlyInputResponse>();
}

async function readAgentStatus(env: Env): Promise<AgentStatus | null> {
  if (!env.AGENT_STATUS_PATH) return null;

  const url = new URL(env.AGENT_STATUS_PATH, env.FLY_BASE_URL);
  const response = await fetch(url, { headers: upstreamHeaders(env) });
  if (!response.ok) return null;
  return response.json<AgentStatus>();
}

function upstreamHeaders(env: Env): Headers {
  const headers = new Headers();
  if (env.FLY_UPSTREAM_AUTHORIZATION) headers.set("Authorization", env.FLY_UPSTREAM_AUTHORIZATION);
  return headers;
}

async function proxyToFly(request: Request, env: Env): Promise<Response> {
  const source = new URL(request.url);
  const target = new URL(env.FLY_BASE_URL);
  const strippedPath = source.pathname.replace(/^\/terminal\/?/, "/");
  target.pathname = strippedPath === "/" ? "/" : strippedPath;
  target.search = source.search;

  const headers = new Headers(request.headers);
  headers.delete("Host");
  headers.delete("Cookie");
  const authorization = upstreamHeaders(env).get("Authorization");
  if (authorization) headers.set("Authorization", authorization);

  return fetch(target, {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
  });
}

async function flyMachineStatusResponse(env: Env): Promise<Response> {
  return json({ machine: await flyMachineStatus(env) });
}

async function flyMachineStatus(env: Env): Promise<Record<string, unknown>> {
  return flyRequest(env, `/apps/${env.FLY_APP_NAME}/machines/${env.FLY_MACHINE_ID}`);
}

async function flyMachineAction(env: Env, action: "start" | "stop"): Promise<Record<string, unknown>> {
  return flyRequest(env, `/apps/${env.FLY_APP_NAME}/machines/${env.FLY_MACHINE_ID}/${action}`, {
    method: "POST",
  });
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

async function flyRequest(
  env: Env,
  path: string,
  init: RequestInit = {},
): Promise<Record<string, unknown>> {
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
    const body = await response.text();
    throw new Error(`Fly API ${response.status}: ${body}`);
  }

  if (response.status === 204) return {};
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

async function stopFlyMachineForSession(env: Env, id: string, reason: string): Promise<void> {
  const now = isoNow();
  await ensureFlyMachineStopped(env);
  await env.DB.prepare(
    "UPDATE sessions SET state = 'stopped', stopped_at = ?, updated_at = ? WHERE id = ? AND state != 'complete'",
  )
    .bind(now, now, id)
    .run();

  await notify(env, `OpenCode session ${id} stopped: ${reason}`);
}

async function notify(env: Env, text: string): Promise<void> {
  if (!env.NOTIFY_WEBHOOK_URL) return;
  await fetch(env.NOTIFY_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

async function findSession(env: Env, id: string): Promise<SessionRow | null> {
  return env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
}

async function touchLatestRunningSession(env: Env): Promise<void> {
  const now = isoNow();
  await env.DB.prepare(
    `UPDATE sessions
     SET last_seen_at = ?, updated_at = ?
     WHERE id = (
       SELECT id FROM sessions WHERE state IN ('starting', 'running') ORDER BY created_at DESC LIMIT 1
     )`,
  )
    .bind(now, now)
    .run();
}

function isIdlePastLimit(session: SessionRow, env: Env): boolean {
  const limitSeconds = Number(env.IDLE_STOP_SECONDS || "3600");
  const basis = session.last_status_at || session.last_seen_at || session.updated_at || session.created_at;
  const idleSeconds = (Date.now() - new Date(basis).getTime()) / 1000;
  return idleSeconds > limitSeconds;
}

async function readTitle(request: Request): Promise<string | null> {
  const contentType = request.headers.get("Content-Type") || "";
  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as { title?: string };
    return normalizeTitle(body.title);
  }

  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    return normalizeTitle(String(form.get("title") || ""));
  }

  return null;
}

async function readMessageText(request: Request): Promise<string> {
  const contentType = request.headers.get("Content-Type") || "";
  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as { text?: string; message?: string; command?: string };
    return String(body.text || body.message || body.command || "").trimEnd();
  }

  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    return String(form.get("text") || form.get("message") || form.get("command") || "").trimEnd();
  }

  return (await request.text()).trimEnd();
}

function normalizeTitle(title: string | undefined): string | null {
  const normalized = title?.trim();
  return normalized ? normalized.slice(0, 120) : null;
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

function html(value: string, status = 200): Response {
  return new Response(value, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location } });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      default:
        return "&quot;";
    }
  });
}
