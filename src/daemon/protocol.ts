import * as Schema from "effect/Schema";
import { Percent, Status } from "../session/model.ts";

/**
 * Newline-delimited JSON between the menu bar shell (client) and the daemon.
 * Requests arrive on the daemon's stdin; events leave on its stdout. Logs go to stderr.
 * The Swift shell mirrors these shapes in `macos/Insomnia/Protocol.swift`.
 */
export const Request = Schema.TaggedUnion({
  /** `durationSeconds: null` keeps the Mac awake until stopped. */
  Start: { durationSeconds: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))) },
  Stop: {},
  SetLowBatteryThreshold: { percent: Schema.NullOr(Percent) },
  InstallPrivileges: {},
  Refresh: {},
});
export type Request = typeof Request.Type;

export const Event = Schema.TaggedUnion({
  Status: { status: Status },
  /** A request failed. `kind` is the error tag, for clients that want to special-case it. */
  Error: { kind: Schema.String, message: Schema.String },
});
export type Event = typeof Event.Type;

export const RequestJson = Schema.fromJsonString(Request);
export const EventJson = Schema.fromJsonString(Event);
