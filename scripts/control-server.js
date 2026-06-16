const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");

const HOME = process.env.HOME || "/home/dev";
const AGENTS_PATH = path.join(HOME, ".config", "opencode", "AGENTS.md");
const FS_ROOT = path.resolve(process.env.WORKSPACE_ROOT || path.join(HOME, "workspace"));
const MAX_FILE_BYTES = 1_000_000;
const MAX_TREE_ENTRIES = 800;

const host = "0.0.0.0";
const port = Number(process.env.PORT || "8080");

const ttydHost = "127.0.0.1";
const ttydPort = Number(process.env.TTYD_PORT || "7681");

const opencodeHost = "127.0.0.1";
const opencodePort = Number(process.env.OPENCODE_PORT || "4096");
const opencodeUser = process.env.OPENCODE_SERVER_USERNAME || "opencode";

const previewHost = "127.0.0.1";
const previewPortBase = Number(process.env.PREVIEW_PORT || "5173");
const PREVIEW_STATE_PATH = path.join(HOME, ".opencode-phone", "previews.json");
const previews = new Map();

const password = process.env.OPENCODE_SERVER_PASSWORD || "change-me-now";

// opencode serve also enforces Basic auth (it reads OPENCODE_SERVER_PASSWORD). It only
// listens on loopback, so this header is added internally when proxying upstream.
const opencodeAuth =
  "Basic " + Buffer.from(`${opencodeUser}:${password}`).toString("base64");

const previewResponseHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

function requestProto(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  return proto || "http";
}

function requestHost(req) {
  const host = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
  return host || req.headers.host || "";
}

function authorized(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;
  try {
    const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
    const index = decoded.indexOf(":");
    return decoded.slice(index + 1) === password;
  } catch {
    return false;
  }
}

function requireAuth(req, res) {
  if (authorized(req)) return true;
  res.writeHead(401, { "WWW-Authenticate": 'Basic realm="opencode-phone"' });
  res.end("Unauthorized");
  return false;
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(`${JSON.stringify(body)}\n`);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 2_000_000) req.destroy(); // 2MB guard
    });
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); } catch { resolve(null); }
    });
    req.on("error", () => resolve(null));
  });
}

function parseUrl(rawUrl) {
  return new URL(rawUrl || "/", "http://opencode-phone.local");
}

function isSafeRelPath(input) {
  const rel = String(input || "").replace(/^\/+/, "");
  return !rel.includes("\0") && !path.isAbsolute(rel) && rel.split(/[\\/]+/).every((part) => part !== "..");
}

function normalizeRelPath(input) {
  const rel = String(input || "").replace(/^\/+/, "");
  if (!isSafeRelPath(rel)) throw Object.assign(new Error("invalid_path"), { status: 400 });
  return rel === "." ? "" : rel;
}

function ensureInsideRoot(absPath) {
  const rootReal = fs.realpathSync(FS_ROOT);
  const real = fs.realpathSync(absPath);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    throw Object.assign(new Error("path_outside_root"), { status: 403 });
  }
  return real;
}

function ensureWritableParent(parent) {
  const rootReal = fs.realpathSync(FS_ROOT);
  let cursor = parent;
  while (!fs.existsSync(cursor)) {
    const next = path.dirname(cursor);
    if (next === cursor) throw Object.assign(new Error("path_outside_root"), { status: 403 });
    cursor = next;
  }
  const real = fs.realpathSync(cursor);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    throw Object.assign(new Error("path_outside_root"), { status: 403 });
  }
  let current = FS_ROOT;
  const relative = path.relative(FS_ROOT, parent);
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) break;
    if (fs.lstatSync(current).isSymbolicLink()) throw Object.assign(new Error("symlink_not_allowed"), { status: 400 });
  }
}

function resolveExisting(rel) {
  const safeRel = normalizeRelPath(rel);
  const abs = path.resolve(FS_ROOT, safeRel);
  ensureInsideRoot(abs);
  return { rel: safeRel, abs };
}

function resolveWritable(rel) {
  const safeRel = normalizeRelPath(rel);
  if (!safeRel) throw Object.assign(new Error("invalid_path"), { status: 400 });
  const abs = path.resolve(FS_ROOT, safeRel);
  const parent = path.dirname(abs);
  ensureWritableParent(parent);
  if (fs.existsSync(abs)) {
    const stat = fs.lstatSync(abs);
    if (stat.isSymbolicLink()) throw Object.assign(new Error("symlink_not_allowed"), { status: 400 });
    ensureInsideRoot(abs);
  }
  return { rel: safeRel, abs };
}

function fsNode(abs, rel, depth, budget) {
  if (budget.count++ > MAX_TREE_ENTRIES) return null;
  const stat = fs.lstatSync(abs);
  const name = rel ? path.basename(rel) : path.basename(FS_ROOT);
  const base = {
    name,
    path: rel,
    type: stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "file",
    size: stat.size,
    mtime: stat.mtime.toISOString(),
  };
  if (!stat.isDirectory() || depth <= 0 || stat.isSymbolicLink()) return base;
  const entries = fs.readdirSync(abs, { withFileTypes: true })
    .filter((entry) => entry.name !== ".git" && entry.name !== "node_modules")
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  base.children = [];
  for (const entry of entries) {
    const childRel = rel ? path.join(rel, entry.name) : entry.name;
    const childAbs = path.join(abs, entry.name);
    try {
      const child = fsNode(childAbs, childRel, depth - 1, budget);
      if (child) base.children.push(child);
    } catch {
      // Ignore unreadable entries instead of failing the whole tree.
    }
  }
  return base;
}

