// opencode phone — single-page chat over the proxied opencode server API.
// All /opencode/* calls are same-origin; the browser carries the Basic-auth credential
// it already used to load this page. Live updates arrive over the /opencode/event SSE stream.

import { openSettings } from "./settings.js";
import { mountArtifact, parseRichText, computeDiff } from "./artifacts.js";
import { $, els } from "./dom.js";
import { setupGithubProject } from "./github-project.js";
import { state } from "./state.js";
import { api, ensureAuthed, fsApi, getMachine, loadDefaultModel } from "./api.js";
import { setupMarkdown, renderMarkdown } from "./markdown.js";
import { closeSidebar, setupMobile } from "./mobile.js";
import { confirmAction, escapeHtml, sleep, stringify, toast } from "./utils.js";
import { mountSessionList } from "../client/session-list.tsx";
import { mountComposer } from "../client/composer.tsx";
import { mountThread } from "../client/thread.tsx";
import { mountFilesPane } from "../client/files-pane.tsx";
import { mountApp } from "../client/app.tsx";

// Render the Remix layout into #root BEFORE anything else: every top-level els.* access below and
// the per-region renderers depend on these nodes existing. dom.js resolves els lazily, so this is
// the single point that must run first.
mountApp(document.getElementById("root"));

// Remix component handles, assigned in init() once their mount hosts exist (see mountThread /
// mountFilesPane). renderThread()/renderFiles() guard on these so pre-init calls are no-ops.
let threadApi = null;

// --------------------------------------------------------------------------- machine

const RUNNING = "started";
const TRANSITION = new Set(["starting", "stopping"]); // mid-flight states the poll waits out
const STATE_LABEL = {
  started: "Running", starting: "Starting…", stopping: "Stopping…",
  stopped: "Stopped", suspended: "Stopped", created: "Stopped", unknown: "Unknown",
};

function renderMachine(stateStr) {
  const running = stateStr === RUNNING;
  const starting = stateStr === "starting";
  const stopping = stateStr === "stopping";
  els.machineDot.className = "dot " + stateStr;
  els.machineState.textContent = STATE_LABEL[stateStr] || stateStr;
  // Offer "Stop" for a running OR starting machine (so you can cancel a slow start) — only block
  // clicks while actively stopping. This guarantees the control never locks you out.
  const showStop = running || starting;
  els.machineToggle.disabled = stopping;
  els.machineToggle.textContent = stopping ? "Stopping…" : showStop ? "Stop machine" : "Start machine";
  els.machineToggle.dataset.action = showStop ? "stop" : "start";
  // "Start" is the call-to-action (primary); "Stop"/busy are quieter ghost buttons.
  els.machineToggle.classList.toggle("btn-primary", !showStop && !stopping);
  els.machineToggle.classList.toggle("btn-ghost", showStop || stopping);
}

async function refreshMachine(known) {
  const stateStr = known ?? await getMachine();
  const wasOn = state.machineOn;
  state.machineOn = stateStr === RUNNING;
  renderMachine(stateStr);
  updateMode();
  if (state.machineOn && !wasOn) await onMachineUp();
  else if (!state.machineOn && wasOn) onMachineDown();
}

// When the box comes up: load agents and nudge the DO to (re)connect its opencode bridge,
// then refresh the open session. Live updates always arrive over the same /sync WebSocket.
async function onMachineUp() {
  await loadAgents();
  await refreshFiles().catch(() => {});
  syncSend({ type: "sync" });
  if (state.activeId) syncSend({ type: "open", sessionID: state.activeId });
}

function onMachineDown() {
  state.files.root = null;
  state.files.nodes.clear();
  state.files.selected = "";
  state.files.selectedType = "directory";
  state.files.selectedMtime = "";
  state.files.dirty = false;
  state.files.editorOpen = false;
  filesPane?.clearEditor();
  renderFiles("Start the machine to browse files.");
}

// --------------------------------------------------------------------------- filesystem view

// The files pane is a Remix (remix/ui) component mounted into #files-host (see init()). It owns the
// toolbar (New file / New folder / Rename / Delete), the status line, the tree, and the editor —
// wiring those to the callbacks renderFiles() feeds. The HEADER's #files-refresh button (not
// rendered by the component) stays wired here; #files-close stays wired by mobile.js.
els.filesRefresh.addEventListener("click", () => refreshFiles(true).catch((e) => toast("File refresh failed: " + e.message)));

let filesPane = null;
let filesRefreshTimer = 0;

function scheduleFilesRefresh(delay = 700) {
  if (!state.machineOn) return;
  clearTimeout(filesRefreshTimer);
  filesRefreshTimer = setTimeout(() => {
    refreshFiles(false, { silent: true }).catch(() => {});
  }, delay);
}

async function refreshFiles(force = false, options = {}) {
  if (!state.machineOn) { renderFiles("Start the machine to browse files."); return; }
  if (state.files.loading) return;
  const silent = options.silent === true;
  state.files.loading = true;
  if (!silent) renderFiles("Loading files…");
  try {
    state.files.nodes.clear();
    await loadTree("", force ? 2 : 1);
    for (const path of [...state.files.expanded]) {
      if (path) await loadTree(path, 1).catch(() => {});
    }
    await syncOpenFileAfterRefresh();
    state.files.loading = false;
    renderFiles();
  } catch (e) {
    state.files.loading = false;
    if (!silent) renderFiles("Could not load files.");
    throw e;
  } finally {
    state.files.loading = false;
  }
}

async function loadTree(path, depth = 1) {
  const data = await fsApi(`/fs/tree?path=${encodeURIComponent(path)}&depth=${depth}`);
  if (!data?.tree) return;
  if (!path) state.files.root = data.tree;
  indexFileNode(data.tree);
}

function indexFileNode(node) {
  state.files.nodes.set(node.path || "", node);
  for (const child of node.children || []) indexFileNode(child);
}

