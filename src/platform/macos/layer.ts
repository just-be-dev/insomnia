import * as Layer from "effect/Layer";
import { batteryMonitorLayer, sleepControlLayer } from "./pmset.ts";
import { privilegeInstallerLayer } from "./privileges.ts";
import { fileStateStoreLayer } from "./store.ts";

/** Every macOS adapter. Requires the platform services (FileSystem, Path, ChildProcessSpawner). */
export const macosLayer = Layer.mergeAll(
  sleepControlLayer,
  batteryMonitorLayer,
  privilegeInstallerLayer,
  fileStateStoreLayer,
);