function fsError(res, e) {
  json(res, e && e.status || 500, { error: String(e && e.message || e) });
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
    ".map": "application/json; charset=utf-8",
  }[ext] || "application/octet-stream";
}

function loadPreviewState() {
  try {
    const saved = JSON.parse(fs.readFileSync(PREVIEW_STATE_PATH, "utf8"));
    for (const item of saved.previews || []) {
      if (!item || typeof item.id !== "string") continue;
      const id = previewId(item.id);
      if (!id) continue;
      const cwdRel = normalizeRelPath(item.cwd || "");
      const cwd = path.resolve(FS_ROOT, cwdRel);
      previews.set(id, {
        id,
        cwdRel,
        cwd,
        port: Number(item.port || previewPortBase),
        command: String(item.command || ""),
        visibility: item.visibility === "public" ? "public" : "private",
        createdAt: item.createdAt || new Date().toISOString(),
        updatedAt: item.updatedAt || new Date().toISOString(),
        child: null,
        stdout: "",
        stderr: "",
      });
    }
  } catch {
    /* no persisted previews yet */
  }
}

function savePreviewState() {
  fs.mkdirSync(path.dirname(PREVIEW_STATE_PATH), { recursive: true });
  const items = [...previews.values()].map((preview) => ({
    id: preview.id,
    cwd: preview.cwdRel,
    port: preview.port,
    command: preview.command,
    visibility: preview.visibility || "private",
    createdAt: preview.createdAt,
    updatedAt: preview.updatedAt,
  }));
  fs.writeFileSync(PREVIEW_STATE_PATH, JSON.stringify({ previews: items }, null, 2));
}

function previewId(value) {
  return String(value || "default").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "default";
}

function previewBasePath(preview) {
  if (preview.visibility === "public") return `/preview/public/${preview.id}/`;
  return preview.id === "default" ? "/preview/" : `/preview/${preview.id}/`;
}

