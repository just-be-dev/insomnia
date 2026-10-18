import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { SessionManager } from "../session/application.ts";
import { PrivilegeInstaller } from "../session/service.ts";
import { type Event, EventJson, type Request, RequestJson } from "./protocol.ts";

const decodeRequest = Schema.decodeUnknownEffect(RequestJson);
const encodeEvent = Schema.encodeSync(EventJson);

const errorEvent = (error: { readonly _tag?: string; readonly message: string }): Event => ({
  _tag: "Error",
  kind: error._tag ?? "Error",
  message: error.message,
});

/** Applies one request. Failures become `Error` events; they never stop the daemon. */
export const handle = Effect.fn("daemon.handle")(function* (request: Request) {
  const manager = yield* SessionManager;
  switch (request._tag) {
    case "Start":
      return yield* manager.start(
        request.durationSeconds === null ? null : request.durationSeconds * 1000,
      );
    case "Stop":
      return yield* manager.stop;
    case "SetLowBatteryThreshold":
      return yield* manager.setLowBatteryThreshold(request.percent);
    case "Refresh":
      return yield* manager.refresh;
    case "InstallPrivileges": {
      const installer = yield* PrivilegeInstaller;
      yield* installer.install;
      return yield* manager.refresh;
    }
  }
});

/**
 * Serves the JSON-lines protocol over stdio until stdin closes. The menu bar shell owns the
 * other end of the pipes, so if the shell quits or crashes, stdin closes, the daemon's scope
 * closes, and the session finalizer restores normal sleep.
 */
export const serveStdio = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const manager = yield* SessionManager;
  // Every event goes through one queue so a single writer owns stdout and can drain it on exit.
  const events = yield* Queue.unbounded<Event, Cause.Done>();
  const emitStatus = manager.status.pipe(
    Effect.flatMap((status) => Queue.offer(events, { _tag: "Status", status })),
  );

  const writer = yield* Stream.fromQueue(events).pipe(
    Stream.map((event) => `${encodeEvent(event)}\n`),
    // Polls and request echoes often repeat the same status; send each distinct one once.
    Stream.changesWith((a, b) => a === b && a.startsWith('{"_tag":"Status"')),
    Stream.run(stdio.stdout()),
    Effect.forkScoped,
  );

  yield* emitStatus;
  // Background changes (expiry, safety stop, polling). Requests also emit status directly below,
  // so a client always sees the result of its own request; duplicates are harmless.
  yield* manager.changes.pipe(
    Stream.drop(1),
    Stream.runForEach((status) => Queue.offer(events, { _tag: "Status", status })),
    Effect.forkScoped,
  );

  yield* stdio.stdin.pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.filter((line) => line.trim().length > 0),
    Stream.runForEach((line) =>
      decodeRequest(line).pipe(
        Effect.flatMap(handle),
        Effect.catch((error) => Queue.offer(events, errorEvent(error))),
        Effect.andThen(emitStatus),
      ),
    ),
  );

  yield* Effect.logInfo("stdin closed; shutting down");
  yield* Queue.end(events);
  yield* Fiber.join(writer).pipe(Effect.ignore);
});
