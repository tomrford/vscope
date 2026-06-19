import {
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  PubSub,
  Ref,
  Schedule,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";
import {
  RuntimeDeviceLost,
  SNAPSHOT_SAMPLE_FORMAT,
  SerialConfig,
  SnapshotDraft,
  SnapshotSamplesWrite,
  SnapshotTrigger,
  type SnapshotRecord,
} from "@vscope/shared";
import { Persistence, type PersistenceService } from "@vscope/persistence";
import { summarizeDevice, VScopeFrameParseError, VScopeSerial, VScopeState } from "@vscope/serial";
import type {
  VScopeControlStatus,
  VScopeDevice,
  VScopeDeviceError,
  VScopeDeviceSummary,
  VScopeSerialEvent,
  VScopeSnapshotHeader,
  VScopeStaticMetadata,
  VScopeTiming,
  VScopeTrigger,
} from "@vscope/serial";

import {
  type RuntimeCoreError,
  RuntimeCorePersistenceError,
  RuntimeCorePolicyError,
  RuntimeCoreSerialError,
} from "./errors";
import type {
  ActiveDeviceState,
  CoreCommand,
  CoreQuery,
  CoreQueryResult,
  DeviceConfigState,
  DeviceControlCommand,
  RuntimeAppState,
  SnapshotCaptureCommand,
} from "./model";
import { decideDeviceControl, permissionsForDevice } from "./policy";
import { RuntimeCore } from "./service";

const MAX_LOG_ENTRIES = 100;
const MAX_WARNINGS = 32;

interface DeviceRuntimeState {
  readonly status: VScopeControlStatus;
  readonly config: DeviceConfigState | null;
  readonly frame: ReadonlyArray<number> | null;
}

interface InitialStores {
  readonly app: RuntimeAppState;
  readonly snapshots: ReadonlyArray<SnapshotRecord>;
}

interface DeviceSession {
  readonly path: string;
  readonly frames: PubSub.PubSub<ReadonlyArray<number> | null>;
  readonly lastFrame: Ref.Ref<ReadonlyArray<number> | null>;
  readonly ended: Deferred.Deferred<void, RuntimeDeviceLost>;
}

type DeviceMonitorFiber = Fiber.Fiber<void, never>;

const makeRuntimeCore = Effect.gen(function* () {
  const persistence = yield* Persistence;
  const serial = yield* VScopeSerial;
  const initial = yield* hydrateInitialStores(persistence);
  const appRef = yield* SubscriptionRef.make(initial.app);
  const snapshotsRef = yield* SubscriptionRef.make(initial.snapshots);
  const activeDeviceRef = yield* SubscriptionRef.make<ActiveDeviceState | null>(null);
  const deviceStatusRef = yield* SubscriptionRef.make<VScopeControlStatus | null>(null);
  const deviceConfigRef = yield* SubscriptionRef.make<DeviceConfigState | null>(null);
  const parentScope = yield* Scope.Scope;
  const monitorFiber = yield* Ref.make<DeviceMonitorFiber | null>(null);
  const sessionRef = yield* Ref.make<DeviceSession | null>(null);
  const dispatchLock = yield* Semaphore.make(1);

  const updateApp = (update: (app: RuntimeAppState) => RuntimeAppState) =>
    SubscriptionRef.updateAndGet(appRef, (app) => finalizeApp(update(app)));

  const logApp = (message: string) =>
    updateApp((app) => {
      const now = timestamp();
      return { ...app, logs: appendLog(app.logs, message, now) };
    });

  const warnApp = (message: string) =>
    updateApp((app) => {
      const now = timestamp();
      return {
        ...app,
        warnings: appendWarning(app.warnings, message, now),
        logs: appendLog(app.logs, message, now),
      };
    });

  const updateActiveDevice = (
    path: string,
    update: (device: ActiveDeviceState) => ActiveDeviceState,
  ) =>
    SubscriptionRef.updateSome(activeDeviceRef, (device) => {
      if (!device || device.path !== path) {
        return Option.none();
      }
      const next = update(device);
      return next === device ? Option.none() : Option.some(next);
    });

  const clearActiveDeviceError = (path: string) =>
    updateActiveDevice(path, (device) =>
      device.error === null ? device : { ...device, error: null },
    );

  const applyDeviceError = (path: string, error: RuntimeCoreError) =>
    updateActiveDevice(path, (device) => ({ ...device, error: describeCause(error) }));

  const openSession = (path: string, initialFrame: ReadonlyArray<number> | null) =>
    Effect.gen(function* () {
      const frames = yield* PubSub.sliding<ReadonlyArray<number> | null>(32);
      const lastFrame = yield* Ref.make(initialFrame);
      const ended = yield* Deferred.make<void, RuntimeDeviceLost>();
      const session: DeviceSession = { path, frames, lastFrame, ended };
      yield* Ref.set(sessionRef, session);
      return session;
    });

  const finishSession = (session: DeviceSession, reason: RuntimeDeviceLost | null) =>
    Ref.set(sessionRef, null).pipe(
      Effect.andThen(
        reason ? Deferred.fail(session.ended, reason) : Deferred.succeed(session.ended, undefined),
      ),
      Effect.asVoid,
    );

  const closeSession = (path: string, reason: RuntimeDeviceLost | null) =>
    Ref.get(sessionRef).pipe(
      Effect.flatMap((session) =>
        session && session.path === path ? finishSession(session, reason) : Effect.void,
      ),
    );

  const closeCurrentSession = (reason: RuntimeDeviceLost | null) =>
    Ref.get(sessionRef).pipe(
      Effect.flatMap((session) => (session ? finishSession(session, reason) : Effect.void)),
    );

  const interruptMonitor = Effect.gen(function* () {
    const fiber = yield* Ref.getAndSet(monitorFiber, null);
    if (fiber) {
      yield* Fiber.interrupt(fiber).pipe(Effect.asVoid);
    }
  });

  const frames: Stream.Stream<ReadonlyArray<number> | null, RuntimeDeviceLost> = Stream.unwrap(
    Ref.get(sessionRef).pipe(
      Effect.map((session) =>
        session
          ? Stream.fromPubSub(session.frames).pipe(Stream.haltWhen(Deferred.await(session.ended)))
          : Stream.fail(new RuntimeDeviceLost({ reason: "No device is connected." })),
      ),
    ),
  );

  const lastFrame = Ref.get(sessionRef).pipe(
    Effect.flatMap((session) => (session ? Ref.get(session.lastFrame) : Effect.succeed(null))),
  );

  const permissions = Effect.gen(function* () {
    const device = yield* SubscriptionRef.get(activeDeviceRef);
    const status = yield* SubscriptionRef.get(deviceStatusRef);
    return permissionsForDevice(device, status);
  });

  const readModel = Effect.gen(function* () {
    const app = yield* SubscriptionRef.get(appRef);
    const snapshots = yield* SubscriptionRef.get(snapshotsRef);
    const activeDevice = yield* SubscriptionRef.get(activeDeviceRef);
    const deviceStatus = yield* SubscriptionRef.get(deviceStatusRef);
    const deviceConfig = yield* SubscriptionRef.get(deviceConfigRef);
    const currentPermissions = yield* permissions;
    return {
      app,
      snapshots,
      activeDevice,
      deviceStatus,
      deviceConfig,
      permissions: currentPermissions,
    };
  });

  const publishStatus = (path: string, status: VScopeControlStatus) =>
    Effect.gen(function* () {
      const activeDevice = yield* SubscriptionRef.get(activeDeviceRef);
      if (!activeDevice || activeDevice.path !== path) {
        return;
      }

      const current = yield* SubscriptionRef.get(deviceStatusRef);
      if (!current || !statusEquals(current, status)) {
        yield* SubscriptionRef.set(deviceStatusRef, status);
      }
      yield* clearActiveDeviceError(path);
    });

  const clearLiveDeviceStores = Effect.all(
    [SubscriptionRef.set(deviceStatusRef, null), SubscriptionRef.set(deviceConfigRef, null)],
    { discard: true },
  );

  const markDeviceLost = (device: VScopeDevice, error: RuntimeCoreError) => {
    const reason = describeCause(error);
    const message = `Lost ${device.deviceName} at ${device.path}: ${reason}`;
    return Effect.all(
      [
        updateActiveDevice(device.path, (active) => ({
          ...active,
          connectionStatus: "lost",
          error: reason,
        })),
        clearLiveDeviceStores,
        warnApp(message),
        closeSession(device.path, new RuntimeDeviceLost({ reason })),
        serial.removeDevice(device.path).pipe(Effect.ignore),
      ],
      { discard: true },
    );
  };

  const applyConnectedDevice = (summary: VScopeDeviceSummary, runtimeState: DeviceRuntimeState) =>
    Effect.gen(function* () {
      const existing = yield* SubscriptionRef.get(activeDeviceRef);
      yield* SubscriptionRef.set(activeDeviceRef, activeDeviceFromSummary(summary));
      yield* SubscriptionRef.set(deviceStatusRef, runtimeState.status);
      yield* SubscriptionRef.set(deviceConfigRef, runtimeState.config);

      if (existing?.connectionStatus !== "connected") {
        yield* logApp(`Connected ${summary.deviceName} at ${summary.path}`);
      }
    });

  const applyDisconnectedDevice = (summary: {
    readonly path: string;
    readonly deviceName: string;
  }) =>
    Effect.gen(function* () {
      const active = yield* SubscriptionRef.get(activeDeviceRef);
      if (!active || active.path !== summary.path || active.connectionStatus !== "connected") {
        return;
      }

      yield* SubscriptionRef.set(activeDeviceRef, {
        ...active,
        connectionStatus: "disconnected",
        error: null,
      });
      yield* clearLiveDeviceStores;
      yield* logApp(`Disconnected ${summary.deviceName} at ${summary.path}`);
    });

  const applyLostDevice = (event: Extract<VScopeSerialEvent, { readonly _tag: "DeviceLost" }>) =>
    Effect.gen(function* () {
      const active = yield* SubscriptionRef.get(activeDeviceRef);
      if (!active || active.path !== event.device.path) {
        return;
      }

      const reason = describeCause(event.cause);
      yield* SubscriptionRef.set(activeDeviceRef, {
        ...active,
        connectionStatus: "lost",
        error: reason,
      });
      yield* clearLiveDeviceStores;
      yield* warnApp(`Lost ${event.device.deviceName} at ${event.device.path}: ${reason}`);
    });

  const applyConfigPatch = (
    path: string,
    command: DeviceControlCommand["type"],
    patch: {
      readonly timing?: VScopeTiming | undefined;
      readonly trigger?: VScopeTrigger | undefined;
      readonly channelMap?: ReadonlyArray<number> | undefined;
      readonly rtValue?: readonly [number, number] | undefined;
    },
  ) =>
    Effect.gen(function* () {
      const active = yield* SubscriptionRef.get(activeDeviceRef);
      const config = yield* SubscriptionRef.get(deviceConfigRef);
      if (!active || active.path !== path || !config) {
        return yield* new RuntimeCorePolicyError({
          command,
          reason: "No editable device configuration is available.",
        });
      }

      const rtValues = new Map(config.rtValues);
      if (patch.rtValue) {
        rtValues.set(patch.rtValue[0], patch.rtValue[1]);
      }

      yield* SubscriptionRef.set(deviceConfigRef, {
        timing: patch.timing ?? config.timing,
        trigger: patch.trigger ?? config.trigger,
        channelMap: patch.channelMap ?? config.channelMap,
        rtValues,
      });
      yield* clearActiveDeviceError(path);
    });

  const handleSerialEvent = (event: VScopeSerialEvent) => {
    switch (event._tag) {
      case "DeviceOpened":
        return Effect.void;
      case "DeviceRemoved":
        return interruptMonitor.pipe(
          Effect.andThen(closeSession(event.device.path, null)),
          Effect.andThen(applyDisconnectedDevice(event.device)),
        );
      case "DeviceLost":
        return interruptMonitor.pipe(
          Effect.andThen(
            closeSession(
              event.device.path,
              new RuntimeDeviceLost({ reason: describeCause(event.cause) }),
            ),
          ),
          Effect.andThen(applyLostDevice(event)),
        );
    }
  };

  yield* serial.events.pipe(Stream.runForEach(handleSerialEvent), Effect.forkScoped);

  const connectDevice = (command: Extract<CoreCommand, { readonly type: "devices/connect" }>) =>
    Effect.gen(function* () {
      const app = yield* SubscriptionRef.get(appRef);
      const active = yield* SubscriptionRef.get(activeDeviceRef);
      if (active?.connectionStatus === "connected") {
        return yield* new RuntimeCorePolicyError({
          command: command.type,
          reason: "Disconnect the current device before connecting another one.",
        });
      }

      yield* interruptMonitor;
      yield* closeCurrentSession(null);
      const config = command.serialConfig ?? app.settings.defaultSerialConfig;
      const device = yield* serial
        .openDevice(openOptions(command.path, config, app.settings.polling))
        .pipe(
          Effect.mapError(
            (cause) => new RuntimeCoreSerialError({ operation: "devices/connect", cause }),
          ),
        );
      const { summary, runtimeState } = yield* Effect.gen(function* () {
        const summary = yield* summarizeDevice(device);
        const runtimeState = yield* readDeviceRuntimeState(device, summary.metadata);
        return { summary, runtimeState };
      }).pipe(
        Effect.mapError(
          (cause) => new RuntimeCoreSerialError({ operation: "devices/connect", cause }),
        ),
        Effect.tapError(() => serial.removeDevice(device.path).pipe(Effect.ignore)),
      );

      yield* applyConnectedDevice(summary, runtimeState);
      const session = yield* openSession(device.path, runtimeState.frame);
      const fiber = yield* monitorDevice(device, session, app.settings.polling).pipe(
        Effect.forkIn(parentScope),
      );
      yield* Ref.set(monitorFiber, fiber);
    });

  const disconnectDevice = () =>
    Effect.gen(function* () {
      const active = yield* SubscriptionRef.get(activeDeviceRef);
      if (!active || active.connectionStatus !== "connected") {
        return yield* new RuntimeCorePolicyError({
          command: "devices/disconnect",
          reason: "No connected device is available.",
        });
      }

      yield* interruptMonitor;
      yield* closeSession(active.path, null);
      yield* serial
        .removeDevice(active.path)
        .pipe(
          Effect.mapError(
            (cause) => new RuntimeCoreSerialError({ operation: "devices/disconnect", cause }),
          ),
        );

      yield* applyDisconnectedDevice(active);
    });

  const monitorDevice = (
    device: VScopeDevice,
    session: DeviceSession,
    polling: RuntimeAppState["settings"]["polling"],
  ): Effect.Effect<void> => {
    const statusMonitor = Stream.fromSchedule(
      Schedule.spaced(`${pollMillis(polling.stateHz)} millis`),
    ).pipe(
      Stream.runForEach(() =>
        device.getStatus({ retryAttempts: 0 }).pipe(
          Effect.flatMap((status) => publishStatus(device.path, status)),
          Effect.catch((cause) =>
            cause instanceof VScopeFrameParseError ? Effect.void : Effect.fail(cause),
          ),
          Effect.mapError(
            (cause) => new RuntimeCoreSerialError({ operation: "devices/status", cause }),
          ),
        ),
      ),
    );

    const frameMonitor = Stream.fromSchedule(
      Schedule.spaced(`${pollMillis(polling.frameHz)} millis`),
    ).pipe(
      Stream.runForEach(() =>
        device.getFrame({ retryAttempts: 0 }).pipe(
          Effect.flatMap((frame) => {
            const values = Array.from(frame);
            return Ref.set(session.lastFrame, values).pipe(
              Effect.andThen(PubSub.publish(session.frames, values)),
              Effect.asVoid,
            );
          }),
          Effect.catch((cause) =>
            cause instanceof VScopeFrameParseError
              ? PubSub.publish(session.frames, null).pipe(Effect.asVoid)
              : Effect.fail(cause),
          ),
          Effect.mapError(
            (cause) => new RuntimeCoreSerialError({ operation: "devices/frame", cause }),
          ),
        ),
      ),
    );

    return Effect.all([statusMonitor, frameMonitor], {
      concurrency: "unbounded",
      discard: true,
    }).pipe(Effect.catch((error) => markDeviceLost(device, error)));
  };

  const withDevice = <A>(
    command: DeviceControlCommand,
    operation: (device: VScopeDevice) => Effect.Effect<A, VScopeDeviceError>,
    applyResult: (path: string, result: A) => Effect.Effect<void, RuntimeCoreError>,
  ) =>
    Effect.gen(function* () {
      const active = yield* SubscriptionRef.get(activeDeviceRef);
      const status = yield* SubscriptionRef.get(deviceStatusRef);
      const currentPermissions = permissionsForDevice(active, status);
      const decision = decideDeviceControl(command, active, currentPermissions);
      if (!decision.allowed) {
        return yield* new RuntimeCorePolicyError({
          command: command.type,
          reason: decision.reason,
        });
      }

      const device = yield* serial
        .getDeviceByPath(decision.device.path)
        .pipe(
          Effect.mapError(
            (cause) => new RuntimeCoreSerialError({ operation: command.type, cause }),
          ),
        );
      const result = yield* operation(device).pipe(
        Effect.mapError((cause) => new RuntimeCoreSerialError({ operation: command.type, cause })),
        Effect.tapError((error) => applyDeviceError(device.path, error)),
      );
      yield* applyResult(device.path, result);
    });

  const controlDevice = (command: DeviceControlCommand) => {
    switch (command.type) {
      case "devices/run":
        return withDevice(
          command,
          (device) => device.setState(VScopeState.Running),
          (path, status) => publishStatus(path, status),
        );
      case "devices/stop":
        return withDevice(
          command,
          (device) => device.setState(VScopeState.Halted),
          (path, status) => publishStatus(path, status),
        );
      case "devices/trigger":
        return withDevice(
          command,
          (device) => device.trigger,
          (path, status) => publishStatus(path, status),
        );
      case "devices/setTiming":
        return withDevice(
          command,
          (device) => device.setTiming(command.timing),
          (path, timing) => applyConfigPatch(path, command.type, { timing }),
        );
      case "devices/setTrigger":
        return withDevice(
          command,
          (device) => device.setTrigger(command.trigger),
          (path, trigger) => applyConfigPatch(path, command.type, { trigger }),
        );
      case "devices/setRtValue":
        return withDevice(
          command,
          (device) => device.setRtValue(command.index, command.value),
          (path, value) =>
            applyConfigPatch(path, command.type, { rtValue: [command.index, value] }),
        );
      case "devices/setChannelMap":
        return withDevice(
          command,
          (device) => device.setChannelMap(command.channel, command.variable),
          (path, channelMap) => applyConfigPatch(path, command.type, { channelMap }),
        );
    }
  };

  const captureSnapshot = (command: SnapshotCaptureCommand) =>
    Effect.gen(function* () {
      const active = yield* SubscriptionRef.get(activeDeviceRef);
      const status = yield* SubscriptionRef.get(deviceStatusRef);
      const currentPermissions = permissionsForDevice(active, status);
      if (!active || active.connectionStatus !== "connected") {
        return yield* new RuntimeCorePolicyError({
          command: command.type,
          reason: "No connected device is available.",
        });
      }

      if (!currentPermissions.captureSnapshot) {
        return yield* new RuntimeCorePolicyError({
          command: command.type,
          reason:
            "Snapshot capture is available only when the connected device has a ready snapshot.",
        });
      }

      return yield* Effect.gen(function* () {
        const device = yield* serial
          .getDeviceByPath(active.path)
          .pipe(
            Effect.mapError(
              (cause) => new RuntimeCoreSerialError({ operation: command.type, cause }),
            ),
          );
        const capturedAt = timestamp();
        const header = yield* device.getSnapshotHeader.pipe(
          Effect.mapError(
            (cause) => new RuntimeCoreSerialError({ operation: command.type, cause }),
          ),
        );
        const bytes = yield* device
          .collectSnapshotBytes({ header })
          .pipe(
            Effect.mapError(
              (cause) => new RuntimeCoreSerialError({ operation: command.type, cause }),
            ),
          );
        const label = normalizedSnapshotLabel(command.label, active.deviceName, capturedAt);
        const record = yield* persistence
          .createSnapshot(
            snapshotDraftFromCapture({
              device: active,
              header,
              label,
              capturedAt,
            }),
            SnapshotSamplesWrite.make({
              format: SNAPSHOT_SAMPLE_FORMAT,
              data: bytes,
            }),
          )
          .pipe(
            Effect.mapError(
              (cause) => new RuntimeCorePersistenceError({ operation: command.type, cause }),
            ),
          );
        const snapshots = yield* persistence
          .listSnapshots()
          .pipe(
            Effect.mapError(
              (cause) => new RuntimeCorePersistenceError({ operation: "snapshots/list", cause }),
            ),
          );

        yield* SubscriptionRef.set(snapshotsRef, snapshots);
        yield* clearActiveDeviceError(active.path);
        yield* logApp(`Captured snapshot "${record.label}" from ${active.deviceName}`);
      }).pipe(Effect.tapError((error) => applyDeviceError(active.path, error)));
    });

  const dispatchUnlocked = (command: CoreCommand): Effect.Effect<void, RuntimeCoreError> => {
    switch (command.type) {
      case "warnings/clear":
        return updateApp((app) => ({ ...app, warnings: [] })).pipe(Effect.asVoid);
      case "settings/patch":
        return Effect.gen(function* () {
          const stateResult = yield* persistence
            .patchSettings(command.patch)
            .pipe(
              Effect.mapError(
                (cause) => new RuntimeCorePersistenceError({ operation: "settings/patch", cause }),
              ),
            );
          yield* updateApp((app) => ({
            ...app,
            settings: stateResult.settings,
            settingsRecovery: stateResult.recovery,
          }));
        });
      case "preferences/patch":
        return Effect.gen(function* () {
          const stateResult = yield* persistence
            .patchPreferences(command.patch)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new RuntimeCorePersistenceError({ operation: "preferences/patch", cause }),
              ),
            );
          yield* updateApp((app) => ({
            ...app,
            preferences: stateResult.preferences,
            preferencesRecovery: stateResult.recovery,
          }));
        });
      case "devices/connect":
        return connectDevice(command);
      case "devices/disconnect":
        return disconnectDevice();
      case "snapshots/capture":
        return captureSnapshot(command);
      case "devices/run":
      case "devices/stop":
      case "devices/setTiming":
      case "devices/setTrigger":
      case "devices/setRtValue":
      case "devices/setChannelMap":
      case "devices/trigger":
        return controlDevice(command);
    }
  };

  const dispatch = (command: CoreCommand): Effect.Effect<void, RuntimeCoreError> =>
    dispatchLock.withPermit(dispatchUnlocked(command));

  const query = (queryRequest: CoreQuery): Effect.Effect<CoreQueryResult, RuntimeCoreError> => {
    switch (queryRequest.type) {
      case "ports/list":
        return serial.listPorts.pipe(
          Effect.map(
            (ports): CoreQueryResult => ({
              type: "ports/list",
              ports,
            }),
          ),
          Effect.mapError(
            (cause) => new RuntimeCoreSerialError({ operation: "ports/list", cause }),
          ),
        );
      case "snapshots/list":
        return SubscriptionRef.get(snapshotsRef).pipe(
          Effect.map((snapshots) => ({
            type: "snapshots/list",
            snapshots,
          })),
        );
      case "snapshots/readSamples":
        return persistence.readSnapshotSamples(queryRequest.id).pipe(
          Effect.map(
            (samples): CoreQueryResult => ({
              type: "snapshots/readSamples",
              samples: Option.getOrNull(samples),
            }),
          ),
          Effect.mapError(
            (cause) =>
              new RuntimeCorePersistenceError({ operation: "snapshots/readSamples", cause }),
          ),
        );
    }
  };

  const shutdown = interruptMonitor.pipe(
    Effect.andThen(closeCurrentSession(null)),
    Effect.andThen(
      serial.closeAll.pipe(
        Effect.mapError((cause) => new RuntimeCoreSerialError({ operation: "shutdown", cause })),
      ),
    ),
    Effect.andThen(
      Effect.gen(function* () {
        const active = yield* SubscriptionRef.get(activeDeviceRef);
        if (active?.connectionStatus === "connected") {
          yield* SubscriptionRef.set(activeDeviceRef, {
            ...active,
            connectionStatus: "disconnected",
            error: null,
          });
        }
        yield* clearLiveDeviceStores;
        yield* logApp("Runtime core shutdown closed the serial device");
      }),
    ),
    Effect.asVoid,
  );

  return {
    app: SubscriptionRef.get(appRef),
    appChanges: SubscriptionRef.changes(appRef),
    snapshots: SubscriptionRef.get(snapshotsRef),
    snapshotChanges: SubscriptionRef.changes(snapshotsRef),
    activeDevice: SubscriptionRef.get(activeDeviceRef),
    activeDeviceChanges: SubscriptionRef.changes(activeDeviceRef),
    deviceStatus: SubscriptionRef.get(deviceStatusRef),
    deviceStatusChanges: SubscriptionRef.changes(deviceStatusRef),
    deviceConfig: SubscriptionRef.get(deviceConfigRef),
    deviceConfigChanges: SubscriptionRef.changes(deviceConfigRef),
    permissions,
    readModel,
    dispatch,
    query,
    shutdown,
    frames,
    lastFrame,
  };
});

