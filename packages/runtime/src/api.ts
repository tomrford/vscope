import { Effect, Option, Result, Schema, Stream } from "effect";
import {
  RuntimeDeviceConfigPayload,
  RuntimeDeviceDto,
  RuntimeFramePayload,
  RuntimeSetTimingRequest,
  RuntimeSetTriggerRequest,
  RuntimeStateDto,
  RuntimeSnapshotRecord,
  type RuntimeWriteConfigRequest,
} from "@vscope/shared";
import { PersistentId, type SnapshotSampleBlob } from "@vscope/persistence";
import type { SerialPortInfo, VScopeTiming, VScopeTrigger } from "@vscope/serial";

import type { RuntimeCoreError } from "./core/errors";
import type { CoreDevice, CoreState } from "./core/model";
import type { RuntimeCoreService } from "./core/service";

export interface RuntimeRpcHandlers {
  readonly getState: Effect.Effect<RuntimeStateDto>;
  readonly listPorts: Effect.Effect<ReadonlyArray<SerialPortInfo>, RuntimeCoreError>;
  readonly connectDevice: (path: string) => Effect.Effect<RuntimeStateDto, RuntimeCoreError>;
  readonly disconnectDevice: Effect.Effect<RuntimeStateDto, RuntimeCoreError>;
  readonly runDevice: Effect.Effect<RuntimeStateDto, RuntimeCoreError>;
  readonly stopDevice: Effect.Effect<RuntimeStateDto, RuntimeCoreError>;
  readonly triggerDevice: Effect.Effect<RuntimeStateDto, RuntimeCoreError>;
  readonly setTiming: (timing: VScopeTiming) => Effect.Effect<RuntimeStateDto, RuntimeCoreError>;
  readonly setTrigger: (trigger: VScopeTrigger) => Effect.Effect<RuntimeStateDto, RuntimeCoreError>;
  readonly setRtValue: (
    index: number,
    value: number,
  ) => Effect.Effect<RuntimeStateDto, RuntimeCoreError>;
  readonly setChannelMap: (
    channel: number,
    variable: number,
  ) => Effect.Effect<RuntimeStateDto, RuntimeCoreError>;
  readonly captureSnapshot: (
    label?: string | undefined,
  ) => Effect.Effect<RuntimeStateDto["snapshots"][number], RuntimeCoreError>;
  readonly listSnapshots: Effect.Effect<RuntimeStateDto["snapshots"], RuntimeCoreError>;
}

export interface RuntimeSubscriptions {
  readonly status: Stream.Stream<RuntimeStateDto>;
  readonly frame: Stream.Stream<RuntimeFramePayload>;
}

export interface RuntimeMcpHandlers {
  readonly getState: Effect.Effect<RuntimeStateDto>;
  readonly listPorts: Effect.Effect<ReadonlyArray<SerialPortInfo>, RuntimeCoreError>;
  readonly connectDevice: (path: string) => Effect.Effect<RuntimeStateDto, RuntimeCoreError>;
  readonly disconnectDevice: Effect.Effect<RuntimeStateDto, RuntimeCoreError>;
  readonly runDevice: Effect.Effect<RuntimeStateDto, RuntimeCoreError>;
  readonly stopDevice: Effect.Effect<RuntimeStateDto, RuntimeCoreError>;
  readonly triggerDevice: Effect.Effect<RuntimeStateDto, RuntimeCoreError>;
  readonly readConfig: Effect.Effect<RuntimeDeviceConfigPayload>;
  readonly writeConfig: (
    patch: RuntimeWriteConfigRequest,
  ) => Effect.Effect<RuntimeDeviceConfigPayload, RuntimeCoreError>;
  readonly readFrame: Effect.Effect<RuntimeFramePayload | null>;
  readonly captureSnapshot: (
    label?: string | undefined,
  ) => Effect.Effect<RuntimeStateDto["snapshots"][number], RuntimeCoreError>;
  readonly listSnapshots: Effect.Effect<RuntimeStateDto["snapshots"], RuntimeCoreError>;
}