// renderFiles() stays the single re-render seam the rest of the app calls — it now bridges current
// state.files to the mounted files pane (projection + callbacks) instead of building DOM by hand.
// The `status` argument maps to props.status; the component supplies "Workspace is empty." itself.
function renderFiles(status) {
  filesPane?.update({
    root: state.files.root,
    expanded: state.files.expanded,
    selected: state.files.selected,
    status: status || "",
    machineOn: state.machineOn,
    editorOpen: state.files.editorOpen,
    selectedType: state.files.selectedType,
    dirty: state.files.dirty,
    onSelectFile: (path) => { openFile(path).catch((e) => toast("Open failed: " + e.message)); },
    onToggleDir: (path) => { toggleFolder(path).catch((e) => toast("Open failed: " + e.message)); },
    onNewFile: () => { createFile().catch((e) => toast("Create file failed: " + e.message)); },
    onNewFolder: () => { createFolder().catch((e) => toast("Create folder failed: " + e.message)); },
    onRename: () => { renameSelected().catch((e) => toast("Rename failed: " + e.message)); },
    onDelete: (anchor) => { deleteSelected(anchor).catch((e) => toast("Delete failed: " + e.message)); },
    onRefresh: () => { refreshFiles(true).catch((e) => toast("File refresh failed: " + e.message)); },
    onClose: () => {}, // mobile.js handles the header close button
    onSave: () => { saveOpenFile().catch((e) => toast("Save failed: " + e.message)); },
    onEditorInput: () => { state.files.dirty = true; renderFiles(); },
  });
}

async function toggleFolder(path) {
  const wasExpanded = state.files.expanded.has(path);
  state.files.selected = path;
  state.files.selectedType = "directory";
  state.files.editorOpen = false;
  if (wasExpanded) state.files.expanded.delete(path);
  else {
    state.files.expanded.add(path);
    const node = state.files.nodes.get(path);
    if (!node?.children) await loadTree(path, 1);
  }
  renderFiles();
}

async function openFile(path) {
  if (state.files.dirty && !confirm("Discard unsaved file changes?")) return;
  const file = await fsApi(`/fs/file?path=${encodeURIComponent(path)}`);
  state.files.selected = path;
  state.files.selectedType = "file";
  state.files.selectedMtime = file.mtime || state.files.nodes.get(path)?.mtime || "";
  state.files.dirty = false;
  state.files.editorOpen = true;
  filesPane?.setEditor(path, file.content || "");
  renderFiles();
}

async function saveOpenFile() {
  if (!state.files.selected || state.files.selectedType !== "file") return;
  await fsApi("/fs/file", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: state.files.selected, content: filesPane?.getEditorValue() ?? "" }),
  });
  state.files.dirty = false;
  toast("Saved " + state.files.selected);
  await refreshFiles();
}

async function createFile() {
  if (!state.machineOn) return;
  const base = currentDirectory();
  const rel = prompt("New file path", base ? base + "/untitled.txt" : "untitled.txt");
  if (!rel) return;
  await fsApi("/fs/file", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: rel, content: "" }),
  });
  state.files.expanded.add(dirname(rel));
  await refreshFiles(true);
  await openFile(rel);
}

async function createFolder() {
  if (!state.machineOn) return;
  const base = currentDirectory();
  const rel = prompt("New folder path", base ? base + "/new-folder" : "new-folder");
  if (!rel) return;
  await fsApi("/fs/mkdir", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: rel }),
  });
  state.files.expanded.add(dirname(rel));
  await refreshFiles(true);
}

async function renameSelected() {
  const from = state.files.selected;
  if (!from) return;
  const to = prompt("Rename path", from);
  if (!to || to === from) return;
  await fsApi("/fs/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, to }),
  });
  state.files.expanded.add(dirname(to));
  state.files.expanded.delete(from);
  state.files.selected = to;
  // The editor path is props-driven (selected + selectedType); just re-render to reflect the rename.
  await refreshFiles(true);
}

async function deleteSelected(anchor) {
  const rel = state.files.selected;
  if (!rel) return;
  const isDir = state.files.selectedType === "directory";
  const detail = isDir ? " and everything inside it" : "";
  const ok = await confirmAction(anchor || els.fileDelete, {
    title: `Delete ${isDir ? "folder" : "file"}?`,
    body: `${rel}${detail} — this can't be undone.`,
  });
  if (!ok) return;
  await fsApi(`/fs/path?path=${encodeURIComponent(rel)}`, { method: "DELETE" });
  state.files.selected = "";
  state.files.selectedType = "directory";
  state.files.selectedMtime = "";
  state.files.dirty = false;
  state.files.editorOpen = false;
  filesPane?.clearEditor();
  await refreshFiles(true);
}

async function syncOpenFileAfterRefresh() {
  const selected = state.files.selected;
  if (!selected) return;
  const node = state.files.nodes.get(selected);
  if (!node) {
    state.files.selected = "";
    state.files.selectedType = "directory";
    state.files.selectedMtime = "";
    state.files.dirty = false;
    state.files.editorOpen = false;
    filesPane?.clearEditor();
    return;
  }
  if (state.files.selectedType !== "file") return;
  if (node.type !== "file") {
    state.files.selectedType = node.type;
    state.files.selectedMtime = node.mtime || "";
    state.files.editorOpen = false;
    filesPane?.clearEditor();
    return;
  }
  if (state.files.dirty) return;
  if (state.files.selectedMtime && node.mtime === state.files.selectedMtime) return;
  const file = await fsApi(`/fs/file?path=${encodeURIComponent(selected)}`);
  if (state.files.selected !== selected || state.files.dirty) return;
  state.files.selectedMtime = file.mtime || node.mtime || "";
  state.files.editorOpen = true;
  filesPane?.setEditor(selected, file.content || "");
}

function currentDirectory() {
  if (!state.files.selected) return "";
  return state.files.selectedType === "directory" ? state.files.selected : dirname(state.files.selected);
}

