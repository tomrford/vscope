import { describe, expect, test } from "bun:test";
import { Persistence, type PersistenceService } from "@vscope/persistence";
import {
  DEFAULT_PREFERENCES,
  DEFAULT_SETTINGS,
  PersistentId,
  PollingSettings,
  Preferences,
  PreferencesState,
  SNAPSHOT_SAMPLE_FORMAT,
  Settings,
  SettingsState,
  SnapshotRecord,
  SnapshotSampleBlob,
  SnapshotSampleDescriptor,
  Timestamp,
  noRecovery,
  type SnapshotListQuery,
} from "@vscope/shared";
import { Effect, Fiber, Layer, Option, PubSub, Schema, Stream } from "effect";
import type * as Scope from "effect/Scope";
import {
  VScopeDeviceAlreadyOpenError,
  VScopeDeviceNotFoundError,
  VScopeEndianness,
  VScopeInvalidArgumentError,
  VScopeSerial,
  VScopeState,
  type SerialPortInfo,
  type VScopeControlStatus,
  type VScopeDevice,
  type VScopeDeviceInfo,
  type VScopeSerialEvent,
  type VScopeSerialService,
  type VScopeState as VScopeStateValue,
  type VScopeStaticMetadata,
  type VScopeTiming,
  type VScopeTrigger,
} from "@vscope/serial";

import { RuntimeCore, RuntimeCoreLive } from ".";