export interface RuntimeApi {
  readonly rpc: RuntimeRpcHandlers;
  readonly subscriptions: RuntimeSubscriptions;
  readonly mcp: RuntimeMcpHandlers;
  readonly snapshots: RuntimeSnapshotHandlers;
}

export interface RuntimeSnapshotHandlers {
  readonly readSamples: (
    id: RuntimeStateDto["snapshots"][number]["id"],
  ) => Effect.Effect<SnapshotSampleBlob | null, unknown>;
}

export function makeRuntimeApi(core: RuntimeCoreService): RuntimeApi {
  const getState = core.getSnapshot.pipe(Effect.map(runtimeStateDto));
  const dispatch = (command: Parameters<RuntimeCoreService["dispatch"]>[0]) =>
    core.dispatch(command).pipe(Effect.map(runtimeStateDto));

  const rpc: RuntimeRpcHandlers = {
    getState,
    listPorts: core
      .query({ type: "ports/list" })
      .pipe(Effect.map((result) => (result.type === "ports/list" ? result.ports : []))),
    connectDevice: (path) => dispatch({ type: "devices/connect", path }),
    disconnectDevice: dispatch({ type: "devices/disconnect" }),
    runDevice: dispatch({ type: "devices/run" }),
    stopDevice: dispatch({ type: "devices/stop" }),
    triggerDevice: dispatch({ type: "devices/trigger" }),
    setTiming: (timing) => dispatch({ type: "devices/setTiming", timing }),
    setTrigger: (trigger) => dispatch({ type: "devices/setTrigger", trigger }),
    setRtValue: (index, value) => dispatch({ type: "devices/setRtValue", index, value }),
    setChannelMap: (channel, variable) =>
      dispatch({ type: "devices/setChannelMap", channel, variable }),
    captureSnapshot: (label) =>
      core
        .dispatch({ type: "snapshots/capture", label })
        .pipe(Effect.map((state) => state.snapshots[0])),
    listSnapshots: core
      .query({ type: "snapshots/list" })
      .pipe(Effect.map((result) => (result.type === "snapshots/list" ? result.snapshots : []))),
  };

  const subscriptions: RuntimeSubscriptions = {
    status: core.changes.pipe(Stream.map(runtimeStateDto)),
    frame: core.changes.pipe(Stream.filterMap(framePayloadResultFromState)),
  };

  const mcp: RuntimeMcpHandlers = {
    getState,
    listPorts: rpc.listPorts,
    connectDevice: rpc.connectDevice,
    disconnectDevice: rpc.disconnectDevice,
    runDevice: rpc.runDevice,
    stopDevice: rpc.stopDevice,
    triggerDevice: rpc.triggerDevice,
    readConfig: core.getSnapshot.pipe(Effect.map(configPayloadFromState)),
    writeConfig: (patch) => writeConfig(core, patch).pipe(Effect.map(configPayloadFromState)),
    readFrame: core.getSnapshot.pipe(
      Effect.map((state) => Option.getOrNull(framePayloadFromState(state))),
    ),
    captureSnapshot: rpc.captureSnapshot,
    listSnapshots: rpc.listSnapshots,
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

export function runtimeStateDto(state: CoreState): RuntimeStateDto {
  return RuntimeStateDto.make({
    ...state,
    settings: jsonValue(state.settings),
    settingsRecovery: jsonValue(state.settingsRecovery),
    preferences: jsonValue(state.preferences),
    preferencesRecovery: jsonValue(state.preferencesRecovery),
    savedDevices: state.savedDevices.map(jsonValue),
    snapshots: state.snapshots.map(snapshotDto),
    permissions: jsonValue(state.permissions),
    warnings: state.warnings.map(jsonValue),
    logs: state.logs.map(jsonValue),
    device: state.device
      ? RuntimeDeviceDto.make({
          ...state.device,
          info: jsonValue(state.device.info),
          metadata: jsonValue(state.device.metadata),
          status: jsonValue(state.device.status),
          intent: jsonValue(state.device.intent),
          timing: timingDto(state.device.timing),
          trigger: triggerDto(state.device.trigger),
          rtValues: Array.from(state.device.rtValues.entries()),
        })
      : null,
  });
}

function framePayloadFromState(state: CoreState): Option.Option<RuntimeFramePayload> {
  if (!state.device?.frame || !state.device.channelMap) {
    return Option.none();
  }

  return Option.some(
    RuntimeFramePayload.make({
      values: state.device.frame,
      channelMap: state.device.channelMap,
    }),
  );
}

function framePayloadResultFromState(
  state: CoreState,
): Result.Result<RuntimeFramePayload, CoreState> {
  return Option.match(framePayloadFromState(state), {
    onNone: () => Result.fail(state),
    onSome: Result.succeed,
  });
}

function configPayloadFromState(state: CoreState): RuntimeDeviceConfigPayload {
  const device = state.device;
  return RuntimeDeviceConfigPayload.make({
    connected: device?.connectionStatus === "connected",
    timing: timingDto(device?.timing ?? null),
    trigger: triggerDto(device?.trigger ?? null),
    channelMap: device?.channelMap ?? [],
    rtValues: device ? Array.from(device.rtValues.entries()) : [],
    variables: device?.metadata?.variables ?? [],
    rtLabels: device?.metadata?.rtLabels ?? [],
    permissions: jsonValue(state.permissions),
  });
}

function snapshotDto(snapshot: CoreState["snapshots"][number]): RuntimeSnapshotRecord {
  return RuntimeSnapshotRecord.make({
    ...snapshot,
    trigger: RuntimeSetTriggerRequest.make(snapshot.trigger),
    metadata: jsonValue(snapshot.metadata),
  });
}

function timingDto(timing: CoreDevice["timing"]): RuntimeSetTimingRequest | null {
  return timing ? RuntimeSetTimingRequest.make(timing) : null;
}

function triggerDto(trigger: CoreDevice["trigger"]): RuntimeSetTriggerRequest | null {
  return trigger ? RuntimeSetTriggerRequest.make(trigger) : null;
}

function jsonValue(value: unknown): unknown {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  return parsed;
}

function writeConfig(
  core: RuntimeCoreService,
  patch: RuntimeWriteConfigRequest,
): Effect.Effect<CoreState, RuntimeCoreError> {
  return Effect.gen(function* () {
    let state = yield* core.getSnapshot;
    const device = state.device;

    if (patch.timing) {
      const divider = patch.timing.divider ?? device?.timing?.divider;
      const preTrig = patch.timing.preTrig ?? device?.timing?.preTrig;
      if (divider !== undefined && preTrig !== undefined) {
        state = yield* core.dispatch({
          type: "devices/setTiming",
          timing: { divider, preTrig },
        });
      }
    }

    if (patch.trigger) {
      const threshold = patch.trigger.threshold ?? device?.trigger?.threshold;
      const channel = patch.trigger.channel ?? device?.trigger?.channel;
      const mode = patch.trigger.mode ?? device?.trigger?.mode;
      if (threshold !== undefined && channel !== undefined && mode !== undefined) {
        state = yield* core.dispatch({
          type: "devices/setTrigger",
          trigger: { threshold, channel, mode },
        });
      }
    }

    if (patch.channelMap) {
      const currentMap = state.device?.channelMap ?? [];
      for (const [channel, variable] of patch.channelMap.entries()) {
        if (currentMap[channel] !== variable) {
          state = yield* core.dispatch({ type: "devices/setChannelMap", channel, variable });
        }
      }
    }

    if (patch.rtValues) {
      for (const [index, value] of Object.entries(patch.rtValues)) {
        state = yield* core.dispatch({
          type: "devices/setRtValue",
          index: Number(index),
          value,
        });
      }
    }

    return state;
  });
}