function dirname(rel) {
  const parts = String(rel || "").split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

// Composer is shown only when the box is up and a session is open. When the box is off we
// show a read-only banner so saved sessions stay browsable.
function updateMode() {
  if (state.machineOn) {
    els.offlineBanner.hidden = true;
    els.composer.hidden = !state.activeId;
  } else {
    els.composer.hidden = true;
    els.offlineBanner.hidden = !state.activeId;
    if (state.activeId) {
      els.offlineBanner.innerHTML =
        `<span>Machine is off — viewing the saved copy (read-only).</span>
         <button class="btn primary" id="banner-start" type="button">Start machine to chat</button>`;
      $("#banner-start").addEventListener("click", () => els.machineToggle.click());
    }
  }
  renderSessionBar();
  renderComposerState();
}

els.machineToggle.addEventListener("click", () => toggleMachine());

let polling = false;

async function toggleMachine() {
  const action = els.machineToggle.dataset.action || "start";
  renderMachine(action === "start" ? "starting" : "stopping"); // instant feedback
  try {
    const res = ensureAuthed(await fetch(`/api/machine/${action}`, { method: "POST", credentials: "same-origin" }));
    if (!res.ok) throw new Error(`Could not ${action} the machine (${res.status})`);
  } catch (e) {
    toast(String(e.message || e));
  }
  // The start request may block server-side until healthy; either way, fast-poll the REAL state
  // until it settles. refreshMachine() is authoritative — it always wins over optimistic labels.
  await refreshMachine();
  pollUntilSettled();
}

// Fast-poll the authoritative machine state until it stops transitioning, then hand back to the
// slow background interval. Always renders the real state, so the UI can never get stuck.
async function pollUntilSettled() {
  if (polling) return;
  polling = true;
  try {
    for (let i = 0; i < 60; i++) {
      const s = await getMachine();
      await refreshMachine(s);
      if (!TRANSITION.has(s)) return; // settled: started / stopped / suspended / unknown
      await sleep(2000);
    }
  } finally {
    polling = false;
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

// The session rail is a Remix (remix/ui) component mounted into #session-list (see init()).
// renderSessions() stays the single re-render seam the rest of the app calls — it now just feeds
// fresh props to the mounted root instead of rebuilding the DOM by hand.
let updateSessionList = null;
function renderSessions() {
  updateSessionList?.({
    sessions: state.sessions,
    activeId: state.activeId,
    fmtTime,
    onSelect: selectSession,
    onRename: renameSession,
    onDelete: deleteSession,
  });
}

async function renameSession(s, title) {
  const next = String(title || "").trim();
  if (!next || next === s.title) return;
  try {
    await api(`/session/${s.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: next }),
    });
    s.title = next;
    renderSessions();
  } catch (e) {
    toast("Rename failed: " + e);
  }
}

// The composer is a Remix (remix/ui) component mounted into #composer (see init()). renderComposer()
// pushes current state + action callbacks to it. The legacy renderComposerState()/renderSessionBar()
// names stay as thin delegates so their many call sites keep working.
let updateComposer = null;
let composerApi = null;
function renderComposer() {
  updateComposer?.({
    busy: isBusy(),
    reverted: state.machineOn && !!state.activeId && !!activeSession()?.revert,
    agents: state.agents,
    selectedAgent: state.agent,
    autoApprove: state.autoApprove,
    onSend: (text) => { if (!isBusy()) sendText(text); },
    onStop: () => stopActive(),
    onUndo: () => undoLast(),
    onRedo: () => unrevertSession(),
    onCompact: () => compactSession(),
    onFork: () => forkSession(),
    onAgentChange: (name) => { state.agent = name; },
    onAutoApproveChange: (checked) => {
      state.autoApprove = checked;
      localStorage.setItem("oc.autoApprove", checked ? "1" : "0");
      if (state.activeId) applyPermission(state.activeId, state.autoApprove);
    },
  });
}

async function deleteSession(s, anchor) {
  const ok = await confirmAction(anchor, {
    title: "Delete session?",
    body: `"${s.title || "Untitled session"}" will be permanently removed.`,
  });
  if (!ok) return;
  try {
    await api(`/session/${s.id}`, { method: "DELETE" });
    removeSession(s.id); // the DO also broadcasts session.deleted; removeSession is idempotent
    toast("Session deleted");
  } catch (e) {
    toast("Delete failed: " + e);
  }
}

async function loadAgents() {
  try {
    const agents = await api("/agent");
    const primary = (Array.isArray(agents) ? agents : []).filter((a) => a.mode === "primary" && a.description);
    if (!primary.length) return;
    state.agents = primary.map((a) => ({ name: a.name, label: a.name.charAt(0).toUpperCase() + a.name.slice(1) }));
    state.agent = primary.some((a) => a.name === "build") ? "build" : primary[0].name;
    renderComposer();
  } catch {
    /* agents unavailable until the box is up; ignore */
  }
}

// Auto-approve: a per-session permission ruleset. Allow-all means opencode runs every tool
// (bash, edit, …) without prompting — stored with the session, so it holds even after the
// machine restarts mid-task. The Plan agent still blocks edits regardless.
const ALLOW_ALL = [{ permission: "*", pattern: "**", action: "allow" }];

async function applyPermission(id, allow) {
  if (!id) return;
  try {
    await api(`/session/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permission: allow ? ALLOW_ALL : [] }),
    });
  } catch (e) {
    toast("Auto-approve update failed: " + e);
  }
}

