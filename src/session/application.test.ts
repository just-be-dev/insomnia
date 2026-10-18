import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Context from "effect/Context";
import * as TestClock from "effect/testing/TestClock";
import { SessionManager } from "./application.ts";
import type { PersistedState } from "./model.ts";
import { type MemoryMac, makeMemoryMac, memoryMacLayer } from "./testing.ts";

const minutes = (n: number) => n * 60_000;

/** Builds a SessionManager in its own scope so tests can close it and observe shutdown. */
const boot = (mac: MemoryMac) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      SessionManager.layer.pipe(Layer.provide(memoryMacLayer(mac))),
      scope,
    );
    return {
      manager: Context.get(context, SessionManager),
      shutdown: Scope.close(scope, Exit.void),
    };
  });

describe("SessionManager", () => {
  it.effect("an indefinite session disables sleep until stopped, then restores it", () =>
    Effect.gen(function* () {
      const mac = yield* makeMemoryMac();
      const { manager } = yield* boot(mac);

      yield* manager.start(null);
      yield* TestClock.adjust("12 hours");
      expect(yield* Ref.get(mac.sleepDisabled)).toBe(true);
      expect((yield* manager.status).session._tag).toBe("Active");

      yield* manager.stop;
      const status = yield* manager.status;
      expect(yield* Ref.get(mac.sleepDisabled)).toBe(false);
      expect(status.session._tag).toBe("Idle");
      expect(status.lastEnded?.reason).toBe("Stopped");
      expect((yield* Ref.get(mac.persisted)).session._tag).toBe("Idle");
    }),
  );

  it.effect("a timed session ends at its deadline, not before", () =>
    Effect.gen(function* () {
      const mac = yield* makeMemoryMac();
      const { manager } = yield* boot(mac);

      yield* manager.start(minutes(30));
      yield* TestClock.adjust(minutes(29));
      expect(yield* Ref.get(mac.sleepDisabled)).toBe(true);

      yield* TestClock.adjust(minutes(1) + 1000);
      const status = yield* manager.status;
      expect(yield* Ref.get(mac.sleepDisabled)).toBe(false);
      expect(status.lastEnded).toEqual({ reason: "Expired", at: minutes(30) });
    }),
  );

  it.effect("starting again replaces the deadline", () =>
    Effect.gen(function* () {
      const mac = yield* makeMemoryMac();
      const { manager } = yield* boot(mac);

      yield* manager.start(minutes(10));
      yield* TestClock.adjust(minutes(5));
      yield* manager.start(minutes(60));
      yield* TestClock.adjust(minutes(10));
      expect(yield* Ref.get(mac.sleepDisabled)).toBe(true);
    }),
  );

  it.effect("the safety stop ends a session once battery drops to the threshold", () =>
    Effect.gen(function* () {
      const mac = yield* makeMemoryMac({ battery: { percent: 50, onAC: false } });
      const { manager } = yield* boot(mac);
      yield* manager.start(null);

      yield* Ref.set(mac.battery, { percent: 21, onAC: false });
      yield* TestClock.adjust("30 seconds");
      expect(yield* Ref.get(mac.sleepDisabled)).toBe(true);

      yield* Ref.set(mac.battery, { percent: 20, onAC: false });
      yield* TestClock.adjust("30 seconds");
      expect(yield* Ref.get(mac.sleepDisabled)).toBe(false);
      expect((yield* manager.status).lastEnded?.reason).toBe("LowBattery");
    }),
  );

  it.effect("low battery on AC power doesn't stop or block a session", () =>
    Effect.gen(function* () {
      const mac = yield* makeMemoryMac({ battery: { percent: 5, onAC: true } });
      const { manager } = yield* boot(mac);
      yield* manager.start(null);
      yield* TestClock.adjust("1 minute");
      expect(yield* Ref.get(mac.sleepDisabled)).toBe(true);
    }),
  );

  it.effect("refuses to start on battery at or below the threshold", () =>
    Effect.gen(function* () {
      const mac = yield* makeMemoryMac({ battery: { percent: 20, onAC: false } });
      const { manager } = yield* boot(mac);

      const error = yield* Effect.flip(manager.start(null));
      expect(error._tag).toBe("BatteryTooLow");
      expect(yield* Ref.get(mac.writes)).toEqual([]);
      expect((yield* Ref.get(mac.persisted)).session._tag).toBe("Idle");
    }),
  );

  it.effect("turning the safety stop off allows a low-battery start", () =>
    Effect.gen(function* () {
      const mac = yield* makeMemoryMac({ battery: { percent: 10, onAC: false } });
      const { manager } = yield* boot(mac);
      yield* manager.setLowBatteryThreshold(null);
      yield* manager.start(null);
      yield* TestClock.adjust("1 minute");
      expect(yield* Ref.get(mac.sleepDisabled)).toBe(true);
      expect((yield* Ref.get(mac.persisted)).settings.lowBatteryThreshold).toBeNull();
    }),
  );

  it.effect("raising the threshold above the current level ends a running session", () =>
    Effect.gen(function* () {
      const mac = yield* makeMemoryMac({ battery: { percent: 40, onAC: false } });
      const { manager } = yield* boot(mac);
      yield* manager.start(null);
      yield* manager.setLowBatteryThreshold(50);
      expect(yield* Ref.get(mac.sleepDisabled)).toBe(false);
      expect((yield* manager.status).lastEnded?.reason).toBe("LowBattery");
    }),
  );

  it.effect("without permissions, start fails and leaves no session behind", () =>
    Effect.gen(function* () {
      const mac = yield* makeMemoryMac({ privileges: "Missing" });
      const { manager } = yield* boot(mac);

      const error = yield* Effect.flip(manager.start(null));
      expect(error._tag).toBe("PrivilegesMissing");
      expect((yield* manager.status).session._tag).toBe("Idle");
      expect((yield* Ref.get(mac.persisted)).session._tag).toBe("Idle");
    }),
  );

  it.effect("ends the session when something else turns disablesleep off", () =>
    Effect.gen(function* () {
      const mac = yield* makeMemoryMac();
      const { manager } = yield* boot(mac);
      yield* manager.start(null);

      yield* Ref.set(mac.sleepDisabled, false);
      yield* TestClock.adjust("30 seconds");
      const status = yield* manager.status;
      expect(status.session._tag).toBe("Idle");
      expect(status.lastEnded?.reason).toBe("External");
    }),
  );

  it.effect("a pmset read failure is not mistaken for an outside change", () =>
    Effect.gen(function* () {
      const mac = yield* makeMemoryMac();
      const { manager } = yield* boot(mac);
      yield* manager.start(null);

      yield* Ref.set(mac.pmsetBroken, true);
      yield* TestClock.adjust("2 minutes");
      expect((yield* manager.status).session._tag).toBe("Active");
    }),
  );

  it.effect("if restoring sleep fails at expiry, it keeps retrying", () =>
    Effect.gen(function* () {
      const mac = yield* makeMemoryMac();
      const { manager } = yield* boot(mac);
      yield* manager.start(minutes(1));

      yield* Ref.set(mac.pmsetBroken, true);
      yield* TestClock.adjust(minutes(2));
      expect((yield* manager.status).session._tag).toBe("Active");

      yield* Ref.set(mac.pmsetBroken, false);
      yield* TestClock.adjust("1 second");
      expect(yield* Ref.get(mac.sleepDisabled)).toBe(false);
      expect((yield* manager.status).lastEnded?.reason).toBe("Expired");
    }),
  );

  it.effect("shutting down restores sleep for an active session", () =>
    Effect.gen(function* () {
      const mac = yield* makeMemoryMac();
      const { manager, shutdown } = yield* boot(mac);
      yield* manager.start(null);

      yield* shutdown;
      expect(yield* Ref.get(mac.sleepDisabled)).toBe(false);
      const persisted = yield* Ref.get(mac.persisted);
      expect(persisted.session._tag).toBe("Idle");
      expect(persisted.lastEnded?.reason).toBe("Shutdown");
    }),
  );

  it.effect("shutting down while idle leaves an outside disablesleep alone", () =>
    Effect.gen(function* () {
      const mac = yield* makeMemoryMac({ sleepDisabled: true });
      const { manager, shutdown } = yield* boot(mac);
      expect((yield* manager.status).sleepDisabled).toBe(true);

      yield* shutdown;
      expect(yield* Ref.get(mac.sleepDisabled)).toBe(true);
      expect(yield* Ref.get(mac.writes)).toEqual([]);
    }),
  );

  it.effect("stop clears an outside disablesleep even when idle", () =>
    Effect.gen(function* () {
      const mac = yield* makeMemoryMac({ sleepDisabled: true });
      const { manager } = yield* boot(mac);
      yield* manager.stop;
      expect(yield* Ref.get(mac.sleepDisabled)).toBe(false);
      expect((yield* manager.status).lastEnded).toBeNull();
    }),
  );

  describe("recovery after a hard kill", () => {
    const activeUntil = (endsAt: number | null): PersistedState => ({
      settings: { lowBatteryThreshold: 20 },
      session: { _tag: "Active", startedAt: 0, endsAt },
      lastEnded: null,
    });

    it.effect("resumes an unexpired session and keeps its deadline", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(minutes(10));
        const mac = yield* makeMemoryMac({ persisted: activeUntil(minutes(60)) });
        const { manager } = yield* boot(mac);
        expect(yield* Ref.get(mac.sleepDisabled)).toBe(true);
        expect((yield* manager.status).session._tag).toBe("Active");

        yield* TestClock.adjust(minutes(50) + 1000);
        expect(yield* Ref.get(mac.sleepDisabled)).toBe(false);
      }),
    );

    it.effect("restores sleep for a session that expired while the daemon was down", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(minutes(90));
        const mac = yield* makeMemoryMac({
          sleepDisabled: true,
          persisted: activeUntil(minutes(60)),
        });
        const { manager } = yield* boot(mac);
        expect(yield* Ref.get(mac.sleepDisabled)).toBe(false);
        expect((yield* manager.status).lastEnded).toEqual({ reason: "Expired", at: minutes(60) });
      }),
    );

    it.effect("restores sleep instead of resuming on low battery", () =>
      Effect.gen(function* () {
        const mac = yield* makeMemoryMac({
          sleepDisabled: true,
          battery: { percent: 5, onAC: false },
          persisted: activeUntil(null),
        });
        const { manager } = yield* boot(mac);
        expect(yield* Ref.get(mac.sleepDisabled)).toBe(false);
        expect((yield* manager.status).lastEnded?.reason).toBe("LowBattery");
      }),
    );
  });
});
