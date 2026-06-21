import { Effect, Stream } from "effect";
import {
  PersistentId,
  RuntimeActiveDevice,
  RuntimeAppDto,
  RuntimeControlStatus,
  RuntimeDeviceInfo,
  RuntimeDeviceConfigPayload,
  RuntimeFramePayload,
  RuntimeLogEntryDto,
  RuntimePortInfo,
  RuntimeSetTimingRequest,
  RuntimeSetTriggerRequest,
  RuntimeWarningDto,
  type RuntimeDeviceLost,
  type RuntimeSettingsPatchRequest,
  type SnapshotRecord,
  type SnapshotSampleBlob,
} from "@vscope/shared";
import type {
  SerialPortInfo,
  VScopeState as VScopeStateValue,
  VScopeControlStatus,
  VScopeTiming,
  VScopeTrigger,
} from "@vscope/serial";
import { VScopeState } from "@vscope/serial";

import type { RuntimeCoreError } from "./core/errors";
import type { ActiveDeviceState, DeviceConfigState, RuntimeAppState } from "./core/model";
import type { RuntimeCoreService } from "./core/service";

export interface RuntimeRpcHandlers {
  readonly getApp: Effect.Effect<RuntimeAppDto>;
  readonly patchSettings: (
    patch: RuntimeSettingsPatchRequest,
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
  readonly listSnapshots: Effect.Effect<ReadonlyArray<SnapshotRecord>, RuntimeCoreError>;
}

export interface RuntimeSubscriptions {
  readonly app: Stream.Stream<RuntimeAppDto>;
  readonly snapshots: Stream.Stream<ReadonlyArray<SnapshotRecord>>;
  readonly activeDevice: Stream.Stream<RuntimeActiveDevice | null>;
  readonly status: Stream.Stream<RuntimeControlStatus | null>;
  readonly config: Stream.Stream<RuntimeDeviceConfigPayload | null>;
  readonly frames: Stream.Stream<RuntimeFramePayload | null, RuntimeDeviceLost>;
}

export interface RuntimeApi {
  readonly rpc: RuntimeRpcHandlers;
  readonly subscriptions: RuntimeSubscriptions;
  readonly snapshots: RuntimeSnapshotHandlers;
}

export interface RuntimeSnapshotHandlers {
  readonly readSamples: (
    id: PersistentId,
  ) => Effect.Effect<SnapshotSampleBlob | null, RuntimeCoreError>;
}

export function makeRuntimeApi(core: RuntimeCoreService): RuntimeApi {
  const dispatch = (command: Parameters<RuntimeCoreService["dispatch"]>[0]) =>
    core.dispatch(command);
  const readFrame = core.lastFrame.pipe(Effect.map(framePayload));
  const listSnapshots = core.listSnapshots;

  const rpc: RuntimeRpcHandlers = {
    getApp: core.app.pipe(Effect.map(appDto)),
    patchSettings: (patch) => dispatch({ type: "settings/patch", patch }),
    listPorts: core.listPorts.pipe(Effect.map((ports) => ports.map(runtimePortInfo))),
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
    snapshots: core.snapshotChanges,
    activeDevice: core.activeDeviceChanges.pipe(Stream.map(activeDeviceDto)),
    status: core.deviceStatusChanges.pipe(Stream.map(statusDto)),
    config: core.deviceConfigChanges.pipe(Stream.map(configDto)),
    frames: core.frames.pipe(Stream.map(framePayload)),
  };

  const snapshots: RuntimeSnapshotHandlers = {
    readSamples: (id) => core.readSnapshotSamples(id),
  };

  return { rpc, subscriptions, snapshots };
}

export function appDto(app: RuntimeAppState): RuntimeAppDto {
  return RuntimeAppDto.make({
    ...app,
    warnings: app.warnings.map((warning) => RuntimeWarningDto.make(warning)),
    logs: app.logs.map((entry) => RuntimeLogEntryDto.make(entry)),
  });
}

export function activeDeviceDto(device: ActiveDeviceState | null): RuntimeActiveDevice | null {
  return device
    ? RuntimeActiveDevice.make({
        ...device,
        connected: device.connected,
        info: device.info ? RuntimeDeviceInfo.make(device.info) : null,
      })
    : null;
}

export function statusDto(status: DeviceStatusInput): RuntimeControlStatus | null {
  return status
    ? RuntimeControlStatus.make({
        state: stateDto(status.state),
        snapshotValid: status.snapshotValid,
      })
    : null;
}

export function configDto(config: DeviceConfigState | null): RuntimeDeviceConfigPayload | null {
  return config
    ? RuntimeDeviceConfigPayload.make({
        timing: timingDto(config.timing),
        trigger: triggerDto(config.trigger),
        channelMap: config.channelMap,
        rtValues: Array.from(config.rtValues.entries()),
      })
    : null;
}

export function framePayload(values: ReadonlyArray<number> | null): RuntimeFramePayload | null {
  return values === null ? null : RuntimeFramePayload.make({ values });
}

export function runtimePortInfo(port: SerialPortInfo): RuntimePortInfo {
  return RuntimePortInfo.make(port);
}

function timingDto(timing: DeviceConfigState["timing"]): RuntimeSetTimingRequest | null {
  return timing ? RuntimeSetTimingRequest.make(timing) : null;
}

function triggerDto(trigger: DeviceConfigState["trigger"]): RuntimeSetTriggerRequest | null {
  return trigger ? RuntimeSetTriggerRequest.make(trigger) : null;
}

type DeviceStatusInput = VScopeControlStatus | null;

function stateDto(state: VScopeStateValue): RuntimeControlStatus["state"] {
  switch (state) {
    case VScopeState.Halted:
      return "halted";
    case VScopeState.Running:
      return "running";
    case VScopeState.Acquiring:
      return "acquiring";
    case VScopeState.Misconfigured:
      return "misconfigured";
  }
}
