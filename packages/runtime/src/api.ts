import { Effect, Schema, Stream } from "effect";
import {
  PersistentId,
  RuntimeActiveDevice,
  RuntimeAppDto,
  RuntimeCommandPermissions,
  RuntimeControlStatus,
  RuntimeDeviceInfo,
  RuntimeDeviceConfigPayload,
  RuntimeFramePayload,
  RuntimeLogEntryDto,
  RuntimePortInfo,
  RuntimeSetTimingRequest,
  RuntimeSetTriggerRequest,
  RuntimeSnapshotRecord,
  RuntimeWarningDto,
  type RuntimeDeviceLost,
  type RuntimePreferencesPatchRequest,
  type RuntimeSettingsPatchRequest,
  type SnapshotRecord,
  type SnapshotSampleBlob,
} from "@vscope/shared";
import type {
  SerialPortInfo,
  VScopeControlStatus,
  VScopeTiming,
  VScopeTrigger,
} from "@vscope/serial";

import type { RuntimeCoreError } from "./core/errors";
import type { ActiveDeviceState, DeviceConfigState, RuntimeAppState } from "./core/model";
import type { CommandPermissions } from "./core/policy";
import type { RuntimeCoreService } from "./core/service";

export interface RuntimeRpcHandlers {
  readonly getApp: Effect.Effect<RuntimeAppDto>;
  readonly patchSettings: (
    patch: RuntimeSettingsPatchRequest,
  ) => Effect.Effect<void, RuntimeCoreError>;
  readonly patchPreferences: (
    patch: RuntimePreferencesPatchRequest,
  ) => Effect.Effect<void, RuntimeCoreError>;
  readonly listPorts: Effect.Effect<ReadonlyArray<RuntimePortInfo>, RuntimeCoreError>;
  readonly getActiveDevice: Effect.Effect<RuntimeActiveDevice | null>;
  readonly connectDevice: (path: string) => Effect.Effect<void, RuntimeCoreError>;
  readonly disconnectDevice: Effect.Effect<void, RuntimeCoreError>;
  readonly getDeviceStatus: Effect.Effect<RuntimeControlStatus | null>;
  readonly runDevice: Effect.Effect<void, RuntimeCoreError>;
  readonly stopDevice: Effect.Effect<void, RuntimeCoreError>;
  readonly triggerDevice: Effect.Effect<void, RuntimeCoreError>;
  readonly getConfig: Effect.Effect<RuntimeDeviceConfigPayload | null>;
  readonly setTiming: (timing: VScopeTiming) => Effect.Effect<void, RuntimeCoreError>;
  readonly setTrigger: (trigger: VScopeTrigger) => Effect.Effect<void, RuntimeCoreError>;
  readonly setRtValue: (index: number, value: number) => Effect.Effect<void, RuntimeCoreError>;
  readonly setChannelMap: (
    channel: number,
    variable: number,
  ) => Effect.Effect<void, RuntimeCoreError>;
  readonly readFrame: Effect.Effect<RuntimeFramePayload | null>;
  readonly captureSnapshot: (label?: string | undefined) => Effect.Effect<void, RuntimeCoreError>;
  readonly listSnapshots: Effect.Effect<ReadonlyArray<RuntimeSnapshotRecord>, RuntimeCoreError>;
}

export interface RuntimeSubscriptions {
  readonly app: Stream.Stream<RuntimeAppDto>;
  readonly snapshots: Stream.Stream<ReadonlyArray<RuntimeSnapshotRecord>>;
  readonly activeDevice: Stream.Stream<RuntimeActiveDevice | null>;
  readonly status: Stream.Stream<RuntimeControlStatus | null>;
  readonly permissions: Stream.Stream<RuntimeCommandPermissions>;
  readonly config: Stream.Stream<RuntimeDeviceConfigPayload | null>;
  readonly frames: Stream.Stream<RuntimeFramePayload | null, RuntimeDeviceLost>;
}

