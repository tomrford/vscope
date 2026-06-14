import { Context, Effect, Option } from "effect";

import type { PersistenceError } from "./errors.ts";
import type {
  PersistentId,
  Preferences,
  PreferencesPatch,
  PreferencesState,
  SavedDevice,
  SavedDeviceDraft,
  SavedDeviceIdentity,
  Settings,
  SettingsPatch,
  SettingsState,
  SnapshotComparison,
  SnapshotComparisonDraft,
  SnapshotDraft,
  SnapshotListQuery,
  SnapshotRecord,
  SnapshotSampleBlob,
  SnapshotSamplesWrite,
} from "./model.ts";

export type OpenPersistenceOptions = {
  readonly path: string;
  readonly migrate?: boolean;
};

export type PersistenceService = {
  readonly path: string;
  readonly readSettings: Effect.Effect<SettingsState, PersistenceError>;
  readonly writeSettings: (settings: Settings) => Effect.Effect<SettingsState, PersistenceError>;
  readonly patchSettings: (patch: SettingsPatch) => Effect.Effect<SettingsState, PersistenceError>;
  readonly resetSettings: Effect.Effect<SettingsState, PersistenceError>;
  readonly readPreferences: Effect.Effect<PreferencesState, PersistenceError>;
  readonly writePreferences: (
    preferences: Preferences,
  ) => Effect.Effect<PreferencesState, PersistenceError>;
  readonly patchPreferences: (
    patch: PreferencesPatch,
  ) => Effect.Effect<PreferencesState, PersistenceError>;
  readonly resetPreferences: Effect.Effect<PreferencesState, PersistenceError>;
  readonly listSavedDevices: Effect.Effect<ReadonlyArray<SavedDevice>, PersistenceError>;
  readonly getSavedDevice: (
    id: PersistentId,
  ) => Effect.Effect<Option.Option<SavedDevice>, PersistenceError>;
  readonly findSavedDeviceByIdentity: (
    identity: SavedDeviceIdentity,
  ) => Effect.Effect<Option.Option<SavedDevice>, PersistenceError>;
  readonly upsertSavedDevice: (
    draft: SavedDeviceDraft,
  ) => Effect.Effect<SavedDevice, PersistenceError>;
  readonly forgetSavedDevice: (id: PersistentId) => Effect.Effect<void, PersistenceError>;
  readonly createSnapshot: (
    draft: SnapshotDraft,
    samples?: SnapshotSamplesWrite,
  ) => Effect.Effect<SnapshotRecord, PersistenceError>;
  readonly listSnapshots: (
    query?: SnapshotListQuery,
  ) => Effect.Effect<ReadonlyArray<SnapshotRecord>, PersistenceError>;
  readonly getSnapshot: (
    id: PersistentId,
  ) => Effect.Effect<Option.Option<SnapshotRecord>, PersistenceError>;
  readonly renameSnapshot: (
    id: PersistentId,
    label: string,
  ) => Effect.Effect<SnapshotRecord, PersistenceError>;
  readonly deleteSnapshot: (id: PersistentId) => Effect.Effect<void, PersistenceError>;
  readonly writeSnapshotSamples: (
    id: PersistentId,
    samples: SnapshotSamplesWrite,
  ) => Effect.Effect<SnapshotRecord, PersistenceError>;
  readonly readSnapshotSamples: (
    id: PersistentId,
  ) => Effect.Effect<Option.Option<SnapshotSampleBlob>, PersistenceError>;
  readonly createSnapshotComparison: (
    draft: SnapshotComparisonDraft,
  ) => Effect.Effect<SnapshotComparison, PersistenceError>;
  readonly listSnapshotComparisons: Effect.Effect<
    ReadonlyArray<SnapshotComparison>,
    PersistenceError
  >;
  readonly renameSnapshotComparison: (
    id: PersistentId,
    label: string,
  ) => Effect.Effect<SnapshotComparison, PersistenceError>;
  readonly deleteSnapshotComparison: (id: PersistentId) => Effect.Effect<void, PersistenceError>;
};

export class Persistence extends Context.Service<Persistence, PersistenceService>()(
  "@vscope/persistence/Persistence",
) {}
