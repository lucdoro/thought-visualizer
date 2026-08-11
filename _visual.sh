#!/usr/bin/env bash
# _visual — attach current terminal to the thought visualizer.
# Runs the daemon if not up, opens the visualizer in a browser, and posts
# a session_start observation tagged with terminal/cwd context.
set -euo pipefail

SERVER="http://127.0.0.1:4173"
PLIST="$HOME/Library/LaunchAgents/design.lucdoro.thought-visualizer.plist"
INDEX="/Users/lucdoro/thought-visualizer/index.html"

# 1) Daemon check + start
if ! curl -s -o /dev/null --max-time 1 "$SERVER/"; then
  echo "→ daemon offline, starting via launchctl…"
  launchctl load "$PLIST" 2>/dev/null || true
  sleep 1
  if ! curl -s -o /dev/null --max-time 2 "$SERVER/"; then
    echo "  ✗ daemon still not up — check $HOME/thought-visualizer/daemon.err"
    exit 1
  fi
fi

# 2) Tag this attachment
TAG="term-$(basename "$(tty 2>/dev/null || echo unknown)" | tr -d '/')-$$-$(date +%s)"
INVOKER="${1:-manual}"

# 3) Post session_start observation with terminal context
curl -s --max-time 2 -X POST "$SERVER/observe" \
  -H 'Content-Type: application/json' \
  --data "$(cat <<EOF
{"type":"session_start","payload":{
  "session_tag":"$TAG",
  "cwd":"$PWD",
  "terminal":"$(basename "$SHELL") pid=$$",
  "invoker":"$INVOKER",
  "iso":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}}
EOF
)" >/dev/null || true

# 4) Open the browser
if command -v open >/dev/null; then
  open "$INDEX" 2>/dev/null || true
fi

cat <<EOF

  🧠  visual attached
      session tag : $TAG
      cwd         : $PWD
      visualizer  : $SERVER
      file        : file://$INDEX

  Global hooki w ~/.claude/settings.json już strumieniują każdą sesję
  Claude Code do wizualizatora — ta sesja jest po prostu oznaczona
  tag'iem powyżej, żeby wyróżnić.

EOF
