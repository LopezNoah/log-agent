// Settings overlay — Account / Organizations / Projects / Connectors / Billing.
// Connectors (LLM, GitHub, Fly.io, Notifications) are fully wired to /api/connectors;
// the other sections are scaffolded placeholders for now. Self-contained module: it owns
// its own fetch + toast and tells the rest of the app when connectors change via an event.

import { confirmAction } from "./utils.js";
import { mountSettings } from "../client/settings-panel.tsx";

// The settings overlay is rendered by the Remix <App> component, so it doesn't exist at module
// load — resolve these lazily on first openSettings() (every other usage flows through that).
let overlay, content, nav;
// The settings nav + content are a Remix (remix/ui) component (src/client/settings-panel.tsx),
// mounted lazily on first openSettings(); render() feeds it fresh props via buildProps().
let settingsApi;

let connectors = []; // cached list from the API
let envMeta = {}; // deployment-level info (e.g. whether a Fly env token is configured)
let active = "llm";
let systemPrompt = {}; // /api/system-prompt state ({loading}/{error}/{source,boxReachable,content})
// "Connect ChatGPT" device-code flow state, projected into the LLM section's props.
// status: idle | starting | awaiting | connected | error
let chatgptConnect = { status: "idle" };

// ---------------------------------------------------------------- provider metadata

const LLM_PROVIDERS = {
  anthropic: { name: "Anthropic", keyHint: "sk-ant-…", model: "anthropic/claude-sonnet-4-6" },
  openai: { name: "OpenAI", keyHint: "sk-…", model: "openai/gpt-4o" },
  openrouter: { name: "OpenRouter", keyHint: "sk-or-…", model: "openrouter/anthropic/claude-sonnet-4-6" },
  google: { name: "Google", keyHint: "AIza…", model: "google/gemini-2.0-flash" },
  groq: { name: "Groq", keyHint: "gsk_…", model: "groq/llama-3.3-70b-versatile" },
};

const VM_SIZES = ["shared-cpu-1x", "shared-cpu-2x", "shared-cpu-4x", "performance-1x", "performance-2x", "performance-4x"];
const GH_PERMISSIONS = ["contents", "pull_requests", "issues", "workflows", "actions"];
const NOTIFY_PROVIDERS = { slack: "Slack", discord: "Discord", webhook: "Webhook" };

const SECTIONS = [
  { id: "account", label: "Account" },
  { id: "orgs", label: "Organizations" },
  { id: "projects", label: "Projects" },
  { id: "__connectors", label: "Connectors", group: true },
  { id: "llm", label: "LLM providers", indent: true },
  { id: "github", label: "GitHub", indent: true },
  { id: "fly", label: "Fly.io", indent: true },
  { id: "notifications", label: "Notifications", indent: true },
  { id: "system", label: "System prompt" },
  { id: "billing", label: "Billing / budgets" },
];

// ---------------------------------------------------------------- api + utils

async function request(path, opts = {}) {
  const res = await fetch(path, { credentials: "same-origin", ...opts });
  if (res.status === 401) { location.href = "/login"; throw new Error("unauthorized"); }
  if (!res.ok) throw new Error((await res.text().catch(() => "")) || `${path} → ${res.status}`);
  return res.status === 204 ? null : res.json();
}

function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

function announceChange() {
  window.dispatchEvent(new CustomEvent("connectors-changed"));
}

async function reload() {
  const { connectors: list, env } = await request("/api/connectors");
  connectors = list || [];
  envMeta = env || {};
}

// ---------------------------------------------------------------- shell

// On mobile the nav is a horizontal scroller — keep the selected pill in view.
function scrollNavToActive(btn) {
  if (btn && window.matchMedia("(max-width: 767px)").matches) {
    btn.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  }
}

export async function openSettings() {
  overlay ??= document.getElementById("settings-overlay");
  content ??= document.getElementById("settings-content");
  nav ??= document.getElementById("settings-nav");
  wireSettings();
  settingsApi ??= mountSettings(content, document.getElementById("settings-nav-items"));
  overlay.hidden = false;
  active = "llm";
  systemPrompt = {};
  clearTimeout(chatgptPollTimer);
  chatgptConnect = { status: "idle" };
  try {
    await reload();
  } catch {
    content.innerHTML = `<div class="text-bad">Could not load connectors.</div>`;
    return;
  }
  render();
}

