import { Effect, Layer, Schema } from "effect";
import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcSchema } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

import {
  LiveViewSettings,
  NetworkSettings,
  PollingSettings,
  PersistentId,
  RecoveryState,
  SerialConfig,
  Settings,
  SnapshotRecord,
  SnapshotSettings,
  Theme,
} from "./model.ts";
import { TriggerMode } from "./trigger.ts";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

// Route surface of the runtime daemon. Server routing and every client derive
// their paths from here.
export const RuntimeEndpoint = {
  health: "/health",
  rpc: "/rpc",
  mcp: "/mcp",
  snapshots: "/snapshots",
} as const;

export const runtimeRpcUrl = (base: string | URL): string =>
  new URL(RuntimeEndpoint.rpc, base).toString();

export const runtimeRpcSocketUrl = (base: string | URL): string => {
  const url = new URL(RuntimeEndpoint.rpc, base);
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  }
  return url.toString();
};

// NDJSON, not JSON: streaming RPCs are newline-framed messages. JSON
// serialization expects one complete payload per decode and so never delivers a
// stream that doesn't terminate. Server and client both provide this layer so
// the two sides cannot desync.
export const RuntimeRpcSerialization = RpcSerialization.layerNdjson;

export class RuntimeConnectRequest extends Schema.Class<RuntimeConnectRequest>(
  "RuntimeConnectRequest",
)({
  path: Schema.String.check(Schema.isMinLength(1)),
}) {}

export class RuntimeSetTimingRequest extends Schema.Class<RuntimeSetTimingRequest>(
  "RuntimeSetTimingRequest",
)({
  totalDurationSeconds: Schema.Finite.check(Schema.isGreaterThan(0)),
  preTriggerSeconds: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
}) {}

export class RuntimeSetTriggerRequest extends Schema.Class<RuntimeSetTriggerRequest>(
  "RuntimeSetTriggerRequest",
)({
  threshold: Schema.Finite,
  channel: NonNegativeInt,
  mode: TriggerMode,
}) {}

export class RuntimeTimingPatch extends Schema.Class<RuntimeTimingPatch>("RuntimeTimingPatch")({
  totalDurationSeconds: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThan(0))),
  preTriggerSeconds: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
}) {}

export class RuntimeTriggerPatch extends Schema.Class<RuntimeTriggerPatch>("RuntimeTriggerPatch")({
  threshold: Schema.optionalKey(Schema.Finite),
  channel: Schema.optionalKey(NonNegativeInt),
  mode: Schema.optionalKey(TriggerMode),
}) {}

export class RuntimeSetRtValueRequest extends Schema.Class<RuntimeSetRtValueRequest>(
  "RuntimeSetRtValueRequest",
)({
  index: NonNegativeInt,
  value: Schema.Finite,
}) {}

export class RuntimeSetChannelMapRequest extends Schema.Class<RuntimeSetChannelMapRequest>(
  "RuntimeSetChannelMapRequest",
)({
  channel: NonNegativeInt,
  variable: NonNegativeInt,
}) {}

export class RuntimeSnapshotCaptureRequest extends Schema.Class<RuntimeSnapshotCaptureRequest>(
  "RuntimeSnapshotCaptureRequest",
)({
  label: Schema.optionalKey(Schema.String),
}) {}

export class RuntimeSnapshotIdRequest extends Schema.Class<RuntimeSnapshotIdRequest>(
  "RuntimeSnapshotIdRequest",
)({
  id: PersistentId,
}) {}

export class RuntimeSnapshotFavoriteRequest extends Schema.Class<RuntimeSnapshotFavoriteRequest>(
  "RuntimeSnapshotFavoriteRequest",
)({
  id: PersistentId,
  favorite: Schema.Boolean,
}) {}

const RuntimeSerialConfigPatch = Schema.Struct({
  baudRate: Schema.optionalKey(SerialConfig.fields.baudRate),
  dataBits: Schema.optionalKey(SerialConfig.fields.dataBits),
  stopBits: Schema.optionalKey(SerialConfig.fields.stopBits),
  parity: Schema.optionalKey(SerialConfig.fields.parity),
  dtr: Schema.optionalKey(SerialConfig.fields.dtr),
  rts: Schema.optionalKey(SerialConfig.fields.rts),
});

const RuntimePollingSettingsPatch = Schema.Struct({
  stateHz: Schema.optionalKey(PollingSettings.fields.stateHz),
  frameHz: Schema.optionalKey(PollingSettings.fields.frameHz),
  serialTimeoutMs: Schema.optionalKey(PollingSettings.fields.serialTimeoutMs),
  retryAttempts: Schema.optionalKey(PollingSettings.fields.retryAttempts),
});

