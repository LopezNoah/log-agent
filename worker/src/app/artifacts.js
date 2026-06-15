// Ephemeral UI artifacts. The assistant emits fenced ```ui blocks containing JSON UI
// *descriptions* — never HTML. This module parses them and renders each with a trusted,
// hand-built component. No arbitrary code runs: every value is inserted via textContent.
//
//   ```ui
//   { "type": "checklist", "props": { "title": "Plan", "items": [ ... ] } }
//   ```
//
// Unknown types and invalid JSON degrade to a plain code block, so normal chats are untouched.

const PREVIEW_SANDBOX = "allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-top-navigation-by-user-activation";
const PREVIEW_ALLOW = "clipboard-read; clipboard-write; fullscreen";

// --------------------------------------------------------------------------- parsing

// Split assistant text into ordered markdown / ui segments. Incomplete (still-streaming)
// ```ui blocks are held back behind a "building UI…" note until their closing fence arrives.
export function parseRichText(text) {
  const segments = [];
  const re = /```ui[ \t]*\r?\n([\s\S]*?)```/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) segments.push({ kind: "md", text: text.slice(last, m.index) });
    segments.push(parseSpec(m[1]));
    last = re.lastIndex;
  }
  let tail = text.slice(last);
  const open = tail.indexOf("```ui");
  if (open !== -1) {
    // A fence has opened but not closed yet (mid-stream): show text up to it, then a placeholder.
    if (open > 0) segments.push({ kind: "md", text: tail.slice(0, open) });
    segments.push({ kind: "pending" });
    tail = "";
  }
  if (tail) segments.push({ kind: "md", text: tail });
  if (!segments.length) segments.push({ kind: "md", text });
  return segments;
}

function parseSpec(raw) {
  try {
    const spec = JSON.parse(raw);
    if (spec && typeof spec === "object" && typeof spec.type === "string") return { kind: "ui", spec };
  } catch { /* fall through */ }
  return { kind: "md", text: "```json\n" + raw.trim() + "\n```" }; // invalid → show as code
}

// --------------------------------------------------------------------------- mount

const WIDGETS = {
  checklist: checklistWidget,
  table: tableWidget,
  status: statusWidget,
  diff: diffWidget,
  "file-explorer": fileExplorerWidget,
  preview: previewWidget,
  sandbox: sandboxWidget,
  command: commandWidget,
  form: formWidget,
};

// Render one artifact spec into `container`. ctx provides host integration:
//   { state:{get,set}, sendText, toast, openUrl, isPinned, togglePin }
export function mountArtifact(container, spec, ctx) {
  let node;
  try {
    node = (WIDGETS[spec.type] || unknownWidget)(spec, ctx);
  } catch (e) {
    node = errorWidget(spec, e);
  }
  container.appendChild(node);
}

// --------------------------------------------------------------------------- shell + helpers

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// Common card chrome: header (icon + title + pin) and a body to fill.
function shell(ctx, spec, { title, icon }) {
  const root = el("div", "widget");
  const head = el("div", "widget-head");
  const titleWrap = el("div", "widget-title");
  if (icon) titleWrap.append(el("span", "widget-icon", icon));
  titleWrap.append(el("span", null, title || spec.type));
  head.append(titleWrap);

  const actions = el("div", "widget-actions");
  const pinned = ctx.isPinned(spec.__id);
  const pin = el("button", "widget-act" + (pinned ? " on" : ""), pinned ? "📌" : "📌");
  pin.title = pinned ? "Unpin" : "Pin — keep this after the chat updates";
  pin.style.opacity = pinned ? "1" : "0.4";
  pin.addEventListener("click", () => ctx.togglePin(spec));
  actions.append(pin);
  head.append(actions);

  root.append(head);
  const body = el("div", "widget-body");
  root.append(body);
  return { root, body, actions };
}

function statusClass(value) {
  const v = String(value).toLowerCase();
  if (/(error|fail|crash|dead)/.test(v)) return "bad";
  if (/(work|start|pending|build|deploy|load)/.test(v)) return "amber";
  if (/(run|ok|online|ready|success|done|active|live|connected)/.test(v)) return "good";
  return "muted";
}

function pill(value) {
  const p = el("span", "widget-pill " + statusClass(value), String(value));
  return p;
}

// --------------------------------------------------------------------------- widgets