function closeSettings() {
  overlay.hidden = true;
  // Stop any in-flight ChatGPT OAuth polling so it doesn't keep firing after the overlay closes.
  clearTimeout(chatgptPollTimer);
  if (chatgptConnect.status === "awaiting" || chatgptConnect.status === "starting") {
    chatgptConnect = { status: "idle" };
  }
}

// Single re-render seam: push fresh props (nav + active section + data) to the Remix settings
// component. The component renders the nav from `sections`; settings.js no longer builds DOM.
function render() {
  content.scrollTop = 0;
  settingsApi.update(buildProps());
}

// Project the module's state + canonical metadata + every action callback into the component's
// SettingsPanelProps. The fetch/reload/announceChange/toast logic stays here, behind these callbacks.
function buildProps() {
  return {
    // data
    active,
    sections: SECTIONS,
    connectors,
    env: envMeta,
    systemPrompt,
    llmProviders: LLM_PROVIDERS,
    vmSizes: VM_SIZES,
    ghPermissions: GH_PERMISSIONS,
    notifyProviders: NOTIFY_PROVIDERS,
    chatgptConnect,
    // nav
    onSelectSection: (id, btn) => {
      active = id;
      if (id === "system") loadSystemPrompt();
      render();
      scrollNavToActive(btn);
    },
    // LLM
    onAddLlm: addLlm,
    onSetDefaultLlm: (id) => llmAction("default", id),
    onEditLlm: (id) => llmAction("edit", id),
    onConnectChatgpt: connectChatgpt,
    onRemoveConnector: removeConnectorById,
    // GitHub
    onSaveGithub: saveGithub,
    onSyncGithub: syncGithub,
    // Fly.io
    onSaveFly: saveFly,
    // Notifications
    onAddNotification: addNotification,
    onTestNotification: testNotification,
    // System prompt
    onSaveSystemPrompt: saveSystemPrompt,
    onResetSystemPrompt: resetSystemPrompt,
  };
}

// ---------------------------------------------------------------- LLM providers

// Old #llm-form submit: validate key, default the model, POST /api/connectors, reload+announce+render.
async function addLlm(v) {
  if (!v.key) return toast("Enter an API key");
  const model = v.model || LLM_PROVIDERS[v.provider].model;
  try {
    await request("/api/connectors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "llm", provider: v.provider, label: v.label, config: { model }, secret: v.key }),
    });
    await reload();
    announceChange();
    render();
    toast("LLM key saved");
  } catch (err) { toast("Save failed: " + err.message); }
}