export interface RuntimeMcpHandlers {
  readonly getApp: Effect.Effect<RuntimeAppDto>;
  readonly listPorts: Effect.Effect<ReadonlyArray<RuntimePortInfo>, RuntimeCoreError>;
  readonly getActiveDevice: Effect.Effect<RuntimeActiveDevice | null>;
  readonly connectDevice: (path: string) => Effect.Effect<void, RuntimeCoreError>;
  readonly disconnectDevice: Effect.Effect<void, RuntimeCoreError>;
  readonly getDeviceStatus: Effect.Effect<RuntimeControlStatus | null>;
  readonly runDevice: Effect.Effect<void, RuntimeCoreError>;
  readonly stopDevice: Effect.Effect<void, RuntimeCoreError>;
  readonly triggerDevice: Effect.Effect<void, RuntimeCoreError>;
  readonly readConfig: Effect.Effect<RuntimeDeviceConfigPayload | null>;
  readonly readFrame: Effect.Effect<RuntimeFramePayload | null>;
  readonly captureSnapshot: (label?: string | undefined) => Effect.Effect<void, RuntimeCoreError>;
  readonly listSnapshots: Effect.Effect<ReadonlyArray<RuntimeSnapshotRecord>, RuntimeCoreError>;
}

export interface RuntimeApi {
  readonly rpc: RuntimeRpcHandlers;
  readonly subscriptions: RuntimeSubscriptions;
  readonly mcp: RuntimeMcpHandlers;
  readonly snapshots: RuntimeSnapshotHandlers;
}

export interface RuntimeSnapshotHandlers {
  readonly readSamples: (
    id: RuntimeSnapshotRecord["id"],
  ) => Effect.Effect<SnapshotSampleBlob | null, unknown>;
}

export function makeRuntimeApi(core: RuntimeCoreService): RuntimeApi {
  const dispatch = (command: Parameters<RuntimeCoreService["dispatch"]>[0]) =>
    core.dispatch(command);
  const readFrame = core.lastFrame.pipe(Effect.map(framePayload));
  const listSnapshots = core
    .query({ type: "snapshots/list" })
    .pipe(
      Effect.map((result) =>
        result.type === "snapshots/list" ? result.snapshots.map(snapshotDto) : [],
      ),
    );

  const rpc: RuntimeRpcHandlers = {
    getApp: core.app.pipe(Effect.map(appDto)),
    patchSettings: (patch) => dispatch({ type: "settings/patch", patch }),
    patchPreferences: (patch) => dispatch({ type: "preferences/patch", patch }),
    listPorts: core
      .query({ type: "ports/list" })
      .pipe(
        Effect.map((result) =>
          result.type === "ports/list" ? result.ports.map(runtimePortInfo) : [],
        ),
      ),
    getActiveDevice: core.activeDevice.pipe(Effect.map(activeDeviceDto)),
    connectDevice: (path) => dispatch({ type: "devices/connect", path }),
    disconnectDevice: dispatch({ type: "devices/disconnect" }),
    getDeviceStatus: core.deviceStatus.pipe(Effect.map(statusDto)),
    runDevice: dispatch({ type: "devices/run" }),
    stopDevice: dispatch({ type: "devices/stop" }),
    triggerDevice: dispatch({ type: "devices/trigger" }),
    getConfig: core.deviceConfig.pipe(Effect.map(configDto)),
    setTiming: (timing) => dispatch({ type: "devices/setTiming", timing }),
    setTrigger: (trigger) => dispatch({ type: "devices/setTrigger", trigger }),
    setRtValue: (index, value) => dispatch({ type: "devices/setRtValue", index, value }),
    setChannelMap: (channel, variable) =>
      dispatch({ type: "devices/setChannelMap", channel, variable }),
    readFrame,
    captureSnapshot: (label) => dispatch({ type: "snapshots/capture", label }),
    listSnapshots,
  };

  const subscriptions: RuntimeSubscriptions = {
    app: core.appChanges.pipe(Stream.map(appDto)),
    snapshots: core.snapshotChanges.pipe(Stream.map((snapshots) => snapshots.map(snapshotDto))),
    activeDevice: core.activeDeviceChanges.pipe(Stream.map(activeDeviceDto)),
    status: core.deviceStatusChanges.pipe(Stream.map(statusDto)),
    permissions: Stream.merge(
      core.activeDeviceChanges.pipe(Stream.map(() => undefined)),
      core.deviceStatusChanges.pipe(Stream.map(() => undefined)),
    ).pipe(
      Stream.mapEffect(() => core.permissions),
      Stream.changesWith(permissionsEquals),
      Stream.map(permissionsDto),
    ),
    config: core.deviceConfigChanges.pipe(Stream.map(configDto)),
    frames: core.frames.pipe(Stream.map(framePayload)),
  };

  const mcp: RuntimeMcpHandlers = {
    getApp: rpc.getApp,
    listPorts: rpc.listPorts,
    getActiveDevice: rpc.getActiveDevice,
    connectDevice: rpc.connectDevice,
    disconnectDevice: rpc.disconnectDevice,
    getDeviceStatus: rpc.getDeviceStatus,
    runDevice: rpc.runDevice,
    stopDevice: rpc.stopDevice,
    triggerDevice: rpc.triggerDevice,
    readConfig: rpc.getConfig,
    readFrame,
    captureSnapshot: rpc.captureSnapshot,
    listSnapshots,
  };

  const snapshots: RuntimeSnapshotHandlers = {
    readSamples: (id) =>
      Schema.decodeUnknownEffect(PersistentId)(id).pipe(
        Effect.flatMap((persistentId) =>
          core.query({ type: "snapshots/readSamples", id: persistentId }),
        ),
        Effect.map((result) => (result.type === "snapshots/readSamples" ? result.samples : null)),
      ),
  };

  return { rpc, subscriptions, mcp, snapshots };
}

