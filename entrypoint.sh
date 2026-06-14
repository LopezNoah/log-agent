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
export SESSION_STATUS_PATH="${SESSION_STATUS_PATH:-/home/dev/session/status.json}"

cd /home/dev/workspace
mark-session-status running null "server starting"

exec node /usr/local/share/opencode-phone/control-server.js