export const RuntimeCoreLive = Layer.effect(RuntimeCore, makeRuntimeCore);

function hydrateInitialStores(
  persistence: PersistenceService,
): Effect.Effect<InitialStores, RuntimeCorePersistenceError> {
  return Effect.gen(function* () {
    const bootedAt = timestamp();
    const settingsState = yield* persistence.readSettings.pipe(
      Effect.mapError(
        (cause) => new RuntimeCorePersistenceError({ operation: "settings/read", cause }),
      ),
    );
    const preferencesState = yield* persistence.readPreferences.pipe(
      Effect.mapError(
        (cause) => new RuntimeCorePersistenceError({ operation: "preferences/read", cause }),
      ),
    );
    const savedDevices = yield* persistence.listSavedDevices.pipe(
      Effect.mapError(
        (cause) => new RuntimeCorePersistenceError({ operation: "savedDevices/list", cause }),
      ),
    );
    const snapshots = yield* persistence
      .listSnapshots()
      .pipe(
        Effect.mapError(
          (cause) => new RuntimeCorePersistenceError({ operation: "snapshots/list", cause }),
        ),
      );

    return {
      app: finalizeApp({
        bootedAt,
        updatedAt: bootedAt,
        status: "ready",
        settings: settingsState.settings,
        settingsRecovery: settingsState.recovery,
        preferences: preferencesState.preferences,
        preferencesRecovery: preferencesState.recovery,
        savedDevices,
        warnings: [],
        logs: [],
      }),
      snapshots,
    };
  });
}

