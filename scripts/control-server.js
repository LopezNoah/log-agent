const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");

const host = "0.0.0.0";
const port = Number(process.env.PORT || "8080");
const ttydHost = "127.0.0.1";
const ttydPort = Number(process.env.TTYD_PORT || "7681");
const statusPath = process.env.SESSION_STATUS_PATH || "/home/dev/session/status.json";
const password = process.env.OPENCODE_SERVER_PASSWORD || "change-me-now";

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

function readStatus() {
  try {
    return JSON.parse(fs.readFileSync(statusPath, "utf8"));
  } catch {
    return {
      state: "running",
      exitCode: null,
      message: "status file not initialized",
      updatedAt: new Date().toISOString(),
    };
  }
}

function writeStatus(next) {
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  const current = readStatus();
  const status = { ...current, ...next, updatedAt: new Date().toISOString() };
  fs.writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`);
  return status;
}

function execFilePromise(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function ensureTmuxSession() {
  try {
    await execFilePromise("tmux", ["has-session", "-t", "opencode"], { timeout: 2000 });
  } catch {
    await execFilePromise(
      "tmux",
      ["new-session", "-d", "-s", "opencode", "-c", "/home/dev/workspace", "/home/dev/bin/session-shell"],
      { timeout: 5000 },
    );
  }
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(`${JSON.stringify(body)}\n`);
}

async function capturePane(lines = 120) {
  await ensureTmuxSession();
  return new Promise((resolve) => {
    execFile(
      "tmux",
      ["capture-pane", "-t", "opencode", "-p", "-S", `-${Math.max(1, Math.min(lines, 1000))}`],
      { timeout: 2000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ ok: false, output: "", error: stderr || error.message });
          return;
        }
        resolve({ ok: true, output: stdout, error: null });
      },
    );
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 128 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function parseInput(req, body) {
  const contentType = req.headers["content-type"] || "";
  if (contentType.includes("application/json")) {
    const parsed = JSON.parse(body || "{}");
    return String(parsed.text || parsed.command || "").trimEnd();
  }
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return new URLSearchParams(body).get("text")?.trimEnd() || "";
  }
  return body.trimEnd();
}

async function loadTmuxBuffer(text) {
  await new Promise((resolve, reject) => {
    const child = spawn("tmux", ["load-buffer", "-b", "opencode-input", "-"], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(stderr || `tmux load-buffer exited ${code}`));
    });
    child.stdin.end(text);
  });
}

async function sendInput(text) {
  await ensureTmuxSession();
  await loadTmuxBuffer(text);
  await execFilePromise("tmux", ["paste-buffer", "-b", "opencode-input", "-t", "opencode"], { timeout: 5000 });
  await execFilePromise("tmux", ["send-keys", "-t", "opencode", "Enter"], { timeout: 5000 });
  return writeStatus({ state: "running", exitCode: null, message: "input sent" });
}

function proxy(req, res) {
  let responded = false;
  const upstream = http.request(
    {
      host: ttydHost,
      port: ttydPort,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `${ttydHost}:${ttydPort}` },
    },
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
    json(res, 502, { error: "ttyd_unavailable", message: error.message });
  });

  req.pipe(upstream);
}

function startTtyd() {
  const child = spawn(
    "/usr/local/bin/ttyd",
    ["-i", "127.0.0.1", "-p", String(ttydPort), "-W", "/home/dev/bin/attach-session"],
    { stdio: "inherit", env: process.env },
  );

  child.on("exit", (code, signal) => {
    writeStatus({ state: "failed", exitCode: code, error: `ttyd exited: ${signal || code}` });
    process.exit(code || 1);
  });
}

startTtyd();

const server = http.createServer((req, res) => {
  if (!requireAuth(req, res)) return;

  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname === "/api/session/status" && req.method === "GET") {
    json(res, 200, readStatus());
    return;
  }

  if (url.pathname === "/api/session/output" && req.method === "GET") {
    capturePane(Number(url.searchParams.get("lines") || "120")).then((body) => json(res, 200, body));
    return;
  }

  if (url.pathname === "/api/session/input" && req.method === "POST") {
    readBody(req)
      .then((body) => parseInput(req, body))
      .then(async (text) => {
        if (!text) {
          json(res, 400, { ok: false, error: "missing input text" });
          return;
        }
        const status = await sendInput(text);
        const output = await capturePane(120);
        json(res, 200, { ok: true, status, output });
      })
      .catch((error) => json(res, 500, { ok: false, error: error.message }));
    return;
  }

  if (url.pathname === "/api/session/complete" && req.method === "POST") {
    json(res, 200, writeStatus({ state: "complete", exitCode: 0, message: "marked complete by API" }));
    return;
  }

  if (url.pathname === "/api/session/running" && req.method === "POST") {
    json(res, 200, writeStatus({ state: "running", exitCode: null, message: "marked running by API" }));
    return;
  }

  proxy(req, res);
});

server.on("upgrade", (req, socket, head) => {
  if (!authorized(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="opencode-phone"\r\n\r\n');
    socket.destroy();
    return;
  }

  const upstream = net.connect(ttydPort, ttydHost, () => {
    upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) {
        for (const item of value) upstream.write(`${key}: ${item}\r\n`);
      } else if (value !== undefined) {
        upstream.write(`${key}: ${value}\r\n`);
      }
    }
    upstream.write(`host: ${ttydHost}:${ttydPort}\r\n`);
    upstream.write("\r\n");
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });

  upstream.on("error", () => socket.destroy());
});

server.listen(port, host, () => {
  console.log(`opencode-phone control server listening on ${host}:${port}`);
});