describe("@vscope/runtime core", () => {
  test("hydrates persistent state and lists ports through the serial service", async () => {
    const result = await runWithCore(
      Effect.gen(function* () {
        const core = yield* RuntimeCore;
        const snapshot = yield* core.getSnapshot;
        const ports = yield* core.query({ type: "ports/list" });
        return { snapshot, ports };
      }),
    );

    expect(result.snapshot.settings).toEqual(testSettings);
    expect(result.snapshot.preferences).toEqual(DEFAULT_PREFERENCES);
    expect(result.snapshot.permissions.mode).toBe("empty");
    expect(result.ports).toEqual({
      type: "ports/list",
      ports: [fakePort],
    });
  });

  test("keeps runtime/core to one active device", async () => {
    const result = await runWithCore(
      Effect.gen(function* () {
        const core = yield* RuntimeCore;
        const connected = yield* core.dispatch({
          type: "devices/connect",
          path: fakePort.path,
        });
        const duplicate = yield* Effect.exit(
          core.dispatch({
            type: "devices/connect",
            path: "/dev/tty.second",
          }),
        );
        return { connected, duplicate };
      }),
      fakeSerialLayer([fakePort, secondPort]),
    );

    expect(result.connected.device?.path).toBe(fakePort.path);
    expect(result.connected.permissions.mode).toBe("halted");
    expect(result.duplicate._tag).toBe("Failure");
  });

  test("observes the run-trigger-capture lifecycle through status polling", async () => {
    const result = await runWithCore(
      Effect.gen(function* () {
        const core = yield* RuntimeCore;
        yield* core.dispatch({
          type: "devices/connect",
          path: fakePort.path,
        });
        const running = yield* core.dispatch({ type: "devices/run" });
        const triggered = yield* core.dispatch({ type: "devices/trigger" });
        yield* Effect.sleep("80 millis");
        const captured = yield* core.getSnapshot;
        return { running, triggered, captured };
      }),
    );

    expect(result.running.device?.state).toBe(VScopeState.Running);
    expect(result.running.device?.snapshotAvailability).toBe("not-ready");
    expect(result.triggered.device?.requestedState).toBe(VScopeState.Acquiring);
    expect(result.triggered.device?.intent?.status).toBe("pending");
    expect(result.captured.device?.state).toBe(VScopeState.Halted);
    expect(result.captured.device?.snapshotAvailability).toBe("ready");
    expect(result.captured.device?.intent?.status).toBe("settled");
  });

  test("refreshes live frames without polling RT values", async () => {
    const snapshot = await runWithCore(
      Effect.gen(function* () {
        const core = yield* RuntimeCore;
        const connected = yield* core.dispatch({
          type: "devices/connect",
          path: fakePort.path,
        });
        yield* Effect.sleep("80 millis");
        const refreshed = yield* core.getSnapshot;
        return { connected, refreshed };
      }),
    );

    expect(snapshot.connected.device?.frame?.[0]).toBe(1);
    expect(snapshot.refreshed.device?.frame?.[0]).toBeGreaterThan(1);
    expect(snapshot.refreshed.device?.rtValues.get(0)).toBe(1);
  });

  test("keeps the device connected when frame polling fails", async () => {
    const snapshot = await runWithCore(
      Effect.gen(function* () {
        const core = yield* RuntimeCore;
        const connected = yield* core.dispatch({
          type: "devices/connect",
          path: fakePort.path,
        });
        yield* Effect.sleep("80 millis");
        const refreshed = yield* core.getSnapshot;
        return { connected, refreshed };
      }),
      fakeSerialLayer([fakePort], { device: { failFramesAfter: 1 } }),
    );

    expect(snapshot.connected.device?.frame?.[0]).toBe(1);
    expect(snapshot.refreshed.device?.connectionStatus).toBe("connected");
    expect(snapshot.refreshed.device?.frame?.[0]).toBe(1);
    expect(snapshot.refreshed.warnings).toEqual([]);
  });

  test("captures ready snapshots into persistence and reads samples lazily", async () => {
    const result = await runWithCore(
      Effect.gen(function* () {
        const core = yield* RuntimeCore;
        yield* core.dispatch({
          type: "devices/connect",
          path: fakePort.path,
        });
        yield* core.dispatch({ type: "devices/run" });
        yield* core.dispatch({ type: "devices/trigger" });
        yield* Effect.sleep("80 millis");
        const captured = yield* core.dispatch({
          type: "snapshots/capture",
          label: "Boot trace",
        });
        const listed = yield* core.query({ type: "snapshots/list" });
        if (listed.type !== "snapshots/list") {
          throw new Error("Expected snapshots/list result");
        }
        const samples = yield* core.query({
          type: "snapshots/readSamples",
          id: listed.snapshots[0].id,
        });
        return { captured, listed, samples };
      }),
    );

    expect(result.captured.snapshots.length).toBe(1);
    expect(result.captured.device?.intent?.kind).toBe("captureSnapshot");
    expect(result.captured.device?.intent?.status).toBe("settled");
    expect(result.listed.snapshots[0].label).toBe("Boot trace");
    expect(result.listed.snapshots[0].device).toMatchObject({
      name: fakeInfo.deviceName,
    });
    expect(result.listed.snapshots[0].sample.stored).toBe(true);
    if (result.samples.type !== "snapshots/readSamples") {
      throw new Error("Expected snapshots/readSamples result");
    }
    expect(result.samples.samples?.data.byteLength).toBe(
      fakeInfo.channelCount * fakeInfo.bufferSize * Float32Array.BYTES_PER_ELEMENT,
    );
  });

  test("keeps snapshot capture intent pending until download completes", async () => {
    const result = await runWithCore(
      Effect.gen(function* () {
        const core = yield* RuntimeCore;
        yield* core.dispatch({
          type: "devices/connect",
          path: fakePort.path,
        });
        yield* core.dispatch({ type: "devices/run" });
        yield* core.dispatch({ type: "devices/trigger" });
        yield* Effect.sleep("80 millis");
        const capture = yield* core
          .dispatch({
            type: "snapshots/capture",
            label: "Slow trace",
          })
          .pipe(Effect.forkScoped);
        yield* Effect.sleep("50 millis");
        const during = yield* core.getSnapshot;
        const captured = yield* Fiber.join(capture);
        return { during, captured };
      }),
      fakeSerialLayer([fakePort], { device: { collectSnapshotDelayMillis: 150 } }),
    );

    expect(result.during.device?.intent?.kind).toBe("captureSnapshot");
    expect(result.during.device?.intent?.status).toBe("pending");
    expect(result.during.permissions.captureSnapshot).toBe(false);
    expect(result.captured.device?.intent?.kind).toBe("captureSnapshot");
    expect(result.captured.device?.intent?.status).toBe("settled");
  });

  test("persists settings patches through the core dispatch boundary", async () => {
    const snapshot = await runWithCore(
      Effect.gen(function* () {
        const core = yield* RuntimeCore;
        return yield* core.dispatch({
          type: "settings/patch",
          patch: { theme: "dark" },
        });
      }),
    );

    expect(snapshot.settings.theme).toBe("dark");
  });
});