function checklistWidget(spec, ctx) {
  const props = spec.props || {};
  const { root, body } = shell(ctx, spec, { title: props.title || "Checklist", icon: "☑" });
  const saved = ctx.state.get() || {};
  const list = el("div", "check-list");
  (props.items || []).forEach((it, i) => {
    const id = (it && it.id != null ? it.id : i) + "";
    const done = id in saved ? saved[id] : !!(it && (it.done || it.checked));
    const row = el("label", "check-item" + (done ? " done" : ""));
    const box = el("input");
    box.type = "checkbox";
    box.checked = done;
    box.addEventListener("change", () => {
      const cur = ctx.state.get() || {};
      cur[id] = box.checked;
      ctx.state.set(cur);
      row.classList.toggle("done", box.checked);
    });
    row.append(box, el("span", "check-text", typeof it === "string" ? it : it.text || ""));
    list.append(row);
  });
  body.append(list);
  return root;
}

function tableWidget(spec, ctx) {
  const props = spec.props || {};
  const { root, body } = shell(ctx, spec, { title: props.title || "Table", icon: "▦" });
  const wrap = el("div", "table-wrap");
  const table = el("table", "widget-table");
  if (Array.isArray(props.columns) && props.columns.length) {
    const tr = el("tr");
    props.columns.forEach((c) => tr.append(el("th", null, String(c))));
    const thead = el("thead");
    thead.append(tr);
    table.append(thead);
  }
  const tbody = el("tbody");
  (props.rows || []).forEach((r) => {
    const tr = el("tr");
    (Array.isArray(r) ? r : [r]).forEach((cell) => tr.append(el("td", null, String(cell))));
    tbody.append(tr);
  });
  table.append(tbody);
  wrap.append(table);
  body.append(wrap);
  return root;
}

function statusWidget(spec, ctx) {
  const props = spec.props || {};
  const { root, body } = shell(ctx, spec, { title: props.title || "Status", icon: "◍" });
  const grid = el("div", "status-grid");
  for (const [k, v] of Object.entries(props)) {
    if (k === "title") continue;
    const row = el("div", "status-row");
    row.append(el("span", "status-dot " + statusClass(v)));
    row.append(el("span", "status-key", k));
    row.append(el("span", "status-val", String(v)));
    grid.append(row);
  }
  body.append(grid);
  return root;
}

function diffWidget(spec, ctx) {
  const props = spec.props || {};
  const before = String(props.before ?? "");
  const after = String(props.after ?? "");
  const { root, body, actions } = shell(ctx, spec, { title: props.filename || "Diff", icon: "≢" });

  const st = ctx.state.get() || {};
  let mode = st.mode || "inline";
  const toggle = el("button", "widget-act", mode === "inline" ? "⇆ Split" : "≡ Inline");
  toggle.title = "Toggle inline / side-by-side";
  toggle.addEventListener("click", () => {
    mode = mode === "inline" ? "split" : "inline";
    ctx.state.set({ ...ctx.state.get(), mode });
    paint();
  });
  actions.prepend(toggle);

  function paint() {
    body.innerHTML = "";
    toggle.textContent = mode === "inline" ? "⇆ Split" : "≡ Inline";
    const ops = computeDiff(before, after);
    body.append(mode === "split" ? renderSplit(ops) : renderInline(ops));
  }
  paint();
  return root;
}

