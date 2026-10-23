#!/usr/bin/env bash
# Builds Insomnia.app for arm64 and x86_64 and zips each into dist/, with SHA256SUMS.
# These are the assets install.sh downloads from a GitHub release.
#
#   VERSION=1.2.3   stamped into Info.plist (default: the one checked in)
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf dist
mkdir -p dist

for arch in arm64 x86_64; do
  app="build/$arch/Insomnia.app"
  ARCH="$arch" OUT="$app" scripts/build-app.sh
  # ditto keeps the code signatures and bundle metadata intact.
  ditto -c -k --keepParent "$app" "dist/Insomnia-$arch.zip"
done

(cd dist && shasum -a 256 Insomnia-*.zip > SHA256SUMS)
echo "✓ dist/"
cat dist/SHA256SUMS
