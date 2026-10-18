import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import {
  type Battery,
  type PersistedState,
  PowerCommandFailed,
  type Privileges,
  PrivilegesMissing,
  StateStoreError,
  initialPersistedState,
} from "./model.ts";
import { BatteryMonitor, PrivilegeInstaller, SleepControl, StateStore } from "./service.ts";

/** Scriptable stand-in for pmset, the battery, and the state file. */
export interface MemoryMac {
  readonly sleepDisabled: Ref.Ref<boolean>;
  readonly privileges: Ref.Ref<Privileges>;
  /** When true, reading or writing pmset fails like a broken command. */
  readonly pmsetBroken: Ref.Ref<boolean>;
  readonly battery: Ref.Ref<Battery | null>;
  readonly persisted: Ref.Ref<PersistedState>;
  readonly saveFails: Ref.Ref<boolean>;
  /** Every `setDisabled` call, in order. */
  readonly writes: Ref.Ref<ReadonlyArray<boolean>>;
  readonly installs: Ref.Ref<number>;
}

export const makeMemoryMac = (
  initial: {
    readonly sleepDisabled?: boolean;
    readonly privileges?: Privileges;
    readonly battery?: Battery | null;
    readonly persisted?: PersistedState;
  } = {},
) =>
  Effect.gen(function* () {
    const mac: MemoryMac = {
      sleepDisabled: yield* Ref.make(initial.sleepDisabled ?? false),
      privileges: yield* Ref.make<Privileges>(initial.privileges ?? "Granted"),
      pmsetBroken: yield* Ref.make(false),
      battery: yield* Ref.make<Battery | null>(
        initial.battery === undefined ? { percent: 80, onAC: false } : initial.battery,
      ),
      persisted: yield* Ref.make(initial.persisted ?? initialPersistedState),
      saveFails: yield* Ref.make(false),
      writes: yield* Ref.make<ReadonlyArray<boolean>>([]),
      installs: yield* Ref.make(0),
    };
    return mac;
  });

export const memoryMacLayer = (mac: MemoryMac) =>
  Layer.mergeAll(
    Layer.succeed(SleepControl, {
      isDisabled: Effect.gen(function* () {
        if (yield* Ref.get(mac.pmsetBroken)) {
          return yield* new PowerCommandFailed({ command: "pmset -g", detail: "broken" });
        }
        return yield* Ref.get(mac.sleepDisabled);
      }),
      setDisabled: (disabled) =>
        Effect.gen(function* () {
          if ((yield* Ref.get(mac.privileges)) === "Missing") return yield* new PrivilegesMissing();
          if (yield* Ref.get(mac.pmsetBroken)) {
            return yield* new PowerCommandFailed({ command: "pmset", detail: "broken" });
          }
          yield* Ref.update(mac.writes, (writes) => [...writes, disabled]);
          yield* Ref.set(mac.sleepDisabled, disabled);
        }),
      privileges: Ref.get(mac.privileges),
    }),
    Layer.succeed(BatteryMonitor, { read: Ref.get(mac.battery) }),
    Layer.succeed(StateStore, {
      load: Ref.get(mac.persisted),
      save: (state) =>
        Effect.gen(function* () {
          if (yield* Ref.get(mac.saveFails)) {
            return yield* new StateStoreError({ detail: "disk full" });
          }
          yield* Ref.set(mac.persisted, state);
        }),
    }),
    Layer.succeed(PrivilegeInstaller, {
      install: Effect.gen(function* () {
        yield* Ref.update(mac.installs, (n) => n + 1);
        yield* Ref.set(mac.privileges, "Granted");
      }),
      uninstall: Ref.set(mac.privileges, "Missing"),
    }),
  );