const RuntimeSnapshotSettingsPatch = Schema.Struct({
  retentionDays: Schema.optionalKey(SnapshotSettings.fields.retentionDays),
});

const RuntimeLiveViewSettingsPatch = Schema.Struct({
  bufferDurationSeconds: Schema.optionalKey(LiveViewSettings.fields.bufferDurationSeconds),
});

const RuntimeNetworkSettingsPatch = Schema.Struct({
  port: Schema.optionalKey(NetworkSettings.fields.port),
});

export class RuntimeSettingsPatchRequest extends Schema.Class<RuntimeSettingsPatchRequest>(
  "RuntimeSettingsPatchRequest",
)({
  theme: Schema.optionalKey(Theme),
  defaultSerialConfig: Schema.optionalKey(RuntimeSerialConfigPatch),
  polling: Schema.optionalKey(RuntimePollingSettingsPatch),
  snapshots: Schema.optionalKey(RuntimeSnapshotSettingsPatch),
  liveView: Schema.optionalKey(RuntimeLiveViewSettingsPatch),
  network: Schema.optionalKey(RuntimeNetworkSettingsPatch),
}) {}

export class RuntimeApiError extends Schema.TaggedErrorClass<RuntimeApiError>("RuntimeApiError")(
  "RuntimeApiError",
  {
    message: Schema.String,
  },
) {}

export class RuntimeDeviceLost extends Schema.TaggedErrorClass<RuntimeDeviceLost>(
  "RuntimeDeviceLost",
)("RuntimeDeviceLost", {
  reason: Schema.String,
}) {}

export class RuntimeFramePayload extends Schema.Class<RuntimeFramePayload>("RuntimeFramePayload")({
  values: Schema.Array(Schema.Finite),
}) {}

export class RuntimePortInfo extends Schema.Class<RuntimePortInfo>("RuntimePortInfo")({
  path: Schema.String,
  manufacturer: Schema.optionalKey(Schema.String),
  serialNumber: Schema.optionalKey(Schema.String),
  pnpId: Schema.optionalKey(Schema.String),
  locationId: Schema.optionalKey(Schema.String),
  productId: Schema.optionalKey(Schema.String),
  vendorId: Schema.optionalKey(Schema.String),
}) {}

export class RuntimeDeviceInfo extends Schema.Class<RuntimeDeviceInfo>("RuntimeDeviceInfo")({
  channelCount: NonNegativeInt,
  bufferSize: NonNegativeInt,
  isrKHz: NonNegativeInt,
  variableCount: NonNegativeInt,
  rtCount: NonNegativeInt,
  nameLength: NonNegativeInt,
  endianness: Schema.Literals([0, 1]),
  deviceName: Schema.String,
}) {}

export class RuntimeActiveDevice extends Schema.Class<RuntimeActiveDevice>("RuntimeActiveDevice")({
  path: Schema.String,
  deviceName: Schema.String,
  connected: Schema.Boolean,
  info: Schema.NullOr(RuntimeDeviceInfo),
  variables: Schema.Array(Schema.String),
  rtLabels: Schema.Array(Schema.String),
  error: Schema.NullOr(Schema.String),
}) {}

export const RuntimeDeviceState = Schema.Literals([
  "halted",
  "running",
  "acquiring",
  "misconfigured",
]);
export type RuntimeDeviceState = Schema.Schema.Type<typeof RuntimeDeviceState>;

export class RuntimeControlStatus extends Schema.Class<RuntimeControlStatus>(
  "RuntimeControlStatus",
)({
  state: RuntimeDeviceState,
  snapshotValid: Schema.Boolean,
}) {}

export class RuntimeDeviceConfigPayload extends Schema.Class<RuntimeDeviceConfigPayload>(
  "RuntimeDeviceConfigPayload",
)({
  timing: Schema.NullOr(RuntimeSetTimingRequest),
  trigger: Schema.NullOr(RuntimeSetTriggerRequest),
  channelMap: Schema.Array(NonNegativeInt),
  rtValues: Schema.Array(Schema.Tuple([NonNegativeInt, Schema.Finite])),
}) {}

export const RuntimeActivityLevel = Schema.Literals(["warning", "error"]);
export type RuntimeActivityLevel = Schema.Schema.Type<typeof RuntimeActivityLevel>;

export class RuntimeActivityEntryDto extends Schema.Class<RuntimeActivityEntryDto>(
  "RuntimeActivityEntryDto",
)({
  id: Schema.String,
  level: RuntimeActivityLevel,
  message: Schema.String,
  createdAt: Schema.String,
}) {}

