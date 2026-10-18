#!/usr/bin/env bash
# Copies build/Insomnia.app to ~/Applications and links the CLI into ~/.local/bin.
set -euo pipefail
cd "$(dirname "$0")/.."

dest="$HOME/Applications/Insomnia.app"
mkdir -p "$HOME/Applications" "$HOME/.local/bin"

# Quit a running copy first; it restores normal sleep on the way out.
osascript -e 'tell application id "dev.just-be.insomnia" to quit' >/dev/null 2>&1 || true
sleep 1

rm -rf "$dest"
cp -R build/Insomnia.app "$dest"
ln -sf "$dest/Contents/Resources/insomnia" "$HOME/.local/bin/insomnia"

echo "✓ installed $dest"
echo "✓ linked ~/.local/bin/insomnia"
echo "  open it with: open \"$dest\""