function fileExplorerWidget(spec, ctx) {
  const props = spec.props || {};
  const { root, body, actions } = shell(ctx, spec, { title: props.root || "File Explorer", icon: "▤" });
  const refresh = el("button", "widget-act", "↻");
  refresh.title = "Refresh";
  refresh.disabled = !ctx.machineOn;
  actions.prepend(refresh);

  async function load(path = "") {
    const st = ctx.state.get() || { expanded: { "": true } };
    ctx.state.set({ ...st, loading: true, error: "" });
    paint();
    try {
      const data = await ctx.fsTree(path, path ? 1 : 2);
      const next = ctx.state.get() || { expanded: { "": true } };
      const tree = path ? replaceTreeNode(next.tree, data.tree) : data.tree;
      ctx.state.set({ ...next, tree, loading: false, error: "" });
    } catch (e) {
      const next = ctx.state.get() || {};
      ctx.state.set({ ...next, loading: false, error: e.message || String(e) });
    }
    paint();
  }

  async function open(path) {
    const st = ctx.state.get() || {};
    ctx.state.set({ ...st, selected: path, content: "Loading…" });
    paint();
    try {
      const file = await ctx.fsFile(path);
      ctx.state.set({ ...ctx.state.get(), selected: path, content: file.content || "" });
    } catch (e) {
      ctx.state.set({ ...ctx.state.get(), selected: path, content: e.message || String(e) });
    }
    paint();
  }

  async function toggle(node) {
    const st = ctx.state.get() || { expanded: { "": true } };
    const expanded = { ...(st.expanded || {}) };
    expanded[node.path] = !expanded[node.path];
    ctx.state.set({ ...st, expanded, selected: node.path });
    if (expanded[node.path] && !node.children) await load(node.path);
    else paint();
  }

  function paintNode(node, depth) {
    const isDir = node.type === "directory";
    const st = ctx.state.get() || {};
    const expanded = !!(st.expanded || {})[node.path];
    const wrap = el("div");
    const row = el("button", "artifact-file-row" + (st.selected === node.path ? " selected" : ""));
    row.style.paddingLeft = `${8 + depth * 14}px`;
    row.append(el("span", "artifact-file-caret", isDir ? (expanded ? "▾" : "▸") : ""));
    row.append(el("span", "artifact-file-name", node.name || node.path || "/"));
    row.addEventListener("click", () => isDir ? toggle(node) : open(node.path));
    wrap.append(row);
    if (isDir && expanded) for (const child of node.children || []) wrap.append(paintNode(child, depth + 1));
    return wrap;
  }

  function paint() {
    const st = ctx.state.get() || {};
    body.innerHTML = "";
    if (st.loading) body.append(el("div", "artifact-pending", "Loading files…"));
    if (st.error) body.append(el("div", "text-bad", st.error));
    const tree = st.tree;
    if (!tree) return;
    const list = el("div", "artifact-file-list");
    for (const child of tree.children || []) list.append(paintNode(child, 0));
    body.append(list);
    if (st.selected && st.content != null) {
      body.append(el("div", "artifact-file-path", st.selected));
      body.append(el("pre", "artifact-file-content", st.content));
    }
  }

  refresh.addEventListener("click", () => load(""));
  const initial = ctx.state.get() || {};
  if (!ctx.machineOn) {
    body.append(el("div", "artifact-pending", "Start the machine to browse files."));
  } else if (!initial.tree && !initial.loading) load("");
  else paint();
  return root;
}

function replaceTreeNode(root, node) {
  if (!root || root.path === node.path) return node;
  if (!Array.isArray(root.children)) return root;
  return { ...root, children: root.children.map((child) => replaceTreeNode(child, node)) };
}

const DIFF_CELL_LIMIT = 400_000; // n*m guard so big files don't hang the LCS

function computeDiff(a, b) {
  const A = a.split("\n");
  const B = b.split("\n");
  if (A.length * B.length > DIFF_CELL_LIMIT) {
    // Too large to diff cheaply — show as full delete + add.
    return [...A.map((l) => ({ t: "del", a: l })), ...B.map((l) => ({ t: "add", b: l }))];
  }
  const n = A.length;
  const m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) ops.push({ t: "eq", a: A[i], b: B[j], i, j }), i++, j++;
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ t: "del", a: A[i], i: i++ });
    else ops.push({ t: "add", b: B[j], j: j++ });
  }
  while (i < n) ops.push({ t: "del", a: A[i], i: i++ });
  while (j < m) ops.push({ t: "add", b: B[j], j: j++ });
  return ops;
}

function renderInline(ops) {
  const pre = el("pre", "diff diff-inline");
  for (const op of ops) {
    const sign = op.t === "add" ? "+" : op.t === "del" ? "-" : " ";
    const line = el("div", "diff-line " + op.t);
    line.append(el("span", "diff-gutter", sign));
    line.append(el("span", "diff-text", (op.t === "add" ? op.b : op.a) ?? ""));
    pre.append(line);
  }
  return pre;
}

function renderSplit(ops) {
  const grid = el("div", "diff-split");
  const left = el("pre", "diff diff-col");
  const right = el("pre", "diff diff-col");
  for (const op of ops) {
    if (op.t === "eq") {
      left.append(splitLine(op.a, "eq"));
      right.append(splitLine(op.b, "eq"));
    } else if (op.t === "del") {
      left.append(splitLine(op.a, "del"));
      right.append(splitLine("", "empty"));
    } else {
      left.append(splitLine("", "empty"));
      right.append(splitLine(op.b, "add"));
    }
  }
  grid.append(left, right);
  return grid;
}

function splitLine(text, t) {
  const line = el("div", "diff-line " + t);
  line.append(el("span", "diff-text", text ?? ""));
  return line;
}