async function newSession() {
  const s = await api("/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  state.sessions.unshift(s);
  await applyPermission(s.id, state.autoApprove);
  syncSend({ type: "sync" }); // nudge the DO to pick up the new session
  await selectSession(s.id);
}

// History comes from the DO over the /sync WebSocket: request it, render when it arrives
// (onSyncMessage → "messages"). Works whether the box is on or off.
// `mode` controls URL history: "push" (a user navigation), "replace" (initial/auto-select), or
// "none" (we're reacting to a back/forward popstate, so don't touch history).
function selectSession(id, mode = "push") {
  closeSidebar();
  state.activeId = id;
  state.messages.clear();
  renderSessions();
  updateMode();
  renderThread(true);
  syncSend({ type: "open", sessionID: id });
  if (state.machineOn) composerApi?.focusInput();
  if (mode === "push") history.pushState({ session: id }, "", sessionHref(id));
  else if (mode === "replace") history.replaceState({ session: id }, "", sessionHref(id));
}

// URL routing: each session lives at /sessions/<id>. The Astro route src/pages/sessions/[id].astro
// serves the app shell there, so deep-links and reloads land on the right session.
function sessionFromUrl() {
  const m = location.pathname.match(/^\/sessions\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}
function sessionHref(id) {
  return id ? "/sessions/" + encodeURIComponent(id) : "/";
}
window.addEventListener("popstate", () => {
  const id = sessionFromUrl();
  if (id && id !== state.activeId) selectSession(id, "none");
});

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
  if (info.role === "assistant" && info.time?.completed) scheduleFilesRefresh(250);
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
  if (part.type === "tool") scheduleFilesRefresh(part.state?.status === "completed" || part.status === "completed" ? 250 : 900);
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
  const prevTop = els.thread.scrollTop;

  // The thread is a Remix (remix/ui) component mounted into #thread-content (see init()). It renders
  // #empty + the pinned section + the .msg list; main.js still owns the rich-content pipeline
  // (renderBody) and the artifact mounts (hydrate/mountPin), plus all the scroll/observer/nav code.
  mountQueue = []; // bound cross-render accumulation (matches the old reset; renderBody pushes into it)
  threadApi?.update({
    messages: orderedMessages(),
    revertBoundary: revertBoundaryCreated(),
    machineOn: state.machineOn,
    pins: pinsFor(state.activeId).map((spec, i) => ({
      domId: "pin_" + String(spec.__id ?? i).replace(/[^A-Za-z0-9_-]/g, ""),
      spec,
    })),
    renderBody: (m) => (m.info.role === "user" ? renderUser(m) : renderAssistant(m)),
    hydrate: () => drainArtifacts(),
    mountPin: (slotEl, pin) => mountArtifact(slotEl, pin.spec, artifactCtx(pin.spec)),
    onAct: (action, id, anchor) => {
      if (action === "edit") editMessage(id);
      else if (action === "revert") revertToMessage(id, "Reverted — use Redo to restore.");
      else if (action === "fork") forkSession(id);
      else if (action === "copy") copyMessage(id);
      else if (action === "delete") deleteMessage(id, anchor);
    },
  });
  renderUsageTotal();
  renderThreadNav();

  // Auto-scroll itself is owned by the ResizeObserver (it fires on content-height changes, never
  // per token). Here we only handle the two cases the observer can't: (a) an explicit request
  // (open/select/send) snaps to bottom and re-arms following; (b) when NOT following, restore the
  // pre-rebuild scrollTop so tearing down + rebuilding .msg nodes never nudges your reading spot.
  if (scroll) { following = true; els.thread.scrollTop = els.thread.scrollHeight; }
  else if (!following) els.thread.scrollTop = prevTop;
  updateScrollAffordances();
}

// --------------------------------------------------------------------------- scroll follow + prompt nav

// Scroll state lives in plain module variables — independent of the render cycle — so the
// auto-scroll decision never jitters with re-render timing (perf tip #2, vanilla equivalent).
//   following — pinned to the bottom; auto-scroll is allowed
//   touching  — a finger is on the thread (mobile): pause auto-scroll until release
let following = true;
let touching = false;
let scrollRaf = 0;
const AT_BOTTOM_PX = 24; // distance from the bottom that still counts as "at the bottom"

function atBottom() {
  return els.thread.scrollHeight - els.thread.scrollTop - els.thread.clientHeight <= AT_BOTTOM_PX;
}

// The ONLY code that programmatically scrolls. Driven by a ResizeObserver on the thread content,
// so it runs when the content's height actually changes (a new line, a tool result) — not on
// every token (perf tip #1).
function maybeAutoScroll() {
  if (following && !touching) els.thread.scrollTop = els.thread.scrollHeight;
  updateScrollAffordances();
}

new ResizeObserver(() => maybeAutoScroll()).observe(els.threadContent);

// Mobile: a finger on the thread pauses auto-scroll outright; releasing resumes it only if the
// user is still at the bottom (the scroll handler keeps `following` accurate during the drag).
els.thread.addEventListener("touchstart", () => { touching = true; }, { passive: true });
els.thread.addEventListener("touchend", () => { touching = false; }, { passive: true });
els.thread.addEventListener("touchcancel", () => { touching = false; }, { passive: true });

function renderThreadNav() {
  const users = orderedMessages().filter((m) => m.info.role === "user" && !m.info.id?.startsWith("local-"));
  if (users.length < 2) { els.threadNav.hidden = true; els.threadNav.innerHTML = ""; return; }
  els.threadNav.hidden = false;
  els.threadNav.innerHTML = users
    .map((m, i) => `<button type="button" class="thread-nav-dot" data-mid="${escapeHtml(m.info.id)}" aria-label="Prompt ${i + 1}" title="${escapeHtml(promptPreview(m))}"></button>`)
    .join("");
  updateActiveDot();
}

function promptPreview(m) {
  const text = m.order.map((id) => m.parts.get(id)).filter((p) => p?.type === "text").map((p) => p.text).join(" ").trim();
  return text.length > 60 ? text.slice(0, 60) + "…" : text || "Prompt";
}

function msgNode(mid) {
  return threadApi?.msgNode(mid) ?? null;
}

function updateScrollAffordances() {
  // Show "↓ Latest" only when we're not following AND there's actually content below the fold.
  els.jumpBottom.hidden = following || atBottom();
  updateActiveDot();
}

// Anchor a just-sent prompt near the top so the response streams in below it (manifesto #4 /
// ChatGPT): the start stays put and we don't pin to the bottom. Scroll down yourself to follow.
function anchorTop(mid) {
  following = false;
  const node = msgNode(mid);
  if (node) node.scrollIntoView({ block: "start", behavior: "auto" });
  updateScrollAffordances();
}

// Highlight the dot for the prompt whose section is currently at/above the top of the viewport.
function updateActiveDot() {
  if (els.threadNav.hidden) return;
  const dots = els.threadNav.querySelectorAll(".thread-nav-dot");
  if (!dots.length) return;
  const threadTop = els.thread.getBoundingClientRect().top;
  let activeMid = dots[0].dataset.mid;
  for (const dot of dots) {
    const node = msgNode(dot.dataset.mid);
    if (node && node.getBoundingClientRect().top - threadTop <= 64) activeMid = dot.dataset.mid;
  }
  dots.forEach((d) => d.toggleAttribute("data-active", d.dataset.mid === activeMid));
}

// A manual scroll up disables following; scrolling back to the bottom re-enables it (manifesto
// #1/#2). Our own auto-scroll lands at the bottom → atBottom() true → following stays on.
els.thread.addEventListener("scroll", () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    following = atBottom();
    updateScrollAffordances();
  });
});

