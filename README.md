# Insomnia

A menu bar app that keeps your Mac awake, with the lid closed too, so Wi‑Fi and long jobs keep running. It is a small replacement for Amphetamine's closed‑display mode, built on `pmset -a disablesleep`.

- **Keep Awake**: until stopped, or for 15 minutes to 8 hours. Sleep comes back when the time runs out.
- **Low Battery Stop**: on battery, ends the session at or below a threshold (default 20%) and refuses to start below it. Doesn't apply on AC power.
- **Fails safe**: quitting or crashing the app restores normal sleep (see [Safety](#safety)).

## Install

```sh
mise trust && mise install      # Bun, Node, dependencies
mise run app:install            # builds and copies Insomnia.app to ~/Applications, links ~/.local/bin/insomnia
open ~/Applications/Insomnia.app
```

The first time, choose **Install Permissions…** in the menu (or run `insomnia install`). It asks for an admin password once and installs `/etc/sudoers.d/insomnia`:

```
<you> ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1
```

That rule covers those two exact commands and nothing else. The file is checked with `visudo -c` before it's installed. `insomnia uninstall` removes it.

Turn on **Launch at Login** from the menu if you want it.

## CLI

```sh
insomnia status      # sleep state, session, battery, safety stop, permissions
insomnia restore     # emergency off: pmset -a disablesleep 0 and clear any saved session
insomnia install     # install the sudoers rule
insomnia uninstall   # remove it and restore sleep
insomnia daemon      # what the menu bar app runs (JSON lines on stdio)
```

From source: `mise run cli -- status`.

## How it works

```text
Insomnia.app (Swift, ~550 lines)            insomnia daemon (Bun + Effect)
  NSStatusItem menu  ── JSON lines stdin ──▶  SessionManager ──▶ sudo -n pmset -a disablesleep 0|1
  renders Status     ◀─ JSON lines stdout ──  polls pmset -g / pmset -g batt every 30s
                                              state.json in ~/Library/Application Support/insomnia
```

The Swift shell has no logic of its own. It launches the compiled daemon from `Contents/Resources/insomnia`, sends requests (`Start`, `Stop`, `SetLowBatteryThreshold`, `InstallPrivileges`, `Refresh`), and renders the `Status` events it gets back. Daemon logs go to `~/Library/Logs/insomnia.log`.

## Safety

- **App quits or crashes**: the daemon's stdin closes, its scope closes, and the session finalizer runs `disablesleep 0`.
- **Daemon crashes**: the app restarts it. On startup the daemon reads the saved session: a session that has expired or is below the battery threshold gets sleep restored, and an unexpired one resumes with its original deadline.
- **Daemon killed with `kill -9` while the app is gone too**: sleep stays disabled until Insomnia runs again or you run `insomnia restore`. The session is saved before `pmset` is changed, so the next start always finds it.
- **Something else changes `disablesleep`**: if it's turned off during a session, the session ends as "ended by another app". If it's turned on while Insomnia is idle, the menu shows a warning with **Restore Normal Sleep**, and Insomnia doesn't touch it otherwise.

## Development

```sh
mise run check        # tsc, oxlint, vitest, oxfmt --check, swiftc -typecheck
mise run test:watch
mise run app:build    # build/Insomnia.app
INSOMNIA_DEV_ROOT=$PWD build/Insomnia.app/Contents/MacOS/Insomnia   # shell + daemon from source
INSOMNIA_STATE_DIR=/tmp/insomnia mise run daemon                    # throwaway state
```

See [AGENTS.md](AGENTS.md) for the layout and conventions.
