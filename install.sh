#!/usr/bin/env bash
# Installs Insomnia from the latest GitHub release:
#
#   curl -fsSL https://raw.githubusercontent.com/just-be-dev/insomnia/main/install.sh | bash
#
#   INSOMNIA_VERSION=v0.2.0   install a specific release tag instead of the latest
#   INSOMNIA_NO_OPEN=1        don't launch the app after installing
#
# It copies Insomnia.app to ~/Applications and links the CLI to ~/.local/bin/insomnia.
# It does not touch sudoers: choose "Install Permissions…" in the menu (or run
# `insomnia install`) when you're ready.
set -euo pipefail

repo="just-be-dev/insomnia"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

main() {
  [[ "$(uname -s)" == "Darwin" ]] || die "Insomnia only runs on macOS"

  local major
  major="$(sw_vers -productVersion | cut -d. -f1)"
  ((major >= 13)) || die "Insomnia needs macOS 13 or later (this is $(sw_vers -productVersion))"

  # Prefer the native build even when this shell runs under Rosetta.
  local arch
  if [[ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" == "1" ]]; then
    arch=arm64
  else
    arch="$(uname -m)"
  fi
  case "$arch" in
    arm64 | x86_64) ;;
    *) die "unsupported architecture: $arch" ;;
  esac

  local base
  if [[ -n "${INSOMNIA_VERSION:-}" ]]; then
    base="https://github.com/$repo/releases/download/$INSOMNIA_VERSION"
  else
    base="https://github.com/$repo/releases/latest/download"
  fi

  # Global, so the EXIT trap can still see it after main returns.
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  local zip="Insomnia-$arch.zip"
  say "→ downloading $zip (${INSOMNIA_VERSION:-latest})"
  curl -fsSL --retry 3 -o "$tmp/$zip" "$base/$zip" || die "couldn't download $base/$zip"
  curl -fsSL --retry 3 -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" || die "couldn't download $base/SHA256SUMS"

  say "→ verifying checksum"
  (cd "$tmp" && grep " $zip\$" SHA256SUMS | shasum -a 256 -c - >/dev/null) || die "checksum mismatch for $zip"

  ditto -x -k "$tmp/$zip" "$tmp/unpacked"
  [[ -d "$tmp/unpacked/Insomnia.app" ]] || die "release archive doesn't contain Insomnia.app"

  local apps="$HOME/Applications"
  local bin="$HOME/.local/bin"
  local dest="$apps/Insomnia.app"
  mkdir -p "$apps" "$bin"

  # Quit a running copy first; it restores normal sleep on the way out.
  if pgrep -xq Insomnia; then
    say "→ quitting the running Insomnia"
    osascript -e 'tell application id "dev.just-be.insomnia" to quit' >/dev/null 2>&1 || true
    sleep 1
  fi

  rm -rf "$dest"
  mv "$tmp/unpacked/Insomnia.app" "$dest"
  xattr -dr com.apple.quarantine "$dest" 2>/dev/null || true
  ln -sf "$dest/Contents/Resources/insomnia" "$bin/insomnia"

  say "✓ installed $dest"
  say "✓ linked $bin/insomnia"

  case ":$PATH:" in
    *":$bin:"*) ;;
    *) say "  note: $bin isn't on your PATH; add it to use the insomnia CLI" ;;
  esac

  if [[ -z "${INSOMNIA_NO_OPEN:-}" ]]; then
    open "$dest"
    say "  Insomnia is in your menu bar. Choose \"Install Permissions…\" there the first time."
  else
    say "  open it with: open \"$dest\""
  fi
}

# Everything runs from main, so a partially downloaded script does nothing.
main "$@"