function rewritePreviewHtml(html, basePath) {
  let out = html;
  if (!/<base\s/i.test(out)) out = out.replace(/<head(\s[^>]*)?>/i, (m) => `${m}<base href="${basePath}">`);
  const attrs = "(?:src|href|action|poster)";
  out = out.replace(new RegExp(`\\b(${attrs})=(['\"])/(?!/|preview/)`, "gi"), `$1=$2${basePath}`);
  out = out.replace(/url\((['"]?)\/(?!\/|preview\/)/gi, `url($1${basePath}`);
  return out;
}

function handleFs(req, res, url) {
  try { fs.mkdirSync(FS_ROOT, { recursive: true }); } catch (e) { return void fsError(res, e); }

  if (url.pathname === "/fs/tree" && req.method === "GET") {
    try {
      const { rel, abs } = resolveExisting(url.searchParams.get("path") || "");
      const depth = Math.max(0, Math.min(3, Number(url.searchParams.get("depth") || "1")));
      return void json(res, 200, { root: "/workspace", path: rel, tree: fsNode(abs, rel, depth, { count: 0 }) });
    } catch (e) { return void fsError(res, e); }
  }

  if (url.pathname === "/fs/file" && req.method === "GET") {
    try {
      const { rel, abs } = resolveExisting(url.searchParams.get("path") || "");
      const stat = fs.lstatSync(abs);
      if (!stat.isFile() || stat.isSymbolicLink()) return void json(res, 400, { error: "not_a_file" });
      if (stat.size > MAX_FILE_BYTES) return void json(res, 413, { error: "file_too_large", maxBytes: MAX_FILE_BYTES });
      return void json(res, 200, { path: rel, content: fs.readFileSync(abs, "utf8"), size: stat.size, mtime: stat.mtime.toISOString() });
    } catch (e) { return void fsError(res, e); }
  }

  if (url.pathname === "/fs/file" && req.method === "PUT") {
    return void readBody(req).then((body) => {
      try {
        if (!body || typeof body.path !== "string" || typeof body.content !== "string") return json(res, 400, { error: "missing_path_or_content" });
        if (Buffer.byteLength(body.content, "utf8") > MAX_FILE_BYTES) return json(res, 413, { error: "file_too_large", maxBytes: MAX_FILE_BYTES });
        const { rel, abs } = resolveWritable(body.path);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, body.content, "utf8");
        json(res, 200, { ok: true, path: rel });
      } catch (e) { fsError(res, e); }
    });
  }

  if (url.pathname === "/fs/mkdir" && req.method === "POST") {
    return void readBody(req).then((body) => {
      try {
        if (!body || typeof body.path !== "string") return json(res, 400, { error: "missing_path" });
        const { rel, abs } = resolveWritable(body.path);
        fs.mkdirSync(abs, { recursive: true });
        json(res, 200, { ok: true, path: rel });
      } catch (e) { fsError(res, e); }
    });
  }

  if (url.pathname === "/fs/path" && req.method === "DELETE") {
    const target = url.searchParams.get("path");
    return void readBody(req).then((body) => {
      try {
        const relPath = target || body && body.path;
        if (typeof relPath !== "string" || !relPath) return json(res, 400, { error: "missing_path" });
        const { rel, abs } = resolveExisting(relPath);
        if (!rel) return json(res, 400, { error: "cannot_delete_root" });
        const stat = fs.lstatSync(abs);
        fs.rmSync(abs, { recursive: stat.isDirectory(), force: false, maxRetries: 2, retryDelay: 50 });
        json(res, 200, { ok: true, path: rel, recursive: stat.isDirectory() });
      } catch (e) { fsError(res, e); }
    });
  }

  if (url.pathname === "/fs/rename" && req.method === "POST") {
    return void readBody(req).then((body) => {
      try {
        if (!body || typeof body.from !== "string" || typeof body.to !== "string") return json(res, 400, { error: "missing_from_or_to" });
        const from = resolveExisting(body.from);
        const to = resolveWritable(body.to);
        if (!from.rel || !to.rel) return json(res, 400, { error: "invalid_path" });
        if (fs.existsSync(to.abs)) return json(res, 409, { error: "target_exists" });
        fs.mkdirSync(path.dirname(to.abs), { recursive: true });
        fs.renameSync(from.abs, to.abs);
        json(res, 200, { ok: true, path: to.rel });
      } catch (e) { fsError(res, e); }
    });
  }

  json(res, 404, { error: "not_found" });
}

function previewInfo(preview) {
  const status = preview.child
    ? preview.child.exitCode == null && preview.child.signalCode == null ? "running" : "stopped"
    : preview.command ? "stopped" : "static";
  return {
    id: preview.id,
    pid: preview.child?.pid || 0,
    pgid: preview.child?.pid || 0,
    cwd: preview.cwdRel,
    port: preview.port,
    status,
    command: preview.command || "static workspace",
    visibility: preview.visibility || "private",
    url: previewBasePath(preview),
    createdAt: preview.createdAt,
    updatedAt: preview.updatedAt,
    stdout: preview.stdout || "",
    stderr: preview.stderr || "",
  };
}

function appendPreviewLog(preview, key, chunk) {
  preview[key] = (preview[key] || "") + chunk.toString("utf8");
  if (preview[key].length > 20_000) preview[key] = preview[key].slice(-20_000);
}

function nextPreviewPort() {
  const used = new Set([...previews.values()].map((preview) => preview.port));
  let port = previewPortBase;
  while (used.has(port)) port++;
  return port;
}

function detectPreviewCommand(cwd, port, basePath) {
  const packagePath = path.join(cwd, "package.json");
  if (!fs.existsSync(packagePath)) return "";
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(packagePath, "utf8")); } catch { return ""; }
  const scripts = pkg.scripts || {};
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  if (scripts.dev) {
    if (deps.vite) return `npm run dev -- --host 0.0.0.0 --port ${port} --base ${basePath}`;
    if (deps.next) return `npm run dev -- --hostname 0.0.0.0 --port ${port}`;
    return `npm run dev -- --host 0.0.0.0 --port ${port}`;
  }
  if (scripts.start) return `npm start -- --host 0.0.0.0 --port ${port}`;
  return "";
}

function stopPreview(id = "default") {
  const preview = previews.get(previewId(id));
  if (!preview) return false;
  stopPreviewProcess(preview);
  previews.delete(preview.id);
  savePreviewState();
  return true;
}

function stopPreviewProcess(preview) {
  if (preview.child && preview.child.exitCode == null && preview.child.signalCode == null) {
    try { process.kill(-preview.child.pid, "SIGTERM"); } catch { try { preview.child.kill("SIGTERM"); } catch { /* already gone */ } }
  }
  preview.child = null;
  preview.updatedAt = new Date().toISOString();
  savePreviewState();
}

function startPreview(body = {}) {
  const id = previewId(body.id);
  const previous = previews.get(id);
  const cwdRel = normalizeRelPath(body.cwd || "");
  const cwd = path.resolve(FS_ROOT, cwdRel);
  ensureInsideRoot(cwd);
  if (!fs.lstatSync(cwd).isDirectory()) throw Object.assign(new Error("cwd_not_directory"), { status: 400 });

  if (previous?.child && previous.child.exitCode == null && previous.child.signalCode == null) {
    stopPreviewProcess(previous);
  }
  const port = Math.max(1024, Math.min(65535, Number(body.port || nextPreviewPort())));
  const visibility = body.visibility === "public" || body.visibility === "private" ? body.visibility : previous?.visibility || "private";
  const basePath = previewBasePath({ id, visibility });
  const command = typeof body.command === "string" && body.command.trim()
    ? body.command.trim()
    : detectPreviewCommand(cwd, port, basePath);
  const now = new Date().toISOString();
  const preview = {
    id,
    cwdRel,
    cwd,
    port,
    command,
    visibility,
    createdAt: previous?.createdAt || now,
    updatedAt: now,
    child: null,
    stdout: "",
    stderr: "",
  };

  if (command) {
    const child = spawn(command, {
      cwd,
      detached: true,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PORT: String(port), HOST: "0.0.0.0", BROWSER: "none", CI: "1" },
    });
    preview.child = child;
    child.stdout.on("data", (chunk) => appendPreviewLog(preview, "stdout", chunk));
    child.stderr.on("data", (chunk) => appendPreviewLog(preview, "stderr", chunk));
    child.on("exit", (code, signal) => {
      appendPreviewLog(preview, "stderr", `\npreview exited: ${signal || code}\n`);
    });
    child.unref();
  }

  previews.set(id, preview);
  savePreviewState();
  return preview;
}

