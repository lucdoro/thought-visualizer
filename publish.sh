#!/usr/bin/env bash
# Wgrywa archiwum plakatów pamięci na lucdoro.design/thoughts/.
# Uruchamiaj z Terminal.app (Claude Code Bash tool jest blokowany przez fail2ban).
set -euo pipefail
cd "$(dirname "$0")"

REMOTE_HOST="lucdoro-web"
REMOTE_DIR="/home/p567739/public_html/lucdoro.design/thoughts"

if [[ ! -d posters ]] || [[ -z "$(ls -A posters 2>/dev/null)" ]]; then
  echo "brak plakatów w ./posters — najpierw kliknij 'plakat' w wizualizatorze"
  exit 0
fi

echo "→ mkdir na serwerze: ${REMOTE_HOST}:${REMOTE_DIR}"
ssh "${REMOTE_HOST}" "mkdir -p ${REMOTE_DIR}"

echo "→ scp posters/*.{png,json,html} …"
scp -q posters/*.png "${REMOTE_HOST}:${REMOTE_DIR}/" 2>/dev/null || true
scp -q posters/*.json "${REMOTE_HOST}:${REMOTE_DIR}/" 2>/dev/null || true
scp -q posters/index.html "${REMOTE_HOST}:${REMOTE_DIR}/index.html"

echo ""
echo "  gotowe · https://lucdoro.design/thoughts/"
echo ""
