import {
  Clock,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  PubSub,
  Ref,
  Schedule,
  Schema,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";
import {
  type RuntimeActivityLevel,
  RuntimeDeviceLost,
  type PersistentId,
  SNAPSHOT_SAMPLE_FORMAT,
  SerialConfig,
  SnapshotDraft,
  type SnapshotSampleBlob,
  SnapshotSamplesWrite,
  SnapshotTrigger,
  Timestamp,
  errorReason,
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
  describeRuntimeCoreError,
  RuntimeCorePersistenceError,
  RuntimeCorePolicyError,
  RuntimeCoreSerialError,
} from "./errors";
import type {
  ActiveDeviceState,
  CoreCommand,
  DeviceConfigState,
  DeviceControlCommand,
  RuntimeActivityEntry,
  RuntimeLogEntry,
  RuntimeAppState,
  SnapshotCaptureCommand,
} from "./model";
import { canCaptureSnapshot, decideDeviceControl } from "./policy";
import { RuntimeCore } from "./service";

const MAX_LOG_ENTRIES = 100;
const MAX_ACTIVITY_ENTRIES = 32;

interface DeviceRuntimeState {
  readonly status: VScopeControlStatus;
  readonly config: DeviceConfigState | null;
  readonly frame: ReadonlyArray<number> | null;
}

interface DeviceSession {
  readonly path: string;
  readonly frames: PubSub.PubSub<ReadonlyArray<number> | null>;
  readonly lastFrame: Ref.Ref<ReadonlyArray<number> | null>;
  readonly ended: Deferred.Deferred<void, RuntimeDeviceLost>;
}

interface DeviceMonitor {
  readonly path: string;
  readonly fiber: Fiber.Fiber<void, never>;
}

const makeRuntimeCore = Effect.fn("RuntimeCore.make")(function* () {
  const persistence = yield* Persistence;
  const serial = yield* VScopeSerial;
  const initial = yield* hydrateInitialStores(persistence);
  const appRef = yield* SubscriptionRef.make(initial.app);
  const snapshotsRef = yield* SubscriptionRef.make(initial.snapshots);
  const activeDeviceRef = yield* SubscriptionRef.make<ActiveDeviceState | null>(null);
  const deviceStatusRef = yield* SubscriptionRef.make<VScopeControlStatus | null>(null);
  const deviceConfigRef = yield* SubscriptionRef.make<DeviceConfigState | null>(null);
  const parentScope = yield* Scope.Scope;
  const monitorRef = yield* Ref.make<DeviceMonitor | null>(null);
  const sessionRef = yield* Ref.make<DeviceSession | null>(null);
  const activitySequenceRef = yield* Ref.make(0);
  const dispatchLock = yield* Semaphore.make(1);

  const refreshSnapshots = Effect.fn("RuntimeCore.refreshSnapshots")(function* (
    retentionDays: RuntimeAppState["settings"]["snapshots"]["retentionDays"],
  ) {
    yield* pruneExpiredSnapshots(persistence, retentionDays);
    const snapshots = yield* persistence
      .listSnapshots()
      .pipe(
        Effect.mapError(
          (cause) => new RuntimeCorePersistenceError({ operation: "snapshots/list", cause }),
        ),
      );
    yield* SubscriptionRef.set(snapshotsRef, snapshots);
  });

  const updateApp = (update: (app: RuntimeAppState) => RuntimeAppState) =>
    SubscriptionRef.updateAndGet(appRef, (app) => finalizeApp(update(app)));

  const logApp = (message: string) =>
    updateApp((app) => {
      const now = timestamp();
      return { ...app, logs: appendLog(app.logs, message, now) };
    });

  const recordActivity = Effect.fn("RuntimeCore.recordActivity")(function* (
    level: RuntimeActivityLevel,
    message: string,
  ) {
    const sequence = yield* Ref.updateAndGet(activitySequenceRef, (value) => value + 1);
    yield* updateApp((app) => {
      const now = timestamp();
      return {
        ...app,
        activity: appendActivity(app.activity, level, message, now, sequence),
        logs: appendLog(app.logs, message, now),
      };
    });
  });

  const warnApp = (message: string) => recordActivity("warning", message);
  const errorApp = (message: string) => recordActivity("error", message);

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
    updateActiveDevice(path, (device) => ({ ...device, error: errorReason(error) }));

  const openSession = Effect.fn("RuntimeCore.openSession")(function* (
    path: string,
    initialFrame: ReadonlyArray<number> | null,
  ) {
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

  const interruptMonitor = Effect.fn("RuntimeCore.interruptMonitor")(function* (path?: string) {
    const monitor = yield* Ref.modify(monitorRef, (current) =>
      current && (path === undefined || current.path === path) ? [current, null] : [null, current],
    );
    if (monitor) {
      yield* Fiber.interrupt(monitor.fiber).pipe(Effect.asVoid);
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

  const readModel = Effect.gen(function* () {
    const app = yield* SubscriptionRef.get(appRef);
    const snapshots = yield* SubscriptionRef.get(snapshotsRef);
    const activeDevice = yield* SubscriptionRef.get(activeDeviceRef);
    const deviceStatus = yield* SubscriptionRef.get(deviceStatusRef);
    const deviceConfig = yield* SubscriptionRef.get(deviceConfigRef);
    return {
      app,
      snapshots,
      activeDevice,
      deviceStatus,
      deviceConfig,
    };
  }).pipe(Effect.withSpan("RuntimeCore.readModel"));

  const publishStatus = Effect.fn("RuntimeCore.publishStatus")(function* (
    path: string,
    status: VScopeControlStatus,
  ) {
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
    const reason = errorReason(error);
    const message = `Lost ${device.deviceName} at ${device.path}: ${reason}`;
    return Effect.all(
      [
        updateActiveDevice(device.path, (active) => ({
          ...active,
          connected: false,
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

  const applyConnectedDevice = Effect.fn("RuntimeCore.applyConnectedDevice")(function* (
    summary: VScopeDeviceSummary,
    runtimeState: DeviceRuntimeState,
  ) {
    const existing = yield* SubscriptionRef.get(activeDeviceRef);
    yield* SubscriptionRef.set(activeDeviceRef, activeDeviceFromSummary(summary));
    yield* SubscriptionRef.set(deviceStatusRef, runtimeState.status);
    yield* SubscriptionRef.set(deviceConfigRef, runtimeState.config);

    if (existing?.connected !== true) {
      yield* logApp(`Connected ${summary.deviceName} at ${summary.path}`);
    }
  });

  const applyDisconnectedDevice = Effect.fn("RuntimeCore.applyDisconnectedDevice")(
    function* (summary: { readonly path: string; readonly deviceName: string }) {
      const active = yield* SubscriptionRef.get(activeDeviceRef);
      if (!active || active.path !== summary.path || !active.connected) {
        return;
      }

      yield* SubscriptionRef.set(activeDeviceRef, {
        ...active,
        connected: false,
        error: null,
      });
      yield* clearLiveDeviceStores;
      yield* logApp(`Disconnected ${summary.deviceName} at ${summary.path}`);
    },
  );

  const applyLostDevice = Effect.fn("RuntimeCore.applyLostDevice")(function* (
    event: Extract<VScopeSerialEvent, { readonly _tag: "DeviceLost" }>,
  ) {
    const active = yield* SubscriptionRef.get(activeDeviceRef);
    if (!active || active.path !== event.device.path) {
      return;
    }

    const reason = errorReason(event.cause);
    yield* SubscriptionRef.set(activeDeviceRef, {
      ...active,
      connected: false,
      error: reason,
    });
    yield* clearLiveDeviceStores;
    yield* warnApp(`Lost ${event.device.deviceName} at ${event.device.path}: ${reason}`);
  });

  const applyConfigPatch = Effect.fn("RuntimeCore.applyConfigPatch")(function* (
    path: string,
    command: DeviceControlCommand["type"],
    patch: {
      readonly timing?: VScopeTiming | undefined;
      readonly trigger?: VScopeTrigger | undefined;
      readonly channelMap?: ReadonlyArray<number> | undefined;
      readonly rtValue?: readonly [number, number] | undefined;
    },
  ) {
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

  const handleActiveSerialEvent = Effect.fn("RuntimeCore.handleActiveSerialEvent")(function* (
    path: string,
    effect: Effect.Effect<void>,
  ) {
    const currentDevice = yield* Effect.option(serial.getDeviceByPath(path));
    if (Option.isSome(currentDevice)) {
      return;
    }
    const active = yield* SubscriptionRef.get(activeDeviceRef);
    if (active?.path === path) {
      yield* effect;
    }
  });

  const handleSerialEvent = (event: VScopeSerialEvent) => {
    switch (event._tag) {
      case "DeviceOpened":
        return Effect.void;
      case "DeviceRemoved":
        return handleActiveSerialEvent(
          event.device.path,
          interruptMonitor(event.device.path).pipe(
            Effect.andThen(closeSession(event.device.path, null)),
            Effect.andThen(applyDisconnectedDevice(event.device)),
          ),
        );
      case "DeviceLost":
        return handleActiveSerialEvent(
          event.device.path,
          interruptMonitor(event.device.path).pipe(
            Effect.andThen(
              closeSession(
                event.device.path,
                new RuntimeDeviceLost({ reason: errorReason(event.cause) }),
              ),
            ),
            Effect.andThen(applyLostDevice(event)),
          ),
        );
    }
  };

  yield* serial.events.pipe(
    Stream.runForEach((event) => dispatchLock.withPermit(handleSerialEvent(event))),
    Effect.forkScoped,
  );

  const connectDevice = Effect.fn("RuntimeCore.connectDevice")(function* (
    command: Extract<CoreCommand, { readonly type: "devices/connect" }>,
  ) {
    const app = yield* SubscriptionRef.get(appRef);
    const active = yield* SubscriptionRef.get(activeDeviceRef);
    if (active?.connected) {
      yield* interruptMonitor();
      yield* closeSession(active.path, null);
      yield* serial
        .removeDevice(active.path)
        .pipe(
          Effect.mapError(
            (cause) => new RuntimeCoreSerialError({ operation: "devices/disconnect", cause }),
          ),
        );
      yield* applyDisconnectedDevice(active);
    }

    yield* interruptMonitor();
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
    const settingsState = yield* persistence.patchSettings({ lastDevicePath: command.path }).pipe(
      Effect.mapError(
        (cause) => new RuntimeCorePersistenceError({ operation: "settings/patch", cause }),
      ),
      Effect.tapError(() => serial.removeDevice(device.path).pipe(Effect.ignore)),
    );

    yield* updateApp((app) => ({
      ...app,
      settings: settingsState.settings,
      settingsRecovery: settingsState.recovery,
    }));
    yield* applyConnectedDevice(summary, runtimeState);
    const session = yield* openSession(device.path, runtimeState.frame);
    const fiber = yield* monitorDevice(device, session, app.settings.polling).pipe(
      Effect.forkIn(parentScope),
    );
    yield* Ref.set(monitorRef, { path: device.path, fiber });
  });

  const disconnectDevice = Effect.fn("RuntimeCore.disconnectDevice")(function* () {
    const active = yield* SubscriptionRef.get(activeDeviceRef);
    if (!active || !active.connected) {
      return yield* new RuntimeCorePolicyError({
        command: "devices/disconnect",
        reason: "No connected device is available.",
      });
    }

    yield* interruptMonitor();
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
    const statusMonitor = device.getStatus({ retryAttempts: 0 }).pipe(
      Effect.flatMap((status) => publishStatus(device.path, status)),
      Effect.catch((cause) =>
        cause instanceof VScopeFrameParseError ? Effect.void : Effect.fail(cause),
      ),
      Effect.mapError(
        (cause) => new RuntimeCoreSerialError({ operation: "devices/status", cause }),
      ),
      Effect.schedule(Schedule.spaced(`${pollMillis(polling.stateHz)} millis`)),
    );

    const frameMonitor = device.getFrame({ retryAttempts: 0 }).pipe(
      Effect.flatMap((frame) =>
        Ref.set(session.lastFrame, frame).pipe(
          Effect.andThen(PubSub.publish(session.frames, frame)),
          Effect.asVoid,
        ),
      ),
      Effect.catch((cause) =>
        cause instanceof VScopeFrameParseError
          ? PubSub.publish(session.frames, null).pipe(Effect.asVoid)
          : Effect.fail(cause),
      ),
      Effect.mapError((cause) => new RuntimeCoreSerialError({ operation: "devices/frame", cause })),
      Effect.schedule(Schedule.spaced(`${pollMillis(polling.frameHz)} millis`)),
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
      const decision = decideDeviceControl(command, active, status);
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
          (device) => device.start,
          (path, status) => publishStatus(path, status),
        );
      case "devices/stop":
        return withDevice(
          command,
          (device) => device.stop,
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

  const captureSnapshot = Effect.fn("RuntimeCore.captureSnapshot")(function* (
    command: SnapshotCaptureCommand,
  ) {
    const active = yield* SubscriptionRef.get(activeDeviceRef);
    const status = yield* SubscriptionRef.get(deviceStatusRef);
    if (!active || !active.connected) {
      return yield* new RuntimeCorePolicyError({
        command: command.type,
        reason: "No connected device is available.",
      });
    }

    if (!canCaptureSnapshot(active, status)) {
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
        Effect.mapError((cause) => new RuntimeCoreSerialError({ operation: command.type, cause })),
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
      const app = yield* SubscriptionRef.get(appRef);
      yield* refreshSnapshots(app.settings.snapshots.retentionDays);
      yield* clearActiveDeviceError(active.path);
      yield* logApp(`Captured snapshot "${record.label}" from ${active.deviceName}`);
    }).pipe(Effect.tapError((error) => applyDeviceError(active.path, error)));
  });

  const dispatchUnlocked = (command: CoreCommand): Effect.Effect<void, RuntimeCoreError> => {
    switch (command.type) {
      case "activity/clear":
        return updateApp((app) => ({ ...app, activity: [] })).pipe(Effect.asVoid);
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
          yield* refreshSnapshots(stateResult.settings.snapshots.retentionDays);
        });
      case "devices/connect":
        return connectDevice(command);
      case "devices/disconnect":
        return disconnectDevice();
      case "snapshots/capture":
        return captureSnapshot(command);
      case "snapshots/delete":
        return persistence.deleteSnapshot(command.id).pipe(
          Effect.mapError(
            (cause) => new RuntimeCorePersistenceError({ operation: command.type, cause }),
          ),
          Effect.andThen(
            SubscriptionRef.get(appRef).pipe(
              Effect.flatMap((app) => refreshSnapshots(app.settings.snapshots.retentionDays)),
            ),
          ),
        );
      case "snapshots/favorite":
        return persistence.setSnapshotFavorite(command.id, command.favorite).pipe(
          Effect.mapError(
            (cause) => new RuntimeCorePersistenceError({ operation: command.type, cause }),
          ),
          Effect.andThen(
            SubscriptionRef.get(appRef).pipe(
              Effect.flatMap((app) => refreshSnapshots(app.settings.snapshots.retentionDays)),
            ),
          ),
        );
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
    dispatchLock.withPermit(
      dispatchUnlocked(command).pipe(
        Effect.tapError((error) =>
          command.type === "activity/clear"
            ? Effect.void
            : errorApp(describeRuntimeCoreError(error)),
        ),
      ),
    );

  const listPorts = serial.listPorts.pipe(
    Effect.mapError((cause) => new RuntimeCoreSerialError({ operation: "ports/list", cause })),
    Effect.tapError((error) => errorApp(describeRuntimeCoreError(error))),
  );

  const listSnapshots = SubscriptionRef.get(snapshotsRef);

  const readSnapshotSamples = (
    id: PersistentId,
  ): Effect.Effect<SnapshotSampleBlob | null, RuntimeCoreError> =>
    persistence.readSnapshotSamples(id).pipe(
      Effect.map(Option.getOrNull),
      Effect.mapError(
        (cause) => new RuntimeCorePersistenceError({ operation: "snapshots/readSamples", cause }),
      ),
    );

  const shutdown = interruptMonitor().pipe(
    Effect.andThen(closeCurrentSession(null)),
    Effect.andThen(
      serial.closeAll.pipe(
        Effect.mapError((cause) => new RuntimeCoreSerialError({ operation: "shutdown", cause })),
      ),
    ),
    Effect.andThen(
      Effect.gen(function* () {
        const active = yield* SubscriptionRef.get(activeDeviceRef);
        if (active?.connected) {
          yield* SubscriptionRef.set(activeDeviceRef, {
            ...active,
            connected: false,
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
    readModel,
    dispatch,
    listPorts,
    listSnapshots,
    readSnapshotSamples,
    shutdown,
    frames,
    lastFrame,
  };
});

export const RuntimeCoreLive = Layer.effect(RuntimeCore, makeRuntimeCore());

const hydrateInitialStores = Effect.fn("RuntimeCore.hydrateInitialStores")(function* (
  persistence: PersistenceService,
) {
  const bootedAt = timestamp();
  const settingsState = yield* persistence.readSettings.pipe(
    Effect.mapError(
      (cause) => new RuntimeCorePersistenceError({ operation: "settings/read", cause }),
    ),
  );
  yield* pruneExpiredSnapshots(persistence, settingsState.settings.snapshots.retentionDays);
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
      activity: [],
      logs: [],
    }),
    snapshots,
  };
});

const pruneExpiredSnapshots = Effect.fn("RuntimeCore.pruneExpiredSnapshots")(function* (
  persistence: PersistenceService,
  retentionDays: RuntimeAppState["settings"]["snapshots"]["retentionDays"],
) {
  if (retentionDays === "never") {
    return;
  }

  const now = yield* Clock.currentTimeMillis;
  const cutoff = Schema.decodeUnknownSync(Timestamp)(
    new Date(now - retentionDays * 24 * 60 * 60 * 1000).toISOString(),
  );
  yield* persistence
    .pruneSnapshotsBefore(cutoff)
    .pipe(
      Effect.mapError(
        (cause) => new RuntimeCorePersistenceError({ operation: "snapshots/prune", cause }),
      ),
    );
});

function finalizeApp(app: RuntimeAppState): RuntimeAppState {
  return {
    ...app,
    updatedAt: timestamp(),
    status: app.activity.length > 0 ? "degraded" : "ready",
  };
}

function activeDeviceFromSummary(summary: VScopeDeviceSummary): ActiveDeviceState {
  return {
    path: summary.path,
    deviceName: summary.deviceName,
    connected: true,
    info: summary.metadata.info,
    variables: summary.metadata.variables,
    rtLabels: summary.metadata.rtLabels,
    error: null,
  };
}

function statusEquals(a: VScopeControlStatus, b: VScopeControlStatus): boolean {
  return a.state === b.state && a.snapshotValid === b.snapshotValid;
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

const readDeviceRuntimeState = Effect.fn("RuntimeCore.readDeviceRuntimeState")(function* (
  device: VScopeDevice,
  metadata: VScopeStaticMetadata,
) {
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
    frame,
  };
});

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
    sampleRateHz: header.sampleRateHz,
    totalDurationSeconds: header.totalDurationSeconds,
    preTriggerSeconds: header.preTriggerSeconds,
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

function appendActivity(
  activity: ReadonlyArray<RuntimeActivityEntry>,
  level: RuntimeActivityLevel,
  message: string,
  now: string,
  sequence: number,
) {
  return [
    {
      id: `${now}:activity:${sequence}`,
      level,
      message,
      createdAt: now,
    },
    ...activity,
  ].slice(0, MAX_ACTIVITY_ENTRIES);
}

function appendLog(logs: ReadonlyArray<RuntimeLogEntry>, message: string, now: string) {
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
