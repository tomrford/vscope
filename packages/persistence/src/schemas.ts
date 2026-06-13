import { Schema } from "effect";

export {
  DEFAULT_PREFERENCES,
  DEFAULT_SETTINGS,
  PreferencesSchema,
  PreferencesStateSchema,
  SavedPortConfigSchema,
  SavedPortSchema,
  SettingsSchema,
  SettingsStateSchema,
  SnapshotDraftSchema,
  SnapshotRecordSchema,
  SnapshotSamplesSchema,
  decodeJsonRecord,
  decodeNumberArray,
  decodePreferences,
  decodeSavedPort,
  decodeSavedPortConfig,
  decodeSettings,
  decodeSnapshotDraft,
  decodeSnapshotRecord,
  decodeSnapshotSamples,
  decodeStringArray,
  noRecovery,
  recovery,
  type PartialPreferences,
  type PartialSettings,
  type Preferences,
  type PreferencesState,
  type SavedPort,
  type SavedPortConfig,
  type Settings,
  type SettingsState,
  type SnapshotDraft,
  type SnapshotRecord,
  type SnapshotSamples,
} from "@vscope/shared";

export const SnapshotMetaRowSchema = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  device_names_json: Schema.String,
  channel_count: Schema.Number,
  sample_count: Schema.Number,
  divider: Schema.Number,
  pre_trig: Schema.Number,
  channel_map_json: Schema.String,
  trigger_threshold: Schema.Number,
  trigger_channel: Schema.Number,
  trigger_mode: Schema.String,
  rt_values_json: Schema.String,
  metadata_json: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
});

export const SnapshotDataRowSchema = Schema.Struct({
  data: Schema.Unknown,
  byte_len: Schema.Number,
});

export const decodeSnapshotMetaRow = Schema.decodeUnknownSync(SnapshotMetaRowSchema);
export const decodeSnapshotDataRow = Schema.decodeUnknownSync(SnapshotDataRowSchema);
