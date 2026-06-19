import { Effect, Layer, Schema } from "effect";
import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcSchema } from "effect/unstable/rpc";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import {
  LiveViewSettings,
  NetworkSettings,
  PersistentId,
  PollingSettings,
  Preferences,
  RecoveryState,
  SavedDevice,
  SerialConfig,
  Settings,
  SnapshotRecord,
  SnapshotSettings,
  Theme,
} from "./model.ts";
import { TriggerMode } from "./trigger.ts";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

export const RuntimeMcpTool = Schema.Literals([
  "vscope_get_app",
  "vscope_list_ports",
  "vscope_get_active_device",
  "vscope_connect_device",
  "vscope_disconnect_device",
  "vscope_get_device_status",
  "vscope_run_device",
  "vscope_stop_device",
  "vscope_trigger_device",
  "vscope_read_config",
  "vscope_write_config",
  "vscope_read_frame",
  "vscope_capture_snapshot",
  "vscope_list_snapshots",
]);
export type RuntimeMcpTool = Schema.Schema.Type<typeof RuntimeMcpTool>;

export class RuntimeConnectRequest extends Schema.Class<RuntimeConnectRequest>(
  "RuntimeConnectRequest",
)({
  path: Schema.String.check(Schema.isMinLength(1)),
}) {}

export class RuntimeSetTimingRequest extends Schema.Class<RuntimeSetTimingRequest>(
  "RuntimeSetTimingRequest",
)({
  divider: PositiveInt,
  preTrig: NonNegativeInt,
}) {}

export class RuntimeSetTriggerRequest extends Schema.Class<RuntimeSetTriggerRequest>(
  "RuntimeSetTriggerRequest",
)({
  threshold: Schema.Finite,
  channel: NonNegativeInt,
  mode: TriggerMode,
}) {}

export class RuntimeTimingPatch extends Schema.Class<RuntimeTimingPatch>("RuntimeTimingPatch")({
  divider: Schema.optionalKey(PositiveInt),
  preTrig: Schema.optionalKey(NonNegativeInt),
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

export class RuntimeSettingsPatchRequest extends Schema.Class<RuntimeSettingsPatchRequest>(
  "RuntimeSettingsPatchRequest",
)({
  theme: Schema.optionalKey(Theme),
  defaultSerialConfig: Schema.optionalKey(SerialConfig),
  polling: Schema.optionalKey(PollingSettings),
  snapshots: Schema.optionalKey(SnapshotSettings),
  liveView: Schema.optionalKey(LiveViewSettings),
  network: Schema.optionalKey(NetworkSettings),
}) {}

export class RuntimePreferencesPatchRequest extends Schema.Class<RuntimePreferencesPatchRequest>(
  "RuntimePreferencesPatchRequest",
)({
  recentPortPaths: Schema.optionalKey(Schema.Array(Schema.String)),
  favoriteSnapshotIds: Schema.optionalKey(Schema.Array(PersistentId)),
  favoriteDeviceIds: Schema.optionalKey(Schema.Array(PersistentId)),
  showAdvancedControls: Schema.optionalKey(Schema.Boolean),
}) {}

export class RuntimeMcpJsonRpcRequest extends Schema.Class<RuntimeMcpJsonRpcRequest>(
  "RuntimeMcpJsonRpcRequest",
)({
  jsonrpc: Schema.optionalKey(Schema.Literal("2.0")),
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number, Schema.Null])),
  method: Schema.String,
  params: Schema.optionalKey(Schema.Json),
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

export class RuntimeCommandPermissions extends Schema.Class<RuntimeCommandPermissions>(
  "RuntimeCommandPermissions",
)({
  mode: Schema.Literals([
    "empty",
    "disconnected",
    "lost",
    "syncing",
    "halted",
    "running",
    "acquiring",
    "misconfigured",
  ]),
  connect: Schema.Boolean,
  disconnect: Schema.Boolean,
  setTiming: Schema.Boolean,
  setTrigger: Schema.Boolean,
  setRtValue: Schema.Boolean,
  setChannelMap: Schema.Boolean,
  trigger: Schema.Boolean,
  run: Schema.Boolean,
  stop: Schema.Boolean,
  captureSnapshot: Schema.Boolean,
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

export class RuntimeSnapshotRecord extends Schema.Class<RuntimeSnapshotRecord>(
  "RuntimeSnapshotRecord",
)({
  ...SnapshotRecord.fields,
}) {}

export class RuntimeDeviceInfo extends Schema.Class<RuntimeDeviceInfo>("RuntimeDeviceInfo")({
  channelCount: NonNegativeInt,
  bufferSize: NonNegativeInt,
  isrKHz: NonNegativeInt,
  variableCount: NonNegativeInt,
  rtCount: NonNegativeInt,
  rtBufferCapacity: NonNegativeInt,
  nameLength: NonNegativeInt,
  endianness: Schema.Literals([0, 1]),
  deviceName: Schema.String,
}) {}

export class RuntimeActiveDevice extends Schema.Class<RuntimeActiveDevice>("RuntimeActiveDevice")({
  path: Schema.String,
  deviceName: Schema.String,
  connectionStatus: Schema.Literals(["connected", "disconnected", "lost"]),
  info: Schema.NullOr(RuntimeDeviceInfo),
  variables: Schema.Array(Schema.String),
  rtLabels: Schema.Array(Schema.String),
  error: Schema.NullOr(Schema.String),
}) {}

export class RuntimeControlStatus extends Schema.Class<RuntimeControlStatus>(
  "RuntimeControlStatus",
)({
  state: Schema.Literals([0, 1, 2, 3]),
  requestedState: Schema.Literals([0, 1, 2, 3]),
  snapshotValid: Schema.Boolean,
  requestPending: Schema.Boolean,
  triggerEnabled: Schema.Boolean,
  flags: NonNegativeInt,
}) {}

export class RuntimeDeviceConfigPayload extends Schema.Class<RuntimeDeviceConfigPayload>(
  "RuntimeDeviceConfigPayload",
)({
  timing: Schema.NullOr(RuntimeSetTimingRequest),
  trigger: Schema.NullOr(RuntimeSetTriggerRequest),
  channelMap: Schema.Array(NonNegativeInt),
  rtValues: Schema.Array(Schema.Tuple([NonNegativeInt, Schema.Finite])),
}) {}

export class RuntimeWarningDto extends Schema.Class<RuntimeWarningDto>("RuntimeWarningDto")({
  id: Schema.String,
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
  preferences: Preferences,
  preferencesRecovery: RecoveryState,
  savedDevices: Schema.Array(SavedDevice),
  warnings: Schema.Array(RuntimeWarningDto),
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
  Rpc.make("settings.patch", {
    payload: RuntimeSettingsPatchRequest,
    error: RuntimeApiError,
  }),
  Rpc.make("preferences.patch", {
    payload: RuntimePreferencesPatchRequest,
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
  Rpc.make("device.permissions", {
    success: RpcSchema.Stream(RuntimeCommandPermissions, Schema.Never),
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
  Rpc.make("snapshots.list", {
    success: Schema.Array(RuntimeSnapshotRecord),
    error: RuntimeApiError,
  }),
  Rpc.make("snapshots.index", {
    success: RpcSchema.Stream(Schema.Array(RuntimeSnapshotRecord), Schema.Never),
  }),
) {}

export const makeRuntimeRpcClient = (url: string) =>
  RpcClient.make(RuntimeRpcs).pipe(
    Effect.provide(
      RpcClient.layerProtocolHttp({ url }).pipe(
        Layer.provideMerge([FetchHttpClient.layer, RpcSerialization.layerJson]),
      ),
    ),
  );
