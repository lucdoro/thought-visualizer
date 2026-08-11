#!/usr/bin/env bash
# install-visual.sh — link _visual and _tvisual into ~/.local/bin so you
# can call either from any terminal (Terminal.app, iTerm, tmux, ...).
set -euo pipefail
cd "$(dirname "$0")"

BIN="$HOME/.local/bin"
mkdir -p "$BIN"

chmod +x "$PWD/_visual.sh"
ln -sf "$PWD/_visual.sh" "$BIN/_visual"
ln -sf "$PWD/_visual.sh" "$BIN/_tvisual"

echo "→ zainstalowane:"
echo "    $BIN/_visual   → $PWD/_visual.sh"
echo "    $BIN/_tvisual  → $PWD/_visual.sh"
echo ""

case ":${PATH:-}:" in
  *":$BIN:"*)
    echo "✓ $BIN jest w PATH — otwórz nowy terminal, wpisz:  _visual"
    ;;
  *)
    echo "⚠ $BIN NIE jest w PATH. Dodaj do ~/.zshrc lub ~/.bashrc:"
    echo ""
    echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
    echo ""
    echo "  potem: source ~/.zshrc  (lub otwórz nowy terminal), i już."
    ;;
esac