function stripPreviewPath(rawUrl, preview, publicRoute = false) {
  const base = publicRoute ? `/preview/public/${preview.id}` : preview.id === "default" ? "/preview" : `/preview/${preview.id}`;
  const stripped = rawUrl.replace(new RegExp("^" + base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/?"), "/");
  return stripped === "" ? "/" : stripped;
}

function serveStaticPreview(req, res, preview, assetPath) {
  if (req.method !== "GET" && req.method !== "HEAD") return void json(res, 405, { error: "method_not_allowed" });
  let rel;
  try { rel = normalizeRelPath(decodeURIComponent(assetPath.replace(/^\/+/, ""))); }
  catch (e) { return void fsError(res, e); }
  let abs = path.resolve(preview.cwd, rel || "index.html");
  try {
    ensureInsideRoot(preview.cwd);
    if (!fs.existsSync(abs) || fs.lstatSync(abs).isDirectory()) abs = path.join(preview.cwd, "index.html");
    if (!fs.existsSync(abs) || !fs.lstatSync(abs).isFile()) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...previewResponseHeaders });
      return void res.end(`<!doctype html><title>Preview</title><body style="font:14px system-ui;padding:24px"><h1>No preview yet</h1><p>Create an index.html in /workspace, or POST /preview/start to launch a dev server.</p></body>`);
    }
    ensureInsideRoot(abs);
    const type = contentType(abs);
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", ...previewResponseHeaders });
    if (req.method === "HEAD") return void res.end();
    if (type.startsWith("text/html")) return void res.end(rewritePreviewHtml(fs.readFileSync(abs, "utf8"), previewBasePath(preview)));
    fs.createReadStream(abs).pipe(res);
  } catch (e) { fsError(res, e); }
}

function handlePreview(req, res, url, rawUrl) {
  try { fs.mkdirSync(FS_ROOT, { recursive: true }); } catch (e) { return void fsError(res, e); }

  if (url.pathname === "/preview/list" && req.method === "GET") {
    return void json(res, 200, { previews: [...previews.values()].map(previewInfo) });
  }

  if (url.pathname === "/preview/start" && req.method === "POST") {
    return void readBody(req).then((body) => {
      try { json(res, 200, { ok: true, preview: previewInfo(startPreview(body || {})) }); }
      catch (e) { fsError(res, e); }
    });
  }

  if (url.pathname === "/preview/restart" && req.method === "POST") {
    return void readBody(req).then((body) => {
      try {
        const id = previewId(body?.id);
        const previous = previews.get(id);
        const next = startPreview({
          id,
          cwd: previous?.cwdRel || "",
          command: previous?.command || "",
          port: previous?.port,
          ...(body || {}),
        });
        json(res, 200, { ok: true, preview: previewInfo(next) });
      } catch (e) { fsError(res, e); }
    });
  }

  if (url.pathname === "/preview/stop" && req.method === "POST") {
    return void readBody(req).then((body) => {
      try {
        const preview = previews.get(previewId(body?.id));
        if (!preview) return json(res, 404, { error: "preview_not_found" });
        stopPreviewProcess(preview);
        json(res, 200, { ok: true, preview: previewInfo(preview) });
      } catch (e) { fsError(res, e); }
    });
  }

  if (/^\/preview\/[^/]+\/visibility$/.test(url.pathname) && req.method === "POST") {
    const id = previewId(url.pathname.split("/")[2]);
    return void readBody(req).then((body) => {
      try {
        const preview = previews.get(id);
        if (!preview) return json(res, 404, { error: "preview_not_found" });
        preview.visibility = body?.visibility === "public" ? "public" : "private";
        preview.updatedAt = new Date().toISOString();
        savePreviewState();
        json(res, 200, { ok: true, preview: previewInfo(preview) });
      } catch (e) { fsError(res, e); }
    });
  }

  if (url.pathname === "/preview/all" && req.method === "DELETE") {
    for (const id of [...previews.keys()]) stopPreview(id);
    return void json(res, 200, { ok: true });
  }

  if (/^\/preview\/[^/]+$/.test(url.pathname) && req.method === "DELETE") {
    const id = decodeURIComponent(url.pathname.slice("/preview/".length)) || "default";
    return void json(res, 200, { ok: stopPreview(id), id });
  }

  const route = previewRoute(url.pathname);
  if (!route) return void json(res, 404, { error: "not_found" });
  const preview = previews.get(route.id) || (!route.publicRoute ? defaultPreview(route.id) : null);
  if (!preview) return void json(res, 404, { error: "preview_not_found" });
  if (route.publicRoute && preview.visibility !== "public") return void json(res, 404, { error: "preview_not_found" });

  if (preview?.child && preview.child.exitCode == null && preview.child.signalCode == null) {
    const basePath = previewBasePath(preview);
    proxyHttp(req, res, {
      upstreamHost: previewHost,
      upstreamPort: preview.port,
      path: stripPreviewPath(rawUrl, preview, route.publicRoute),
      extraHeaders: previewForwardHeaders(req, basePath),
      responseHeaders: previewResponseHeaders,
      rewriteResponse: (body, headers) => maybeRewritePreviewResponse(body, headers, basePath),
      rewriteLocation: (location) => rewritePreviewLocation(location, req, basePath),
    });
    return;
  }
  serveStaticPreview(req, res, preview, route.assetPath);
}

