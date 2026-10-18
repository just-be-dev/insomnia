import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { SessionManager } from "../session/application.ts";
import { makeMemoryMac, memoryMacLayer } from "../session/testing.ts";
import { serveStdio } from "./daemon.ts";
import { type Event, EventJson, RequestJson } from "./protocol.ts";

const decodeEvent = Schema.decodeUnknownSync(EventJson);
const decodeRequest = Schema.decodeUnknownSync(RequestJson);

/** Feeds `lines` to the daemon's stdin, lets stdin close, and returns every event it wrote. */
const runDaemon = (lines: ReadonlyArray<string>, mac: Parameters<typeof memoryMacLayer>[0]) =>
  Effect.gen(function* () {
    const written = yield* Ref.make<ReadonlyArray<string>>([]);
    const stdio = Stdio.layerTest({
      stdin: Stream.make(new TextEncoder().encode(lines.map((line) => `${line}\n`).join(""))),
      stdout: () =>
        Sink.forEach((chunk: string | Uint8Array) =>
          Ref.update(written, (all) => [
            ...all,
            typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
          ]),
        ),
    });
    yield* Effect.scoped(serveStdio).pipe(
      Effect.provide(
        Layer.mergeAll(stdio, SessionManager.layer.pipe(Layer.provideMerge(memoryMacLayer(mac)))),
      ),
    );
    return (yield* Ref.get(written))
      .join("")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line): Event => decodeEvent(line));
  });

describe("protocol", () => {
  it("decodes each request shape", () => {
    expect(decodeRequest('{"_tag":"Start","durationSeconds":3600}')).toEqual({
      _tag: "Start",
      durationSeconds: 3600,
    });
    expect(decodeRequest('{"_tag":"Start","durationSeconds":null}')).toEqual({
      _tag: "Start",
      durationSeconds: null,
    });
    expect(decodeRequest('{"_tag":"SetLowBatteryThreshold","percent":null}')._tag).toBe(
      "SetLowBatteryThreshold",
    );
  });

  it("rejects durations and thresholds out of range", () => {
    expect(() => decodeRequest('{"_tag":"Start","durationSeconds":0}')).toThrow();
    expect(() => decodeRequest('{"_tag":"Start","durationSeconds":1.5}')).toThrow();
    expect(() => decodeRequest('{"_tag":"SetLowBatteryThreshold","percent":101}')).toThrow();
    expect(() => decodeRequest('{"_tag":"Reboot"}')).toThrow();
  });
});

describe("serveStdio", () => {
  it.effect("applies requests, streams status, and restores sleep when stdin closes", () =>
    Effect.gen(function* () {
      const mac = yield* makeMemoryMac();
      const events = yield* runDaemon(['{"_tag":"Start","durationSeconds":null}'], mac);

      const statuses = events.flatMap((event) => (event._tag === "Status" ? [event.status] : []));
      expect(statuses[0]?.session._tag).toBe("Idle");
      expect(statuses.some((status) => status.session._tag === "Active")).toBe(true);
      // stdin closed after the Start, so shutdown must have turned sleep back on.
      expect(yield* Ref.get(mac.writes)).toEqual([true, false]);
      expect((yield* Ref.get(mac.persisted)).lastEnded?.reason).toBe("Shutdown");
    }),
  );

  it.effect("reports bad input and failed requests as Error events and keeps serving", () =>
    Effect.gen(function* () {
      const mac = yield* makeMemoryMac({ battery: { percent: 10, onAC: false } });
      const events = yield* runDaemon(
        [
          "not json",
          '{"_tag":"Start","durationSeconds":60}',
          '{"_tag":"SetLowBatteryThreshold","percent":5}',
          '{"_tag":"Start","durationSeconds":60}',
        ],
        mac,
      );
      const errors = events.flatMap((event) => (event._tag === "Error" ? [event.kind] : []));
      expect(errors).toEqual(["SchemaError", "BatteryTooLow"]);
      expect(yield* Ref.get(mac.writes)).toEqual([true, false]);
    }),
  );

  it.effect("installs permissions on request and reports them as granted", () =>
    Effect.gen(function* () {
      const mac = yield* makeMemoryMac({ privileges: "Missing" });
      const events = yield* runDaemon(['{"_tag":"InstallPrivileges"}'], mac);
      expect(yield* Ref.get(mac.installs)).toBe(1);
      const last = events.findLast((event) => event._tag === "Status");
      expect(last?._tag === "Status" && last.status.privileges).toBe("Granted");
    }),
  );
});