async function runWithCore<A, E>(
  effect: Effect.Effect<A, E, RuntimeCore | Scope.Scope>,
  serialLayer = fakeSerialLayer([fakePort]),
): Promise<A> {
  return await Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(
          RuntimeCoreLive.pipe(Layer.provide(Layer.mergeAll(fakePersistenceLayer(), serialLayer))),
        ),
      ),
    ),
  );
}

const fakePort: SerialPortInfo = {
  path: "/dev/tty.vscope",
  manufacturer: "vscope",
  serialNumber: "test-serial",
  pnpId: undefined,
  locationId: undefined,
  productId: "0001",
  vendorId: "0002",
};

const secondPort: SerialPortInfo = {
  path: "/dev/tty.second",
  manufacturer: "vscope",
  serialNumber: "test-serial-2",
  pnpId: undefined,
  locationId: undefined,
  productId: "0001",
  vendorId: "0002",
};

const fakeInfo: VScopeDeviceInfo = {
  channelCount: 2,
  bufferSize: 1000,
  isrKHz: 20,
  variableCount: 2,
  rtCount: 2,
  rtBufferCapacity: 16,
  nameLength: 16,
  endianness: VScopeEndianness.Little,
  deviceName: "scope-a",
};

const fakeMetadata: VScopeStaticMetadata = {
  info: fakeInfo,
  variables: ["voltage", "current"],
  rtLabels: ["kp", "ki"],
  channelMap: [0, 1],
};

const fakeTiming: VScopeTiming = {
  divider: 2,
  preTrig: 10,
};

const fakeTrigger: VScopeTrigger = {
  threshold: 0.5,
  channel: 1,
  mode: "rising",
};

const testSettings = Settings.make({
  ...DEFAULT_SETTINGS,
  polling: PollingSettings.make({
    stateHz: 60,
    frameHz: DEFAULT_SETTINGS.polling.frameHz,
    frameTimeoutMs: DEFAULT_SETTINGS.polling.frameTimeoutMs,
    crcRetryAttempts: DEFAULT_SETTINGS.polling.crcRetryAttempts,
  }),
});

