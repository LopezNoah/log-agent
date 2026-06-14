# OpenCode Phone Worker

Cloudflare Worker control plane for the Fly machine.

It does four jobs:

1. Protects access with Worker-level Basic Auth.
2. Starts the Fly machine when a session starts.
3. Proxies `/terminal/*` to the Fly app, including WebSocket traffic for `ttyd`.
4. Stores session state in D1 and stops the Fly machine when a session is complete or idle too long.

The dashboard and session pages are the primary UI. You can send commands/prompts from Cloudflare to the Fly machine without opening the raw terminal. The Worker stores user inputs and terminal output snapshots in D1 so sessions can be reviewed later.

The raw terminal remains available at `/terminal/` as an escape hatch.

## Create D1

```bash
cd /Users/noahlopez/Development/Github/opencode-phone/worker
npm install
npx wrangler d1 create opencode_phone
```

Copy the generated `database_id` into `wrangler.toml`, then apply the migration:

```bash
npm run db:migrate
```

## Set Secrets

```bash
npx wrangler secret put CONTROL_PASSWORD
npx wrangler secret put FLY_API_TOKEN
```

Optional, if the Fly app itself also has Basic Auth enabled:

```bash
npx wrangler secret put FLY_UPSTREAM_AUTHORIZATION
```

Use the full header value for `FLY_UPSTREAM_AUTHORIZATION`, for example:

```text
Basic base64(username:password)
```

Optional notification webhook:

```bash
npx wrangler secret put NOTIFY_WEBHOOK_URL
```

The Worker sends JSON like:

```json
{ "text": "OpenCode session ... stopped: complete" }
```

## Deploy

```bash
npm run deploy
```

## Routes

- `GET /` shows a small dashboard.
- `POST /api/sessions` creates a D1 session and starts the Fly machine.
- `GET /api/sessions` lists recent sessions.
- `GET /api/sessions/:id` returns one session.
- `GET /sessions/:id` shows a session page with a message box, D1 log, and live output.
- `GET /api/sessions/:id/messages` returns D1 message/output logs.
- `POST /api/sessions/:id/messages` sends text to the Fly tmux session and logs it in D1.
- `POST /api/sessions/:id/seen` records browser activity.
- `POST /api/sessions/:id/complete` marks a session complete and stops the Fly machine.
- `POST /api/sessions/:id/stop` manually stops the Fly machine.
- `GET /api/sessions/:id/fly` returns the Fly machine status.
- `GET /api/session/output` returns recent terminal output from the Fly `tmux` pane.
- `/terminal/*` proxies to the Fly app.

## Completion Detection

The safest design is for the Fly container to run `ttyd` with a small supervisor around `opencode` or `tmux`.

The supervisor should expose an HTTP status endpoint on the Fly app, for example:

```json
{
  "state": "running",
  "exitCode": null,
  "updatedAt": "2026-06-14T22:00:00.000Z"
}
```

When the CLI exits, it should return:

```json
{
  "state": "complete",
  "exitCode": 0,
  "updatedAt": "2026-06-14T22:15:00.000Z"
}
```

Then set this in `wrangler.toml`:

```toml
AGENT_STATUS_PATH = "/api/session/status"
```

Without `AGENT_STATUS_PATH`, the Worker falls back to `IDLE_STOP_SECONDS`. The default is `3600` seconds.

## Fly Config

The Fly app should not use Fly's HTTP autosuspend when this Worker controls shutdown:

```toml
auto_start_machines = true
auto_stop_machines = false
min_machines_running = 0
```

That lets a task continue after the browser tab closes. The Worker stops the machine later.
