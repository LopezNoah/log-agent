// Settings overlay — Account / Organizations / Projects / Connectors / Billing.
// Connectors (LLM, GitHub, Fly.io, Notifications) are fully wired to /api/connectors;
// the other sections are scaffolded placeholders for now. Self-contained module: it owns
// its own fetch + toast and tells the rest of the app when connectors change via an event.

import { confirmAction } from "./utils.js";

const overlay = document.getElementById("settings-overlay");
const content = document.getElementById("settings-content");
const nav = document.getElementById("settings-nav");

let connectors = []; // cached list from the API
let envMeta = {}; // deployment-level info (e.g. whether a Fly env token is configured)
let active = "llm";

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

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function byType(type) {
  return connectors.filter((c) => c.type === type);
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

function buildNav() {
  const items = document.getElementById("settings-nav-items");
  items.innerHTML = "";
  for (const s of SECTIONS) {
    if (s.group) {
      const g = document.createElement("div");
      g.className = "settings-nav-group";
      g.textContent = s.label;
      items.appendChild(g);
      continue;
    }
    const b = document.createElement("button");
    b.className = "settings-nav-item" + (s.indent ? " indent" : "") + (s.id === active ? " active" : "");
    b.textContent = s.label;
    b.addEventListener("click", () => { active = s.id; render(); scrollNavToActive(b); });
    items.appendChild(b);
  }
}

// On mobile the nav is a horizontal scroller — keep the selected pill in view.
function scrollNavToActive(btn) {
  if (window.matchMedia("(max-width: 767px)").matches) {
    btn.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  }
}

export async function openSettings() {
  overlay.hidden = false;
  active = "llm";
  buildNav();
  content.innerHTML = `<div class="settings-loading text-muted">Loading…</div>`;
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
}

function render() {
  buildNav();
  const fn = RENDERERS[active] || renderPlaceholder;
  content.scrollTop = 0;
  fn();
}

// ---------------------------------------------------------------- small DOM helpers

function panel(title, subtitle, bodyHtml) {
  return `<div class="settings-panel">
    <header class="settings-panel-head">
      <h2>${esc(title)}</h2>
      ${subtitle ? `<p>${esc(subtitle)}</p>` : ""}
    </header>
    ${bodyHtml}
  </div>`;
}

function field(label, inner, hint) {
  return `<label class="settings-field"><span>${esc(label)}</span>${inner}${hint ? `<small>${esc(hint)}</small>` : ""}</label>`;
}

function secretPlaceholder(c) {
  return c?.hasSecret ? `•••• ${esc(c.secretLast4 || "set")} — leave blank to keep` : "";
}

// ---------------------------------------------------------------- LLM providers

function renderLlm() {
  const items = byType("llm");
  const rows = items.length
    ? items.map((c) => `
      <div class="connector-row" data-id="${esc(c.id)}">
        <div class="connector-main">
          <div class="connector-title">
            ${esc(LLM_PROVIDERS[c.provider]?.name || c.provider)}
            ${c.isDefault ? `<span class="badge">default</span>` : ""}
          </div>
          <div class="connector-sub">${esc(c.config?.model || "no model set")} · key ••••${esc(c.secretLast4 || "")}</div>
        </div>
        <div class="connector-actions">
          ${c.isDefault ? "" : `<button class="btn btn-ghost" data-act="default">Make default</button>`}
          <button class="btn btn-ghost" data-act="edit">Edit</button>
          <button class="btn btn-ghost text-bad" data-act="delete">Remove</button>
        </div>
      </div>`).join("")
    : `<p class="text-muted text-sm">No LLM keys yet. Add one below — the default key is what new sessions use.</p>`;

  const opts = Object.entries(LLM_PROVIDERS).map(([k, v]) => `<option value="${k}">${esc(v.name)}</option>`).join("");
  content.innerHTML = panel(
    "LLM providers",
    "Bring your own API key. Keys are encrypted at rest and pushed to the box only at runtime.",
    `<div class="connector-list">${rows}</div>
     <form id="llm-form" class="settings-form">
       <h3>Add a provider key</h3>
       ${field("Provider", `<select id="llm-provider" class="field">${opts}</select>`)}
       ${field("Label (optional)", `<input id="llm-label" class="field" placeholder="e.g. Personal Anthropic">`)}
       ${field("API key", `<input id="llm-key" type="password" autocomplete="off" class="field" placeholder="sk-ant-…">`)}
       ${field("Model", `<input id="llm-model" class="field" placeholder="provider/model">`, "provider/model — sent with every message")}
       <div class="settings-form-actions"><button class="btn btn-primary" type="submit">Add key</button></div>
     </form>`,
  );

  const pSel = content.querySelector("#llm-provider");
  const keyInp = content.querySelector("#llm-key");
  const modelInp = content.querySelector("#llm-model");
  const syncHints = () => {
    const meta = LLM_PROVIDERS[pSel.value];
    keyInp.placeholder = meta.keyHint;
    if (!modelInp.value) modelInp.placeholder = meta.model;
  };
  pSel.addEventListener("change", syncHints);
  syncHints();

  content.querySelector("#llm-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const secret = keyInp.value.trim();
    if (!secret) return toast("Enter an API key");
    const provider = pSel.value;
    const model = modelInp.value.trim() || LLM_PROVIDERS[provider].model;
    try {
      await request("/api/connectors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "llm", provider, label: content.querySelector("#llm-label").value.trim(), config: { model }, secret }),
      });
      await reload();
      announceChange();
      render();
      toast("LLM key saved");
    } catch (err) { toast("Save failed: " + err.message); }
  });

  content.querySelectorAll(".connector-row[data-id]").forEach((row) => {
    const id = row.dataset.id;
    row.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => llmAction(b.dataset.act, id, b)));
  });
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