els.jumpBottom.addEventListener("click", () => {
  following = true;
  els.jumpBottom.hidden = true;
  els.thread.scrollTo({ top: els.thread.scrollHeight, behavior: "smooth" });
});

els.threadNav.addEventListener("click", (e) => {
  const dot = e.target.closest(".thread-nav-dot");
  if (!dot) return;
  const node = msgNode(dot.dataset.mid);
  if (!node) return;
  following = false;
  node.scrollIntoView({ behavior: "smooth", block: "start" });
});

function renderUser(m) {
  const text = m.order.map((id) => m.parts.get(id)).filter((p) => p?.type === "text").map((p) => p.text).join("");
  return `<div class="bubble">${escapeHtml(text || textFallback(m))}</div>`;
}

function renderAssistant(m) {
  let html = "";
  let streaming = !m.info.time?.completed;
  const artCtr = { n: 0 }; // per-message artifact index, for stable ids
  for (const id of m.order) {
    const p = m.parts.get(id);
    if (!p || p.ignored) continue;
    if (p.type === "text" || p.type === "reasoning") {
      if (p.text) html += renderRichText(p.text, m.info.id, artCtr);
    } else if (p.type === "tool") {
      html += renderTool(p);
    }
  }
  if (!html && streaming) html = `<div class="text"></div>`;
  if (streaming) html += `<span class="caret"></span>`;
  else html += renderUsage(m.info);
  return html;
}

// --------------------------------------------------------------------------- UI artifacts

let mountQueue = [];                  // [{ domId, spec }] to hydrate after innerHTML is set
const artifactState = new Map();      // ephemeral per-artifact UI state (survives re-renders)

// Render assistant text that may contain fenced ```ui artifact blocks. Markdown segments go
// through the normal pipeline; artifact segments become placeholder slots hydrated by drainArtifacts.
function renderRichText(text, msgId, ctr) {
  let html = "";
  for (const seg of parseRichText(text)) {
    if (seg.kind === "md") {
      html += renderMarkdown(seg.text);
    } else if (seg.kind === "pending") {
      html += `<div class="artifact-pending">▦ building UI…</div>`;
    } else {
      const id = `${msgId}-${ctr.n++}`;
      seg.spec.__id = id;
      const domId = "art_" + id.replace(/[^A-Za-z0-9_-]/g, "");
      mountQueue.push({ domId, spec: seg.spec });
      html += `<div class="artifact-slot" id="${domId}"></div>`;
    }
  }
  return html;
}

function drainArtifacts() {
  for (const { domId, spec } of mountQueue) {
    const slot = document.getElementById(domId);
    if (slot) mountArtifact(slot, spec, artifactCtx(spec));
  }
  mountQueue = [];
}

// Host integration handed to each widget — no widget touches globals directly.
function artifactCtx(spec) {
  const id = spec.__id;
  return {
    state: { get: () => artifactState.get(id), set: (v) => artifactState.set(id, v) },
    sendText: (t) => sendText(t),
    toast,
    openUrl: (u) => { if (u) window.open(u, "_blank", "noopener"); },
    fsTree: (path = "", depth = 1) => fsApi(`/fs/tree?path=${encodeURIComponent(path)}&depth=${depth}`),
    fsFile: (path) => fsApi(`/fs/file?path=${encodeURIComponent(path)}`),
    previewStart: (props = {}) => fsApi("/preview/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(props),
    }),
    previewRestart: (props = {}) => fsApi("/preview/restart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(props),
    }),
    previewStop: (id = "default") => fsApi("/preview/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }),
    previewList: () => fsApi("/preview/list"),
    machineOn: state.machineOn,
    isPinned: (aid) => pinsFor(state.activeId).some((p) => p.__id === aid),
    togglePin: (s) => togglePin(s),
  };
}

// --------------------------------------------------------------------------- pinned widgets

const PIN_KEY = "oc.pins"; // { [sessionId]: UIArtifact[] }

function allPins() {
  try { return JSON.parse(localStorage.getItem(PIN_KEY)) || {}; } catch { return {}; }
}
function pinsFor(sessionId) {
  return (sessionId && allPins()[sessionId]) || [];
}
function setPinsFor(sessionId, pins) {
  const all = allPins();
  if (pins.length) all[sessionId] = pins; else delete all[sessionId];
  localStorage.setItem(PIN_KEY, JSON.stringify(all));
}
function togglePin(spec) {
  if (!state.activeId) return;
  const pins = pinsFor(state.activeId);
  const i = pins.findIndex((p) => p.__id === spec.__id);
  if (i >= 0) pins.splice(i, 1);
  else pins.push({ type: spec.type, props: spec.props, __id: spec.__id });
  setPinsFor(state.activeId, pins);
  renderThread();
}

// Pinned artifacts render in a sticky section at the top of the thread and persist (localStorage)
// across reloads for that session, unlike ephemeral in-message widgets. The thread component now
// renders the pinned section + slots from props.pins; main.js only mounts each slot via mountPin
// (see renderThread) and toggles membership here (togglePin → renderThread re-render).

function fmtTokens(n) {
  if (!n) return "0";
  return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n);
}

function fmtCost(c) {
  return "$" + (c < 0.01 ? c.toFixed(4) : c.toFixed(2));
}

// opencode reports per-message usage on the assistant message info: tokens {input,output,
// reasoning,cache:{read,write}} and cost. Render a compact footer; show nothing if absent.
function renderUsage(info) {
  const t = info?.tokens || {};
  const cost = info?.cost;
  const bits = [];
  if (info?.modelID) bits.push(escapeHtml(info.modelID));
  if (t.input != null || t.output != null) bits.push(`↑ ${fmtTokens(t.input)} ↓ ${fmtTokens(t.output)}`);
  if (t.cache?.read) bits.push(`cache ${fmtTokens(t.cache.read)}`);
  if (typeof cost === "number" && cost > 0) bits.push(fmtCost(cost));
  return bits.length ? `<div class="usage">${bits.join(" · ")}</div>` : "";
}

