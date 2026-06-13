import { Schema } from "effect";

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const NonNegativeFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

export const SNAPSHOT_SAMPLE_FORMAT = "f32le-interleaved-v1";
export type SnapshotSampleFormat = typeof SNAPSHOT_SAMPLE_FORMAT;

export const ThemeSchema = Schema.Literals(["system", "light", "dark"]);
export type Theme = Schema.Schema.Type<typeof ThemeSchema>;

export const SettingsSchema = Schema.Struct({
  theme: ThemeSchema,
  sampleRetentionSeconds: Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 3600 })),
  defaultDivider: PositiveInt,
  triggerThreshold: Schema.Finite,
  triggerChannel: NonNegativeInt,
});

export type Settings = Schema.Schema.Type<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  sampleRetentionSeconds: 30,
  defaultDivider: 1,
  triggerThreshold: 0,
  triggerChannel: 0,
};

export type PartialSettings = Partial<Settings>;

export const PreferencesSchema = Schema.Struct({
  recentPortPaths: Schema.Array(Schema.String),
  lastPortPath: Schema.NullOr(Schema.String),
  favoriteSnapshotIds: Schema.Array(NonNegativeInt),
  showAdvancedControls: Schema.Boolean,
});

export type Preferences = Schema.Schema.Type<typeof PreferencesSchema>;

export const DEFAULT_PREFERENCES: Preferences = {
  recentPortPaths: [],
  lastPortPath: null,
  favoriteSnapshotIds: [],
  showAdvancedControls: false,
};

export type PartialPreferences = Partial<Preferences>;

export const RecoveryStateSchema = Schema.Struct({
  pending: Schema.Boolean,
  message: Schema.NullOr(Schema.String),
});

export type RecoveryState = Schema.Schema.Type<typeof RecoveryStateSchema>;

export const noRecovery: RecoveryState = {
  pending: false,
  message: null,
};

export function recovery(message: string): RecoveryState {
  return {
    pending: true,
    message,
  };
}

export const SettingsStateSchema = Schema.Struct({
  settings: SettingsSchema,
  recovery: RecoveryStateSchema,
});

export type SettingsState = Schema.Schema.Type<typeof SettingsStateSchema>;

export const PreferencesStateSchema = Schema.Struct({
  preferences: PreferencesSchema,
  recovery: RecoveryStateSchema,
});

export type PreferencesState = Schema.Schema.Type<typeof PreferencesStateSchema>;

export const SerialParitySchema = Schema.Literals(["none", "even", "mark", "odd", "space"]);
export type SerialParity = Schema.Schema.Type<typeof SerialParitySchema>;

export const SerialPortConfigSchema = Schema.Struct({
  baudRate: PositiveInt,
  dataBits: Schema.optionalKey(Schema.Literals([5, 6, 7, 8])),
  stopBits: Schema.optionalKey(Schema.Literals([1, 1.5, 2])),
  parity: Schema.optionalKey(SerialParitySchema),
  rtscts: Schema.optionalKey(Schema.Boolean),
  xon: Schema.optionalKey(Schema.Boolean),
  xoff: Schema.optionalKey(Schema.Boolean),
  xany: Schema.optionalKey(Schema.Boolean),
  hupcl: Schema.optionalKey(Schema.Boolean),
});

export type SerialPortConfig = Schema.Schema.Type<typeof SerialPortConfigSchema>;

export const DEFAULT_SERIAL_PORT_CONFIG: SerialPortConfig = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: "none",
};

export const SerialPortInfoSchema = Schema.Struct({
  path: Schema.String,
  manufacturer: Schema.optionalKey(Schema.String),
  serialNumber: Schema.optionalKey(Schema.String),
  pnpId: Schema.optionalKey(Schema.String),
  locationId: Schema.optionalKey(Schema.String),
  productId: Schema.optionalKey(Schema.String),
  vendorId: Schema.optionalKey(Schema.String),
});

export type SerialPortInfo = Schema.Schema.Type<typeof SerialPortInfoSchema>;

export const SerialPortSelectionSchema = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1)),
  config: SerialPortConfigSchema,
});

export type SerialPortSelection = Schema.Schema.Type<typeof SerialPortSelectionSchema>;

export const SavedPortConfigSchema = Schema.Record(Schema.String, Schema.Json);
export type SavedPortConfig = Schema.Schema.Type<typeof SavedPortConfigSchema>;

export const SavedPortSchema = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1)),
  lastConfig: SavedPortConfigSchema,
  updatedAt: Schema.String.check(Schema.isMinLength(1)),
});

export type SavedPort = Schema.Schema.Type<typeof SavedPortSchema>;