function finalizeApp(app: RuntimeAppState): RuntimeAppState {
  return {
    ...app,
    updatedAt: timestamp(),
    status: app.warnings.length > 0 ? "degraded" : "ready",
  };
}

function activeDeviceFromSummary(summary: VScopeDeviceSummary): ActiveDeviceState {
  return {
    path: summary.path,
    deviceName: summary.deviceName,
    connectionStatus: "connected",
    info: summary.metadata.info,
    variables: summary.metadata.variables,
    rtLabels: summary.metadata.rtLabels,
    error: null,
  };
}

function statusEquals(a: VScopeControlStatus, b: VScopeControlStatus): boolean {
  return (
    a.state === b.state &&
    a.requestedState === b.requestedState &&
    a.snapshotValid === b.snapshotValid &&
    a.requestPending === b.requestPending &&
    a.triggerEnabled === b.triggerEnabled &&
    a.flags === b.flags
  );
}

function openOptions(
  path: string,
  config: SerialConfig,
  polling: RuntimeAppState["settings"]["polling"],
) {
  return {
    path,
    baudRate: config.baudRate,
    dataBits: config.dataBits,
    stopBits: config.stopBits,
    parity: config.parity,
    dtr: config.dtr,
    rts: config.rts,
    requestTimeoutMillis: polling.serialTimeoutMs,
    retryAttempts: polling.retryAttempts,
  };
}