// Sum cost + tokens across the active session's completed assistant messages.
function renderUsageTotal() {
  let cost = 0;
  let input = 0;
  let output = 0;
  for (const m of orderedMessages()) {
    const info = m.info;
    if (info.role !== "assistant" || !info.time?.completed) continue;
    const t = info.tokens || {};
    cost += typeof info.cost === "number" ? info.cost : 0;
    input += t.input || 0;
    output += t.output || 0;
  }
  const total = input + output;
  const el = els.usageTotal;
  if (!el) return;
  if (!total && !cost) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = `Σ ↑ ${fmtTokens(input)} ↓ ${fmtTokens(output)}` + (cost > 0 ? ` · ${fmtCost(cost)}` : "");
}

// A readable one-line label for a tool call from its input (opencode usually sets state.title,
// but this is a sensible fallback and drives the bash "$ command" line).
function toolLabel(tool, input) {
  if (!input || typeof input !== "object") return "";
  if (tool === "bash") return String(input.command || input.description || "");
  if (tool === "read" || tool === "edit" || tool === "write") return String(input.filePath || input.path || "");
  if (tool === "grep") return String(input.pattern || "");
  if (tool === "glob" || tool === "list") return String(input.pattern || input.path || "");
  if (tool === "webfetch") return String(input.url || "");
  return "";
}

// before/after content for tools that change a file, so they can render in the diff component.
function fileEdit(tool, input) {
  if (!input || typeof input !== "object") return null;
  const filename = input.filePath || input.path || input.file || "";
  if (tool === "write") {
    const after = String(input.content ?? "");
    return after ? { filename, before: "", after } : null;
  }
  if (tool === "edit") {
    const before = String(input.oldString ?? input.old_string ?? "");
    const after = String(input.newString ?? input.new_string ?? "");
    return before || after ? { filename, before, after } : null; // else fall back to generic rendering
  }
  return null;
}

// Build an inline diff as escaped HTML (reuses the .diff* classes from the diff widget) + a
// +adds/-dels stat. Memoized per part so the per-token thread rebuild doesn't re-run the LCS.
const diffCache = new Map();
function diffHtml(partId, before, after) {
  const key = `${partId}:${before.length}:${after.length}`;
  const hit = diffCache.get(key);
  if (hit) return hit;
  let adds = 0, dels = 0, rows = "";
  for (const op of computeDiff(before, after)) {
    const sign = op.t === "add" ? "+" : op.t === "del" ? "-" : " ";
    if (op.t === "add") adds++; else if (op.t === "del") dels++;
    const text = (op.t === "add" ? op.b : op.a) ?? "";
    rows += `<div class="diff-line ${op.t}"><span class="diff-gutter">${sign}</span><span class="diff-text">${escapeHtml(text)}</span></div>`;
  }
  const result = { html: `<pre class="diff">${rows}</pre>`, adds, dels };
  diffCache.set(key, result);
  if (diffCache.size > 200) diffCache.delete(diffCache.keys().next().value);
  return result;
}

function renderTool(p) {
  const st = p.state || {};
  const tool = p.tool || p.name || "tool";
  const status = st.status || p.status || "pending";
  const input = st.input ?? p.input ?? {};
  const output = st.output ?? p.output ?? st.error ?? p.error;
  const label = st.title || toolLabel(tool, input);

  // File changes render as a compact diff: collapsed by default with a +adds/-dels stat in the
  // header (useful at a glance), the diff itself one click away.
  const fe = (tool === "edit" || tool === "write") ? fileEdit(tool, input) : null;
  if (fe) {
    const { html, adds, dels } = diffHtml(p.id || p.callID || tool, fe.before, fe.after);
    const stat = `<span class="diff-stat"><span class="add">+${adds}</span> <span class="del">-${dels}</span></span>`;
    return `<details class="tool tool-diff"${status === "error" ? " open" : ""}>
      <summary><span class="tname">${escapeHtml(tool)}</span><span class="tlabel">${escapeHtml(fe.filename || label)}</span>${stat}<span class="tstate ${escapeHtml(status)}">${escapeHtml(status)}</span></summary>
      <div class="tool-diff-body">${html}</div>
    </details>`;
  }

  const cmd = tool === "bash" && input && typeof input === "object" ? String(input.command || "") : "";
  let body = "";
  if (cmd) body += `<div class="tool-cmd"><span class="tool-cmd-prompt">$</span> ${escapeHtml(cmd)}</div>`;
  else if (input && typeof input === "object" && Object.keys(input).length) body += `<pre class="tool-input">${escapeHtml(stringify(input))}</pre>`;
  if (output != null && String(output) !== "") body += `<pre>${escapeHtml(stringify(output))}</pre>`;

  // Collapsed by default (only errors auto-expand); the command/label in the summary tells you what
  // ran, and the output is one click away.
  return `<details class="tool"${status === "error" ? " open" : ""}>
    <summary><span class="tname">${escapeHtml(tool)}</span>${label ? `<span class="tlabel">${escapeHtml(label)}</span>` : ""}<span class="tstate ${escapeHtml(status)}">${escapeHtml(status)}</span></summary>
    ${body ? `<div class="tool-body">${body}</div>` : ""}
  </details>`;
}

function textFallback(m) {
  const p = m.order.map((id) => m.parts.get(id)).find((x) => x?.text);
  return p?.text || "";
}

// --------------------------------------------------------------------------- send

// Composer input, send/stop, agent picker, auto-approve, and the Safari readonly autofill fix all
// live in the Remix composer component (src/client/composer.tsx); it calls back via renderComposer's
// onSend/onStop/etc. sendText() below is the shared post path (also used by artifact form widgets).

