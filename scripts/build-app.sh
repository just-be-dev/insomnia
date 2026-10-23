#!/usr/bin/env bash
# Builds build/Insomnia.app: the Swift menu bar shell plus the compiled Effect daemon.
#
#   ARCH=arm64|x86_64   target architecture (default: this machine's)
#   VERSION=1.2.3       stamped into Info.plist (default: the one checked in)
#   OUT=build/x/Insomnia.app   output path (default: build/Insomnia.app)
set -euo pipefail
cd "$(dirname "$0")/.."

arch="${ARCH:-$(uname -m)}"
case "$arch" in
  arm64) bun_target=bun-darwin-arm64 ;;
  x86_64) bun_target=bun-darwin-x64 ;;
  *) echo "unsupported ARCH: $arch (use arm64 or x86_64)" >&2; exit 1 ;;
esac

app="${OUT:-build/Insomnia.app}"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"

echo "→ compiling daemon for $arch (bun build --compile)"
bun build --compile --minify --target="$bun_target" src/main.ts --outfile "$app/Contents/Resources/insomnia" >/dev/null

echo "→ compiling menu bar shell for $arch (swiftc)"
swiftc -swift-version 5 -O \
  -target "$arch-apple-macos13.0" \
  -framework AppKit -framework ServiceManagement \
  -o "$app/Contents/MacOS/Insomnia" \
  macos/Insomnia/*.swift

cp macos/Insomnia/Info.plist "$app/Contents/Info.plist"
if [[ -n "${VERSION:-}" ]]; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$app/Contents/Info.plist"
fi

echo "→ ad-hoc signing"
codesign --force --sign - "$app/Contents/Resources/insomnia"
codesign --force --sign - "$app"

echo "✓ $app"
