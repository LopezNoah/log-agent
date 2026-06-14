// opencode phone — single-page chat over the proxied opencode server API.
// All /opencode/* calls are same-origin; the browser carries the Basic-auth credential
// it already used to load this page. Live updates arrive over the /opencode/event SSE stream.

const $ = (sel) => document.querySelector(sel);
const els = {
  sessionList: $("#session-list"),
  thread: $("#thread"),
  empty: $("#empty"),
  composer: $("#composer"),
  input: $("#input"),
  newSession: $("#new-session"),
  machineDot: $("#machine-dot"),
  machineState: $("#machine-state"),
  machineToggle: $("#machine-toggle"),
};

const state = {
  sessions: [],
  activeId: null,
  messages: new Map(), // messageID -> { info, parts: Map<partID, part>, order: [] }
  events: null,
};

// --------------------------------------------------------------------------- api

async function api(path, opts = {}) {
  const res = await fetch("/opencode" + path, { credentials: "same-origin", ...opts });
  if (!res.ok) throw new Error(`${opts.method || "GET"} ${path} → ${res.status}`);
  return res.status === 204 ? null : res.json();
}

async function getMachine() {
  try {
    const { machine } = await fetch("/api/machine", { credentials: "same-origin" }).then((r) => r.json());
    return String(machine?.state || "unknown");
  } catch {
    return "unknown";
  }
}

// --------------------------------------------------------------------------- machine

function renderMachine(stateStr) {
  els.machineDot.className = "dot " + stateStr;
  els.machineState.textContent = stateStr;
  const running = stateStr === "started" || stateStr === "starting";
  els.machineToggle.textContent = running ? "Stop" : "Start";
  els.machineToggle.dataset.action = running ? "stop" : "start";
}

async function pollMachine() {
  renderMachine(await getMachine());
}

els.machineToggle.addEventListener("click", async () => {
  const action = els.machineToggle.dataset.action || "start";
  els.machineToggle.disabled = true;
  els.machineState.textContent = action === "start" ? "starting…" : "stopping…";
  try {
    await fetch(`/api/machine/${action}`, { method: "POST", credentials: "same-origin" });
    if (action === "start") await waitForStarted();
  } catch (e) {
    toast(String(e));
  } finally {
    els.machineToggle.disabled = false;
    await pollMachine();
  }
});

async function waitForStarted() {
  for (let i = 0; i < 40; i++) {
    if ((await getMachine()) === "started") {
      await boot();
      return;
    }
    await sleep(2000);
  }
}

// --------------------------------------------------------------------------- sessions

