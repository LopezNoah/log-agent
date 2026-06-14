# opencode phone — Worker

Cloudflare Worker control plane + UI for a single Fly machine that runs the **opencode
headless server** (`opencode serve`). The Worker does three things:

1. **Auth** — gates everything with Basic auth (`CONTROL_PASSWORD`).
2. **UI** — serves a single-page chat app (`public/`) via Cloudflare Static Assets.
3. **Proxy + lifecycle** — transparently proxies `/opencode/*` (REST + SSE streaming) and
   `/terminal/*` (raw ttyd shell) to the Fly box, auto-starts the box on demand, and stops
   it after idle via a cron.

The chat UI talks to opencode's native API, so replies **stream token-by-token** and session
history lives in opencode — the Worker no longer screen-scrapes a terminal or mirrors chat
into D1.

## Architecture

```
Browser ─▶ Worker (auth · SPA · proxy · machine start/stop)
             ├─▶ /opencode/*  →  Fly :8080 → opencode serve :4096   (REST + SSE /event)
             └─▶ /terminal/*  →  Fly :8080 → ttyd :7681             (escape hatch)
Cron */5 ─▶ stop machine when idle past IDLE_STOP_SECONDS
```

`api.machines.dev` is touched **only** on explicit start/stop, the cron, and when a proxied
request finds the box down (auto-start) — never on the per-message path.

## Routes

- `GET /`, `/app.js`, `/styles.css` — the SPA (Static Assets).
- `/opencode/*` — proxied to opencode's server API (sessions, messages, `/event` SSE, WS).
- `/terminal/*` — proxied to ttyd (HTTP + WebSocket).
- `GET /api/machine` — Fly machine status.
- `POST /api/machine/start` · `POST /api/machine/stop` — explicit lifecycle.

## Setup

```bash
cd worker
npm install
npx wrangler d1 migrations apply opencode_phone --remote   # creates activity + settings tables
```

Secrets:

```bash
npx wrangler secret put CONTROL_PASSWORD              # Basic-auth password for the whole app
npx wrangler secret put FLY_API_TOKEN                 # to start/stop the machine
npx wrangler secret put FLY_UPSTREAM_AUTHORIZATION    # "Basic base64(opencode:<OPENCODE_SERVER_PASSWORD>)"
npx wrangler secret put NOTIFY_WEBHOOK_URL            # optional
```

`FLY_UPSTREAM_AUTHORIZATION` is the credential the Worker presents to the Fly control server
(and, in turn, opencode). Use `opencode` as the username and the Fly machine's
`OPENCODE_SERVER_PASSWORD` as the password.

Deploy:

```bash
npm run deploy
```

## Model provider (Fly box)

opencode needs a model. Default is **Ollama**, configured from `OLLAMA_HOST` (and optional
`OPENCODE_MODEL`) in `entrypoint.sh`. **Phase 2** adds a bring-your-own key: a key saved in the
UI is encrypted (AES-GCM) in D1's `settings` table and pushed to opencode at runtime via
`PUT /opencode/auth/:provider` — it is never written to the Fly disk.
