import { Effect, Layer, Schema } from "effect";
import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcSchema } from "effect/unstable/rpc";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import {
  Preferences,
  PersistentId,
  RecoveryState,
  SavedDevice,
  SerialConfig,
  Settings,
  SnapshotRecord,
  LiveViewSettings,
  NetworkSettings,
  PollingSettings,
  SnapshotSettings,
  Theme,
} from "./model.ts";
import { TriggerMode } from "./trigger.ts";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

export const RuntimeMcpTool = Schema.Literals([
  "vscope_get_state",
  "vscope_list_ports",
  "vscope_connect_device",
  "vscope_disconnect_device",
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

export class RuntimeWriteConfigRequest extends Schema.Class<RuntimeWriteConfigRequest>(
  "RuntimeWriteConfigRequest",
)({
  timing: Schema.optionalKey(RuntimeTimingPatch),
  trigger: Schema.optionalKey(RuntimeTriggerPatch),
  channelMap: Schema.optionalKey(Schema.Array(NonNegativeInt)),
  rtValues: Schema.optionalKey(Schema.Record(Schema.String, Schema.Finite)),
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

export class RuntimeFramePayload extends Schema.Class<RuntimeFramePayload>("RuntimeFramePayload")({
  values: Schema.Array(Schema.Finite),
  channelMap: Schema.Array(NonNegativeInt),
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

export class RuntimeDeviceConfigPayload extends Schema.Class<RuntimeDeviceConfigPayload>(
  "RuntimeDeviceConfigPayload",
)({
  connected: Schema.Boolean,
  timing: Schema.NullOr(RuntimeSetTimingRequest),
  trigger: Schema.NullOr(RuntimeSetTriggerRequest),
  channelMap: Schema.Array(NonNegativeInt),
  rtValues: Schema.Array(Schema.Tuple([NonNegativeInt, Schema.Finite])),
  variables: Schema.Array(Schema.String),
  rtLabels: Schema.Array(Schema.String),
  permissions: RuntimeCommandPermissions,
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

export class RuntimeStaticMetadata extends Schema.Class<RuntimeStaticMetadata>(
  "RuntimeStaticMetadata",
)({
  info: RuntimeDeviceInfo,
  variables: Schema.Array(Schema.String),
  rtLabels: Schema.Array(Schema.String),
  channelMap: Schema.Array(NonNegativeInt),
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

export class RuntimeDeviceIntent extends Schema.Class<RuntimeDeviceIntent>("RuntimeDeviceIntent")({
  kind: Schema.Literals([
    "run",
    "stop",
    "trigger",
    "setTiming",
    "setTrigger",
    "setRtValue",
    "setChannelMap",
    "captureSnapshot",
  ]),
  status: Schema.Literals(["pending", "settled", "failed"]),
  sentAt: Schema.String,
  settledAt: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
}) {}

export class RuntimeDeviceDto extends Schema.Class<RuntimeDeviceDto>("RuntimeDeviceDto")({
  path: Schema.String,
  deviceName: Schema.String,
  connectionStatus: Schema.Literals(["connected", "disconnected", "lost"]),
  info: Schema.NullOr(RuntimeDeviceInfo),
  metadata: Schema.NullOr(RuntimeStaticMetadata),
  status: Schema.NullOr(RuntimeControlStatus),
  state: Schema.NullOr(Schema.Number),
  requestedState: Schema.NullOr(Schema.Number),
  requestPending: Schema.Boolean,
  snapshotAvailability: Schema.Literals(["unknown", "not-ready", "ready"]),
  intent: Schema.NullOr(RuntimeDeviceIntent),
  timing: Schema.NullOr(RuntimeSetTimingRequest),
  trigger: Schema.NullOr(RuntimeSetTriggerRequest),
  channelMap: Schema.NullOr(Schema.Array(NonNegativeInt)),
  frame: Schema.NullOr(Schema.Array(Schema.Finite)),
  rtValues: Schema.Array(Schema.Tuple([NonNegativeInt, Schema.Finite])),
  lastFrameAt: Schema.NullOr(Schema.String),
  lastSeenAt: Schema.String,
  error: Schema.NullOr(Schema.String),
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

export class RuntimeStateDto extends Schema.Class<RuntimeStateDto>("RuntimeStateDto")({
  bootedAt: Schema.String,
  updatedAt: Schema.String,
  status: Schema.Literals(["ready", "degraded"]),
  settings: Settings,
  settingsRecovery: RecoveryState,
  preferences: Preferences,
  preferencesRecovery: RecoveryState,
  savedDevices: Schema.Array(SavedDevice),
  snapshots: Schema.Array(RuntimeSnapshotRecord),
  device: Schema.NullOr(RuntimeDeviceDto),
  permissions: RuntimeCommandPermissions,
  warnings: Schema.Array(RuntimeWarningDto),
  logs: Schema.Array(RuntimeLogEntryDto),
}) {}

export class RuntimeRpcs extends RpcGroup.make(
  Rpc.make("runtime.getState", {
    success: RuntimeStateDto,
    error: RuntimeApiError,
  }),
  Rpc.make("runtime.status", {
    success: RuntimeStateDto,
    stream: true,
  }),
  Rpc.make("settings.patch", {
    payload: RuntimeSettingsPatchRequest,
    success: RuntimeStateDto,
    error: RuntimeApiError,
  }),
  Rpc.make("preferences.patch", {
    payload: RuntimePreferencesPatchRequest,
    success: RuntimeStateDto,
    error: RuntimeApiError,
  }),
  Rpc.make("ports.list", {
    success: Schema.Array(RuntimePortInfo),
    error: RuntimeApiError,
  }),
  Rpc.make("device.connect", {
    payload: RuntimeConnectRequest,
    success: RuntimeStateDto,
    error: RuntimeApiError,
  }),
  Rpc.make("device.disconnect", {
    success: RuntimeStateDto,
    error: RuntimeApiError,
  }),
  Rpc.make("device.run", {
    success: RuntimeStateDto,
    error: RuntimeApiError,
  }),
  Rpc.make("device.stop", {
    success: RuntimeStateDto,
    error: RuntimeApiError,
  }),
  Rpc.make("device.trigger", {
    success: RuntimeStateDto,
    error: RuntimeApiError,
  }),
  Rpc.make("device.setTiming", {
    payload: RuntimeSetTimingRequest,
    success: RuntimeStateDto,
    error: RuntimeApiError,
  }),
  Rpc.make("device.setTrigger", {
    payload: RuntimeSetTriggerRequest,
    success: RuntimeStateDto,
    error: RuntimeApiError,
  }),
  Rpc.make("device.setRtValue", {
    payload: RuntimeSetRtValueRequest,
    success: RuntimeStateDto,
    error: RuntimeApiError,
  }),
  Rpc.make("device.setChannelMap", {
    payload: RuntimeSetChannelMapRequest,
    success: RuntimeStateDto,
    error: RuntimeApiError,
  }),
  Rpc.make("device.frame", {
    success: RpcSchema.Stream(RuntimeFramePayload, Schema.Never),
  }),
  Rpc.make("snapshots.capture", {
    payload: RuntimeSnapshotCaptureRequest,
    success: RuntimeSnapshotRecord,
    error: RuntimeApiError,
  }),
  Rpc.make("snapshots.list", {
    success: Schema.Array(RuntimeSnapshotRecord),
    error: RuntimeApiError,
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
