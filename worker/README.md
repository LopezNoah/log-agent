# opencode phone — Worker

Cloudflare Worker control plane + UI for a single Fly machine that runs the **opencode
headless server** (`opencode serve`). The Worker does three things:

1. **Auth** — a styled login page (`GET /login`) checks `CONTROL_PASSWORD` and issues a signed,
   HttpOnly session cookie (HMAC, 30-day). Every other route is gated by that cookie.
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

- `GET /`, `/assets/app.js`, `/styles.css` — the SPA (Static Assets).
- `GET /login` · `POST /login` · `GET|POST /logout` — session login page + cookie lifecycle.
- `/opencode/*` — proxied to opencode's server API (sessions, messages, `/event` SSE, WS).
- `/fs/tree`, `/fs/file`, `/fs/mkdir`, `/fs/path`, `/fs/rename` — proxied filesystem API
  rooted at `/home/dev/workspace` on the Fly box.
- `/preview/`, `/preview/:id/` — private same-origin app previews. Serve the configured preview
  workspace statically by default, or proxy a running preview process.
- `/preview/public/:id/` — public preview content, only when that preview is marked public.
- `/preview/start`, `/preview/list`, `/preview/restart`, `/preview/stop`,
  `POST /preview/:id/visibility`, `DELETE /preview/:id`, `DELETE /preview/all` — basic preview
  process lifecycle and metadata. Preview metadata persists on the box by ID; visibility is private
  unless explicitly set to `public`.
- `/terminal/*` — proxied to ttyd (HTTP + WebSocket).
- `GET /api/machine` — Fly machine status.
- `POST /api/machine/start` · `POST /api/machine/stop` — explicit lifecycle.
- `GET|POST /api/connectors`, `PATCH|DELETE /api/connectors/:id`,
  `POST /api/connectors/:id/default`, `POST /api/connectors/:id/test` — BYOK connectors (below).

## Setup

```bash
cd worker
npm install
npx wrangler d1 migrations apply opencode_phone --remote   # activity + connectors tables
```

Secrets:

```bash
npx wrangler secret put CONTROL_PASSWORD              # login password for the whole app
npx wrangler secret put SETTINGS_ENC_KEY              # base64 32-byte AES-GCM key for connector secrets
npx wrangler secret put SESSION_SECRET               # optional; HMAC key for cookies (defaults to CONTROL_PASSWORD)
npx wrangler secret put FLY_API_TOKEN                 # to start/stop the machine
npx wrangler secret put FLY_UPSTREAM_AUTHORIZATION    # "Basic base64(opencode:<OPENCODE_SERVER_PASSWORD>)"
npx wrangler secret put NOTIFY_WEBHOOK_URL            # optional, legacy single webhook
```

Generate `SETTINGS_ENC_KEY` with `head -c 32 /dev/urandom | base64`. Rotating `SESSION_SECRET`
(or `CONTROL_PASSWORD`, when no `SESSION_SECRET` is set) invalidates every outstanding session.

`FLY_UPSTREAM_AUTHORIZATION` is the credential the Worker presents to the Fly control server
(and, in turn, opencode). Use `opencode` as the username and the Fly machine's
`OPENCODE_SERVER_PASSWORD` as the password.

Deploy:

```bash
npm run deploy
```

## Connectors (BYOK)

Settings → **Connectors** stores bring-your-own credentials in D1's `connectors` table. Each
secret (API key / token / webhook URL) is AES-GCM encrypted with `SETTINGS_ENC_KEY`; the API
only ever returns the last 4 chars. Types:

- **LLM providers** (Anthropic, OpenAI, OpenRouter, Google, Groq) — multiple keys; one is the
  *default*. The default key + model is pushed to opencode at runtime via
  `PUT /opencode/auth/:provider` (never written to the Fly disk), and its model is attached to
  each outgoing message.
- **GitHub** — personal access token + recorded repo permissions (OAuth is stubbed).
- **Fly.io** — BYO token, org slug, max VM size, max idle minutes (stored; not yet wired to
  machine provisioning).
- **Notifications** — Slack / Discord / generic webhook sinks; machine + run alerts fan out to
  all of them (plus the legacy `NOTIFY_WEBHOOK_URL`).

Account / Organizations / Projects / Billing are scaffolded placeholders in the Settings UI.

## UI artifacts (ephemeral widgets)

The assistant can render interactive widgets inline by emitting a fenced **`ui`** block of JSON —
a UI *description*, never HTML. The frontend (`public/artifacts.js`) parses it and renders with a
trusted, hand-built component; no model output is ever executed. Unknown types / invalid JSON fall
back to a code block, so normal replies are unaffected ("not every chat is like this").

````
```ui
{ "type": "checklist", "props": { "title": "Build plan",
  "items": [ { "id": "1", "text": "Create API" }, { "id": "2", "text": "Build UI" } ] } }
```
````

Phase 1 widget types: `checklist`, `table`, `status`, `diff` (inline/split), `file-explorer`,
`preview`, `sandbox`, `command`, `form` (submit posts a message back to the agent). Any widget can be
**pinned** (📌) to keep it at the top of the thread; pins persist per-session in `localStorage`.
`preview` renders a basic v0-style iframe shell for `/preview/*` URLs and can start the basic preview
server. `sandbox` embeds only approved preview URLs in an iframe without same-origin privileges; it
does not execute model HTML. Static preview HTML is rewritten so root-relative assets stay under the
preview base path instead of escaping to the parent app.
Coming later: Monaco `editor` and a live preview-control system.

To make an agent actually emit these, add the protocol to its instructions (e.g. opencode
`AGENTS.md` on the box): *"When a structured UI helps, emit a fenced `ui` block with
`{ type, props }` using one of the supported types; otherwise reply normally."*