export const SnapshotRecordSchema = Schema.Struct({
  id: NonNegativeInt,
  label: Schema.String.check(Schema.isMinLength(1)),
  deviceNames: Schema.Array(Schema.String),
  channelCount: PositiveInt,
  sampleCount: NonNegativeInt,
  divider: PositiveInt,
  preTrig: NonNegativeInt,
  channelMap: Schema.Array(NonNegativeInt),
  triggerThreshold: Schema.Finite,
  triggerChannel: NonNegativeInt,
  triggerMode: Schema.String.check(Schema.isMinLength(1)),
  rtValues: Schema.Array(NonNegativeFinite),
  metadata: Schema.Record(Schema.String, Schema.Json),
  createdAt: Schema.String.check(Schema.isMinLength(1)),
  updatedAt: Schema.String.check(Schema.isMinLength(1)),
});

export type SnapshotRecord = Schema.Schema.Type<typeof SnapshotRecordSchema>;

export const SnapshotDraftSchema = Schema.Struct({
  label: Schema.String.check(Schema.isMinLength(1)),
  deviceNames: Schema.Array(Schema.String),
  channelCount: PositiveInt,
  sampleCount: NonNegativeInt,
  divider: PositiveInt,
  preTrig: NonNegativeInt,
  channelMap: Schema.Array(NonNegativeInt),
  triggerThreshold: Schema.Finite,
  triggerChannel: NonNegativeInt,
  triggerMode: Schema.String.check(Schema.isMinLength(1)),
  rtValues: Schema.Array(NonNegativeFinite),
  metadata: Schema.Record(Schema.String, Schema.Json),
  createdAt: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
});

export type SnapshotDraft = Schema.Schema.Type<typeof SnapshotDraftSchema>;

export const SnapshotSamplesSchema = Schema.Array(Schema.Array(Schema.Finite));
export type SnapshotSamples = Schema.Schema.Type<typeof SnapshotSamplesSchema>;

export const SnapshotSamplesBlobSchema = Schema.Struct({
  snapshotId: NonNegativeInt,
  channelCount: PositiveInt,
  sampleCount: NonNegativeInt,
  format: Schema.Literals([SNAPSHOT_SAMPLE_FORMAT]),
  byteLength: NonNegativeInt,
  data: Schema.Uint8Array,
});

export type SnapshotSamplesBlob = Schema.Schema.Type<typeof SnapshotSamplesBlobSchema>;

export const SerialConnectionStateSchema = Schema.TaggedUnion({
  Disconnected: {},
  Connecting: {
    path: Schema.String,
  },
  Connected: {
    path: Schema.String,
    config: SerialPortConfigSchema,
  },
  Error: {
    path: Schema.NullOr(Schema.String),
    message: Schema.String,
  },
});

export type SerialConnectionState = Schema.Schema.Type<typeof SerialConnectionStateSchema>;

export const AppStateSchema = Schema.Struct({
  settings: SettingsStateSchema,
  preferences: PreferencesStateSchema,
  serial: SerialConnectionStateSchema,
  ports: Schema.Array(SerialPortInfoSchema),
  savedPorts: Schema.Array(SavedPortSchema),
  snapshots: Schema.Array(SnapshotRecordSchema),
});

export type AppState = Schema.Schema.Type<typeof AppStateSchema>;

export const RuntimeEventSchema = Schema.TaggedUnion({
  AppStateChanged: {
    state: AppStateSchema,
  },
  PortsChanged: {
    ports: Schema.Array(SerialPortInfoSchema),
  },
  SnapshotSaved: {
    snapshot: SnapshotRecordSchema,
  },
  SnapshotDeleted: {
    id: NonNegativeInt,
  },
});

export type RuntimeEvent = Schema.Schema.Type<typeof RuntimeEventSchema>;

export const decodeSettings = Schema.decodeUnknownSync(SettingsSchema);
export const decodePreferences = Schema.decodeUnknownSync(PreferencesSchema);
export const decodeSavedPort = Schema.decodeUnknownSync(SavedPortSchema);
export const decodeSavedPortConfig = Schema.decodeUnknownSync(SavedPortConfigSchema);
export const decodeSerialPortConfig = Schema.decodeUnknownSync(SerialPortConfigSchema);
export const decodeSerialPortInfo = Schema.decodeUnknownSync(SerialPortInfoSchema);
export const decodeSnapshotRecord = Schema.decodeUnknownSync(SnapshotRecordSchema);
export const decodeSnapshotDraft = Schema.decodeUnknownSync(SnapshotDraftSchema);
export const decodeSnapshotSamples = Schema.decodeUnknownSync(SnapshotSamplesSchema);
export const decodeSnapshotSamplesBlob = Schema.decodeUnknownSync(SnapshotSamplesBlobSchema);
export const decodeAppState = Schema.decodeUnknownSync(AppStateSchema);
export const decodeRuntimeEvent = Schema.decodeUnknownSync(RuntimeEventSchema);
export const decodeStringArray = Schema.decodeUnknownSync(Schema.Array(Schema.String));
export const decodeNumberArray = Schema.decodeUnknownSync(Schema.Array(Schema.Number));
export const decodeJsonRecord = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json));