function fakePersistenceLayer() {
  let settings = testSettings;
  let preferences = DEFAULT_PREFERENCES;
  const snapshots: Array<SnapshotRecord> = [];
  const snapshotSamples = new Map<PersistentId, SnapshotSampleBlob>();
  let snapshotCounter = 0;

  const service: PersistenceService = {
    path: "memory",
    readSettings: Effect.sync(() =>
      SettingsState.make({
        settings,
        recovery: noRecovery,
      }),
    ),
    writeSettings: (nextSettings) =>
      Effect.sync(() => {
        settings = nextSettings;
        return SettingsState.make({
          settings,
          recovery: noRecovery,
        });
      }),
    patchSettings: (patch) =>
      Effect.sync(() => {
        settings = Settings.make({
          theme: patch.theme ?? settings.theme,
          defaultSerialConfig: patch.defaultSerialConfig ?? settings.defaultSerialConfig,
          polling: patch.polling ?? settings.polling,
          snapshots: patch.snapshots ?? settings.snapshots,
          liveView: patch.liveView ?? settings.liveView,
          network: patch.network ?? settings.network,
        });
        return SettingsState.make({
          settings,
          recovery: noRecovery,
        });
      }),
    resetSettings: Effect.sync(() => {
      settings = DEFAULT_SETTINGS;
      return SettingsState.make({
        settings,
        recovery: noRecovery,
      });
    }),
    readPreferences: Effect.sync(() =>
      PreferencesState.make({
        preferences,
        recovery: noRecovery,
      }),
    ),
    writePreferences: (nextPreferences) =>
      Effect.sync(() => {
        preferences = nextPreferences;
        return PreferencesState.make({
          preferences,
          recovery: noRecovery,
        });
      }),
    patchPreferences: (patch) =>
      Effect.sync(() => {
        preferences = Preferences.make({
          recentPortPaths: patch.recentPortPaths ?? preferences.recentPortPaths,
          favoriteSnapshotIds: patch.favoriteSnapshotIds ?? preferences.favoriteSnapshotIds,
          favoriteDeviceIds: patch.favoriteDeviceIds ?? preferences.favoriteDeviceIds,
          showAdvancedControls: patch.showAdvancedControls ?? preferences.showAdvancedControls,
        });
        return PreferencesState.make({
          preferences,
          recovery: noRecovery,
        });
      }),
    resetPreferences: Effect.sync(() => {
      preferences = DEFAULT_PREFERENCES;
      return PreferencesState.make({
        preferences,
        recovery: noRecovery,
      });
    }),
    listSavedDevices: Effect.succeed([]),
    getSavedDevice: () => Effect.succeed(Option.none()),
    findSavedDeviceByIdentity: () => Effect.succeed(Option.none()),
    upsertSavedDevice: () => Effect.die("fake persistence upsertSavedDevice is not implemented"),
    forgetSavedDevice: () => Effect.void,
    createSnapshot: (draft, samples) =>
      Effect.sync(() => {
        const id = persistentId(`snapshot:${(snapshotCounter += 1)}`);
        const now = timestamp();
        const record = SnapshotRecord.make({
          id,
          label: draft.label,
          device: draft.device,
          sample: SnapshotSampleDescriptor.make({
            format: SNAPSHOT_SAMPLE_FORMAT,
            channelCount: draft.channelCount,
            sampleCount: draft.sampleCount,
            byteLength: draft.channelCount * draft.sampleCount * Float32Array.BYTES_PER_ELEMENT,
            stored: samples !== undefined,
          }),
          sampleRateHz: draft.sampleRateHz,
          divider: draft.divider,
          preTriggerSamples: draft.preTriggerSamples,
          channelMap: draft.channelMap,
          trigger: draft.trigger,
          rtValues: draft.rtValues,
          metadata: draft.metadata,
          createdAt: now,
          updatedAt: now,
        });
        snapshots.unshift(record);

        if (samples) {
          snapshotSamples.set(
            id,
            SnapshotSampleBlob.make({
              snapshotId: id,
              format: samples.format,
              channelCount: record.sample.channelCount,
              sampleCount: record.sample.sampleCount,
              byteLength: samples.data.byteLength,
              data: samples.data,
              updatedAt: now,
            }),
          );
        }

        return record;
      }),
    listSnapshots: (query) => Effect.sync(() => filterSnapshots(snapshots, query)),
    getSnapshot: (id) =>
      Effect.sync(() => {
        const snapshot = snapshots.find((candidate) => candidate.id === id);
        return snapshot ? Option.some(snapshot) : Option.none();
      }),
    renameSnapshot: () => Effect.die("fake persistence renameSnapshot is not implemented"),
    deleteSnapshot: () => Effect.void,
    writeSnapshotSamples: () =>
      Effect.die("fake persistence writeSnapshotSamples is not implemented"),
    readSnapshotSamples: (id) =>
      Effect.sync(() => {
        const samples = snapshotSamples.get(id);
        return samples ? Option.some(samples) : Option.none();
      }),
    createSnapshotComparison: () =>
      Effect.die("fake persistence createSnapshotComparison is not implemented"),
    listSnapshotComparisons: Effect.succeed([]),
    renameSnapshotComparison: () =>
      Effect.die("fake persistence renameSnapshotComparison is not implemented"),
    deleteSnapshotComparison: () => Effect.void,
  };

  return Layer.succeed(Persistence, service);
}

function filterSnapshots(
  snapshots: ReadonlyArray<SnapshotRecord>,
  query: SnapshotListQuery | undefined,
): ReadonlyArray<SnapshotRecord> {
  return query?.limit === undefined ? snapshots : snapshots.slice(0, query.limit);
}

function persistentId(value: string): PersistentId {
  return Schema.decodeUnknownSync(PersistentId)(value);
}

function timestamp() {
  return Schema.decodeUnknownSync(Timestamp)(new Date().toISOString());
}

function snapshotSampleBytes(): Uint8Array {
  const samples = new Float32Array(fakeInfo.channelCount * fakeInfo.bufferSize);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = index;
  }
  return new Uint8Array(samples.buffer.slice(0));
}

interface FakeSerialLayerOptions {
  readonly device?: FakeDeviceOptions | undefined;
}

