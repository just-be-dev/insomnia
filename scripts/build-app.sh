#!/usr/bin/env bash
# Builds build/Insomnia.app: the Swift menu bar shell plus the compiled Effect daemon.
set -euo pipefail
cd "$(dirname "$0")/.."

app=build/Insomnia.app
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"

echo "→ compiling daemon (bun build --compile)"
bun build --compile --minify src/main.ts --outfile "$app/Contents/Resources/insomnia" >/dev/null

echo "→ compiling menu bar shell (swiftc)"
swiftc -swift-version 5 -O \
  -target "$(uname -m)-apple-macos13.0" \
  -framework AppKit -framework ServiceManagement \
  -o "$app/Contents/MacOS/Insomnia" \
  macos/Insomnia/*.swift

cp macos/Insomnia/Info.plist "$app/Contents/Info.plist"

echo "→ ad-hoc signing"
codesign --force --sign - "$app/Contents/Resources/insomnia"
codesign --force --sign - "$app"

echo "✓ $app"
