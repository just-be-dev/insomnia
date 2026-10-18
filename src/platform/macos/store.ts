import { homedir } from "node:os";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { PersistedState, StateStoreError, initialPersistedState } from "../../session/model.ts";
import { StateStore } from "../../session/service.ts";

const StateJson = Schema.fromJsonString(PersistedState);
const decodeState = Schema.decodeUnknownEffect(StateJson);
const encodeState = Schema.encodeEffect(StateJson);

export const stateDirConfig = Config.String("INSOMNIA_STATE_DIR").pipe(
  Config.withDefault(`${homedir()}/Library/Application Support/insomnia`),
);

/**
 * JSON file store. A missing file means first run. A file that no longer decodes is
 * set aside as `state.json.invalid` and replaced with defaults, rather than blocking startup.
 */
export const fileStateStoreLayer = Layer.effect(
  StateStore,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* stateDirConfig;
    const file = path.join(dir, "state.json");

    const load = Effect.gen(function* () {
      if (!(yield* fs.exists(file))) return initialPersistedState;
      const text = yield* fs.readFileString(file);
      return yield* decodeState(text).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* Effect.logWarning(`Ignoring unreadable ${file}`, error.message);
            yield* fs.rename(file, `${file}.invalid`).pipe(Effect.ignore);
            return initialPersistedState;
          }),
        ),
      );
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(`Couldn't read ${file}`, error).pipe(Effect.as(initialPersistedState)),
      ),
      Effect.withSpan("StateStore.load"),
    );

    const save = Effect.fn("StateStore.save")(
      function* (state: PersistedState) {
        const text = yield* encodeState(state);
        yield* fs.makeDirectory(dir, { recursive: true });
        const tmp = `${file}.tmp`;
        yield* fs.writeFileString(tmp, `${text}\n`);
        yield* fs.rename(tmp, file);
      },
      Effect.mapError((error) => new StateStoreError({ detail: error.message })),
    );

    return { load, save };
  }),
);
