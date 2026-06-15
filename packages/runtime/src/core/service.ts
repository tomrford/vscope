import { Context, Effect, Stream } from "effect";

import type { RuntimeCoreError } from "./errors";
import type { CoreCommand, CoreQuery, CoreQueryResult, CoreState } from "./model";

export interface RuntimeCoreService {
  readonly changes: Stream.Stream<CoreState>;
  readonly getSnapshot: Effect.Effect<CoreState>;
  readonly dispatch: (command: CoreCommand) => Effect.Effect<CoreState, RuntimeCoreError>;
  readonly query: (query: CoreQuery) => Effect.Effect<CoreQueryResult, RuntimeCoreError>;
  readonly shutdown: Effect.Effect<void, RuntimeCoreError>;
}

export class RuntimeCore extends Context.Service<RuntimeCore, RuntimeCoreService>()(
  "@vscope/runtime/RuntimeCore",
) {}
