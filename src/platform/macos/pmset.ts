import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import {
  type Battery,
  PowerCommandFailed,
  type Privileges,
  PrivilegesMissing,
} from "../../session/model.ts";
import { BatteryMonitor, SleepControl } from "../../session/service.ts";
import { describe, exec } from "./exec.ts";

export const PMSET = "/usr/bin/pmset";
export const SUDO = "/usr/bin/sudo";

/** The exact argument lists the sudoers rule allows. Keep in sync with `sudoersRule`. */
export const disableSleepArgs = (disabled: boolean) =>
  ["-a", "disablesleep", disabled ? "1" : "0"] as const;

// Parsers (pure, tested against real pmset output)

/** Reads `SleepDisabled` from `pmset -g`. A missing line means sleep is enabled. */
export const parseSleepDisabled = (pmsetG: string): boolean => {
  const match = /^\s*SleepDisabled\s+(\d+)\s*$/m.exec(pmsetG);
  return match !== null && match[1] !== "0";
};

/** Reads the internal battery from `pmset -g batt`. `null` when the Mac has none. */
export const parseBattery = (pmsetBatt: string): Battery | null => {
  const percent = /InternalBattery-\d+.*?\t(\d{1,3})%/.exec(pmsetBatt);
  if (percent?.[1] === undefined) return null;
  const value = Number(percent[1]);
  if (!Number.isInteger(value) || value < 0 || value > 100) return null;
  return { percent: value, onAC: /drawing from 'AC Power'/.test(pmsetBatt) };
};

/**
 * True when `sudo -n -l` lists a NOPASSWD rule covering both exact disablesleep commands.
 * `sudo -l <cmd>` alone isn't enough: it succeeds for `(ALL) ALL`, which still asks for a password.
 */
export const parseSudoList = (sudoList: string): boolean => {
  const passwordless = sudoList
    .split("\n")
    .flatMap((line) => {
      const index = line.indexOf("NOPASSWD:");
      return index === -1 ? [] : line.slice(index + "NOPASSWD:".length).split(",");
    })
    .map((command) => command.trim().replace(/\s+/g, " "));
  const covered = (command: string) =>
    passwordless.includes(command) || passwordless.includes("ALL");
  return [true, false].every((disabled) =>
    covered([PMSET, ...disableSleepArgs(disabled)].join(" ")),
  );
};

const isPasswordRequired = (stderr: string) =>
  /password is required|a terminal is required|not allowed to execute|may not run sudo/i.test(
    stderr,
  );

// Adapters

export const sleepControlLayer = Layer.effect(
  SleepControl,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner;
    const run = (command: string, args: ReadonlyArray<string>) =>
      exec(command, args).pipe(
        Effect.provideService(ChildProcessSpawner, spawner),
        Effect.mapError(
          (error) =>
            new PowerCommandFailed({ command: describe(command, args), detail: error.message }),
        ),
      );

    const isDisabled = Effect.gen(function* () {
      const result = yield* run(PMSET, ["-g"]);
      if (result.exitCode !== 0) {
        return yield* new PowerCommandFailed({
          command: "pmset -g",
          detail: result.stderr.trim() || `exit ${result.exitCode}`,
        });
      }
      return parseSleepDisabled(result.stdout);
    });

    const setDisabled = Effect.fn("SleepControl.setDisabled")(function* (disabled: boolean) {
      const args = ["-n", PMSET, ...disableSleepArgs(disabled)];
      const result = yield* run(SUDO, args);
      if (result.exitCode === 0) return;
      if (isPasswordRequired(result.stderr)) return yield* new PrivilegesMissing();
      return yield* new PowerCommandFailed({
        command: describe("sudo", args),
        detail: result.stderr.trim() || `exit ${result.exitCode}`,
      });
    });

    const privileges: Effect.Effect<Privileges> = run(SUDO, ["-n", "-l"]).pipe(
      Effect.map((result): Privileges =>
        result.exitCode === 0 && parseSudoList(result.stdout) ? "Granted" : "Missing",
      ),
      Effect.orElseSucceed((): Privileges => "Missing"),
    );

    return { isDisabled, setDisabled, privileges };
  }),
);

export const batteryMonitorLayer = Layer.effect(
  BatteryMonitor,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner;
    const read = exec(PMSET, ["-g", "batt"]).pipe(
      Effect.provideService(ChildProcessSpawner, spawner),
      Effect.map((result) => (result.exitCode === 0 ? parseBattery(result.stdout) : null)),
      Effect.tapError((error) => Effect.logWarning("Couldn't read battery", error)),
      Effect.orElseSucceed((): Battery | null => null),
    );
    return { read };
  }),
);