// Post a message to the active session (used by the composer and by artifact widgets, e.g. a
// submitted form). Optimistically shows the user bubble until the server echoes the real message.
async function sendText(text) {
  if (!text || !state.activeId) return;

  const localId = "local-" + Date.now();
  state.messages.set(localId, {
    info: { id: localId, role: "user", sessionID: state.activeId, time: { created: Date.now() } },
    parts: new Map([["t", { type: "text", text }]]),
    order: ["t"],
  });
  setBusy(state.activeId, true); // optimistic; session.idle/error will clear it
  renderThread();
  anchorTop(localId); // pin the prompt to the top; the reply streams in below (no bottom-jump)

  const payload = { parts: [{ type: "text", text }] };
  if (state.agent) payload.agent = state.agent;
  if (state.model && state.model.includes("/")) {
    const i = state.model.indexOf("/");
    payload.model = { providerID: state.model.slice(0, i), modelID: state.model.slice(i + 1) };
  }
  try {
    // No client timeout: a generation can legitimately run for minutes. The reply renders from the
    // SSE stream regardless, so even if this POST is slow we don't want to abort it.
    await api(`/session/${state.activeId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      timeout: 0,
    });
  } catch (e) {
    toast("Send failed: " + e);
  }
}

// --------------------------------------------------------------------------- session & message actions

// All of these hit opencode directly through the same-origin /opencode proxy (api()). They only
// make sense while the box is up, which is also the only time the composer + toolbar are shown.
function post(path, body, extra) {
  return api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}), ...extra });
}

function activeSession() {
  return state.sessions.find((s) => s.id === state.activeId) || null;
}

// providerID/modelID for summarize: prefer the user's selected model, else the session's own model.
function currentModel() {
  if (state.model && state.model.includes("/")) {
    const i = state.model.indexOf("/");
    return { providerID: state.model.slice(0, i), modelID: state.model.slice(i + 1) };
  }
  const s = activeSession();
  if (s?.model?.providerID && s?.model?.id) return { providerID: s.model.providerID, modelID: s.model.id };
  return null;
}

function messageText(m) {
  return m.order
    .map((id) => m.parts.get(id))
    .filter((p) => p?.type === "text" || p?.type === "reasoning")
    .map((p) => p.text)
    .join("");
}

// --- busy state (drives Stop vs Send) ---

function isBusy(id = state.activeId) {
  return !!id && state.busy.has(id);
}

function setBusy(id, on) {
  if (!id) return;
  const changed = on ? !state.busy.has(id) : state.busy.has(id);
  if (on) state.busy.add(id); else state.busy.delete(id);
  if (changed && id === state.activeId) renderComposerState();
}

function renderComposerState() {
  renderComposer();
}

// Self-heal busy on a fresh thread load: a session is generating iff its newest assistant message
// hasn't completed. (Don't call this on every part update — between send and the first assistant
// message there's no assistant yet, and it would wrongly clear the optimistic busy flag.)
function reconcileBusy(sessionID) {
  if (!sessionID) return;
  const assistants = [...state.messages.values()]
    .filter((m) => m.info.sessionID === sessionID && m.info.role === "assistant")
    .sort((a, b) => (a.info.time?.created || 0) - (b.info.time?.created || 0));
  const last = assistants[assistants.length - 1];
  setBusy(sessionID, !!last && !last.info.time?.completed && !last.info.error);
}

// --- session toolbar + revert banner ---

function revertBoundaryCreated() {
  const s = activeSession();
  if (!s?.revert?.messageID) return 0;
  return state.messages.get(s.revert.messageID)?.info.time?.created || 0;
}

// The session tools live inside the composer (shown only when the box is up + a session is open),
// so this only toggles the revert-only affordances: the Redo button and the reverted banner.
function renderSessionBar() {
  renderComposer();
}

// --- actions ---

async function stopActive() {
  if (!state.activeId) return;
  try { await post(`/session/${state.activeId}/abort`); }
  catch (e) { toast("Stop failed: " + e); }
  setBusy(state.activeId, false); // optimistic; session.idle confirms
}

async function undoLast() {
  if (!state.activeId) return;
  const lastUser = orderedMessages()
    .filter((m) => m.info.role === "user" && !m.info.id?.startsWith("local-"))
    .pop();
  if (!lastUser) { toast("Nothing to undo."); return; }
  await revertToMessage(lastUser.info.id, "Undid last turn — use Redo to restore.");
}

async function unrevertSession() {
  if (!state.activeId) return;
  try { await post(`/session/${state.activeId}/unrevert`); }
  catch (e) { toast("Redo failed: " + e); }
}

async function revertToMessage(messageID, okMsg) {
  if (!state.activeId || !messageID) return;
  try { await post(`/session/${state.activeId}/revert`, { messageID }); if (okMsg) toast(okMsg); }
  catch (e) { toast("Revert failed: " + e); }
}

// Edit = revert to that message (undoing it + everything after), then prefill the composer with its
// text so the user can tweak and resend. Sending from a reverted point commits the revert.
async function editMessage(messageID) {
  const m = state.messages.get(messageID);
  const text = m ? messageText(m) : "";
  await revertToMessage(messageID);
  composerApi?.setInput(text);
}

async function forkSession(messageID) {
  if (!state.activeId) return;
  try {
    const s = await post(`/session/${state.activeId}/fork`, messageID ? { messageID } : {});
    if (s?.id) {
      syncSession(s);
      syncSend({ type: "sync" }); // let the DO mirror the new session into its cache too
      selectSession(s.id);
      toast("Forked into a new session");
    }
  } catch (e) {
    toast("Fork failed: " + e);
  }
}

async function compactSession() {
  if (!state.activeId) return;
  const model = currentModel();
  if (!model) { toast("Pick a model in Settings first."); return; }
  try { await post(`/session/${state.activeId}/summarize`, model, { timeout: 0 }); toast("Compacting conversation…"); }
  catch (e) { toast("Compact failed: " + e); }
}

async function deleteMessage(messageID, anchor) {
  if (!state.activeId || !messageID) return;
  const ok = await confirmAction(anchor, { title: "Delete message?", body: "It will be removed from the conversation." });
  if (!ok) return;
  try { await api(`/session/${state.activeId}/message/${messageID}`, { method: "DELETE" }); }
  catch (e) { toast("Delete failed: " + e); }
}

function copyMessage(messageID) {
  const m = state.messages.get(messageID);
  if (!m) return;
  const text = messageText(m);
  if (!navigator.clipboard) { toast("Clipboard unavailable"); return; }
  navigator.clipboard.writeText(text).then(() => toast("Copied"), () => toast("Copy failed"));
}

// Per-message hover actions + their dispatch now live in the Remix thread component
// (src/client/thread.tsx): it renders true buttons (gated on machineOn / non-local, matching the old
// renderMsgActions) and calls back via props.onAct(action, messageId, anchorEl) — wired in
// renderThread() to editMessage / revertToMessage / forkSession / copyMessage / deleteMessage.

// --------------------------------------------------------------------------- sync (WebSocket to the SyncHub DO)

// The DO is always reachable (Cloudflare-side), so we connect regardless of the box state.
// It serves the cached session list + messages and relays opencode events when the box is up.
function connectSync() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/sync`);
  state.ws = ws;
  // Only act on intent once the socket is actually OPEN. On a fresh page load init() fires before
  // the handshake finishes, so a sync/open sent eagerly would be silently dropped (syncSend gates
  // on readyState) and the rail/thread would stay on the stale cached snapshot. Doing it here also
  // makes every reconnect reload the open thread.
  ws.onopen = () => {
    syncSend({ type: "sync" });
    if (state.activeId) syncSend({ type: "open", sessionID: state.activeId });
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    onSyncMessage(msg);
  };
  ws.onclose = () => {
    state.ws = null;
    setTimeout(connectSync, 2000); // auto-reconnect with backoff
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

function syncSend(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(obj));
}

function onSyncMessage(msg) {
  if (msg.type === "snapshot" || msg.type === "sessions") {
    setSessions(msg.sessions || []);
    if (!state.activeId) {
      // Honor a /sessions/<id> deep-link if present; otherwise open the most recent session.
      const target = sessionFromUrl() || state.sessions[0]?.id;
      if (target) selectSession(target, "replace");
    }
  } else if (msg.type === "messages") {
    if (msg.sessionID === state.activeId) {
      state.messages.clear();
      for (const item of msg.messages || []) ingestMessage(item);
      reconcileBusy(msg.sessionID); // self-heal Stop/Send if we loaded mid-run
      renderThread(true);
      renderSessionBar();
    }
  } else if (msg.type === "event") {
    handleEvent(msg.event);
  }
}

function setSessions(list) {
  state.sessions = list.sort(
    (a, b) => (b.time?.updated || b.time?.created || 0) - (a.time?.updated || a.time?.created || 0),
  );
  renderSessions();
  renderSessionBar(); // the active session's title/revert state may have changed
}

function handleEvent(payload) {
  const type = payload?.type;
  const props = payload?.properties || payload?.data || {};
  if (type === "message.updated") onMessageUpdated(props.info || props.message);
  else if (type === "message.part.updated") onPartUpdated(props.part);
  else if (type === "message.removed" && props.messageID) { state.messages.delete(props.messageID); renderThread(); }
  else if (type === "session.updated" || type === "session.created") { syncSession(props.info || props.session); renderSessionBar(); }
  else if (type === "session.deleted" || type === "session.removed") removeSession(props.info?.id || props.sessionID);
  else if (type === "session.idle") setBusy(props.sessionID, false);
  else if (type === "session.error") { setBusy(props.sessionID, false); toast("Session error" + sessionErrorText(props)); }
  else if (type === "session.compacted" && props.sessionID === state.activeId) {
    toast("Conversation compacted");
    // Compaction rewrites history wholesale, so the incrementally-built thread can be stale —
    // re-open to pull the authoritative message list from the box.
    syncSend({ type: "open", sessionID: state.activeId });
  }
}

function sessionErrorText(props) {
  const err = props?.error;
  const msg = err?.data?.message || err?.message || err?.name;
  return msg ? ": " + msg : "";
}

function syncSession(s) {
  if (!s?.id) return;
  const i = state.sessions.findIndex((x) => x.id === s.id);
  if (i === -1) state.sessions.unshift(s); else state.sessions[i] = { ...state.sessions[i], ...s };
  renderSessions();
}

function removeSession(id) {
  state.sessions = state.sessions.filter((x) => x.id !== id);
  if (state.activeId === id) {
    state.activeId = null;
    els.composer.hidden = true;
    state.messages.clear();
    renderThread(); // repaint so the thread component shows #empty again
    history.replaceState({}, "", "/"); // drop /sessions/<id> now that nothing is open
    renderSessionBar();
  }
  renderSessions();
}

// --------------------------------------------------------------------------- settings overlay

els.openSettings.addEventListener("click", () => { closeSidebar(); openSettings(); });
// The settings module fires this whenever connectors change; re-read the active model.
window.addEventListener("connectors-changed", () => { loadDefaultModel(); });

// --------------------------------------------------------------------------- boot

els.newSession.addEventListener("click", () => newSession().catch((e) => toast(String(e))));

async function init() {
  updateSessionList = mountSessionList(els.sessionList); // Remix-rendered session rail
  composerApi = mountComposer(els.composer);             // Remix-rendered composer
  updateComposer = composerApi.update;
  threadApi = mountThread(els.threadContent);            // Remix-rendered chat thread (+ #empty + pins)
  filesPane = mountFilesPane(els.filesHost);             // Remix-rendered files pane
  renderComposer();                                      // initial paint (hidden until updateMode shows it)
  setupMobile();
  setupMarkdown();
  setupGithubProject();
  renderFiles("Start the machine to browse files.");
  await loadDefaultModel();
  // SSR pre-fetch: paint the session rail from the server-inlined cache (AppShell.astro) before the
  // WebSocket connects, so there's no empty-sidebar flash. connectSync()'s snapshot then reconciles.
  try {
    const boot = JSON.parse(document.getElementById("oc-boot")?.textContent || "{}");
    if (Array.isArray(boot.sessions) && boot.sessions.length) setSessions(boot.sessions);
  } catch { /* ignore malformed boot data */ }
  connectSync();                   // DO is always reachable; snapshot drives the rail + first select
  await refreshMachine();          // sets machineOn; loads agents + nudges the DO bridge if up
  setInterval(refreshMachine, 15000);
  setInterval(() => {
    if (state.machineOn && document.visibilityState !== "hidden") refreshFiles(false, { silent: true }).catch(() => {});
  }, 5000);
}

// --------------------------------------------------------------------------- utils

init();