function previewForwardHeaders(req, basePath) {
  return {
    "x-forwarded-host": requestHost(req),
    "x-forwarded-proto": requestProto(req),
    "x-forwarded-prefix": basePath.replace(/\/$/, ""),
  };
}

function maybeRewritePreviewResponse(body, headers, basePath) {
  const type = String(headers["content-type"] || "").toLowerCase();
  if (!type.includes("text/html")) return body;
  return rewritePreviewHtml(body.toString("utf8"), basePath);
}

function rewritePreviewLocation(location, req, basePath) {
  if (!location) return location;
  try {
    const publicOrigin = `${requestProto(req)}://${requestHost(req)}`;
    const parsed = new URL(location, publicOrigin);
    if (parsed.origin !== publicOrigin) return location;
    const pathAndQuery = parsed.pathname + parsed.search + parsed.hash;
    if (pathAndQuery === basePath.slice(0, -1) || pathAndQuery.startsWith(basePath)) return pathAndQuery;
    return basePath + pathAndQuery.replace(/^\/+/, "");
  } catch {
    return location.startsWith("/") && !location.startsWith(basePath) ? basePath + location.replace(/^\/+/, "") : location;
  }
}

function previewRoute(pathname) {
  if (pathname === "/preview" || pathname === "/preview/") return { id: "default", assetPath: "", publicRoute: false };
  let m = pathname.match(/^\/preview\/public\/([^/]+)\/?(.*)$/);
  if (m) return { id: previewId(m[1]), assetPath: m[2] || "", publicRoute: true };
  m = pathname.match(/^\/preview\/([^/]+)\/?(.*)$/);
  if (!m || ["start", "list", "restart", "stop", "all", "public"].includes(m[1])) return null;
  return { id: previewId(m[1]), assetPath: m[2] || "", publicRoute: false };
}

function defaultPreview(id = "default") {
  id = previewId(id);
  return {
    id,
    cwdRel: "",
    cwd: FS_ROOT,
    port: previewPortBase,
    command: "",
    visibility: "private",
    createdAt: "",
    updatedAt: "",
    child: null,
    stdout: "",
    stderr: "",
  };
}

// Configure git + gh to use a pushed GitHub token. Writes the git credential store and gh's
// hosts.yml so both `git push` and `gh issue create` work without the token in the environment.
function configureGithub(token, username) {
  const user = username || "x-access-token";
  fs.writeFileSync(path.join(HOME, ".git-credentials"), `https://${user}:${token}@github.com\n`, { mode: 0o600 });
  try { execFileSync("git", ["config", "--global", "credential.helper", "store"]); } catch { /* best effort */ }

  const ghDir = path.join(HOME, ".config", "gh");
  fs.mkdirSync(ghDir, { recursive: true });
  fs.writeFileSync(
    path.join(ghDir, "hosts.yml"),
    `github.com:\n    oauth_token: ${token}\n    user: ${user}\n    git_protocol: https\n`,
    { mode: 0o600 },
  );
}

// Stream a request through to an upstream HTTP service. SSE and chunked responses pass
// through untouched because we pipe the upstream response body directly.
function proxyHttp(req, res, { upstreamHost, upstreamPort, path, extraHeaders = {}, responseHeaders = {}, rewriteResponse, rewriteLocation }) {
  const headers = { ...req.headers, host: `${upstreamHost}:${upstreamPort}`, ...extraHeaders };
  if (rewriteResponse) delete headers["accept-encoding"];
  let responded = false;

  const upstream = http.request(
    { host: upstreamHost, port: upstreamPort, method: req.method, path, headers },
    (upstreamRes) => {
      responded = true;
      const headers = { ...upstreamRes.headers };
      if (rewriteLocation && headers.location) headers.location = rewriteLocation(String(headers.location));
      const shouldRewrite = rewriteResponse && String(headers["content-type"] || "").toLowerCase().includes("text/html");
      if (!shouldRewrite) {
        res.writeHead(upstreamRes.statusCode || 502, { ...headers, ...responseHeaders });
        upstreamRes.pipe(res);
        return;
      }
      const chunks = [];
      upstreamRes.on("data", (chunk) => chunks.push(chunk));
      upstreamRes.on("end", () => {
        const body = rewriteResponse(Buffer.concat(chunks), headers);
        delete headers["content-length"];
        res.writeHead(upstreamRes.statusCode || 502, { ...headers, ...responseHeaders });
        res.end(body);
      });
    },
  );

  upstream.on("error", (error) => {
    if (responded || res.headersSent) {
      res.destroy(error);
      return;
    }
    json(res, 502, { error: "upstream_unavailable", message: error.message });
  });

  req.pipe(upstream);
}

