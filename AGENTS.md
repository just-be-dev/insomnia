# Insomnia

A macOS menu bar app that keeps the Mac awake with the lid closed. All logic is Effect 4 on Bun. The Swift menu bar shell only renders. Read `README.md` first.

## Layout

```text
src/
  main.ts                    CLI entry (effect/cli): daemon, status, install, uninstall, restore
  session/
    model.ts                 Schema models, invariants (isBatteryTooLow, isExpired), tagged errors
    service.ts               capability contracts: SleepControl, BatteryMonitor, StateStore, PrivilegeInstaller
    application.ts           SessionManager: start/stop, expiry, safety stop, recovery, shutdown restore
    testing.ts               scriptable memory adapters (MemoryMac) for tests
  daemon/
    protocol.ts              JSON-lines Request/Event schemas (mirrored in macos/Insomnia/Protocol.swift)
    daemon.ts                stdio server; stdin EOF ends the scope, which restores sleep
  platform/macos/
    exec.ts                  ChildProcess helper (no shell)
    pmset.ts                 pmset/sudo adapters plus pure parsers
    privileges.ts            sudoers rule plus osascript admin install
    store.ts                 state.json store (Schema-decoded, atomic writes)
    layer.ts                 all macOS adapters
macos/Insomnia/              Swift shell: main.swift, StatusMenu.swift, DaemonClient.swift, Protocol.swift, Info.plist
scripts/                     build-app.sh (ARCH, VERSION, OUT), install-app.sh, package-release.sh
install.sh                   curl | bash installer: downloads the latest GitHub release zip
.github/workflows/release.yml  tag v* → check, package both arches, publish release
```

## Rules

- `session/` must not import `platform/`, Bun, or `node:*`. Platform code imports the domain, never the reverse.
- `SessionManager` is the only thing that starts or ends sessions. The CLI's `status` and `restore` use the adapters directly, so they never start a second manager next to a running daemon.
- Only the daemon writes `disablesleep`, and only through `sudo -n /usr/bin/pmset -a disablesleep 0|1`. Those exact argument lists are what the sudoers rule allows, so keep `disableSleepArgs` and `sudoersRule` in sync.
- Order of writes: save the session before turning sleep off, and turn sleep back on before saving the end. A crash between the two steps then always leaves something the next start can recover.
- The shutdown finalizer restores sleep only for an Active session, so it never undoes a `disablesleep` that something else set.
- A pmset read failure is never treated as an outside change (`readSleepDisabled` returns `null`).
- When you change `protocol.ts` or `Status`, update `Protocol.swift` in the same change and keep keys and nulls explicit.
- Stdout belongs to the protocol. Logs go to stderr (`Logger.withConsoleError`).

## Effect

- Before writing Effect code, run `mise run effect-solutions list`, then `mise run effect-solutions show <topic>`. The guides predate Effect 4.0.4 in places, so check against `node_modules/effect`: services are `Context.Service`, errors are `Schema.TaggedError`, the CLI is `effect/cli`, and processes are `effect/process`.
- Import modules directly (`import * as Effect from "effect/Effect"`). Name operations with `Effect.fn("Module.op")`.
- Unstable APIs (`effect/process`, `effect/Stdio`, `effect/cli`, `effect/FileSystem`, `effect/Path`, `@effect/platform-bun`) are allowed only in `src/platform/**`, `src/daemon/**`, `src/main.ts`, and tests. See the tsconfig overrides.

## Verify

```sh
mise run check       # typecheck, lint, test, format:check, swift typecheck
mise run app:build   # when touching Swift, scripts, or the daemon binary
```

- Tests use `@effect/vitest` with `it.effect` and `TestClock`, and memory adapters from `session/testing.ts`. Cover both sides of limits (threshold equality, deadline ±1s) and the failure paths: pmset broken, permissions missing, save failure.
- Parsers are tested against real `pmset`/`sudo -l` output. When macOS changes a format, add the new sample as a test.
- A live check really changes the machine's power settings. Use `INSOMNIA_STATE_DIR=$(mktemp -d)`, a short duration, and check `pmset -g | grep SleepDisabled` before and after.
- Don't install or remove the sudoers rule, push, or publish without the user's approval.
