import { Context, Effect, Option } from "effect";

import type { PersistenceError } from "./errors.ts";
import type {
  PersistentId,
  Settings,
  SettingsPatch,
  SettingsState,
  SnapshotDraft,
  SnapshotListQuery,
  SnapshotRecord,
  SnapshotSampleBlob,
  SnapshotSamplesWrite,
} from "@vscope/shared";

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
};

export class Persistence extends Context.Service<Persistence, PersistenceService>()(
  "@vscope/persistence/Persistence",
) {}
