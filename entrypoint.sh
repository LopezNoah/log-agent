#!/usr/bin/env bash
set -euo pipefail

mkdir -p /home/dev/workspace /home/dev/bin
cp /usr/local/share/opencode-phone/attach-session /home/dev/bin/attach-session
cp /usr/local/share/opencode-phone/agent-done /home/dev/bin/agent-done
cp /usr/local/share/opencode-phone/agent-failed /home/dev/bin/agent-failed
cp /usr/local/share/opencode-phone/agent-run /home/dev/bin/agent-run
cp /usr/local/share/opencode-phone/mark-session-status /home/dev/bin/mark-session-status
cp /usr/local/share/opencode-phone/session-shell /home/dev/bin/session-shell
chmod +x /home/dev/bin/attach-session /home/dev/bin/agent-done /home/dev/bin/agent-failed /home/dev/bin/agent-run /home/dev/bin/mark-session-status /home/dev/bin/session-shell

if [[ "$(id -u)" = "0" ]]; then
  chown -R dev:dev /home/dev
  exec sudo -E -u dev env HOME=/home/dev /entrypoint.sh "$@"
fi

git config --global user.name "${GIT_USER_NAME:-Your Name}"
git config --global user.email "${GIT_USER_EMAIL:-you@example.com}"
git config --global init.defaultBranch main
git config --global credential.helper ""

cat > /home/dev/bin/git-askpass <<'EOF'
#!/usr/bin/env bash
case "$1" in
  *Username*) echo "${GITHUB_USERNAME:-x-access-token}" ;;
  *Password*) echo "${GITHUB_TOKEN}" ;;
  *) echo "" ;;
esac
EOF
chmod +x /home/dev/bin/git-askpass

export GIT_ASKPASS=/home/dev/bin/git-askpass
export PATH="/home/dev/bin:$PATH"
export GITHUB_TOKEN="${GITHUB_TOKEN:-}"
export OLLAMA_HOST="${OLLAMA_HOST:-}"
export OLLAMA_API_KEY="${OLLAMA_API_KEY:-}"
export OPENCODE_SERVER_PASSWORD="${OPENCODE_SERVER_PASSWORD:-change-me-now}"
export OPENCODE_PORT="${OPENCODE_PORT:-4096}"

# opencode config + house rules.
mkdir -p /home/dev/.config/opencode

# Always-on agent instructions: the ephemeral UI artifact protocol the opencode-phone web UI
# renders. Written as a global AGENTS.md and also referenced from opencode.json "instructions"
# so it loads regardless of the workspace repo's own rules.
cat > /home/dev/.config/opencode/AGENTS.md <<'AGENTSEOF'
# opencode phone — UI artifacts

Your replies are shown in the opencode-phone web UI, which renders interactive widgets from JSON
you emit. Use a widget when a structured UI is clearly more useful than prose (multi-step plans,
file/data lists, diffs, status summaries, simple forms). Otherwise reply in normal markdown —
most messages should NOT contain widgets.

## How to emit
Include a fenced code block tagged `ui` containing one JSON object `{ "type", "props" }`. You may
place it inline among normal markdown, and may emit several blocks. Emit strict JSON only — no
comments, no trailing commas. Invalid JSON or unknown types render as a plain code block, so only
use the types below.

## Supported types
- `checklist` — props `{ title, items: [{ id, text, done? }] }`. Track a plan.
- `table` — props `{ title?, columns: [..], rows: [[..], ..] }`.
- `status` — props `{ title?, <label>: <state>, ... }`. States like "running", "ok", "error".
- `diff` — props `{ filename, before, after }`. Show file changes.
- `preview` — props `{ status, url, framework? }`. A running app/preview.
- `command` — props `{ command, status, stdout?, stderr? }`. A command and its output.
- `form` — props `{ title, submitLabel?, fields: [{ name, label, type, options?, placeholder?, required? }] }`.
  Submitted values are sent back to you as a normal message.

## Example
```ui
{ "type": "checklist", "props": { "title": "Build plan", "items": [
  { "id": "1", "text": "Scaffold API" },
  { "id": "2", "text": "Write tests" }
] } }
```
AGENTSEOF

# Leading fragment for opencode.json (trailing comma; the no-extra-fields case strips it).
instructions='"instructions": ["/home/dev/.config/opencode/AGENTS.md"],'

# Default to the Ollama endpoint already wired via OLLAMA_HOST.
# A bring-your-own key (pushed by the Worker via PUT /auth/:id at runtime) overrides this.
if [[ -n "${OLLAMA_HOST}" ]]; then
  ollama_base="${OLLAMA_HOST%/}"
  case "${ollama_base}" in
    http://*|https://*) : ;;
    *) ollama_base="http://${ollama_base}" ;;
  esac
  model="${OPENCODE_MODEL:-ollama/qwen2.5-coder:7b}"
  cat > /home/dev/.config/opencode/opencode.json <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  ${instructions}
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama",
      "options": { "baseURL": "${ollama_base}/v1" },
      "models": { "${model#ollama/}": {} }
    }
  },
  "model": "${model}"
}
EOF
elif [[ -n "${OPENCODE_MODEL:-}" ]]; then
  cat > /home/dev/.config/opencode/opencode.json <<EOF
{ "\$schema": "https://opencode.ai/config.json", ${instructions} "model": "${OPENCODE_MODEL}" }
EOF
else
  cat > /home/dev/.config/opencode/opencode.json <<EOF
{ "\$schema": "https://opencode.ai/config.json", ${instructions%,} }
EOF
fi

cd /home/dev/workspace

# Launch the opencode headless server on loopback; the control server is the only
# externally reachable port (8080) and gates everything with Basic auth.
(
  while true; do
    opencode serve --hostname 127.0.0.1 --port "${OPENCODE_PORT}" \
      >> /home/dev/opencode-serve.log 2>&1 || true
    echo "opencode serve exited, restarting in 2s" >> /home/dev/opencode-serve.log
    sleep 2
  done
) &

exec node /usr/local/share/opencode-phone/control-server.js
