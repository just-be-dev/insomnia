import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type {
  Battery,
  PersistedState,
  PowerCommandFailed,
  PrivilegeInstallFailed,
  Privileges,
  PrivilegesMissing,
  StateStoreError,
} from "./model.ts";

/** Controls the system-wide "never sleep, even with the lid closed" switch. */
export class SleepControl extends Context.Service<
  SleepControl,
  {
    readonly isDisabled: Effect.Effect<boolean, PowerCommandFailed>;
    readonly setDisabled: (
      disabled: boolean,
    ) => Effect.Effect<void, PrivilegesMissing | PowerCommandFailed>;
    readonly privileges: Effect.Effect<Privileges>;
  }
>()("insomnia/SleepControl") {}

/** Reads the internal battery. `null` when there is none or it can't be read. */
export class BatteryMonitor extends Context.Service<
  BatteryMonitor,
  { readonly read: Effect.Effect<Battery | null> }
>()("insomnia/BatteryMonitor") {}

/** Persists settings and the running session across daemon restarts. */
export class StateStore extends Context.Service<
  StateStore,
  {
    readonly load: Effect.Effect<PersistedState>;
    readonly save: (state: PersistedState) => Effect.Effect<void, StateStoreError>;
  }
>()("insomnia/StateStore") {}

/** Installs or removes the passwordless permission for `pmset -a disablesleep`. */
export class PrivilegeInstaller extends Context.Service<
  PrivilegeInstaller,
  {
    readonly install: Effect.Effect<void, PrivilegeInstallFailed>;
    readonly uninstall: Effect.Effect<void, PrivilegeInstallFailed>;
  }
>()("insomnia/PrivilegeInstaller") {}
