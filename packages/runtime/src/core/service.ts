import { Context, Effect, Stream } from "effect";
import type { RuntimeDeviceLost } from "@vscope/shared";

import type { RuntimeCoreError } from "./errors";
import type {
  ActiveDeviceState,
  CoreCommand,
  CoreQuery,
  CoreQueryResult,
  DeviceConfigState,
  RuntimeAppState,
  RuntimeReadModel,
} from "./model";
import type { SnapshotRecord } from "@vscope/shared";
import type { VScopeControlStatus } from "@vscope/serial";
import type { CommandPermissions } from "./policy";

export interface RuntimeCoreService {
  readonly app: Effect.Effect<RuntimeAppState>;
  readonly appChanges: Stream.Stream<RuntimeAppState>;
  readonly snapshots: Effect.Effect<ReadonlyArray<SnapshotRecord>>;
  readonly snapshotChanges: Stream.Stream<ReadonlyArray<SnapshotRecord>>;
  readonly activeDevice: Effect.Effect<ActiveDeviceState | null>;
  readonly activeDeviceChanges: Stream.Stream<ActiveDeviceState | null>;
  readonly deviceStatus: Effect.Effect<VScopeControlStatus | null>;
  readonly deviceStatusChanges: Stream.Stream<VScopeControlStatus | null>;
  readonly deviceConfig: Effect.Effect<DeviceConfigState | null>;
  readonly deviceConfigChanges: Stream.Stream<DeviceConfigState | null>;
  readonly permissions: Effect.Effect<CommandPermissions>;
  readonly readModel: Effect.Effect<RuntimeReadModel>;
  readonly dispatch: (command: CoreCommand) => Effect.Effect<void, RuntimeCoreError>;
  readonly query: (query: CoreQuery) => Effect.Effect<CoreQueryResult, RuntimeCoreError>;
  readonly shutdown: Effect.Effect<void, RuntimeCoreError>;
  // Live frame plane, scoped to the current device session: the stream fails
  // with RuntimeDeviceLost when the device is lost and halts on clean disconnect.
  readonly frames: Stream.Stream<ReadonlyArray<number> | null, RuntimeDeviceLost>;
  readonly lastFrame: Effect.Effect<ReadonlyArray<number> | null>;
}

export class RuntimeCore extends Context.Service<RuntimeCore, RuntimeCoreService>()(
  "@vscope/runtime/RuntimeCore",
) {}