export class RuntimeLogEntryDto extends Schema.Class<RuntimeLogEntryDto>("RuntimeLogEntryDto")({
  id: Schema.String,
  message: Schema.String,
  createdAt: Schema.String,
}) {}

export class RuntimeAppDto extends Schema.Class<RuntimeAppDto>("RuntimeAppDto")({
  bootedAt: Schema.String,
  updatedAt: Schema.String,
  status: Schema.Literals(["ready", "degraded"]),
  settings: Settings,
  settingsRecovery: RecoveryState,
  activity: Schema.Array(RuntimeActivityEntryDto),
  logs: Schema.Array(RuntimeLogEntryDto),
}) {}

export class RuntimeRpcs extends RpcGroup.make(
  Rpc.make("runtime.getApp", {
    success: RuntimeAppDto,
    error: RuntimeApiError,
  }),
  Rpc.make("runtime.app", {
    success: RpcSchema.Stream(RuntimeAppDto, Schema.Never),
  }),
  Rpc.make("activity.clear", {
    error: RuntimeApiError,
  }),
  Rpc.make("settings.patch", {
    payload: RuntimeSettingsPatchRequest,
    error: RuntimeApiError,
  }),
  Rpc.make("ports.list", {
    success: Schema.Array(RuntimePortInfo),
    error: RuntimeApiError,
  }),
  Rpc.make("device.active.get", {
    success: Schema.NullOr(RuntimeActiveDevice),
  }),
  Rpc.make("device.active", {
    success: RpcSchema.Stream(Schema.NullOr(RuntimeActiveDevice), Schema.Never),
  }),
  Rpc.make("device.connect", {
    payload: RuntimeConnectRequest,
    error: RuntimeApiError,
  }),
  Rpc.make("device.disconnect", {
    error: RuntimeApiError,
  }),
  Rpc.make("device.status.get", {
    success: Schema.NullOr(RuntimeControlStatus),
  }),
  Rpc.make("device.status", {
    success: RpcSchema.Stream(Schema.NullOr(RuntimeControlStatus), Schema.Never),
  }),
  Rpc.make("device.run", {
    error: RuntimeApiError,
  }),
  Rpc.make("device.stop", {
    error: RuntimeApiError,
  }),
  Rpc.make("device.trigger", {
    error: RuntimeApiError,
  }),
  Rpc.make("device.config.get", {
    success: Schema.NullOr(RuntimeDeviceConfigPayload),
  }),
  Rpc.make("device.config", {
    success: RpcSchema.Stream(Schema.NullOr(RuntimeDeviceConfigPayload), Schema.Never),
  }),
  Rpc.make("device.setTiming", {
    payload: RuntimeSetTimingRequest,
    error: RuntimeApiError,
  }),
  Rpc.make("device.setTrigger", {
    payload: RuntimeSetTriggerRequest,
    error: RuntimeApiError,
  }),
  Rpc.make("device.setRtValue", {
    payload: RuntimeSetRtValueRequest,
    error: RuntimeApiError,
  }),
  Rpc.make("device.setChannelMap", {
    payload: RuntimeSetChannelMapRequest,
    error: RuntimeApiError,
  }),
  Rpc.make("device.frame.get", {
    success: Schema.NullOr(RuntimeFramePayload),
  }),
  Rpc.make("device.frames", {
    success: RpcSchema.Stream(Schema.NullOr(RuntimeFramePayload), RuntimeDeviceLost),
  }),
  Rpc.make("snapshots.capture", {
    payload: RuntimeSnapshotCaptureRequest,
    error: RuntimeApiError,
  }),
  Rpc.make("snapshots.delete", {
    payload: RuntimeSnapshotIdRequest,
    error: RuntimeApiError,
  }),
  Rpc.make("snapshots.favorite", {
    payload: RuntimeSnapshotFavoriteRequest,
    error: RuntimeApiError,
  }),
  Rpc.make("snapshots.list", {
    success: Schema.Array(SnapshotRecord),
    error: RuntimeApiError,
  }),
  Rpc.make("snapshots.index", {
    success: RpcSchema.Stream(Schema.Array(SnapshotRecord), Schema.Never),
  }),
) {}

export const makeRuntimeRpcClient = (url: string) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const protocol = yield* RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
      Layer.provide(RuntimeRpcSerialization),
      Layer.provide(Socket.layerWebSocket(url)),
      Layer.provide(Socket.layerWebSocketConstructorGlobal),
      Layer.buildWithScope(scope),
    );
    return yield* RpcClient.make(RuntimeRpcs).pipe(Effect.provide(protocol));
  });
