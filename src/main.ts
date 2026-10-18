import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Command from "effect/cli/Command";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { serveStdio } from "./daemon/daemon.ts";
import { macosLayer } from "./platform/macos/layer.ts";
import { SUDOERS_PATH } from "./platform/macos/privileges.ts";
import { SessionManager } from "./session/application.ts";
import { idle } from "./session/model.ts";
import { BatteryMonitor, PrivilegeInstaller, SleepControl, StateStore } from "./session/service.ts";

const daemon = Command.make("daemon", {}, () =>
  Effect.scoped(serveStdio).pipe(Effect.provide(SessionManager.layer)),
).pipe(
  Command.withDescription(
    "Serve the menu bar app over stdio (JSON lines). Restores sleep when stdin closes.",
  ),
);

const status = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const sleep = yield* SleepControl;
    const battery = yield* (yield* BatteryMonitor).read;
    const state = yield* (yield* StateStore).load;
    const disabled = yield* sleep.isDisabled;
    const privileges = yield* sleep.privileges;
    const session =
      state.session._tag === "Idle"
        ? "idle"
        : state.session.endsAt === null
          ? "active (until stopped)"
          : `active until ${new Date(state.session.endsAt).toLocaleTimeString()}`;
    yield* Console.log(
      [
        `sleep:        ${disabled ? "DISABLED (lid close won't sleep)" : "normal"}`,
        `session:      ${session}`,
        `battery:      ${battery === null ? "n/a" : `${battery.percent}%${battery.onAC ? " (AC)" : ""}`}`,
        `safety stop:  ${state.settings.lowBatteryThreshold === null ? "off" : `${state.settings.lowBatteryThreshold}%`}`,
        `permissions:  ${privileges === "Granted" ? "installed" : `missing (run \`insomnia install\`)`}`,
      ].join("\n"),
    );
  }),
).pipe(Command.withDescription("Show sleep, session, battery, and permission state"));

const install = Command.make("install", {}, () =>
  Effect.gen(function* () {
    yield* (yield* PrivilegeInstaller).install;
    yield* Console.log(`Installed ${SUDOERS_PATH}`);
  }),
).pipe(
  Command.withDescription(
    "Allow passwordless `pmset -a disablesleep 0|1` for this user (asks for an admin password once)",
  ),
);

const uninstall = Command.make("uninstall", {}, () =>
  Effect.gen(function* () {
    yield* (yield* PrivilegeInstaller).uninstall;
    yield* Console.log(`Removed ${SUDOERS_PATH} and restored normal sleep`);
  }),
).pipe(Command.withDescription("Remove the sudoers rule and restore normal sleep"));

const restore = Command.make("restore", {}, () =>
  Effect.gen(function* () {
    yield* (yield* SleepControl).setDisabled(false);
    const store = yield* StateStore;
    const state = yield* store.load;
    yield* store.save({ ...state, session: idle });
    yield* Console.log("Normal sleep restored");
  }),
).pipe(
  Command.withDescription(
    "Emergency off: run `pmset -a disablesleep 0` and clear any saved session",
  ),
);

const insomnia = Command.make("insomnia").pipe(
  Command.withDescription("Keep your Mac awake with the lid closed, safely"),
  Command.withSubcommands([daemon, status, install, uninstall, restore]),
);

const cli = Command.run(insomnia, { version: "0.1.0" });

// Logs go to stderr so stdout stays clean for the daemon protocol.
const LoggerLive = Logger.layer([Logger.withConsoleError(Logger.formatLogFmt)]);

const MainLive = Layer.mergeAll(macosLayer.pipe(Layer.provideMerge(BunServices.layer)), LoggerLive);

cli.pipe(Effect.provide(MainLive), BunRuntime.runMain);