function fmtTime(t) {
  const ms = t?.updated || t?.created || t;
  if (!ms) return "";
  const d = new Date(typeof ms === "number" ? ms : Date.parse(ms));
  if (isNaN(d)) return "";
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function renderSessions() {
  els.sessionList.innerHTML = "";
  for (const s of state.sessions) {
    const btn = document.createElement("button");
    btn.className = "session-item" + (s.id === state.activeId ? " active" : "");
    btn.innerHTML = `${escapeHtml(s.title || "Untitled session")}<span class="ts">${escapeHtml(fmtTime(s.time))}</span>`;
    btn.addEventListener("click", () => selectSession(s.id));
    els.sessionList.appendChild(btn);
  }
}

async function loadSessions() {
  const list = await api("/session");
  state.sessions = (Array.isArray(list) ? list : []).sort(
    (a, b) => (b.time?.updated || b.time?.created || 0) - (a.time?.updated || a.time?.created || 0),
  );
  renderSessions();
}

async function newSession() {
  const s = await api("/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  state.sessions.unshift(s);
  await selectSession(s.id);
}

async function selectSession(id) {
  state.activeId = id;
  state.messages.clear();
  renderSessions();
  els.composer.hidden = false;
  els.empty.style.display = "none";
  try {
    const history = await api(`/session/${id}/message`);
    for (const item of Array.isArray(history) ? history : []) ingestMessage(item);
  } catch (e) {
    toast(String(e));
  }
  renderThread(true);
  els.input.focus();
}

// --------------------------------------------------------------------------- message store

// Accepts either { info, parts:[...] } or a flat message object; tolerant to schema drift.
function ingestMessage(item) {
  const info = item?.info || item;
  if (!info?.id) return null;
  let entry = state.messages.get(info.id);
  if (!entry) {
    entry = { info, parts: new Map(), order: [] };
    state.messages.set(info.id, entry);
  } else {
    entry.info = { ...entry.info, ...info };
  }
  const parts = item?.parts || info?.parts || [];
  for (const p of parts) upsertPart(entry, p);
  return entry;
}

function upsertPart(entry, part) {
  if (!part) return;
  const id = part.id || part.callID || `${part.type}-${entry.order.length}`;
  if (!entry.parts.has(id)) entry.order.push(id);
  entry.parts.set(id, { ...(entry.parts.get(id) || {}), ...part });
}

function onMessageUpdated(info) {
  if (!info?.id) return;
  // Drop optimistic local bubbles once the real user message lands.
  if (info.role === "user") {
    for (const key of [...state.messages.keys()]) if (key.startsWith("local-")) state.messages.delete(key);
  }
  ingestMessage({ info });
  if (belongsToActive(info)) renderThread();
}

function onPartUpdated(part) {
  if (!part?.messageID) return;
  let entry = state.messages.get(part.messageID);
  if (!entry) {
    entry = { info: { id: part.messageID, sessionID: part.sessionID, role: "assistant" }, parts: new Map(), order: [] };
    state.messages.set(part.messageID, entry);
  }
  upsertPart(entry, part);
  if (belongsToActive(entry.info) || part.sessionID === state.activeId) renderThread();
}

function belongsToActive(info) {
  return info?.sessionID === state.activeId;
}

// --------------------------------------------------------------------------- rendering

function orderedMessages() {
  return [...state.messages.values()]
    .filter((m) => m.info.sessionID === state.activeId || m.info.id?.startsWith("local-"))
    .sort((a, b) => (a.info.time?.created || 0) - (b.info.time?.created || 0));
}

function renderThread(scroll = false) {
  const nearBottom = els.thread.scrollHeight - els.thread.scrollTop - els.thread.clientHeight < 120;
  els.thread.querySelectorAll(".msg").forEach((n) => n.remove());

  for (const m of orderedMessages()) {
    const node = document.createElement("div");
    node.className = "msg " + (m.info.role || "assistant");
    const body = m.info.role === "user" ? renderUser(m) : renderAssistant(m);
    node.innerHTML = `<div class="role">${escapeHtml(m.info.role || "assistant")}</div>${body}`;
    els.thread.appendChild(node);
  }

  if (scroll || nearBottom) els.thread.scrollTop = els.thread.scrollHeight;
}

function renderUser(m) {
  const text = m.order.map((id) => m.parts.get(id)).filter((p) => p?.type === "text").map((p) => p.text).join("");
  return `<div class="bubble">${escapeHtml(text || textFallback(m))}</div>`;
}

function renderAssistant(m) {
  let html = "";
  let streaming = !m.info.time?.completed;
  for (const id of m.order) {
    const p = m.parts.get(id);
    if (!p) continue;
    if (p.type === "text" || p.type === "reasoning") {
      if (p.text) html += `<div class="text">${escapeHtml(p.text)}</div>`;
    } else if (p.type === "tool") {
      html += renderTool(p);
    }
  }
  if (!html && streaming) html = `<div class="text"></div>`;
  if (streaming) html += `<span class="caret"></span>`;
  return html;
}

function renderTool(p) {
  const name = p.tool || p.name || "tool";
  const st = p.state || {};
  const status = st.status || p.status || "pending";
  const input = st.input ?? p.input;
  const output = st.output ?? p.output ?? st.error ?? p.error;
  const body = [
    input != null ? "› " + stringify(input) : "",
    output != null ? stringify(output) : "",
  ].filter(Boolean).join("\n\n");
  return `<details class="tool"${status === "error" ? " open" : ""}>
    <summary><span class="tname">${escapeHtml(name)}</span><span class="tstate ${escapeHtml(status)}">${escapeHtml(status)}</span></summary>
    ${body ? `<pre>${escapeHtml(body)}</pre>` : ""}
  </details>`;
}

function textFallback(m) {
  const p = m.order.map((id) => m.parts.get(id)).find((x) => x?.text);
  return p?.text || "";
}

// --------------------------------------------------------------------------- send

els.composer.addEventListener("submit", (e) => { e.preventDefault(); send(); });
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
});
els.input.addEventListener("input", () => {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 220) + "px";
});

