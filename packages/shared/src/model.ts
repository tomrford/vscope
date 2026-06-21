import { Effect, Schema } from "effect";
import { TriggerMode } from "./trigger.ts";

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const NonNegativeFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const NonEmptyString = Schema.String.check(Schema.isMinLength(1));

export const SNAPSHOT_SAMPLE_FORMAT = "f32le-interleaved-v1";

export const JsonObject = Schema.Record(Schema.String, Schema.Json);
export type JsonObject = Schema.Schema.Type<typeof JsonObject>;

export const PersistentId = NonEmptyString.pipe(Schema.brand("PersistentId"));
export type PersistentId = Schema.Schema.Type<typeof PersistentId>;

export const Timestamp = NonEmptyString.pipe(Schema.brand("Timestamp"));
export type Timestamp = Schema.Schema.Type<typeof Timestamp>;

export const Theme = Schema.Literals(["system", "light", "dark"]);
export type Theme = Schema.Schema.Type<typeof Theme>;

export const SerialParity = Schema.Literals(["none", "even", "mark", "odd", "space"]);
export type SerialParity = Schema.Schema.Type<typeof SerialParity>;

export class SerialConfig extends Schema.Class<SerialConfig>("SerialConfig")({
  baudRate: PositiveInt,
  dataBits: Schema.Literals([5, 6, 7, 8]),
  stopBits: Schema.Literals([1, 1.5, 2]),
  parity: SerialParity,
  dtr: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  rts: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
}) {}

export const DEFAULT_SERIAL_CONFIG = SerialConfig.make({
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: "none",
  dtr: true,
  rts: true,
});

export class PollingSettings extends Schema.Class<PollingSettings>("PollingSettings")({
  stateHz: Schema.Finite.check(Schema.isBetween({ minimum: 0.1, maximum: 50 })),
  frameHz: Schema.Finite.check(Schema.isBetween({ minimum: 0.1, maximum: 100 })),
  serialTimeoutMs: PositiveInt,
  retryAttempts: NonNegativeInt,
}) {}

export class SnapshotSettings extends Schema.Class<SnapshotSettings>("SnapshotSettings")({
  autoSave: Schema.Boolean,
  retentionDays: Schema.Union([
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3650 })),
    Schema.Literals(["never"]),
  ]),
}) {}

export class LiveViewSettings extends Schema.Class<LiveViewSettings>("LiveViewSettings")({
  bufferDurationSeconds: Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 3600 })),
}) {}

export class NetworkSettings extends Schema.Class<NetworkSettings>("NetworkSettings")({
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
}) {}

export class Settings extends Schema.Class<Settings>("Settings")({
  theme: Theme,
  defaultSerialConfig: SerialConfig,
  polling: PollingSettings,
  snapshots: SnapshotSettings,
  liveView: LiveViewSettings,
  network: NetworkSettings,
}) {}

export type SettingsPatch = Partial<{
  readonly theme: Theme;
  readonly defaultSerialConfig: SerialConfig;
  readonly polling: PollingSettings;
  readonly snapshots: SnapshotSettings;
  readonly liveView: LiveViewSettings;
  readonly network: NetworkSettings;
}>;

export const DEFAULT_SETTINGS = Settings.make({
  theme: "system",
  defaultSerialConfig: DEFAULT_SERIAL_CONFIG,
  polling: PollingSettings.make({
    stateHz: 4,
    frameHz: 30,
    serialTimeoutMs: 500,
    retryAttempts: 2,
  }),
  snapshots: SnapshotSettings.make({
    autoSave: false,
    retentionDays: "never",
  }),
  liveView: LiveViewSettings.make({
    bufferDurationSeconds: 30,
  }),
  network: NetworkSettings.make({
    port: 5174,
  }),
});

export class RecoveryState extends Schema.Class<RecoveryState>("RecoveryState")({
  pending: Schema.Boolean,
  message: Schema.NullOr(Schema.String),
}) {}

export const noRecovery = RecoveryState.make({
  pending: false,
  message: null,
});

export function recovery(message: string): RecoveryState {
  return RecoveryState.make({
    pending: true,
    message,
  });
}

export class SettingsState extends Schema.Class<SettingsState>("SettingsState")({
  settings: Settings,
  recovery: RecoveryState,
}) {}

export class SnapshotDeviceRef extends Schema.Class<SnapshotDeviceRef>("SnapshotDeviceRef")({
  name: Schema.String,
}) {}

export class SnapshotTrigger extends Schema.Class<SnapshotTrigger>("SnapshotTrigger")({
  threshold: Schema.Finite,
  channel: NonNegativeInt,
  mode: TriggerMode,
}) {}

export class SnapshotSampleDescriptor extends Schema.Class<SnapshotSampleDescriptor>(
  "SnapshotSampleDescriptor",
)({
  format: Schema.Literals([SNAPSHOT_SAMPLE_FORMAT]),
  channelCount: PositiveInt,
  sampleCount: NonNegativeInt,
  byteLength: NonNegativeInt,
  stored: Schema.Boolean,
}) {}

export class SnapshotDraft extends Schema.Class<SnapshotDraft>("SnapshotDraft")({
  id: Schema.optionalKey(PersistentId),
  label: NonEmptyString,
  device: SnapshotDeviceRef,
  channelCount: PositiveInt,
  sampleCount: NonNegativeInt,
  sampleRateHz: Schema.NullOr(NonNegativeFinite),
  totalDurationSeconds: NonNegativeFinite,
  preTriggerSeconds: NonNegativeFinite,
  channelMap: Schema.Array(NonNegativeInt),
  trigger: SnapshotTrigger,
  rtValues: Schema.Array(Schema.Finite),
  metadata: JsonObject,
  createdAt: Schema.optionalKey(Timestamp),
}) {}

export class SnapshotRecord extends Schema.Class<SnapshotRecord>("SnapshotRecord")({
  id: PersistentId,
  label: NonEmptyString,
  device: SnapshotDeviceRef,
  sample: SnapshotSampleDescriptor,
  sampleRateHz: Schema.NullOr(NonNegativeFinite),
  totalDurationSeconds: NonNegativeFinite,
  preTriggerSeconds: NonNegativeFinite,
  channelMap: Schema.Array(NonNegativeInt),
  trigger: SnapshotTrigger,
  rtValues: Schema.Array(Schema.Finite),
  metadata: JsonObject,
  createdAt: Timestamp,
  updatedAt: Timestamp,
}) {}

export class SnapshotSamplesWrite extends Schema.Class<SnapshotSamplesWrite>(
  "SnapshotSamplesWrite",
)({
  format: Schema.Literals([SNAPSHOT_SAMPLE_FORMAT]),
  data: Schema.Uint8Array,
}) {}

export class SnapshotSampleBlob extends Schema.Class<SnapshotSampleBlob>("SnapshotSampleBlob")({
  snapshotId: PersistentId,
  format: Schema.Literals([SNAPSHOT_SAMPLE_FORMAT]),
  channelCount: PositiveInt,
  sampleCount: NonNegativeInt,
  byteLength: NonNegativeInt,
  data: Schema.Uint8Array,
  updatedAt: Timestamp,
}) {}

export class SnapshotListQuery extends Schema.Class<SnapshotListQuery>("SnapshotListQuery")({
  limit: Schema.optionalKey(PositiveInt),
}) {}

export function snapshotSampleByteLength(channelCount: number, sampleCount: number): number {
  return channelCount * sampleCount * Float32Array.BYTES_PER_ELEMENT;
}
