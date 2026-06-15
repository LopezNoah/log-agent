// Ephemeral UI artifacts. The assistant emits fenced ```ui blocks containing JSON UI
// *descriptions* — never HTML. This module parses them and renders each with a trusted,
// hand-built component. No arbitrary code runs: every value is inserted via textContent.
//
//   ```ui
//   { "type": "checklist", "props": { "title": "Plan", "items": [ ... ] } }
//   ```
//
// Unknown types and invalid JSON degrade to a plain code block, so normal chats are untouched.

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
  preview: previewWidget,
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
  const { root, body } = shell(ctx, spec, { title: props.framework ? `Preview · ${props.framework}` : "Preview", icon: "▷" });
  const top = el("div", "preview-top");
  top.append(pill(props.status || "unknown"));
  if (props.url) top.append(el("span", "preview-url", props.url));
  body.append(top);

  const row = el("div", "widget-buttons");
  const open = el("button", "btn btn-primary", "Open ↗");
  open.disabled = !props.url;
  open.addEventListener("click", () => ctx.openUrl(props.url));
  row.append(open);
  // Restart/Stop need the preview-control API (a later phase); show them disabled for now.
  for (const label of ["Refresh", "Restart", "Stop"]) {
    const b = el("button", "btn btn-ghost", label);
    b.disabled = true;
    b.title = "Preview control API coming soon";
    row.append(b);
  }
  body.append(row);
  return root;
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