function previewWidget(spec, ctx) {
  const props = spec.props || {};
  const title = props.title || (props.framework ? `${props.framework} preview` : "Preview");
  const { root, body } = shell(ctx, spec, { title, icon: "▷" });
  const previewId = props.id || "default";
  const src = safeFrameUrl(props.url || previewUrl(previewId, props.visibility));
  let frame;

  const chrome = el("div", "preview-chrome");
  const dots = el("div", "preview-dots");
  dots.append(el("span"), el("span"), el("span"));
  const address = el("div", "preview-address", src || "No preview URL");
  const status = pill(props.status || (src ? "ready" : "waiting"));
  chrome.append(dots, address, status);
  body.append(chrome);

  if (src) {
    const stage = el("div", "preview-stage desktop");
    frame = document.createElement("iframe");
    frame.className = "preview-frame";
    frame.loading = "lazy";
    frame.referrerPolicy = "no-referrer";
    frame.setAttribute("sandbox", PREVIEW_SANDBOX);
    frame.setAttribute("allow", PREVIEW_ALLOW);
    frame.allowFullscreen = true;
    frame.src = src;
    frame.title = title;
    stage.append(frame);
    body.append(stage);
  } else {
    body.append(el("div", "preview-empty", "Start a preview server and provide a local preview URL to show it here."));
  }

  const row = el("div", "widget-buttons");
  const open = el("button", "btn btn-primary", "Open ↗");
  open.disabled = !src;
  open.addEventListener("click", () => ctx.openUrl(src));
  row.append(open);

  const refresh = el("button", "btn btn-ghost", "Refresh");
  refresh.disabled = !frame;
  refresh.addEventListener("click", () => reloadFrame(frame, src));
  row.append(refresh);

  if (frame) {
    const device = el("button", "btn btn-ghost", "Mobile");
    device.addEventListener("click", () => {
      const stage = frame.parentElement;
      const mobile = !stage.classList.contains("mobile");
      stage.classList.toggle("mobile", mobile);
      stage.classList.toggle("desktop", !mobile);
      device.textContent = mobile ? "Desktop" : "Mobile";
    });
    row.append(device);
  }

  const payload = { id: previewId, cwd: props.cwd || "", command: props.command || "", port: props.port };
  if (props.visibility) payload.visibility = props.visibility;
  const start = el("button", "btn btn-ghost", "Start");
  start.disabled = !ctx.previewStart;
  start.addEventListener("click", () => runPreviewAction(start, "Starting…", () => ctx.previewStart(payload), status, frame, src, ctx));
  row.append(start);

  const restart = el("button", "btn btn-ghost", "Restart");
  restart.disabled = !ctx.previewRestart;
  restart.addEventListener("click", () => runPreviewAction(restart, "Restarting…", () => ctx.previewRestart(payload), status, frame, src, ctx));
  row.append(restart);

  const stop = el("button", "btn btn-ghost", "Stop");
  stop.disabled = !ctx.previewStop;
  stop.addEventListener("click", () => runPreviewAction(stop, "Stopping…", () => ctx.previewStop(previewId), status, frame, src, ctx));
  row.append(stop);
  body.append(row);
  return root;
}

function previewUrl(id = "default", visibility = "private") {
  const safeId = String(id || "default").replace(/[^A-Za-z0-9_-]/g, "") || "default";
  if (visibility === "public") return `/preview/public/${safeId}/`;
  return safeId === "default" ? "/preview/" : `/preview/${safeId}/`;
}

async function runPreviewAction(button, busyText, action, status, frame, src, ctx) {
  const prev = button.textContent;
  button.disabled = true;
  button.textContent = busyText;
  status.textContent = busyText.replace(/…$/, "").toLowerCase();
  status.className = "widget-pill amber";
  try {
    const result = await action();
    const next = result?.preview?.status || (result?.ok ? "ready" : "unknown");
    status.textContent = next;
    status.className = "widget-pill " + statusClass(next);
    reloadFrame(frame, src);
    ctx.toast("Preview " + next);
  } catch (e) {
    status.textContent = "error";
    status.className = "widget-pill bad";
    ctx.toast("Preview action failed: " + (e.message || e));
  } finally {
    button.disabled = false;
    button.textContent = prev;
  }
}

function reloadFrame(frame, src) {
  if (!frame || !src) return;
  frame.src = src + (src.includes("?") ? "&" : "?") + "_t=" + Date.now();
}