async function send() {
  const text = els.input.value.trim();
  if (!text || !state.activeId) return;
  els.input.value = "";
  els.input.style.height = "auto";

  // Optimistic user bubble; replaced when the server echoes the real message.
  const localId = "local-" + Date.now();
  state.messages.set(localId, {
    info: { id: localId, role: "user", sessionID: state.activeId, time: { created: Date.now() } },
    parts: new Map([["t", { type: "text", text }]]),
    order: ["t"],
  });
  renderThread(true);

  try {
    await api(`/session/${state.activeId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text }] }),
    });
  } catch (e) {
    toast("Send failed: " + e);
  }
}

// --------------------------------------------------------------------------- events (SSE)

function connectEvents() {
  if (state.events) state.events.close();
  const es = new EventSource("/opencode/event", { withCredentials: true });
  state.events = es;
  es.onmessage = (ev) => {
    let payload;
    try { payload = JSON.parse(ev.data); } catch { return; }
    handleEvent(payload);
  };
  es.onerror = () => { /* EventSource auto-reconnects */ };
}

function handleEvent(payload) {
  const type = payload?.type;
  const props = payload?.properties || payload?.data || {};
  if (type === "message.updated") onMessageUpdated(props.info || props.message);
  else if (type === "message.part.updated") onPartUpdated(props.part);
  else if (type === "message.removed" && props.messageID) { state.messages.delete(props.messageID); renderThread(); }
  else if (type === "session.updated") syncSession(props.info || props.session);
  else if (type === "session.deleted" || type === "session.removed") removeSession(props.info?.id || props.sessionID);
}

function syncSession(s) {
  if (!s?.id) return;
  const i = state.sessions.findIndex((x) => x.id === s.id);
  if (i === -1) state.sessions.unshift(s); else state.sessions[i] = { ...state.sessions[i], ...s };
  renderSessions();
}

function removeSession(id) {
  state.sessions = state.sessions.filter((x) => x.id !== id);
  if (state.activeId === id) { state.activeId = null; els.composer.hidden = true; els.empty.style.display = ""; }
  renderSessions();
}

// --------------------------------------------------------------------------- boot

els.newSession.addEventListener("click", () => newSession().catch((e) => toast(String(e))));

async function boot() {
  await loadSessions();
  connectEvents();
  if (!state.activeId && state.sessions[0]) await selectSession(state.sessions[0].id);
}

async function init() {
  await pollMachine();
  setInterval(pollMachine, 15000);
  const machine = await getMachine();
  if (machine === "started") {
    await boot();
  } else {
    els.empty.innerHTML = `<h1>opencode phone</h1><p>The machine is ${escapeHtml(machine)}.</p>
      <button class="btn primary" id="wake">Start machine</button>`;
    $("#wake").addEventListener("click", () => els.machineToggle.click());
  }
}

// --------------------------------------------------------------------------- utils

function stringify(v) { return typeof v === "string" ? v : JSON.stringify(v, null, 2); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

init();