async function llmAction(act, id, anchor) {
  const c = connectors.find((x) => x.id === id);
  if (!c) return;
  if (act === "default") {
    await request(`/api/connectors/${id}/default`, { method: "POST" });
    await reload(); announceChange(); render();
  } else if (act === "delete") {
    const name = LLM_PROVIDERS[c.provider]?.name || c.provider;
    if (!(await confirmAction(anchor, { title: "Remove key?", body: `The ${name} API key will be deleted.`, confirmLabel: "Remove" }))) return;
    await request(`/api/connectors/${id}`, { method: "DELETE" });
    await reload(); announceChange(); render();
    toast("Removed");
  } else if (act === "edit") {
    const model = prompt("Model (provider/model):", c.config?.model || "");
    if (model === null) return;
    const key = prompt("New API key (leave blank to keep current):", "");
    const body = { config: { ...c.config, model: model.trim() } };
    if (key && key.trim()) body.secret = key.trim();
    await request(`/api/connectors/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    await reload(); announceChange(); render();
    toast("Updated");
  }
}

// ---------------------------------------------------------------- Connect ChatGPT (OAuth)

// OpenAI device-code OAuth: POST /start to get a user_code + verification URL + a poll interval,
// then poll /poll until connected (or error/timeout). The OAuth endpoints are owned by the Worker
// (parallel agent); we only drive the UI + polling here. Re-renders the panel at each step via
// the chatgptConnect prop. Guarded so a second click can't start a parallel flow.
let chatgptPollTimer = 0;
const CHATGPT_MAX_POLL_MS = 10 * 60 * 1000; // give up after 10 minutes

async function connectChatgpt() {
  if (chatgptConnect.status === "starting" || chatgptConnect.status === "awaiting") return;
  clearTimeout(chatgptPollTimer);
  chatgptConnect = { status: "starting" };
  render();
  let start;
  try {
    start = await request("/api/connectors/openai-oauth/start", { method: "POST" });
  } catch (err) {
    chatgptConnect = { status: "error", message: "Couldn't start: " + err.message };
    render();
    return;
  }
  const deviceAuthId = start?.device_auth_id;
  const userCode = start?.user_code;
  const verificationUri = start?.verification_uri;
  if (!deviceAuthId || !userCode) {
    chatgptConnect = { status: "error", message: "OAuth start returned no device code." };
    render();
    return;
  }
  chatgptConnect = { status: "awaiting", userCode, verificationUri };
  render();

  const intervalMs = Math.max(2000, Number(start.interval || 5) * 1000);
  const deadline = Date.now() + CHATGPT_MAX_POLL_MS;

  const poll = async () => {
    // Bail if the user closed settings or restarted the flow.
    if (chatgptConnect.status !== "awaiting" || chatgptConnect.userCode !== userCode) return;
    if (Date.now() > deadline) {
      chatgptConnect = { status: "error", message: "Timed out waiting for authorization." };
      render();
      return;
    }
    let res;
    try {
      res = await request("/api/connectors/openai-oauth/poll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
      });
    } catch (err) {
      chatgptConnect = { status: "error", message: "Poll failed: " + err.message };
      render();
      return;
    }
    if (res?.status === "connected") {
      chatgptConnect = { status: "connected" };
      try {
        await reload();
        announceChange();
      } catch { /* connector list refresh is best-effort */ }
      render();
      toast("ChatGPT connected ✓");
      return;
    }
    if (res?.status === "error") {
      chatgptConnect = { status: "error", message: "Authorization failed." };
      render();
      return;
    }
    // status === "pending" (or unknown): keep polling.
    chatgptPollTimer = setTimeout(poll, intervalMs);
  };
  chatgptPollTimer = setTimeout(poll, intervalMs);
}

// ---------------------------------------------------------------- GitHub

// Old #gh-form submit. `existing` is the current github connector (or null); the component parses
// username/token/repoPermissions. authMethod is fixed to "pat" (OAuth is disabled in the form).
async function saveGithub(v, existing) {
  if (!existing && !v.token) return toast("Enter a personal access token");
  const config = { authMethod: "pat", username: v.username, repoPermissions: v.repoPermissions };
  try {
    if (existing) {
      const body = { config };
      if (v.token) body.secret = v.token;
      await request(`/api/connectors/${existing.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    } else {
      await request("/api/connectors", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "github", provider: "github", config, secret: v.token }) });
    }
    await reload(); announceChange(); render();
    toast("GitHub saved");
  } catch (err) { toast("Save failed: " + err.message); }
}

// Old #gh-sync handler. The button's disabled-toggle was DOM-side; the component re-renders after
// reload, so we just run the request + toast (the anchor is unused but kept for signature parity).
async function syncGithub(anchor) {
  if (anchor) anchor.disabled = true;
  try {
    const res = await request("/api/github/sync", { method: "POST" });
    toast(res.ok ? "Synced to machine — git + gh are authenticated" : res.reason === "machine_off" ? "Machine is off — syncs on next start" : "Sync failed");
  } catch (err) { toast("Sync failed: " + err.message); }
  finally { if (anchor) anchor.disabled = false; }
}

// ---------------------------------------------------------------- Fly.io

