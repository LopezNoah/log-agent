import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { fetchUpstreamJson, isMachineStarted, upstreamHeaders } from "./fly";

// How often, at most, to persist the idle-stop activity clock. The reconcile cron compares it
// against IDLE_STOP_SECONDS (default 3600s), so coarse granularity is plenty — writing per token
// would stall the live event relay behind a cross-service D1 write.
const ACTIVITY_WRITE_INTERVAL_MS = 15_000;

// One instance (getByName("hub")) — the single coordination atom for this single-user tool.
// It owns the session/message cache (SQLite), fans out to every connected client over
// WebSocket, and mirrors opencode's SSE event stream while the Fly box is running.
export class SyncHub extends DurableObject<Env> {
  private bridgeActive = false;
  private bridgeAbort: AbortController | null = null;
  private lastActivityWrite = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.sql(`CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, title TEXT, created_at TEXT, updated_at TEXT, data TEXT NOT NULL, synced_at TEXT NOT NULL
      )`);
      this.sql(`CREATE TABLE IF NOT EXISTS session_messages (
        session_id TEXT NOT NULL, message_id TEXT NOT NULL, idx INTEGER NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY (session_id, message_id)
      )`);
    });
  }

  private sql(query: string, ...bindings: unknown[]) {
    return this.ctx.storage.sql.exec(query, ...bindings);
  }

  // ---------------------------------------------------------------- WebSocket fan-out

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].send(JSON.stringify({ type: "snapshot", sessions: this.readCachedSessions() }));
    this.ensureBridge();
    // The cached snapshot above renders instantly but can be stale. Force a reconcile for THIS
    // connection regardless of bridge state — ensureBridge() short-circuits when the bridge is
    // already running (a prior tab), so without this a freshly opened tab/browser would keep
    // showing the stale list until the next upstream event. refreshSessions() no-ops when the box
    // is off, so offline browsing still shows the cache.
    this.ctx.waitUntil(this.refreshSessions().catch(() => {}));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let msg: any;
    try { msg = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message)); } catch { return; }

    if (msg?.type === "open" && msg.sessionID) {
      const sessionId = String(msg.sessionID);
      // Cache-first: answer instantly from the durable cache so the thread loads even when the box
      // is off, slow, or 524ing — never block the client on a live fetch. Then reconcile against
      // opencode in the background and re-broadcast only if it actually changed.
      ws.send(JSON.stringify({ type: "messages", sessionID: sessionId, messages: this.readCachedMessages(sessionId) }));
      this.ctx.waitUntil(this.refreshMessages(sessionId));
    } else if (msg?.type === "sync") {
      // Client observed the box come up (or wants a forced refresh): reconcile the cache against
      // opencode now, then make sure the SSE bridge is running.
      await this.refreshSessions();
      this.ensureBridge();
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    try { ws.close(); } catch { /* already closing */ }
    this.maybeStopBridge();
  }

  async webSocketError(): Promise<void> {
    this.maybeStopBridge();
  }

  private broadcast(obj: unknown): void {
    const data = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(data); } catch { /* dropped */ }
    }
  }

  // ---------------------------------------------------------------- SSE bridge to opencode

  private async ensureBridge(): Promise<void> {
    if (this.bridgeActive) return;
    if (this.ctx.getWebSockets().length === 0) return;
    if (!(await isMachineStarted(this.env))) {
      // Box is off; check again soon in case a client started it.
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
      return;
    }
    this.bridgeActive = true;
    const abort = new AbortController();
    this.bridgeAbort = abort;
    await this.ctx.storage.setAlarm(Date.now() + 30_000);

    // Reconcile the cache against opencode so it's an exact mirror, even if events were missed.
    await this.refreshSessions();
    this.readSSE(abort); // long-lived; not awaited
  }

  // Pull opencode's authoritative session list and make the cache match it exactly (prune
  // sessions that no longer exist upstream), then broadcast the corrected list. opencode is the
  // source of truth; this is what keeps offline browsing accurate instead of showing ghosts.
  private async refreshSessions(): Promise<void> {
    if (!(await isMachineStarted(this.env))) return;
    const sessions = await fetchUpstreamJson<any[]>(this.env, "/opencode/session");
    if (!Array.isArray(sessions)) return; // fetch failed — keep the existing cache, don't wipe it
    this.reconcileSessions(sessions);
    this.broadcast({ type: "sessions", sessions: this.readCachedSessions() });
  }

  // Reconcile one session's messages against opencode and, only if they changed, update the cache
  // and push the fresh copy to clients. Best-effort + time-boxed (fetchUpstreamJson aborts), and
  // run via waitUntil — so a slow/unreachable box never stalls anything; the cache-first send in
  // the open handler already happened. The change check also avoids the expensive full re-cache
  // (DELETE + re-INSERT) of a large session when nothing is new.
  private async refreshMessages(sessionId: string): Promise<void> {
    if (!(await isMachineStarted(this.env))) return;
    const live = await fetchUpstreamJson<any[]>(this.env, `/opencode/session/${encodeURIComponent(sessionId)}/message`);
    if (!Array.isArray(live)) return;
    if (messagesSignature(live) === messagesSignature(this.readCachedMessages(sessionId))) return;
    this.cacheMessages(sessionId, live);
    this.broadcast({ type: "messages", sessionID: sessionId, messages: this.readCachedMessages(sessionId) });
  }

  private maybeStopBridge(): void {
    if (this.ctx.getWebSockets().length === 0) {
      this.bridgeAbort?.abort();
      this.bridgeAbort = null;
      this.bridgeActive = false;
      this.ctx.storage.deleteAlarm();
    }
  }

  // Reliability backstop: while clients are connected, re-check the bridge periodically
  // (reconnect after an SSE drop, or connect once the box comes up).
  async alarm(): Promise<void> {
    if (this.ctx.getWebSockets().length === 0) return;
    await this.ensureBridge();
    await this.ctx.storage.setAlarm(Date.now() + 30_000);
  }

  private async readSSE(abort: AbortController): Promise<void> {
    try {
      const res = await fetch(new URL("/opencode/event", this.env.FLY_BASE_URL), {
        headers: upstreamHeaders(this.env),
        signal: abort.signal,
      });
      if (!res.ok || !res.body) return;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          try { await this.onEvent(JSON.parse(dataLine.slice(5).trim())); } catch { /* skip bad frame */ }
        }
      }
    } catch {
      /* aborted or network error — alarm will retry */
    } finally {
      this.bridgeActive = false;
      this.bridgeAbort = null;
    }
  }

  private async onEvent(payload: any): Promise<void> {
    const type = payload?.type;
    const props = payload?.properties || {};

    // Relay the raw event FIRST, before any cache bookkeeping (same shapes the SPA already handles).
    // message.part.updated fires once per token chunk during a response; anything awaited ahead of
    // this broadcast — e.g. a D1 write — serializes the whole stream behind it, so the browser only
    // sees the reply once it finishes instead of token by token.
    this.broadcast({ type: "event", event: payload });

    if (type === "session.created" || type === "session.updated") {
      if (props.info?.id) this.cacheSession(props.info);
    } else if (type === "session.deleted" || type === "session.removed") {
      const id = props.info?.id || props.sessionID;
      if (id) { this.sql("DELETE FROM sessions WHERE id = ?", id); this.sql("DELETE FROM session_messages WHERE session_id = ?", id); }
    } else if (type === "message.updated" || type === "message.part.updated") {
      this.touchActivity(); // throttled + fire-and-forget; must never block the relay loop
    } else if (type === "session.idle" && props.sessionID) {
      // Response finished — pull the authoritative messages so the cache (and offline view) is current.
      const live = await fetchUpstreamJson<any[]>(this.env, `/opencode/session/${encodeURIComponent(props.sessionID)}/message`);
      if (Array.isArray(live)) this.cacheMessages(props.sessionID, live);
    }
  }

  // ---------------------------------------------------------------- SQLite cache

  // Make the cache exactly match the upstream list: upsert everything present, and delete any
  // cached session (and its messages) that opencode no longer has.
  private reconcileSessions(list: any[]): void {
    const liveIds = new Set<string>(list.map((s) => s?.id).filter(Boolean));
    for (const row of this.sql("SELECT id FROM sessions").toArray() as { id: string }[]) {
      if (!liveIds.has(row.id)) {
        this.sql("DELETE FROM sessions WHERE id = ?", row.id);
        this.sql("DELETE FROM session_messages WHERE session_id = ?", row.id);
      }
    }
    for (const s of list) this.cacheSession(s);
  }

  private cacheSession(s: any): void {
    if (!s?.id) return;
    const now = new Date().toISOString();
    this.sql(
      `INSERT INTO sessions (id, title, created_at, updated_at, data, synced_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at,
         data = excluded.data, synced_at = excluded.synced_at`,
      s.id,
      s.title ?? null,
      msToIso(s.time?.created),
      msToIso(s.time?.updated) ?? now,
      JSON.stringify(s),
      now,
    );
  }

  // Server-side snapshot for SSR pre-fetch (AppShell.astro): the same cached session list the
  // WebSocket sends on connect, read straight from the durable cache — no upstream call, doesn't
  // wake the Fly box. Lets the session rail paint on first paint instead of after the WS round-trip.
  async snapshotSessions(): Promise<unknown[]> {
    return this.readCachedSessions();
  }

  private readCachedSessions(): unknown[] {
    return this.sql("SELECT data FROM sessions ORDER BY updated_at DESC LIMIT 200")
      .toArray()
      .map((r: any) => JSON.parse(r.data as string));
  }

  private cacheMessages(sessionId: string, messages: any[]): void {
    this.sql("DELETE FROM session_messages WHERE session_id = ?", sessionId);
    messages.forEach((m, i) =>
      this.sql(
        "INSERT INTO session_messages (session_id, message_id, idx, data) VALUES (?, ?, ?, ?)",
        sessionId,
        m.info?.id ?? String(i),
        i,
        JSON.stringify(m),
      ),
    );
  }

  private readCachedMessages(sessionId: string): unknown[] {
    return this.sql("SELECT data FROM session_messages WHERE session_id = ? ORDER BY idx ASC", sessionId)
      .toArray()
      .map((r: any) => JSON.parse(r.data as string));
  }

  // Stamp the idle-stop activity clock. Throttled in memory and fire-and-forget: a cross-service
  // D1 write per streamed token would stall the SSE relay, and the cron only needs minute-level
  // freshness (see ACTIVITY_WRITE_INTERVAL_MS).
  private touchActivity(): void {
    const now = Date.now();
    if (now - this.lastActivityWrite < ACTIVITY_WRITE_INTERVAL_MS) return;
    this.lastActivityWrite = now;
    this.env.DB.prepare(
      `INSERT INTO activity (id, last_active_at) VALUES ('machine', ?)
       ON CONFLICT(id) DO UPDATE SET last_active_at = excluded.last_active_at`,
    )
      .bind(new Date().toISOString())
      .run()
      .catch(() => { /* best-effort; the reconcile cron self-heals on its next tick */ });
  }
}

function msToIso(ms: unknown): string | null {
  return typeof ms === "number" ? new Date(ms).toISOString() : null;
}

// Cheap "did the message list change?" fingerprint: count + the last message's id and end time.
// Catches new turns, completions, and reverts/compactions (which change the count) without
// serializing the whole (possibly huge) thread.
function messagesSignature(messages: any[]): string {
  const last = messages[messages.length - 1];
  const t = last?.info?.time;
  return `${messages.length}:${last?.info?.id ?? ""}:${t?.completed ?? t?.updated ?? t?.created ?? ""}`;
}