interface FakeDeviceOptions {
  readonly failFramesAfter?: number | undefined;
  readonly collectSnapshotDelayMillis?: number | undefined;
}

function fakeSerialLayer(
  ports: ReadonlyArray<SerialPortInfo>,
  options: FakeSerialLayerOptions = {},
) {
  const devices = new Map<string, VScopeDevice>();
  const portsByPath = new Map(ports.map((port) => [port.path, port]));

  return Layer.effect(
    VScopeSerial,
    Effect.gen(function* () {
      const events = yield* PubSub.bounded<VScopeSerialEvent>({
        capacity: 64,
        replay: 16,
      });

      const service: VScopeSerialService = {
        listPorts: Effect.succeed(ports),
        openDevice: (openOptions) =>
          Effect.gen(function* () {
            if (!portsByPath.has(openOptions.path)) {
              return yield* Effect.die(`No fake port for ${openOptions.path}`);
            }
            if (devices.has(openOptions.path)) {
              return yield* new VScopeDeviceAlreadyOpenError({ path: openOptions.path });
            }

            const device = fakeDevice(openOptions.path, options.device);
            devices.set(openOptions.path, device);
            yield* PubSub.publish(events, {
              _tag: "DeviceOpened",
              device: {
                path: device.path,
                deviceName: device.deviceName,
                metadata: fakeMetadata,
              },
            });
            return device;
          }),
        getDevice: (identifier) =>
          Effect.flatMap(
            Effect.sync(() => findDevice(devices, identifier)),
            (device) =>
              device
                ? Effect.succeed(device)
                : Effect.fail(new VScopeDeviceNotFoundError({ identifier })),
          ),
        getDeviceByPath: (path) =>
          Effect.flatMap(
            Effect.sync(() => devices.get(path)),
            (device) =>
              device
                ? Effect.succeed(device)
                : Effect.fail(new VScopeDeviceNotFoundError({ identifier: path })),
          ),
        removeDevice: (identifier) =>
          Effect.gen(function* () {
            const device = findDevice(devices, identifier);
            if (!device) {
              return yield* new VScopeDeviceNotFoundError({ identifier });
            }
            devices.delete(device.path);
            yield* PubSub.publish(events, {
              _tag: "DeviceRemoved",
              device: {
                path: device.path,
                deviceName: device.deviceName,
                metadata: fakeMetadata,
              },
            });
          }),
        closeAll: Effect.gen(function* () {
          for (const device of devices.values()) {
            yield* PubSub.publish(events, {
              _tag: "DeviceRemoved",
              device: {
                path: device.path,
                deviceName: device.deviceName,
                metadata: fakeMetadata,
              },
            });
          }
          devices.clear();
        }),
        listDevices: Effect.sync(() =>
          Array.from(devices.values()).map((device) => ({
            path: device.path,
            deviceName: device.deviceName,
            metadata: fakeMetadata,
          })),
        ),
        events: Stream.fromPubSub(events),
      };

      return service;
    }),
  );
}

function findDevice(
  devices: ReadonlyMap<string, VScopeDevice>,
  identifier: string,
): VScopeDevice | undefined {
  return (
    devices.get(identifier) ??
    Array.from(devices.values()).find((device) => device.deviceName === identifier)
  );
}