function appDto(app: RuntimeAppState): RuntimeAppDto {
  return RuntimeAppDto.make({
    ...app,
    warnings: app.warnings.map((warning) => RuntimeWarningDto.make(warning)),
    logs: app.logs.map((entry) => RuntimeLogEntryDto.make(entry)),
  });
}

function activeDeviceDto(device: ActiveDeviceState | null): RuntimeActiveDevice | null {
  return device
    ? RuntimeActiveDevice.make({
        ...device,
        info: device.info ? RuntimeDeviceInfo.make(device.info) : null,
      })
    : null;
}

function statusDto(status: DeviceStatusInput): RuntimeControlStatus | null {
  return status ? RuntimeControlStatus.make(status) : null;
}

function configDto(config: DeviceConfigState | null): RuntimeDeviceConfigPayload | null {
  return config
    ? RuntimeDeviceConfigPayload.make({
        timing: timingDto(config.timing),
        trigger: triggerDto(config.trigger),
        channelMap: config.channelMap,
        rtValues: Array.from(config.rtValues.entries()),
      })
    : null;
}

function framePayload(values: ReadonlyArray<number> | null): RuntimeFramePayload | null {
  return values === null ? null : RuntimeFramePayload.make({ values });
}

function runtimePortInfo(port: SerialPortInfo): RuntimePortInfo {
  const result: {
    path: string;
    manufacturer?: string;
    serialNumber?: string;
    pnpId?: string;
    locationId?: string;
    productId?: string;
    vendorId?: string;
  } = { path: port.path };

  if (port.manufacturer !== undefined) result.manufacturer = port.manufacturer;
  if (port.serialNumber !== undefined) result.serialNumber = port.serialNumber;
  if (port.pnpId !== undefined) result.pnpId = port.pnpId;
  if (port.locationId !== undefined) result.locationId = port.locationId;
  if (port.productId !== undefined) result.productId = port.productId;
  if (port.vendorId !== undefined) result.vendorId = port.vendorId;

  return RuntimePortInfo.make(result);
}

function snapshotDto(snapshot: SnapshotRecord): RuntimeSnapshotRecord {
  return RuntimeSnapshotRecord.make({
    ...snapshot,
  });
}

function timingDto(timing: DeviceConfigState["timing"]): RuntimeSetTimingRequest | null {
  return timing ? RuntimeSetTimingRequest.make(timing) : null;
}

function triggerDto(trigger: DeviceConfigState["trigger"]): RuntimeSetTriggerRequest | null {
  return trigger ? RuntimeSetTriggerRequest.make(trigger) : null;
}

function permissionsDto(permissions: CommandPermissions): RuntimeCommandPermissions {
  return RuntimeCommandPermissions.make(permissions);
}

function permissionsEquals(a: CommandPermissions, b: CommandPermissions): boolean {
  return (
    a.mode === b.mode &&
    a.connect === b.connect &&
    a.disconnect === b.disconnect &&
    a.setTiming === b.setTiming &&
    a.setTrigger === b.setTrigger &&
    a.setRtValue === b.setRtValue &&
    a.setChannelMap === b.setChannelMap &&
    a.trigger === b.trigger &&
    a.run === b.run &&
    a.stop === b.stop &&
    a.captureSnapshot === b.captureSnapshot
  );
}

type DeviceStatusInput = VScopeControlStatus | null;
