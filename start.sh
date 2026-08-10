#!/usr/bin/env bash
# Uruchomienie wizualizatora myśli.
# Bez ANTHROPIC_API_KEY działa tylko tryb "simulate".
set -e
cd "$(dirname "$0")"

# Tryb offline (bez API): otwórz plik bezpośrednio w przeglądarce.
if [[ "${1:-}" == "offline" ]]; then
  open index.html
  exit 0
fi

# Tryb z backendem (potrzebne node + npm install).
if [[ ! -d node_modules ]]; then
  echo "→ instaluję zależności..."
  npm install --silent
fi

echo "→ startuję serwer na http://localhost:4173"
(sleep 1 && open http://localhost:4173) &
node server.js
