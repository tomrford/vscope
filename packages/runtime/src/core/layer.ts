import {
  Effect,
  Fiber,
  Layer,
  Option,
  Ref,
  Schedule,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";
import {
  SNAPSHOT_SAMPLE_FORMAT,
  SerialConfig,
  SnapshotDraft,
  SnapshotRecord,
  SnapshotSamplesWrite,
  SnapshotTrigger,
} from "@vscope/shared";
import { Persistence, type PersistenceService } from "@vscope/persistence";
import { VScopeSerial, VScopeState } from "@vscope/serial";
import type {
  VScopeControlStatus,
  VScopeDevice,
  VScopeDeviceError,
  VScopeDeviceSummary,
  VScopeSerialEvent,
  VScopeSnapshotHeader,
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
  CoreCommand,
  CoreDevice,
  CoreQuery,
  CoreQueryResult,
  CoreState,
  DeviceControlCommand,
  DeviceIntent,
  DeviceIntentKind,
  SnapshotCaptureCommand,
  SnapshotAvailability,
} from "./model";
import { decideDeviceControl, permissionsForDevice } from "./policy";
import { RuntimeCore } from "./service";

const MAX_LOG_ENTRIES = 100;
const MAX_WARNINGS = 32;
const SETTLE_POLL_INTERVAL_MILLIS = 10;
const SETTLE_TIMEOUT_MILLIS = 2000;

interface DeviceRuntimeState {
  readonly status: VScopeControlStatus;
  readonly timing?: VScopeTiming | undefined;
  readonly trigger?: VScopeTrigger | undefined;
  readonly channelMap?: ReadonlyArray<number> | undefined;
  readonly frame?: ReadonlyArray<number> | undefined;
  readonly rtValues?: ReadonlyMap<number, number> | undefined;
}

type DeviceMonitorFiber = Fiber.Fiber<void, never>;

const makeRuntimeCore = Effect.gen(function* () {
  const persistence = yield* Persistence;
  const serial = yield* VScopeSerial;
  const initial = yield* hydrateInitialSnapshot(persistence);
  const state = yield* SubscriptionRef.make(initial);
  const parentScope = yield* Scope.Scope;
  const monitorFiber = yield* Ref.make<DeviceMonitorFiber | null>(null);
  const dispatchLock = yield* Semaphore.make(1);

  const applyState = (update: (snapshot: CoreState) => CoreState) =>
    SubscriptionRef.updateAndGet(state, (snapshot) => finalizeState(update(snapshot)));

  const interruptMonitor = Effect.gen(function* () {
    const fiber = yield* Ref.getAndSet(monitorFiber, null);
    if (fiber) {
      yield* Fiber.interrupt(fiber).pipe(Effect.asVoid);
    }
  });

  const applyConnectedDevice = (summary: VScopeDeviceSummary, runtimeState: DeviceRuntimeState) =>
    applyState((snapshot) => {
      const now = timestamp();
      const existing = snapshot.device;
      const device = buildConnectedDevice({
        summary,
        runtimeState,
        existing,
        now,
      });

      return {
        ...snapshot,
        device,
        logs:
          existing?.connectionStatus === "connected"
            ? snapshot.logs
            : appendLog(snapshot.logs, `Connected ${summary.deviceName} at ${summary.path}`, now),
      };
    });

  const applyDisconnectedDevice = (summary: VScopeDeviceSummary) =>
    applyState((snapshot) => {
      const now = timestamp();
      if (!snapshot.device || snapshot.device.path !== summary.path) {
        return snapshot;
      }

      if (snapshot.device.connectionStatus === "lost") {
        return snapshot;
      }

      return {
        ...snapshot,
        device: {
          ...snapshot.device,
          connectionStatus: "disconnected",
          requestPending: false,
          intent: null,
          lastSeenAt: now,
          error: null,
        },
        logs: appendLog(
          snapshot.logs,
          `Disconnected ${summary.deviceName} at ${summary.path}`,
          now,
        ),
      };
    });

  const applyLostDevice = (event: Extract<VScopeSerialEvent, { readonly _tag: "DeviceLost" }>) =>
    applyState((snapshot) => {
      const now = timestamp();
      const message = `Lost ${event.device.deviceName} at ${event.device.path}: ${describeCause(
        event.cause,
      )}`;
      if (!snapshot.device || snapshot.device.path !== event.device.path) {
        return snapshot;
      }

      return {
        ...snapshot,
        device: {
          ...snapshot.device,
          connectionStatus: "lost",
          requestPending: false,
          intent: settleIntent(snapshot.device.intent, "failed", now, describeCause(event.cause)),
          lastSeenAt: now,
          error: describeCause(event.cause),
        },
        warnings: appendWarning(snapshot.warnings, message, now),
        logs: appendLog(snapshot.logs, message, now),
      };
    });

  const applyStatus = (
    path: string,
    status: VScopeControlStatus,
    intentStatus?: "settled" | undefined,
  ) =>
    applyState((snapshot) => {
      if (!snapshot.device || snapshot.device.path !== path) {
        return snapshot;
      }

      const now = timestamp();
      const intent =
        intentStatus === "settled" || shouldSettleIntentFromStatus(snapshot.device.intent, status)
          ? settleIntent(snapshot.device.intent, "settled", now, null)
          : snapshot.device.intent;

      return {
        ...snapshot,
        device: applyStatusToDevice(snapshot.device, status, now, intent),
      };
    });

  const applyFrame = (path: string, frame: Float32Array) =>
    applyState((snapshot) => {
      if (!snapshot.device || snapshot.device.path !== path) {
        return snapshot;
      }

      const now = timestamp();
      return {
        ...snapshot,
        device: {
          ...snapshot.device,
          frame: Array.from(frame),
          lastFrameAt: now,
          lastSeenAt: now,
          error: null,
        },
      };
    });

  const applySnapshotCaptureSuccess = (
    path: string,
    snapshots: ReadonlyArray<SnapshotRecord>,
    logMessage: string,
  ) =>
    applyState((snapshot) => {
      const now = timestamp();
      const device =
        snapshot.device && snapshot.device.path === path
          ? {
              ...snapshot.device,
              intent: settleIntent(snapshot.device.intent, "settled", now, null),
              lastSeenAt: now,
              error: null,
            }
          : snapshot.device;
      return {
        ...snapshot,
        device,
        snapshots,
        logs: appendLog(snapshot.logs, logMessage, now),
      };
    });

  const applyIntent = (kind: DeviceIntentKind) =>
    applyState((snapshot) => {
      if (!snapshot.device) {
        return snapshot;
      }

      const now = timestamp();
      return {
        ...snapshot,
        device: {
          ...snapshot.device,
          intent: {
            kind,
            status: "pending",
            sentAt: now,
            settledAt: null,
            error: null,
          },
          lastSeenAt: now,
        },
      };
    });

  const applyIntentFailure = (kind: DeviceIntentKind, error: RuntimeCoreError) =>
    applyState((snapshot) => {
      if (!snapshot.device) {
        return snapshot;
      }

      const now = timestamp();
      return {
        ...snapshot,
        device: {
          ...snapshot.device,
          intent: {
            kind,
            status: "failed",
            sentAt: snapshot.device.intent?.sentAt ?? now,
            settledAt: now,
            error: describeCause(error),
          },
          lastSeenAt: now,
          error: describeCause(error),
        },
      };
    });

  const applyDevicePatch = (
    path: string,
    patch: {
      readonly status: VScopeControlStatus;
      readonly timing?: VScopeTiming | undefined;
      readonly trigger?: VScopeTrigger | undefined;
      readonly channelMap?: ReadonlyArray<number> | undefined;
      readonly rtValue?: readonly [number, number] | undefined;
      readonly intentSettled?: boolean | undefined;
    },
  ) =>
    applyState((snapshot) => {
      if (!snapshot.device || snapshot.device.path !== path) {
        return snapshot;
      }

      const now = timestamp();
      const currentRtValues = new Map(snapshot.device.rtValues);
      if (patch.rtValue) {
        currentRtValues.set(patch.rtValue[0], patch.rtValue[1]);
      }

      const intent = patch.intentSettled
        ? settleIntent(snapshot.device.intent, "settled", now, null)
        : snapshot.device.intent;

      return {
        ...snapshot,
        device: applyStatusToDevice(
          {
            ...snapshot.device,
            timing: patch.timing ?? snapshot.device.timing,
            trigger: patch.trigger ?? snapshot.device.trigger,
            channelMap: patch.channelMap ?? snapshot.device.channelMap,
            rtValues: currentRtValues,
          },
          patch.status,
          now,
          intent,
        ),
      };
    });

  const handleSerialEvent = (event: VScopeSerialEvent) => {
    switch (event._tag) {
      case "DeviceOpened":
        return Effect.void;
      case "DeviceRemoved":
        return interruptMonitor.pipe(Effect.andThen(applyDisconnectedDevice(event.device)));
      case "DeviceLost":
        return interruptMonitor.pipe(Effect.andThen(applyLostDevice(event)));
    }
  };

  yield* serial.events.pipe(Stream.runForEach(handleSerialEvent), Effect.forkScoped);

  const connectDevice = (command: Extract<CoreCommand, { readonly type: "devices/connect" }>) =>
    Effect.gen(function* () {
      const snapshot = yield* SubscriptionRef.get(state);
      if (snapshot.device?.connectionStatus === "connected") {
        return yield* new RuntimeCorePolicyError({
          command: command.type,
          reason: "Disconnect the current device before connecting another one.",
        });
      }

      yield* interruptMonitor;
      const config = command.serialConfig ?? snapshot.settings.defaultSerialConfig;
      const device = yield* serial
        .openDevice(openOptions(command.path, config))
        .pipe(
          Effect.mapError(
            (cause) => new RuntimeCoreSerialError({ operation: "devices/connect", cause }),
          ),
        );
      const { summary, runtimeState } = yield* Effect.gen(function* () {
        const summary = yield* summarizeDevice(device);
        const runtimeState = yield* readDeviceRuntimeState(device);
        return { summary, runtimeState };
      }).pipe(
        Effect.mapError(
          (cause) => new RuntimeCoreSerialError({ operation: "devices/connect", cause }),
        ),
        Effect.tapError(() => serial.removeDevice(device.path).pipe(Effect.ignore)),
      );
      const next = yield* applyConnectedDevice(summary, runtimeState);
      const fiber = yield* monitorDevice(device, next.settings.polling).pipe(
        Effect.forkIn(parentScope),
      );
      yield* Ref.set(monitorFiber, fiber);
      return next;
    });

  const disconnectDevice = () =>
    Effect.gen(function* () {
      const snapshot = yield* SubscriptionRef.get(state);
      const device = snapshot.device;
      if (!device || device.connectionStatus !== "connected") {
        return yield* new RuntimeCorePolicyError({
          command: "devices/disconnect",
          reason: "No connected device is available.",
        });
      }

      yield* interruptMonitor;
      yield* serial
        .removeDevice(device.path)
        .pipe(
          Effect.mapError(
            (cause) => new RuntimeCoreSerialError({ operation: "devices/disconnect", cause }),
          ),
        );

      if (!device.metadata) {
        return yield* SubscriptionRef.get(state);
      }

      return yield* applyDisconnectedDevice({
        path: device.path,
        deviceName: device.deviceName,
        metadata: device.metadata,
      });
    });

  const monitorDevice = (
    device: VScopeDevice,
    polling: CoreState["settings"]["polling"],
  ): Effect.Effect<void> => {
    const statusMonitor = Stream.fromSchedule(
      Schedule.spaced(`${pollMillis(polling.stateHz)} millis`),
    ).pipe(
      Stream.runForEach(() =>
        device.getStatus.pipe(
          Effect.flatMap((status) => applyStatus(device.path, status)),
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
        device.getFrame.pipe(
          Effect.flatMap((frame) => applyFrame(device.path, frame)),
          Effect.catch(() => Effect.void),
        ),
      ),
    );

    return Effect.all([statusMonitor, frameMonitor], {
      concurrency: "unbounded",
      discard: true,
    }).pipe(
      Effect.catch((error) =>
        applyState((snapshot) => {
          if (!snapshot.device || snapshot.device.path !== device.path) {
            return snapshot;
          }

          const now = timestamp();
          const message = `Lost ${device.deviceName} at ${device.path}: ${describeCause(error)}`;
          return {
            ...snapshot,
            device: {
              ...snapshot.device,
              connectionStatus: "lost",
              requestPending: false,
              intent: settleIntent(snapshot.device.intent, "failed", now, describeCause(error)),
              lastSeenAt: now,
              error: describeCause(error),
            },
            warnings: appendWarning(snapshot.warnings, message, now),
            logs: appendLog(snapshot.logs, message, now),
          };
        }).pipe(
          Effect.asVoid,
          Effect.andThen(serial.removeDevice(device.path).pipe(Effect.ignore)),
        ),
      ),
    );
  };

  const withDevice = <A>(
    command: DeviceControlCommand,
    intentKind: DeviceIntentKind,
    operation: (device: VScopeDevice) => Effect.Effect<A, VScopeDeviceError>,
    applyResult: (path: string, result: A) => Effect.Effect<CoreState>,
  ) =>
    Effect.gen(function* () {
      const snapshot = yield* SubscriptionRef.get(state);
      const decision = decideDeviceControl(command, snapshot.device, snapshot.permissions);
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
      yield* applyIntent(intentKind);
      const result = yield* operation(device).pipe(
        Effect.mapError((cause) => new RuntimeCoreSerialError({ operation: command.type, cause })),
        Effect.tapError((error) => applyIntentFailure(intentKind, error)),
      );
      return yield* applyResult(device.path, result);
    });

  const controlDevice = (command: DeviceControlCommand) => {
    switch (command.type) {
      case "devices/run":
        return withDevice(
          command,
          "run",
          (device) =>
            device.start({
              timeoutMillis: SETTLE_TIMEOUT_MILLIS,
              pollIntervalMillis: SETTLE_POLL_INTERVAL_MILLIS,
            }),
          (path, status) => applyStatus(path, status, "settled"),
        );
      case "devices/stop":
        return withDevice(
          command,
          "stop",
          (device) =>
            device.stop({
              timeoutMillis: SETTLE_TIMEOUT_MILLIS,
              pollIntervalMillis: SETTLE_POLL_INTERVAL_MILLIS,
            }),
          (path, status) => applyStatus(path, status, "settled"),
        );
      case "devices/trigger":
        return withDevice(
          command,
          "trigger",
          (device) => device.trigger,
          (path, status) => applyStatus(path, status),
        );
      case "devices/setTiming":
        return withDevice(
          command,
          "setTiming",
          (device) =>
            Effect.gen(function* () {
              const timing = yield* device.setTiming(command.timing);
              const status = yield* device.getStatus;
              return { timing, status };
            }),
          (path, result) =>
            applyDevicePatch(path, {
              status: result.status,
              timing: result.timing,
              intentSettled: true,
            }),
        );
      case "devices/setTrigger":
        return withDevice(
          command,
          "setTrigger",
          (device) =>
            Effect.gen(function* () {
              const trigger = yield* device.setTrigger(command.trigger);
              const status = yield* device.getStatus;
              return { trigger, status };
            }),
          (path, result) =>
            applyDevicePatch(path, {
              status: result.status,
              trigger: result.trigger,
              intentSettled: true,
            }),
        );
      case "devices/setRtValue":
        return withDevice(
          command,
          "setRtValue",
          (device) =>
            Effect.gen(function* () {
              const value = yield* device.setRtValue(command.index, command.value);
              const status = yield* device.getStatus;
              return { value, status };
            }),
          (path, result) =>
            applyDevicePatch(path, {
              status: result.status,
              rtValue: [command.index, result.value],
              intentSettled: true,
            }),
        );
      case "devices/setChannelMap":
        return withDevice(
          command,
          "setChannelMap",
          (device) =>
            Effect.gen(function* () {
              const channelMap = yield* device.setChannelMap(command.channel, command.variable);
              const status = yield* device.getStatus;
              return { channelMap, status };
            }),
          (path, result) =>
            applyDevicePatch(path, {
              status: result.status,
              channelMap: result.channelMap,
              intentSettled: true,
            }),
        );
    }
  };

  const captureSnapshot = (command: SnapshotCaptureCommand) =>
    Effect.gen(function* () {
      const snapshot = yield* SubscriptionRef.get(state);
      const currentDevice = snapshot.device;
      if (!currentDevice || currentDevice.connectionStatus !== "connected") {
        return yield* new RuntimeCorePolicyError({
          command: command.type,
          reason: "No connected device is available.",
        });
      }

      if (!snapshot.permissions.captureSnapshot) {
        return yield* new RuntimeCorePolicyError({
          command: command.type,
          reason:
            "Snapshot capture is available only when the connected device has a ready snapshot.",
        });
      }

      yield* applyIntent("captureSnapshot");

      return yield* Effect.gen(function* () {
        const device = yield* serial
          .getDeviceByPath(currentDevice.path)
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
        const label = normalizedSnapshotLabel(command.label, currentDevice.deviceName, capturedAt);
        const record = yield* persistence
          .createSnapshot(
            snapshotDraftFromCapture({
              device: currentDevice,
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

        return yield* applySnapshotCaptureSuccess(
          currentDevice.path,
          snapshots,
          `Captured snapshot "${record.label}" from ${currentDevice.deviceName}`,
        );
      }).pipe(Effect.tapError((error) => applyIntentFailure("captureSnapshot", error)));
    });

  const dispatchUnlocked = (command: CoreCommand): Effect.Effect<CoreState, RuntimeCoreError> => {
    switch (command.type) {
      case "warnings/clear":
        return applyState((snapshot) => ({
          ...snapshot,
          warnings: [],
        }));
      case "settings/patch":
        return Effect.gen(function* () {
          const stateResult = yield* persistence
            .patchSettings(command.patch)
            .pipe(
              Effect.mapError(
                (cause) => new RuntimeCorePersistenceError({ operation: "settings/patch", cause }),
              ),
            );
          return yield* applyState((snapshot) => ({
            ...snapshot,
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
          return yield* applyState((snapshot) => ({
            ...snapshot,
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

  const dispatch = (command: CoreCommand) => dispatchLock.withPermit(dispatchUnlocked(command));

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
        return SubscriptionRef.get(state).pipe(
          Effect.map((snapshot) => ({
            type: "snapshots/list",
            snapshots: snapshot.snapshots,
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
    Effect.andThen(
      serial.closeAll.pipe(
        Effect.mapError((cause) => new RuntimeCoreSerialError({ operation: "shutdown", cause })),
      ),
    ),
    Effect.flatMap(() =>
      applyState((snapshot) => {
        const now = timestamp();
        return {
          ...snapshot,
          device:
            snapshot.device?.connectionStatus === "connected"
              ? {
                  ...snapshot.device,
                  connectionStatus: "disconnected",
                  requestPending: false,
                  intent: null,
                  lastSeenAt: now,
                }
              : snapshot.device,
          logs: appendLog(snapshot.logs, "Runtime core shutdown closed the serial device", now),
        };
      }),
    ),
    Effect.asVoid,
  );

  return {
    changes: SubscriptionRef.changes(state),
    getSnapshot: SubscriptionRef.get(state),
    dispatch,
    query,
    shutdown,
  };
});

export const RuntimeCoreLive = Layer.effect(RuntimeCore, makeRuntimeCore);

function hydrateInitialSnapshot(
  persistence: PersistenceService,
): Effect.Effect<CoreState, RuntimeCorePersistenceError> {
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

    return finalizeState({
      bootedAt,
      updatedAt: bootedAt,
      status: "ready",
      settings: settingsState.settings,
      settingsRecovery: settingsState.recovery,
      preferences: preferencesState.preferences,
      preferencesRecovery: preferencesState.recovery,
      savedDevices,
      snapshots,
      device: null,
      permissions: permissionsForDevice(null),
      warnings: [],
      logs: [],
    });
  });
}

function finalizeState(snapshot: CoreState): CoreState {
  return {
    ...snapshot,
    updatedAt: timestamp(),
    status: snapshot.warnings.length > 0 ? "degraded" : "ready",
    permissions: permissionsForDevice(snapshot.device),
  };
}

function buildConnectedDevice(options: {
  readonly summary: VScopeDeviceSummary;
  readonly runtimeState: DeviceRuntimeState;
  readonly existing: CoreDevice | null;
  readonly now: string;
}): CoreDevice {
  const { summary, runtimeState, existing, now } = options;
  const base: CoreDevice = {
    path: summary.path,
    deviceName: summary.deviceName,
    connectionStatus: "connected",
    info: summary.metadata.info,
    metadata: summary.metadata,
    status: runtimeState.status,
    state: runtimeState.status.state,
    requestedState: runtimeState.status.requestedState,
    requestPending: runtimeState.status.requestPending,
    snapshotAvailability: snapshotAvailability(runtimeState.status),
    intent: null,
    timing: runtimeState.timing ?? null,
    trigger: runtimeState.trigger ?? null,
    channelMap: runtimeState.channelMap ?? summary.metadata.channelMap,
    frame: runtimeState.frame ?? null,
    rtValues: runtimeState.rtValues ?? new Map(),
    lastFrameAt: runtimeState.frame ? now : null,
    lastSeenAt: now,
    error: null,
  };

  if (!existing) {
    return base;
  }

  return {
    ...base,
    lastFrameAt: base.lastFrameAt ?? existing.lastFrameAt,
  };
}

function applyStatusToDevice(
  device: CoreDevice,
  status: VScopeControlStatus,
  now: string,
  intent: DeviceIntent | null,
): CoreDevice {
  return {
    ...device,
    status,
    state: status.state,
    requestedState: status.requestedState,
    requestPending: status.requestPending,
    snapshotAvailability: snapshotAvailability(status),
    intent,
    lastSeenAt: now,
    error: null,
  };
}

function settleIntent(
  intent: DeviceIntent | null,
  status: "settled" | "failed",
  now: string,
  error: string | null,
): DeviceIntent | null {
  if (!intent || intent.status !== "pending") {
    return intent;
  }

  return {
    ...intent,
    status,
    settledAt: now,
    error,
  };
}

function shouldSettleIntentFromStatus(
  intent: DeviceIntent | null,
  status: VScopeControlStatus,
): boolean {
  return (
    !status.requestPending && intent?.status === "pending" && intent.kind !== "captureSnapshot"
  );
}

function snapshotAvailability(status: VScopeControlStatus): SnapshotAvailability {
  if (status.snapshotValid) {
    return "ready";
  }

  if (status.state === VScopeState.Running || status.state === VScopeState.Acquiring) {
    return "not-ready";
  }

  return "unknown";
}

function openOptions(path: string, config: SerialConfig) {
  return {
    path,
    baudRate: config.baudRate,
    dataBits: config.dataBits,
    stopBits: config.stopBits,
    parity: config.parity,
  };
}

function summarizeDevice(device: VScopeDevice) {
  return device.metadata.pipe(
    Effect.map((metadata) => ({
      path: device.path,
      deviceName: device.deviceName,
      metadata,
    })),
  );
}

function readDeviceRuntimeState(
  device: VScopeDevice,
): Effect.Effect<DeviceRuntimeState, VScopeDeviceError> {
  return Effect.gen(function* () {
    const metadata = yield* device.metadata;
    const status = yield* device.getStatus;
    if (status.state === VScopeState.Misconfigured) {
      return {
        status,
      };
    }

    const timing = yield* device.getTiming;
    const trigger = yield* device.getTrigger;
    const channelMap = yield* device.getChannelMap;
    const frame = yield* device.getFrame;
    const rtValues = new Map<number, number>();

    for (let index = 0; index < metadata.rtLabels.length; index += 1) {
      const value = yield* device.getRtValue(index);
      rtValues.set(index, value);
    }

    return {
      status,
      timing,
      trigger,
      channelMap,
      frame: Array.from(frame),
      rtValues,
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
  readonly device: CoreDevice;
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
      variables: device.metadata?.variables ?? [],
      rtLabels: device.metadata?.rtLabels ?? [],
    },
  });
}

function sampleRateHz(info: CoreDevice["info"], divider: number): number | null {
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