// Old #fly-form submit. `existing` is the current fly connector (or null); component parses
// token/orgSlug/maxVmSize/maxIdleMinutes.
async function saveFly(v, existing) {
  if (!existing && !v.token) return toast("Enter a Fly API token");
  const config = { orgSlug: v.orgSlug, maxVmSize: v.maxVmSize, maxIdleMinutes: v.maxIdleMinutes };
  try {
    if (existing) {
      const body = { config };
      if (v.token) body.secret = v.token;
      await request(`/api/connectors/${existing.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    } else {
      await request("/api/connectors", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "fly", provider: "fly", config, secret: v.token }) });
    }
    await reload(); announceChange(); render();
    toast("Fly.io saved");
  } catch (err) { toast("Save failed: " + err.message); }
}

// ---------------------------------------------------------------- Notifications

// Old #notify-form submit. NOTE: the original did NOT announceChange() for notifications — preserved.
async function addNotification(v) {
  if (!v.url) return toast("Enter a webhook URL");
  try {
    await request("/api/connectors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "notification", provider: v.provider, label: v.label, secret: v.url }),
    });
    await reload(); render();
    toast("Sink added");
  } catch (err) { toast("Save failed: " + err.message); }
}

// Old per-row Test handler.
async function testNotification(id, anchor) {
  if (anchor) anchor.disabled = true;
  try {
    const { ok } = await request(`/api/connectors/${id}/test`, { method: "POST" });
    toast(ok ? "Test sent ✓" : "Test failed — check the URL");
  } catch (err) { toast("Test failed: " + err.message); }
  finally { if (anchor) anchor.disabled = false; }
}

// ---------------------------------------------------------------- remove (shared)

// Generic remove routed from every section's Remove/Disconnect button. Derives the human label the
// way the old per-section handlers did (LLM provider name / "GitHub" / "Fly.io" / "sink").
function removeConnectorById(id, anchor) {
  const c = connectors.find((x) => x.id === id);
  if (!c) return;
  let label;
  if (c.type === "llm") label = LLM_PROVIDERS[c.provider]?.name || c.provider;
  else if (c.type === "github") label = "GitHub";
  else if (c.type === "fly") label = "Fly.io";
  else label = "sink";
  return removeConnector(c, label, anchor);
}

async function removeConnector(c, label, anchor) {
  if (!c) return;
  if (!(await confirmAction(anchor, { title: `Remove ${label}?`, body: "This disconnects it from your account.", confirmLabel: "Remove" }))) return;
  try {
    await request(`/api/connectors/${c.id}`, { method: "DELETE" });
    await reload(); announceChange(); render();
    toast("Removed");
  } catch (err) { toast("Remove failed: " + err.message); }
}

// ---------------------------------------------------------------- system prompt
// The box's AGENTS.md: view the current prompt, save an override that persists across machine
// reboots, or reset to the box default. The component renders the panel from `systemPrompt`
// (loading/error/source/boxReachable/content); these callbacks own the fetch + module state.

async function loadSystemPrompt() {
  systemPrompt = { loading: true };
  render();
  try {
    systemPrompt = await request("/api/system-prompt");
  } catch {
    systemPrompt = { error: true };
  }
  render();
}

async function saveSystemPrompt(content2) {
  try {
    const res = await request("/api/system-prompt", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: content2 }),
    });
    toast(res.applied ? "Saved and applied to the machine" : "Saved — applies when the machine starts");
    loadSystemPrompt();
  } catch (err) { toast("Save failed: " + err.message); }
}

async function resetSystemPrompt() {
  if (!confirm("Reset to the box default prompt?")) return;
  try {
    await request("/api/system-prompt", { method: "DELETE" });
    toast("Reset to default");
    loadSystemPrompt();
  } catch (err) { toast("Reset failed: " + err.message); }
}

// ---------------------------------------------------------------- wiring

// The overlay is rendered by the Remix <App>, so it doesn't exist at module load. Wire its close
// affordances once, the first time settings opens (overlay/content/nav are assigned by then).
let wired = false;
function wireSettings() {
  if (wired) return;
  wired = true;
  document.getElementById("settings-close").addEventListener("click", closeSettings);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeSettings(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !overlay.hidden) closeSettings(); });
}
