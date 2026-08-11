#!/usr/bin/env bash
# Wgrywa archiwum plakatów pamięci na lucdoro.design/thoughts/.
# Poster save (v2 distributed) tworzy drzewo: posters/<session-id>/{plakat.png,
# plakat.json, index.json, concepts/*.json}.  Ten skrypt przenosi całe drzewo.
# Uruchamiaj z Terminal.app (fail2ban blokuje SSH z Claude Code Bash tool).
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

# Prefer rsync when available — inkrementalnie, tylko zmiany
if command -v rsync >/dev/null 2>&1; then
  echo "→ rsync -a posters/ …"
  rsync -a --info=progress2 -e "ssh" posters/ "${REMOTE_HOST}:${REMOTE_DIR}/"
else
  echo "→ scp -r posters/* …"
  scp -r -q posters/* "${REMOTE_HOST}:${REMOTE_DIR}/"
fi

echo ""
echo "  gotowe · https://lucdoro.design/thoughts/"
echo ""
echo "  sesje online do zdekodowania:"
for d in posters/*/; do
  session=$(basename "$d")
  echo "    · https://lucdoro.design/thoughts/${session}/"
done