// ---------------------------------------------------------------------------
// /exec : structured run service (Agent Architecture v2). Start a command in a
// detached process group, stream stdout/stderr over SSE, report status, and
// kill the whole tree (SIGTERM -> 5s -> SIGKILL). The Worker's agent tools call
// these; the Worker forwards the SSE straight to the browser.
// ---------------------------------------------------------------------------
const runs = new Map(); // id -> run
let runSeq = 0;
const RUN_RETENTION_MS = 5 * 60_000; // keep finished runs briefly for late status/stream
const MAX_BUFFERED_EVENTS = 4000; // cap per-run replay buffer

function makeRunId() {
  runSeq += 1;
  return `run_${Date.now().toString(36)}_${runSeq}`;
}

function emit(run, event, data) {
  run.events.push({ event, data });
  if (run.events.length > MAX_BUFFERED_EVENTS) run.events.shift();
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of run.subscribers) { try { res.write(payload); } catch { /* dropped */ } }
}

function finishRun(run, code, signal) {
  if (run.endedMs) return; // once
  run.endedMs = Date.now();
  run.exitCode = code;
  run.signal = signal || null;
  if (run.timeoutTimer) { clearTimeout(run.timeoutTimer); run.timeoutTimer = null; }
  if (run.killTimer) { clearTimeout(run.killTimer); run.killTimer = null; }
  emit(run, "exit", { exitCode: code, signal: signal || null, status: run.status });
  for (const res of run.subscribers) { try { res.end(); } catch { /* dropped */ } }
  run.subscribers.clear();
  run.cleanupTimer = setTimeout(() => runs.delete(run.id), RUN_RETENTION_MS);
}

function killRun(run) {
  if (!run || run.endedMs || !run.child) return;
  run.status = "killed";
  const pid = run.child.pid;
  // SIGTERM the process group (negative pid), then SIGKILL the tree after 5s if still alive.
  try { process.kill(-pid, "SIGTERM"); } catch { try { run.child.kill("SIGTERM"); } catch { /* gone */ } }
  run.killTimer = setTimeout(() => {
    try { process.kill(-pid, "SIGKILL"); } catch { try { run.child.kill("SIGKILL"); } catch { /* gone */ } }
  }, 5000);
}

function execStart(body) {
  const command = typeof body.command === "string" ? body.command.trim() : "";
  if (!command) throw Object.assign(new Error("missing_command"), { status: 400 });
  const cwdRel = normalizeRelPath(body.cwd || "");
  const cwd = path.resolve(FS_ROOT, cwdRel);
  ensureInsideRoot(cwd);
  if (!fs.existsSync(cwd) || !fs.lstatSync(cwd).isDirectory()) {
    throw Object.assign(new Error("cwd_not_directory"), { status: 400 });
  }
  const timeoutMs = Number(body.timeoutMs) > 0 ? Math.min(Number(body.timeoutMs), 30 * 60_000) : 0;

  const id = makeRunId();
  const child = spawn(command, {
    cwd,
    detached: true, // own process group → SIGTERM/SIGKILL the whole tree on kill
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CI: "1", BROWSER: "none" },
  });
  const run = {
    id, command, cwdRel,
    status: "running", // running | exited | killed | error
    exitCode: null, signal: null,
    startedAt: new Date().toISOString(), startedMs: Date.now(), endedMs: null,
    events: [], subscribers: new Set(), child,
    killTimer: null, timeoutTimer: null, cleanupTimer: null,
  };
  runs.set(id, run);

  child.stdout.on("data", (c) => emit(run, "stdout", { text: c.toString("utf8") }));
  child.stderr.on("data", (c) => emit(run, "stderr", { text: c.toString("utf8") }));
  child.on("error", (err) => { run.status = "error"; emit(run, "stderr", { text: `spawn error: ${err.message}` }); finishRun(run, null, null); });
  child.on("exit", (code, signal) => { if (run.status === "running") run.status = signal ? "killed" : "exited"; finishRun(run, code, signal); });
  child.unref();

  if (timeoutMs) {
    run.timeoutTimer = setTimeout(() => { emit(run, "stderr", { text: `\n[timed out after ${timeoutMs}ms]\n` }); killRun(run); }, timeoutMs);
  }
  return run;
}

function runStatus(run) {
  return {
    id: run.id, status: run.status, exitCode: run.exitCode, signal: run.signal,
    startedAt: run.startedAt, runtimeMs: (run.endedMs || Date.now()) - run.startedMs,
  };
}

