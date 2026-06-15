const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");

const HOME = process.env.HOME || "/home/dev";
const AGENTS_PATH = path.join(HOME, ".config", "opencode", "AGENTS.md");

const host = "0.0.0.0";
const port = Number(process.env.PORT || "8080");

const ttydHost = "127.0.0.1";
const ttydPort = Number(process.env.TTYD_PORT || "7681");

const opencodeHost = "127.0.0.1";
const opencodePort = Number(process.env.OPENCODE_PORT || "4096");
const opencodeUser = process.env.OPENCODE_SERVER_USERNAME || "opencode";

const password = process.env.OPENCODE_SERVER_PASSWORD || "change-me-now";

// opencode serve also enforces Basic auth (it reads OPENCODE_SERVER_PASSWORD). It only
// listens on loopback, so this header is added internally when proxying upstream.
const opencodeAuth =
  "Basic " + Buffer.from(`${opencodeUser}:${password}`).toString("base64");

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
function proxyHttp(req, res, { upstreamHost, upstreamPort, path, extraHeaders = {} }) {
  const headers = { ...req.headers, host: `${upstreamHost}:${upstreamPort}`, ...extraHeaders };
  let responded = false;

  const upstream = http.request(
    { host: upstreamHost, port: upstreamPort, method: req.method, path, headers },
    (upstreamRes) => {
      responded = true;
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
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

const server = http.createServer((req, res) => {
  const rawUrl = req.url || "/";

  // Unauthenticated liveness probe used by the Worker to detect a started machine.
  if (rawUrl === "/healthz" && req.method === "GET") {
    json(res, 200, { ok: true });
    return;
  }

  if (!requireAuth(req, res)) return;

  // GitHub auth: the Worker pushes the stored PAT here so git + gh are authenticated.
  if (rawUrl === "/github/auth") {
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
  if (rawUrl === "/agents") {
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

  // /opencode/* -> opencode headless server (REST + SSE).
  if (rawUrl === "/opencode" || rawUrl.startsWith("/opencode/")) {
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
  if (rawUrl === "/terminal" || rawUrl.startsWith("/terminal/")) {
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
  let target;
  if (rawUrl === "/opencode" || rawUrl.startsWith("/opencode/")) {
    target = { host: opencodeHost, port: opencodePort, path: rawUrl.replace(/^\/opencode/, "") || "/", auth: opencodeAuth };
  } else if (rawUrl === "/terminal" || rawUrl.startsWith("/terminal/")) {
    target = { host: ttydHost, port: ttydPort, path: rawUrl };
  } else {
    socket.destroy();
    return;
  }

  const upstream = net.connect(target.port, target.host, () => {
    upstream.write(`${req.method} ${target.path} HTTP/${req.httpVersion}\r\n`);
    for (const [key, value] of Object.entries(req.headers)) {
      if (key.toLowerCase() === "host") continue;
      if (Array.isArray(value)) {
        for (const item of value) upstream.write(`${key}: ${item}\r\n`);
      } else if (value !== undefined) {
        upstream.write(`${key}: ${value}\r\n`);
      }
    }
    upstream.write(`host: ${target.host}:${target.port}\r\n`);
    if (target.auth) upstream.write(`authorization: ${target.auth}\r\n`);
    upstream.write("\r\n");
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });

  upstream.on("error", () => socket.destroy());
});

function startTtyd() {
  const child = spawn(
    "/usr/local/bin/ttyd",
    ["-i", ttydHost, "-p", String(ttydPort), "-W", "-b", "/terminal", "/home/dev/bin/attach-session"],
    { stdio: "inherit", env: process.env },
  );
  child.on("exit", () => {
    setTimeout(startTtyd, 2000);
  });
}

startTtyd();

server.listen(port, host, () => {
  console.log(`opencode-phone control server listening on ${host}:${port}`);
  console.log(`  /opencode/* -> ${opencodeHost}:${opencodePort}`);
  console.log(`  /terminal/* -> ${ttydHost}:${ttydPort}`);
});