function sandboxWidget(spec, ctx) {
  const props = spec.props || {};
  const title = props.title || props.component || "Sandbox";
  const { root, body } = shell(ctx, spec, { title, icon: "▣" });
  const src = safeFrameUrl(props.url || previewUrl(props.id, props.visibility));
  const summary = el("div", "sandbox-summary");
  summary.append(pill(props.status || (src ? "isolated" : "configured")));
  summary.append(el("span", null, "Iframe sandbox: scripts may run, but no same-origin privileges, cookies, auth storage, or direct host APIs are exposed."));
  body.append(summary);

  if (src) {
    const frame = document.createElement("iframe");
    frame.className = "sandbox-frame";
    frame.loading = "lazy";
    frame.referrerPolicy = "no-referrer";
    frame.setAttribute("sandbox", PREVIEW_SANDBOX);
    frame.setAttribute("allow", PREVIEW_ALLOW);
    frame.allowFullscreen = true;
    frame.src = src;
    frame.title = title;
    body.append(frame);
  } else {
    body.append(el("div", "preview-empty", "Sandbox registration is ready. Provide a local URL from an approved preview endpoint to render it."));
  }

  const actions = el("div", "widget-buttons");
  const open = el("button", "btn btn-primary", "Open ↗");
  open.disabled = !src;
  open.addEventListener("click", () => ctx.openUrl(src));
  actions.append(open);
  body.append(actions);
  return root;
}

function safeFrameUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw, location.origin);
    if (url.origin === location.origin && (url.pathname === "/preview" || url.pathname.startsWith("/preview/"))) {
      return url.pathname + url.search + url.hash;
    }
  } catch {
    /* ignore invalid URLs */
  }
  return "";
}

function commandWidget(spec, ctx) {
  const props = spec.props || {};
  const { root, body } = shell(ctx, spec, { title: "Command", icon: "›_" });
  const cmd = el("div", "command-line");
  cmd.append(el("span", "command-prompt", "$"));
  cmd.append(el("code", null, props.command || ""));
  cmd.append(pill(props.status || "idle"));
  body.append(cmd);
  const out = (props.stdout || "") + (props.stderr ? "\n" + props.stderr : "");
  if (out.trim()) body.append(el("pre", "command-out", out));
  return root;
}

function formWidget(spec, ctx) {
  const props = spec.props || {};
  const { root, body } = shell(ctx, spec, { title: props.title || "Form", icon: "▤" });
  const form = el("form", "widget-form");
  const fields = Array.isArray(props.fields) ? props.fields : [];
  for (const f of fields) {
    const name = f.name || f.label || "field";
    const label = el("label", "settings-field");
    label.append(el("span", null, f.label || name));
    let input;
    if (f.type === "select") {
      input = el("select", "field");
      (f.options || []).forEach((o) => {
        const opt = el("option", null, typeof o === "string" ? o : o.label || o.value);
        opt.value = typeof o === "string" ? o : o.value ?? o.label;
        input.append(opt);
      });
    } else if (f.type === "textarea") {
      input = el("textarea", "field");
      if (f.placeholder) input.placeholder = f.placeholder;
    } else {
      input = el("input", "field");
      input.type = f.type || "text";
      if (f.placeholder) input.placeholder = f.placeholder;
    }
    input.name = name;
    if (f.required) input.required = true;
    if (f.value != null) input.value = f.value;
    label.append(input);
    form.append(label);
  }
  const submit = el("button", "btn btn-primary", props.submitLabel || "Submit");
  submit.type = "submit";
  form.append(el("div", "widget-buttons")).append(submit);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const data = {};
    for (const f of fields) {
      const name = f.name || f.label || "field";
      const node = form.elements[name];
      if (node) data[name] = node.value;
    }
    // Submission becomes a message back to the agent (the tool-call path comes in Phase 2).
    const lines = Object.entries(data).map(([k, v]) => `- ${k}: ${v}`).join("\n");
    ctx.sendText(`Submitted "${props.title || "form"}":\n${lines}`);
    ctx.toast("Form submitted");
    submit.disabled = true;
    submit.textContent = "Submitted ✓";
  });
  body.append(form);
  return root;
}

function unknownWidget(spec, ctx) {
  const { root, body } = shell(ctx, spec, { title: `Unsupported widget: ${spec.type}`, icon: "▢" });
  const det = el("details", "widget-raw");
  det.append(el("summary", null, "Show description"));
  det.append(el("pre", null, JSON.stringify(spec.props ?? spec, null, 2)));
  body.append(det);
  return root;
}

function errorWidget(spec, err) {
  const root = el("div", "widget");
  const body = el("div", "widget-body");
  body.append(el("div", "text-bad", `Could not render "${spec?.type}" widget: ${err?.message || err}`));
  root.append(body);
  return root;
}