function handleExec(req, res, url) {
  if (url.pathname === "/exec/start" && req.method === "POST") {
    return void readBody(req).then((body) => {
      if (!body) return json(res, 400, { error: "invalid_body" });
      try { const run = execStart(body); json(res, 200, { id: run.id, status: run.status }); }
      catch (e) { json(res, e.status || 500, { error: e.message || "exec_failed" }); }
    });
  }

  const m = url.pathname.match(/^\/exec\/([^/]+)(\/events|\/kill)?$/);
  if (!m) return void json(res, 404, { error: "not_found" });
  const run = runs.get(decodeURIComponent(m[1]));
  if (!run) return void json(res, 404, { error: "run_not_found" });
  const sub = m[2];

  if (sub === "/events" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");
    for (const f of run.events) res.write(`event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`);
    if (run.endedMs) return void res.end(); // already finished — replay buffer included the exit event
    run.subscribers.add(res);
    const drop = () => run.subscribers.delete(res);
    req.on("close", drop);
    res.on("close", drop);
    return;
  }
  if (sub === "/kill" && req.method === "POST") { killRun(run); return void json(res, 200, { ok: true }); }
  if (!sub && req.method === "GET") return void json(res, 200, runStatus(run));
  return void json(res, 405, { error: "method_not_allowed" });
}

// ---------------------------------------------------------------------------
// /relay/codex : forward a ChatGPT-subscription (codex) request to chatgpt.com from the box's
// (non-Cloudflare) IP. chatgpt.com bot-blocks Cloudflare Workers, so the Worker's agent runtime
// sends the call here. The codex bearer arrives as X-Codex-Auth (the box's own Basic auth is on
// Authorization); we forward it as Authorization to chatgpt.com and stream the SSE response back.
// Restricted to the single codex endpoint — not an open proxy.
// ---------------------------------------------------------------------------
const CODEX_RELAY_TARGET = "https://chatgpt.com/backend-api/codex/responses";

function readRaw(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(Buffer.alloc(0)));
  });
}