// ---------------------------------------------------------------- GitHub

function renderGithub() {
  const c = byType("github")[0];
  const cfg = c?.config || {};
  const authMethod = cfg.authMethod || "pat";
  const perms = new Set(cfg.repoPermissions || ["contents", "pull_requests"]);
  const permBoxes = GH_PERMISSIONS.map((p) =>
    `<label class="check"><input type="checkbox" value="${p}" ${perms.has(p) ? "checked" : ""}> ${esc(p.replace("_", " "))}</label>`).join("");

  content.innerHTML = panel(
    "GitHub",
    "Connect a GitHub account so agents can clone, push, and open PRs. Tokens are encrypted at rest.",
    `<form id="gh-form" class="settings-form">
       ${c ? `<div class="connector-status">Connected ${c.config?.username ? `as <b>${esc(c.config.username)}</b>` : ""} · token ••••${esc(c.secretLast4 || "")}
         <button type="button" id="gh-sync" class="btn btn-ghost ml-2">Sync to machine</button></div>` : ""}
       ${field("Auth method", `
         <div class="radio-row">
           <label class="radio"><input type="radio" name="gh-auth" value="pat" ${authMethod === "pat" ? "checked" : ""}> Personal access token</label>
           <label class="radio is-disabled" title="OAuth requires a registered GitHub App — coming soon"><input type="radio" name="gh-auth" value="oauth" disabled> OAuth (soon)</label>
         </div>`)}
       ${field("Username (optional)", `<input id="gh-username" class="field" value="${esc(cfg.username || "")}" placeholder="octocat">`)}
       ${field("Personal access token", `<input id="gh-token" type="password" autocomplete="off" class="field" placeholder="${c ? esc(secretPlaceholder(c)) : "github_pat_… or ghp_…"}">`)}
       ${field("Repo permissions", `<div class="check-grid">${permBoxes}</div>`, "Recorded with the connector; enforced when the agent uses the token.")}
       <div class="settings-form-actions">
         ${c ? `<button class="btn btn-ghost text-bad" type="button" id="gh-remove">Disconnect</button>` : ""}
         <button class="btn btn-primary" type="submit">${c ? "Save" : "Connect"}</button>
       </div>
     </form>`,
  );

  content.querySelector("#gh-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const token = content.querySelector("#gh-token").value.trim();
    if (!c && !token) return toast("Enter a personal access token");
    const config = {
      authMethod: "pat",
      username: content.querySelector("#gh-username").value.trim(),
      repoPermissions: [...content.querySelectorAll(".check-grid input:checked")].map((i) => i.value),
    };
    try {
      if (c) {
        const body = { config };
        if (token) body.secret = token;
        await request(`/api/connectors/${c.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      } else {
        await request("/api/connectors", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "github", provider: "github", config, secret: token }) });
      }
      await reload(); announceChange(); render();
      toast("GitHub saved");
    } catch (err) { toast("Save failed: " + err.message); }
  });

  content.querySelector("#gh-remove")?.addEventListener("click", (e) => removeConnector(c, "GitHub", e.currentTarget));
  content.querySelector("#gh-sync")?.addEventListener("click", async (e) => {
    e.target.disabled = true;
    try {
      const res = await request("/api/github/sync", { method: "POST" });
      toast(res.ok ? "Synced to machine — git + gh are authenticated" : res.reason === "machine_off" ? "Machine is off — syncs on next start" : "Sync failed");
    } catch (err) { toast("Sync failed: " + err.message); }
    finally { e.target.disabled = false; }
  });
}

// ---------------------------------------------------------------- Fly.io

function renderFly() {
  const c = byType("fly")[0];
  const cfg = c?.config || {};
  const sizeOpts = VM_SIZES.map((s) => `<option value="${s}" ${cfg.maxVmSize === s ? "selected" : ""}>${s}</option>`).join("");
  // The deployment's FLY_API_TOKEN drives machine start/stop today; a BYO token is an override.
  const envBanner = envMeta.flyToken
    ? `<div class="connector-status">✓ Using the deployment's Fly token${envMeta.flyOrgSlug ? ` (org <b>${esc(envMeta.flyOrgSlug)}</b>)` : ""} — this powers machine start/stop today. Add a token below only to override it.</div>`
    : `<div class="connector-status text-bad">No Fly token configured on the deployment. Machine start/stop will fail until one is set.</div>`;

  content.innerHTML = panel(
    "Fly.io",
    "Fly runs the machine behind your agents. A bring-your-own token here would override the deployment token (BYO is not yet wired to provisioning).",
    `<form id="fly-form" class="settings-form">
       ${envBanner}
       ${c ? `<div class="connector-status">BYO override saved · token ••••${esc(c.secretLast4 || "")}</div>` : ""}
       ${field("Fly API token (override)", `<input id="fly-token" type="password" autocomplete="off" class="field" placeholder="${c ? esc(secretPlaceholder(c)) : "FlyV1 …"}">`)}
       ${field("Organization slug", `<input id="fly-org" class="field" value="${esc(cfg.orgSlug || "")}" placeholder="personal">`)}
       ${field("Max VM size", `<select id="fly-size" class="field">${sizeOpts}</select>`)}
       ${field("Max idle minutes", `<input id="fly-idle" type="number" min="1" class="field" value="${esc(cfg.maxIdleMinutes ?? 60)}">`, "Auto-stop idle machines after this many minutes.")}
       <div class="settings-form-actions">
         ${c ? `<button class="btn btn-ghost text-bad" type="button" id="fly-remove">Disconnect</button>` : ""}
         <button class="btn btn-primary" type="submit">${c ? "Save" : "Connect"}</button>
       </div>
     </form>`,
  );

  content.querySelector("#fly-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const token = content.querySelector("#fly-token").value.trim();
    if (!c && !token) return toast("Enter a Fly API token");
    const config = {
      orgSlug: content.querySelector("#fly-org").value.trim(),
      maxVmSize: content.querySelector("#fly-size").value,
      maxIdleMinutes: Number(content.querySelector("#fly-idle").value) || 60,
    };
    try {
      if (c) {
        const body = { config };
        if (token) body.secret = token;
        await request(`/api/connectors/${c.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      } else {
        await request("/api/connectors", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "fly", provider: "fly", config, secret: token }) });
      }
      await reload(); announceChange(); render();
      toast("Fly.io saved");
    } catch (err) { toast("Save failed: " + err.message); }
  });

  content.querySelector("#fly-remove")?.addEventListener("click", (e) => removeConnector(c, "Fly.io", e.currentTarget));
}

// ---------------------------------------------------------------- Notifications

function renderNotifications() {
  const items = byType("notification");
  const rows = items.length
    ? items.map((c) => `
      <div class="connector-row" data-id="${esc(c.id)}">
        <div class="connector-main">
          <div class="connector-title">${esc(NOTIFY_PROVIDERS[c.provider] || c.provider)}${c.label ? ` · ${esc(c.label)}` : ""}</div>
          <div class="connector-sub">webhook ••••${esc(c.secretLast4 || "")}</div>
        </div>
        <div class="connector-actions">
          <button class="btn btn-ghost" data-act="test">Test</button>
          <button class="btn btn-ghost text-bad" data-act="delete">Remove</button>
        </div>
      </div>`).join("")
    : `<p class="text-muted text-sm">No notification sinks yet. Add a Slack/Discord webhook to get machine + run alerts.</p>`;

  const opts = Object.entries(NOTIFY_PROVIDERS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("");
  content.innerHTML = panel(
    "Notifications",
    "Alerts for machine start/stop and finished runs, sent to your channels.",
    `<div class="connector-list">${rows}</div>
     <form id="notify-form" class="settings-form">
       <h3>Add a sink</h3>
       ${field("Type", `<select id="notify-provider" class="field">${opts}</select>`)}
       ${field("Label (optional)", `<input id="notify-label" class="field" placeholder="e.g. #builds">`)}
       ${field("Webhook URL", `<input id="notify-url" type="url" class="field" placeholder="https://hooks.slack.com/services/…">`, "Slack/Discord incoming webhook, or any URL that accepts a JSON POST.")}
       <div class="settings-form-actions"><button class="btn btn-primary" type="submit">Add sink</button></div>
     </form>`,
  );

  content.querySelector("#notify-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = content.querySelector("#notify-url").value.trim();
    if (!url) return toast("Enter a webhook URL");
    try {
      await request("/api/connectors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "notification", provider: content.querySelector("#notify-provider").value, label: content.querySelector("#notify-label").value.trim(), secret: url }),
      });
      await reload(); render();
      toast("Sink added");
    } catch (err) { toast("Save failed: " + err.message); }
  });

  content.querySelectorAll(".connector-row[data-id]").forEach((row) => {
    const id = row.dataset.id;
    row.querySelector('[data-act="delete"]').addEventListener("click", (e) => removeConnector(connectors.find((x) => x.id === id), "sink", e.currentTarget));
    row.querySelector('[data-act="test"]').addEventListener("click", async (e) => {
      e.target.disabled = true;
      try {
        const { ok } = await request(`/api/connectors/${id}/test`, { method: "POST" });
        toast(ok ? "Test sent ✓" : "Test failed — check the URL");
      } catch (err) { toast("Test failed: " + err.message); }
      finally { e.target.disabled = false; }
    });
  });
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

// ---------------------------------------------------------------- scaffolded sections

function renderAccount() {
  content.innerHTML = panel(
    "Account",
    "You're signed in with the workspace password.",
    `<div class="settings-form">
       <div class="connector-status">Single-user workspace. Multi-user accounts are planned.</div>
       <div class="settings-form-actions"><a class="btn btn-ghost" href="/logout">Sign out</a></div>
     </div>`,
  );
}

function renderPlaceholder() {
  const copy = {
    orgs: ["Organizations / Tenants", "Group projects and members under an organization. Coming in a later pass — this build is single-user."],
    projects: ["Projects", "Scope sessions, connectors, and budgets to a project. Coming soon."],
    billing: ["Billing / budgets", "Set spend caps per provider and track token usage. Coming soon."],
  }[active] || ["Settings", ""];
  content.innerHTML = panel(copy[0], copy[1], `<div class="settings-soon">🚧 Not built yet</div>`);
}

const RENDERERS = {
  account: renderAccount,
  llm: renderLlm,
  github: renderGithub,
  fly: renderFly,
  notifications: renderNotifications,
  system: renderSystemPrompt,
  orgs: renderPlaceholder,
  projects: renderPlaceholder,
  billing: renderPlaceholder,
};

// System prompt (the box's AGENTS.md). View the current prompt, save an override that persists
// across machine reboots, or reset to the box default.
async function renderSystemPrompt() {
  content.innerHTML = panel("System prompt", "Loading…", "");
  let data;
  try {
    data = await request("/api/system-prompt");
  } catch {
    content.innerHTML = panel("System prompt", "Could not load the system prompt.", "");
    return;
  }
  const isCustom = data.source === "custom";
  const note = isCustom
    ? "Using your custom prompt (overrides the box default; persists across reboots)."
    : data.boxReachable
      ? "Showing the box default. Edit and save to override it."
      : "Machine is off — showing your saved prompt or empty. Start the machine to load the live default.";

  content.innerHTML = panel(
    "System prompt",
    "The agent instructions (AGENTS.md) loaded for every session — includes the UI-artifact protocol.",
    `<form id="sp-form" class="settings-form">
       <div class="connector-status">${esc(note)}</div>
       ${field("Prompt", `<textarea id="sp-text" class="field" rows="16" style="min-height:280px;font-family:ui-monospace,Menlo,monospace;font-size:12.5px"></textarea>`)}
       <div class="settings-form-actions">
         <button type="button" id="sp-reset" class="btn btn-ghost text-bad" ${isCustom ? "" : "disabled"}>Reset to default</button>
         <span class="flex-1"></span>
         <button type="submit" class="btn btn-primary">Save override</button>
       </div>
     </form>`,
  );
  content.querySelector("#sp-text").value = data.content || "";

  content.querySelector("#sp-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = JSON.stringify({ content: content.querySelector("#sp-text").value });
    try {
      const res = await request("/api/system-prompt", { method: "PUT", headers: { "Content-Type": "application/json" }, body });
      toast(res.applied ? "Saved and applied to the machine" : "Saved — applies when the machine starts");
      render();
    } catch (err) { toast("Save failed: " + err.message); }
  });

  content.querySelector("#sp-reset").addEventListener("click", async () => {
    if (!confirm("Reset to the box default prompt?")) return;
    try {
      await request("/api/system-prompt", { method: "DELETE" });
      toast("Reset to default");
      render();
    } catch (err) { toast("Reset failed: " + err.message); }
  });
}

// ---------------------------------------------------------------- wiring

document.getElementById("settings-close").addEventListener("click", closeSettings);
overlay.addEventListener("click", (e) => { if (e.target === overlay) closeSettings(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !overlay.hidden) closeSettings(); });