function readDeviceRuntimeState(
  device: VScopeDevice,
  metadata: VScopeStaticMetadata,
): Effect.Effect<DeviceRuntimeState, VScopeDeviceError> {
  return Effect.gen(function* () {
    const status = yield* device.getStatus();
    if (status.state === VScopeState.Misconfigured) {
      return {
        status,
        config: null,
        frame: null,
      };
    }

    const timing = yield* device.getTiming;
    const trigger = yield* device.getTrigger;
    const channelMap = yield* device.getChannelMap;
    const frame = yield* device.getFrame();
    const rtValues = new Map<number, number>();

    for (let index = 0; index < metadata.rtLabels.length; index += 1) {
      const value = yield* device.getRtValue(index);
      rtValues.set(index, value);
    }

    return {
      status,
      config: {
        timing,
        trigger,
        channelMap,
        rtValues,
      },
      frame: Array.from(frame),
    };
  });
}

function pollMillis(hz: number): number {
  return Math.max(10, Math.round(1000 / hz));
}

function normalizedSnapshotLabel(
  label: string | undefined,
  deviceName: string,
  capturedAt: string,
): string {
  const trimmed = label?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : `${deviceName} ${capturedAt}`;
}

function snapshotDraftFromCapture(options: {
  readonly device: ActiveDeviceState;
  readonly header: VScopeSnapshotHeader;
  readonly label: string;
  readonly capturedAt: string;
}): SnapshotDraft {
  const { device, header, label, capturedAt } = options;
  return SnapshotDraft.make({
    label,
    device: {
      name: device.deviceName,
    },
    channelCount: header.channelCount,
    sampleCount: header.sampleCount,
    sampleRateHz: sampleRateHz(device.info, header.divider),
    divider: header.divider,
    preTriggerSamples: header.preTrig,
    channelMap: Array.from(header.channelMap),
    trigger: SnapshotTrigger.make(header.trigger),
    rtValues: Array.from(header.rtValues),
    metadata: {
      capturedAt,
      deviceInfo: device.info,
      variables: device.variables,
      rtLabels: device.rtLabels,
    },
  });
}

function sampleRateHz(info: ActiveDeviceState["info"], divider: number): number | null {
  if (!info || divider <= 0) {
    return null;
  }

  return (info.isrKHz * 1000) / divider;
}

function appendWarning(
  warnings: ReadonlyArray<{
    readonly id: string;
    readonly message: string;
    readonly createdAt: string;
  }>,
  message: string,
  now: string,
) {
  return [
    {
      id: `${now}:warning:${warnings.length}`,
      message,
      createdAt: now,
    },
    ...warnings,
  ].slice(0, MAX_WARNINGS);
}

function appendLog(
  logs: ReadonlyArray<{
    readonly id: string;
    readonly message: string;
    readonly createdAt: string;
  }>,
  message: string,
  now: string,
) {
  return [
    {
      id: `${now}:log:${logs.length}`,
      message,
      createdAt: now,
    },
    ...logs,
  ].slice(0, MAX_LOG_ENTRIES);
}

function timestamp(): string {
  return new Date().toISOString();
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }

  return String(cause);
}