function hdr(req, name) {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

async function handleCodexRelay(req, res) {
  const codexAuth = hdr(req, "x-codex-auth");
  if (!codexAuth) return void json(res, 400, { error: "missing_codex_auth" });
  const body = await readRaw(req);
  const headers = {
    Authorization: codexAuth,
    "Content-Type": hdr(req, "content-type") || "application/json",
    Accept: hdr(req, "accept") || "text/event-stream",
    originator: hdr(req, "originator") || "opencode",
    "User-Agent": hdr(req, "user-agent") || "opencode-phone/1.0",
  };
  const account = hdr(req, "x-codex-account");
  if (account) headers["ChatGPT-Account-Id"] = account;

  let upstream;
  try {
    upstream = await fetch(CODEX_RELAY_TARGET, { method: "POST", headers, body });
  } catch (e) {
    return void json(res, 502, { error: "codex_relay_failed", message: String((e && e.message) || e) });
  }

  res.writeHead(upstream.status, {
    "Content-Type": upstream.headers.get("content-type") || "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
  });
  if (!upstream.body) return void res.end();
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch { /* client disconnected */ }
  res.end();
}

const server = http.createServer((req, res) => {
  const rawUrl = req.url || "/";
  const url = parseUrl(rawUrl);

  // Unauthenticated liveness probe used by the Worker to detect a started machine.
  if (url.pathname === "/healthz" && req.method === "GET") {
    json(res, 200, { ok: true });
    return;
  }

  if (!requireAuth(req, res)) return;

  // GitHub auth: the Worker pushes the stored PAT here so git + gh are authenticated.
  if (url.pathname === "/github/auth") {
    if (req.method === "GET") {
      const connected = fs.existsSync(path.join(HOME, ".config", "gh", "hosts.yml"));
      return void json(res, 200, { connected });
    }
    if (req.method === "PUT") {
      return void readBody(req).then((body) => {
        if (!body || !body.token) return json(res, 400, { error: "missing_token" });
        try {
          configureGithub(String(body.token), String(body.username || ""));
          json(res, 200, { ok: true });
        } catch (e) {
          json(res, 500, { error: "configure_failed", message: String(e && e.message || e) });
        }
      });
    }
    return void json(res, 405, { error: "method_not_allowed" });
  }

  // System prompt (AGENTS.md): the Worker reads/writes it to support viewing + editing.
  if (url.pathname === "/agents") {
    if (req.method === "GET") {
      let content = "";
      try { content = fs.readFileSync(AGENTS_PATH, "utf8"); } catch { /* not written yet */ }
      return void json(res, 200, { content });
    }
    if (req.method === "PUT") {
      return void readBody(req).then((body) => {
        if (!body || typeof body.content !== "string") return json(res, 400, { error: "missing_content" });
        try {
          fs.mkdirSync(path.dirname(AGENTS_PATH), { recursive: true });
          fs.writeFileSync(AGENTS_PATH, body.content);
          json(res, 200, { ok: true });
        } catch (e) {
          json(res, 500, { error: "write_failed", message: String(e && e.message || e) });
        }
      });
    }
    return void json(res, 405, { error: "method_not_allowed" });
  }

  // Codex egress relay (Agent Architecture v2): the Worker forwards ChatGPT-subscription calls here
  // so they leave from the box's non-Cloudflare IP (chatgpt.com bot-blocks Cloudflare Workers).
  if (url.pathname === "/relay/codex" && req.method === "POST") {
    handleCodexRelay(req, res);
    return;
  }

  // Exec APIs (Agent Architecture v2): start/stream/status/kill commands in the workspace.
  if (url.pathname === "/exec" || url.pathname.startsWith("/exec/")) {
    handleExec(req, res, url);
    return;
  }

  // Filesystem APIs: expose only /home/dev/workspace through relative paths.
  if (url.pathname === "/fs" || url.pathname.startsWith("/fs/")) {
    handleFs(req, res, url);
    return;
  }

  // Preview APIs and /preview/* iframe content. Falls back to static workspace serving.
  if (url.pathname === "/preview" || url.pathname.startsWith("/preview/")) {
    handlePreview(req, res, url, rawUrl);
    return;
  }

  // /opencode/* -> opencode headless server (REST + SSE).
  if (url.pathname === "/opencode" || url.pathname.startsWith("/opencode/")) {
    const path = rawUrl.replace(/^\/opencode/, "") || "/";
    proxyHttp(req, res, {
      upstreamHost: opencodeHost,
      upstreamPort: opencodePort,
      path,
      extraHeaders: { authorization: opencodeAuth },
    });
    return;
  }

  // /terminal/* -> ttyd (raw shell escape hatch). ttyd runs with base path /terminal
  // (-b below) so its asset/ws URLs stay under the prefix; forward the path unchanged.
  if (url.pathname === "/terminal" || url.pathname.startsWith("/terminal/")) {
    proxyHttp(req, res, { upstreamHost: ttydHost, upstreamPort: ttydPort, path: rawUrl });
    return;
  }

  json(res, 404, { error: "not_found" });
});

// WebSocket upgrades: ttyd terminal stream, and any opencode WS (e.g. PTY) endpoints.
server.on("upgrade", (req, socket, head) => {
  if (!authorized(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="opencode-phone"\r\n\r\n');
    socket.destroy();
    return;
  }

  const rawUrl = req.url || "/";
  const url = parseUrl(rawUrl);
  let target;
  if (url.pathname === "/opencode" || url.pathname.startsWith("/opencode/")) {
    target = { host: opencodeHost, port: opencodePort, path: rawUrl.replace(/^\/opencode/, "") || "/", auth: opencodeAuth };
  } else if (url.pathname === "/preview" || url.pathname.startsWith("/preview/")) {
    const route = previewRoute(url.pathname);
    const preview = route ? previews.get(route.id) : null;
    if (route?.publicRoute && preview?.visibility !== "public") {
      socket.destroy();
      return;
    }
    if (!preview?.child || preview.child.exitCode != null || preview.child.signalCode != null) {
      socket.destroy();
      return;
    }
    target = {
      host: previewHost,
      port: preview.port,
      path: stripPreviewPath(rawUrl, preview, route.publicRoute),
      headers: previewForwardHeaders(req, previewBasePath(preview)),
    };
  } else if (url.pathname === "/terminal" || url.pathname.startsWith("/terminal/")) {
    target = { host: ttydHost, port: ttydPort, path: rawUrl };
  } else {
    socket.destroy();
    return;
  }

  const upstream = net.connect(target.port, target.host, () => {
    const overrideHeaders = new Set(Object.keys(target.headers || {}).map((key) => key.toLowerCase()));
    upstream.write(`${req.method} ${target.path} HTTP/${req.httpVersion}\r\n`);
    for (const [key, value] of Object.entries(req.headers)) {
      if (key.toLowerCase() === "host") continue;
      if (overrideHeaders.has(key.toLowerCase())) continue;
      if (Array.isArray(value)) {
        for (const item of value) upstream.write(`${key}: ${item}\r\n`);
      } else if (value !== undefined) {
        upstream.write(`${key}: ${value}\r\n`);
      }
    }
    upstream.write(`host: ${target.host}:${target.port}\r\n`);
    if (target.auth) upstream.write(`authorization: ${target.auth}\r\n`);
    for (const [key, value] of Object.entries(target.headers || {})) upstream.write(`${key}: ${value}\r\n`);
    upstream.write("\r\n");
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });

  upstream.on("error", () => socket.destroy());
});

function startTtyd() {
  const bin = process.env.TTYD_BIN || "/usr/local/bin/ttyd";
  const child = spawn(
    bin,
    ["-i", ttydHost, "-p", String(ttydPort), "-W", "-b", "/terminal", "/home/dev/bin/attach-session"],
    { stdio: "inherit", env: process.env },
  );
  // Don't let a missing/failing ttyd crash the whole control plane (fs/exec/preview); just retry.
  child.on("error", (e) => {
    console.error(`ttyd spawn failed (${bin}): ${e.message}`);
    setTimeout(startTtyd, 5000);
  });
  child.on("exit", () => {
    setTimeout(startTtyd, 2000);
  });
}

loadPreviewState();
startTtyd();

server.listen(port, host, () => {
  console.log(`opencode-phone control server listening on ${host}:${port}`);
  console.log(`  /opencode/* -> ${opencodeHost}:${opencodePort}`);
  console.log(`  /terminal/* -> ${ttydHost}:${ttydPort}`);
});