function fakeDevice(path: string, options: FakeDeviceOptions = {}): VScopeDevice {
  let state: VScopeStateValue = VScopeState.Halted;
  let requestedState: VScopeStateValue = VScopeState.Halted;
  let snapshotValid = false;
  let acquisitionPollsRemaining = 0;
  let frameReads = 0;
  const rtValues = new Map<number, number>([
    [0, 1],
    [1, 2],
  ]);

  const status = (): VScopeControlStatus => ({
    state,
    requestedState,
    snapshotValid,
    requestPending: state !== requestedState,
    triggerEnabled: fakeTrigger.mode !== "disabled",
    flags:
      (snapshotValid ? 1 : 0) |
      (state !== requestedState ? 2 : 0) |
      (fakeTrigger.mode !== "disabled" ? 4 : 0),
  });

  const advanceStatus = () => {
    if (requestedState === VScopeState.Acquiring) {
      if (state === VScopeState.Running) {
        state = VScopeState.Acquiring;
      }
      if (acquisitionPollsRemaining > 0) {
        acquisitionPollsRemaining -= 1;
      }
      if (acquisitionPollsRemaining === 0) {
        state = VScopeState.Halted;
        requestedState = VScopeState.Halted;
        snapshotValid = true;
      }
    }
  };

  const failIfMisconfigured = (operation: string) =>
    state === VScopeState.Misconfigured
      ? Effect.fail(
          new VScopeInvalidArgumentError({
            path,
            operation,
            reason: "Device is misconfigured.",
          }),
        )
      : Effect.void;

  return {
    path,
    deviceName: fakeInfo.deviceName,
    info: fakeMetadata.info,
    metadata: Effect.succeed(fakeMetadata),
    getTiming: failIfMisconfigured("getTiming").pipe(Effect.as(fakeTiming)),
    setTiming: (timing) => failIfMisconfigured("setTiming").pipe(Effect.as(timing)),
    getStatus: Effect.sync(() => {
      advanceStatus();
      return status();
    }),
    getState: Effect.sync(() => state),
    setState: (nextState) =>
      Effect.sync(() => {
        requestedState = nextState;
        state = nextState;
        if (state === VScopeState.Running) {
          snapshotValid = false;
        }
        return status();
      }),
    start: () =>
      Effect.sync(() => {
        requestedState = VScopeState.Running;
        state = VScopeState.Running;
        snapshotValid = false;
        return status();
      }),
    stop: () =>
      Effect.sync(() => {
        requestedState = VScopeState.Halted;
        state = VScopeState.Halted;
        return status();
      }),
    trigger: Effect.gen(function* () {
      if (state !== VScopeState.Running) {
        return yield* new VScopeInvalidArgumentError({
          path,
          operation: "trigger",
          reason: "Device must be running.",
        });
      }
      requestedState = VScopeState.Acquiring;
      acquisitionPollsRemaining = 2;
      return status();
    }),
    getFrame: failIfMisconfigured("getFrame").pipe(
      Effect.andThen(
        Effect.gen(function* () {
          if (options.failFramesAfter !== undefined && frameReads >= options.failFramesAfter) {
            return yield* new VScopeInvalidArgumentError({
              path,
              operation: "getFrame",
              reason: "Frame read failed.",
            });
          }

          frameReads += 1;
          return Float32Array.from([frameReads, 2, 3, 4]);
        }),
      ),
    ),
    getSnapshotHeader: Effect.succeed({
      channelMap: fakeMetadata.channelMap,
      divider: fakeTiming.divider,
      preTrig: fakeTiming.preTrig,
      trigger: fakeTrigger,
      rtValues: [1, 2],
      channelCount: fakeInfo.channelCount,
      sampleCount: fakeInfo.bufferSize,
      byteLength: fakeInfo.channelCount * fakeInfo.bufferSize * Float32Array.BYTES_PER_ELEMENT,
    }),
    snapshotBytes: () => Stream.fromIterable([snapshotSampleBytes()]),
    collectSnapshotBytes: () =>
      options.collectSnapshotDelayMillis === undefined
        ? Effect.succeed(snapshotSampleBytes())
        : Effect.sleep(`${options.collectSnapshotDelayMillis} millis`).pipe(
            Effect.as(snapshotSampleBytes()),
          ),
    getVariableCatalog: Effect.succeed(fakeMetadata.variables),
    getChannelMap: failIfMisconfigured("getChannelMap").pipe(Effect.as(fakeMetadata.channelMap)),
    setChannelMap: (channel, variable) =>
      failIfMisconfigured("setChannelMap").pipe(
        Effect.as(
          fakeMetadata.channelMap.map((current, index) => (index === channel ? variable : current)),
        ),
      ),
    getRtLabels: Effect.succeed(fakeMetadata.rtLabels),
    getRtValue: (index) => Effect.succeed(rtValues.get(index) ?? 0),
    setRtValue: (index, value) =>
      Effect.sync(() => {
        rtValues.set(index, value);
        return value;
      }),
    getTrigger: failIfMisconfigured("getTrigger").pipe(Effect.as(fakeTrigger)),
    setTrigger: (trigger) => failIfMisconfigured("setTrigger").pipe(Effect.as(trigger)),
    closed: Effect.never,
    close: Effect.void,
  };
}
