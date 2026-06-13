import { Buffer } from "node:buffer";
import fs from "node:fs";
import nodePath from "node:path";

import { Effect } from "effect";

import {
  PersistenceClosedError,
  MigrationError,
  PersistenceOpenError,
  PersistenceQueryError,
  PersistenceValidationError,
  SnapshotNotFoundError,
  errorReason,
} from "./errors";
import { runMigrations } from "./migrations";
import {
  DEFAULT_PREFERENCES,
  DEFAULT_SETTINGS,
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
  decodeJsonRecord,
  decodeNumberArray,
  decodePreferences,
  decodeSavedPort,
  decodeSavedPortConfig,
  decodeSettings,
  decodeSnapshotDraft,
  decodeSnapshotMetaRow,
  decodeSnapshotRecord,
  decodeSnapshotSamples,
  decodeStringArray,
  noRecovery,
  recovery,
} from "./schemas";
import { openSqliteDatabase, type SqliteDatabase } from "./sqlite";

export type OpenPersistenceOptions = {
  readonly path: string;
  readonly migrate?: boolean;
};

type SingletonRow = {
  readonly data_json?: unknown;
  readonly recovery_pending?: unknown;
};

type SnapshotDataRow = {
  readonly data?: unknown;
  readonly byte_len?: unknown;
};

export type SnapshotBlob = {
  readonly data: Uint8Array;
  readonly byteLength: number;
};

export type SnapshotDataTarget = Pick<SnapshotRecord, "id" | "channelCount" | "sampleCount">;

function nowIso(): string {
  return new Date().toISOString();
}

function toOpenOptions(options: string | OpenPersistenceOptions): OpenPersistenceOptions {
  return typeof options === "string" ? { path: options } : options;
}

function parseJson<T>(value: string, decode: (input: unknown) => T): T {
  return decode(JSON.parse(value));
}

function toRecoveryPending(value: unknown): boolean {
  return value === 1 || value === true;
}

function toUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  if (Array.isArray(value)) {
    return new Uint8Array(value);
  }

  if (value && typeof value === "object") {
    const view = value as { buffer?: unknown; byteOffset?: unknown; byteLength?: unknown };
    if (view.buffer instanceof ArrayBuffer) {
      const byteOffset = typeof view.byteOffset === "number" ? view.byteOffset : 0;
      if (typeof view.byteLength === "number") {
        return new Uint8Array(view.buffer, byteOffset, view.byteLength);
      }

      return new Uint8Array(view.buffer, byteOffset);
    }
  }

  throw new Error("Unsupported SQLite blob value");
}

function encodeSnapshotSamples(record: SnapshotDataTarget, samples: SnapshotSamples): Buffer {
  if (samples.length !== record.sampleCount) {
    throw new Error(
      `Snapshot ${record.id} sample count mismatch: expected ${record.sampleCount}, got ${samples.length}`,
    );
  }

  const flat = new Float32Array(record.sampleCount * record.channelCount);
  let offset = 0;

  for (const sample of samples) {
    if (sample.length !== record.channelCount) {
      throw new Error(
        `Snapshot ${record.id} channel count mismatch: expected ${record.channelCount}, got ${sample.length}`,
      );
    }

    for (const value of sample) {
      flat[offset] = value;
      offset += 1;
    }
  }

  const bytes = new Uint8Array(flat.buffer, flat.byteOffset, flat.byteLength);
  return Buffer.from(bytes);
}

function decodeSnapshotSamplesFromBlob(
  record: SnapshotDataTarget,
  blob: unknown,
  byteLen: number,
): SnapshotSamples {
  if (record.channelCount <= 0) {
    throw new Error(`Snapshot ${record.id} has invalid channel count`);
  }

  const bytes = toUint8Array(blob);
  const usableBytes = Math.min(byteLen, bytes.byteLength);
  const floatCount = Math.floor(usableBytes / Float32Array.BYTES_PER_ELEMENT);
  const floats = new Float32Array(bytes.buffer, bytes.byteOffset, floatCount);
  const sampleCount = Math.min(record.sampleCount, Math.floor(floats.length / record.channelCount));
  const samples: number[][] = [];

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const start = sampleIndex * record.channelCount;
    samples.push(Array.from(floats.slice(start, start + record.channelCount)));
  }

  return samples;
}

function sortSavedPorts(savedPorts: ReadonlyArray<SavedPort>): ReadonlyArray<SavedPort> {
  return [...savedPorts].toSorted((left, right) => left.path.localeCompare(right.path));
}

function sortSnapshots(snapshots: ReadonlyArray<SnapshotRecord>): ReadonlyArray<SnapshotRecord> {
  return [...snapshots].toSorted(
    (left, right) => right.createdAt.localeCompare(left.createdAt) || right.id - left.id,
  );
}

function toSnapshotRecord(row: unknown): SnapshotRecord {
  const decodedRow = decodeSnapshotMetaRow(row);
  return decodeSnapshotRecord({
    id: decodedRow.id,
    label: decodedRow.name,
    deviceNames: parseJson(decodedRow.device_names_json, decodeStringArray),
    channelCount: decodedRow.channel_count,
    sampleCount: decodedRow.sample_count,
    divider: decodedRow.divider,
    preTrig: decodedRow.pre_trig,
    channelMap: parseJson(decodedRow.channel_map_json, decodeNumberArray),
    triggerThreshold: decodedRow.trigger_threshold,
    triggerChannel: decodedRow.trigger_channel,
    triggerMode: decodedRow.trigger_mode,
    rtValues: parseJson(decodedRow.rt_values_json, decodeNumberArray),
    metadata: parseJson(decodedRow.metadata_json, decodeJsonRecord),
    createdAt: decodedRow.created_at,
    updatedAt: decodedRow.updated_at,
  });
}

export class PersistenceDatabase {
  #closed = false;

  constructor(
    readonly path: string,
    private readonly database: SqliteDatabase,
  ) {}

  runMigrations() {
    return this.withOpen("run migrations", () => runMigrations(this.database));
  }

  close(): Effect.Effect<void, PersistenceQueryError> {
    if (this.#closed) {
      return Effect.void;
    }

    return Effect.try({
      try: () => {
        this.database.close();
        this.#closed = true;
      },
      catch: (cause) =>
        new PersistenceQueryError({
          operation: "close database",
          reason: errorReason(cause),
          cause,
        }),
    });
  }

  readSettings(): Effect.Effect<Settings, PersistenceClosedError | PersistenceQueryError> {
    return this.readSettingsState().pipe(Effect.map((state) => state.settings));
  }

  readSettingsState(): Effect.Effect<
    SettingsState,
    PersistenceClosedError | PersistenceQueryError
  > {
    return this.readSingleton({
      table: "settings",
      label: "settings",
      defaults: DEFAULT_SETTINGS,
      decode: decodeSettings,
      recoveryMessage: "Corrupt settings were reset to defaults.",
    }).pipe(
      Effect.map(({ value, recoveryState }) => ({
        settings: value,
        recovery: recoveryState,
      })),
    );
  }

  updateSettings(
    patch: PartialSettings,
  ): Effect.Effect<
    Settings,
    PersistenceClosedError | PersistenceQueryError | PersistenceValidationError
  > {
    return Effect.gen(
      function* (this: PersistenceDatabase) {
        const current = yield* this.readSettings();
        const merged = yield* this.validate("update settings", () =>
          decodeSettings({ ...current, ...patch }),
        );
        yield* this.writeSingleton("settings", merged, false);
        return merged;
      }.bind(this),
    );
  }

  resetSettings(): Effect.Effect<Settings, PersistenceClosedError | PersistenceQueryError> {
    return this.writeSingleton("settings", DEFAULT_SETTINGS, false).pipe(
      Effect.as(DEFAULT_SETTINGS),
    );
  }

  readPreferences(): Effect.Effect<Preferences, PersistenceClosedError | PersistenceQueryError> {
    return this.readPreferencesState().pipe(Effect.map((state) => state.preferences));
  }

  readPreferencesState(): Effect.Effect<
    PreferencesState,
    PersistenceClosedError | PersistenceQueryError
  > {
    return this.readSingleton({
      table: "preferences",
      label: "preferences",
      defaults: DEFAULT_PREFERENCES,
      decode: decodePreferences,
      recoveryMessage: "Corrupt preferences were reset to defaults.",
    }).pipe(
      Effect.map(({ value, recoveryState }) => ({
        preferences: value,
        recovery: recoveryState,
      })),
    );
  }

  updatePreferences(
    patch: PartialPreferences,
  ): Effect.Effect<
    Preferences,
    PersistenceClosedError | PersistenceQueryError | PersistenceValidationError
  > {
    return Effect.gen(
      function* (this: PersistenceDatabase) {
        const current = yield* this.readPreferences();
        const merged = yield* this.validate("update preferences", () =>
          decodePreferences({ ...current, ...patch }),
        );
        yield* this.writeSingleton("preferences", merged, false);
        return merged;
      }.bind(this),
    );
  }

  resetPreferences(): Effect.Effect<Preferences, PersistenceClosedError | PersistenceQueryError> {
    return this.writeSingleton("preferences", DEFAULT_PREFERENCES, false).pipe(
      Effect.as(DEFAULT_PREFERENCES),
    );
  }

  listSavedPorts(): Effect.Effect<
    ReadonlyArray<SavedPort>,
    PersistenceClosedError | PersistenceQueryError
  > {
    return Effect.gen(
      function* (this: PersistenceDatabase) {
        const result = yield* this.withOpen("list saved ports", () =>
          Effect.try({
            try: () => {
              const rows = this.database
                .prepare("SELECT path, last_config_json, updated_at FROM saved_ports ORDER BY path")
                .all();
              const savedPorts: SavedPort[] = [];
              const corruptPaths: string[] = [];

              for (const row of rows) {
                try {
                  const candidate = row as {
                    readonly path?: unknown;
                    readonly last_config_json?: unknown;
                    readonly updated_at?: unknown;
                  };
                  const path = String(candidate.path);
                  savedPorts.push(
                    decodeSavedPort({
                      path,
                      lastConfig: parseJson(
                        String(candidate.last_config_json),
                        decodeSavedPortConfig,
                      ),
                      updatedAt: String(candidate.updated_at),
                    }),
                  );
                } catch {
                  const path = (row as { readonly path?: unknown }).path;
                  if (typeof path === "string") {
                    corruptPaths.push(path);
                  }
                }
              }

              for (const path of corruptPaths) {
                this.database.prepare("DELETE FROM saved_ports WHERE path = ?").run(path);
              }

              return {
                savedPorts: sortSavedPorts(savedPorts),
                corruptPaths,
              };
            },
            catch: (cause) => this.queryError("list saved ports", cause),
          }),
        );

        for (const path of result.corruptPaths) {
          yield* Effect.logWarning(`Corrupt saved port dropped: ${path}`);
        }

        return result.savedPorts;
      }.bind(this),
    );
  }

  saveSavedPort(
    path: string,
    lastConfig: SavedPortConfig,
  ): Effect.Effect<
    SavedPort,
    PersistenceClosedError | PersistenceQueryError | PersistenceValidationError
  > {
    return Effect.gen(
      function* (this: PersistenceDatabase) {
        const updatedAt = nowIso();
        const savedPort = yield* this.validate("save saved port", () =>
          decodeSavedPort({ path, lastConfig, updatedAt }),
        );
        const config = yield* this.validate("save saved port config", () =>
          decodeSavedPortConfig(lastConfig),
        );

        yield* this.withOpen("save saved port", () =>
          Effect.try({
            try: () => {
              this.database
                .prepare(
                  `
                  INSERT INTO saved_ports (path, last_config_json, updated_at)
                  VALUES (?, ?, ?)
                  ON CONFLICT (path) DO UPDATE SET
                    last_config_json = excluded.last_config_json,
                    updated_at = excluded.updated_at
                `,
                )
                .run(savedPort.path, JSON.stringify(config), updatedAt);
            },
            catch: (cause) => this.queryError("save saved port", cause),
          }),
        );

        return savedPort;
      }.bind(this),
    );
  }

  forgetSavedPort(
    path: string,
  ): Effect.Effect<void, PersistenceClosedError | PersistenceQueryError> {
    return this.withOpen("forget saved port", () =>
      Effect.try({
        try: () => {
          this.database.prepare("DELETE FROM saved_ports WHERE path = ?").run(path);
        },
        catch: (cause) => this.queryError("forget saved port", cause),
      }),
    );
  }

  saveSnapshot(
    draft: SnapshotDraft,
    samples?: SnapshotSamples,
  ): Effect.Effect<
    SnapshotRecord,
    PersistenceClosedError | PersistenceQueryError | PersistenceValidationError
  > {
    return Effect.gen(
      function* (this: PersistenceDatabase) {
        const decodedDraft = yield* this.validate("save snapshot", () =>
          decodeSnapshotDraft(draft),
        );
        const createdAt = decodedDraft.createdAt ?? nowIso();
        const updatedAt = createdAt;
        const record = yield* this.validate("save snapshot record", () =>
          decodeSnapshotRecord({
            id: 0,
            ...decodedDraft,
            createdAt,
            updatedAt,
          }),
        );
        const blob =
          samples === undefined
            ? null
            : yield* this.validate("encode snapshot samples", () => {
                const decodedSamples = decodeSnapshotSamples(samples);
                return encodeSnapshotSamples(record, decodedSamples);
              });

        const id = yield* this.withOpen("save snapshot", () =>
          Effect.try({
            try: () => {
              const transaction = this.database.transaction(() => {
                const result = this.database
                  .prepare(
                    `
                    INSERT INTO snapshot_meta (
                      name,
                      device_names_json,
                      channel_count,
                      sample_count,
                      divider,
                      pre_trig,
                      channel_map_json,
                      trigger_threshold,
                      trigger_channel,
                      trigger_mode,
                      rt_values_json,
                      metadata_json,
                      created_at,
                      updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  `,
                  )
                  .run(
                    record.label,
                    JSON.stringify(record.deviceNames),
                    record.channelCount,
                    record.sampleCount,
                    record.divider,
                    record.preTrig,
                    JSON.stringify(record.channelMap),
                    record.triggerThreshold,
                    record.triggerChannel,
                    record.triggerMode,
                    JSON.stringify(record.rtValues),
                    JSON.stringify(record.metadata),
                    record.createdAt,
                    record.updatedAt,
                  );

                const insertedId = Number(result.lastInsertRowid);

                if (blob) {
                  this.database
                    .prepare(
                      `
                      INSERT INTO snapshot_data (snapshot_id, data, byte_len, updated_at)
                      VALUES (?, ?, ?, ?)
                    `,
                    )
                    .run(insertedId, blob, blob.byteLength, updatedAt);
                }

                return insertedId;
              });

              return transaction();
            },
            catch: (cause) => this.queryError("save snapshot", cause),
          }),
        );

        return decodeSnapshotRecord({ ...record, id });
      }.bind(this),
    );
  }

  listSnapshots(): Effect.Effect<
    ReadonlyArray<SnapshotRecord>,
    PersistenceClosedError | PersistenceQueryError
  > {
    return Effect.gen(
      function* (this: PersistenceDatabase) {
        const result = yield* this.withOpen("list snapshots", () =>
          Effect.try({
            try: () => {
              const rows = this.database
                .prepare(
                  `
                SELECT
                  id,
                  name,
                  device_names_json,
                  channel_count,
                  sample_count,
                  divider,
                  pre_trig,
                  channel_map_json,
                  trigger_threshold,
                  trigger_channel,
                  trigger_mode,
                  rt_values_json,
                  metadata_json,
                  created_at,
                  updated_at
                FROM snapshot_meta
                ORDER BY created_at DESC, id DESC
              `,
                )
                .all();
              const snapshots: SnapshotRecord[] = [];
              const corruptIds: number[] = [];

              for (const row of rows) {
                try {
                  snapshots.push(toSnapshotRecord(row));
                } catch {
                  const id = (row as { readonly id?: unknown }).id;
                  if (typeof id === "number" && Number.isInteger(id)) {
                    corruptIds.push(id);
                  }
                }
              }

              for (const id of corruptIds) {
                this.database.prepare("DELETE FROM snapshot_meta WHERE id = ?").run(id);
              }

              return {
                snapshots: sortSnapshots(snapshots),
                corruptIds,
              };
            },
            catch: (cause) => this.queryError("list snapshots", cause),
          }),
        );

        for (const id of result.corruptIds) {
          yield* Effect.logWarning(`Corrupt snapshot metadata dropped: ${id}`);
        }

        return result.snapshots;
      }.bind(this),
    );
  }

  renameSnapshot(
    id: number,
    label: string,
  ): Effect.Effect<
    SnapshotRecord,
    | PersistenceClosedError
    | PersistenceQueryError
    | PersistenceValidationError
    | SnapshotNotFoundError
  > {
    return Effect.gen(
      function* (this: PersistenceDatabase) {
        const current = yield* this.getSnapshot(id);
        const updated = yield* this.validate("rename snapshot", () =>
          decodeSnapshotRecord({ ...current, label, updatedAt: nowIso() }),
        );

        yield* this.withOpen("rename snapshot", () =>
          Effect.try({
            try: () => {
              this.database
                .prepare("UPDATE snapshot_meta SET name = ?, updated_at = ? WHERE id = ?")
                .run(updated.label, updated.updatedAt, id);
            },
            catch: (cause) => this.queryError("rename snapshot", cause),
          }),
        );

        return updated;
      }.bind(this),
    );
  }

  deleteSnapshot(id: number): Effect.Effect<void, PersistenceClosedError | PersistenceQueryError> {
    return this.withOpen("delete snapshot", () =>
      Effect.try({
        try: () => {
          this.database.prepare("DELETE FROM snapshot_meta WHERE id = ?").run(id);
        },
        catch: (cause) => this.queryError("delete snapshot", cause),
      }),
    );
  }

  storeSnapshotSamples(
    record: SnapshotDataTarget,
    samples: SnapshotSamples,
  ): Effect.Effect<
    void,
    PersistenceClosedError | PersistenceQueryError | PersistenceValidationError
  > {
    return Effect.gen(
      function* (this: PersistenceDatabase) {
        const blob = yield* this.validate("store snapshot samples", () => {
          const decodedSamples = decodeSnapshotSamples(samples);
          return encodeSnapshotSamples(record, decodedSamples);
        });
        yield* this.storeSnapshotBlob(record.id, blob);
      }.bind(this),
    );
  }

  loadSnapshotSamples(
    record: SnapshotDataTarget,
  ): Effect.Effect<
    SnapshotSamples | null,
    PersistenceClosedError | PersistenceQueryError | PersistenceValidationError
  > {
    return Effect.gen(
      function* (this: PersistenceDatabase) {
        const blob = yield* this.loadSnapshotBlob(record.id);
        if (!blob) {
          return null;
        }

        return yield* this.validate("load snapshot samples", () =>
          decodeSnapshotSamplesFromBlob(record, blob.data, blob.byteLength),
        );
      }.bind(this),
    );
  }

  storeSnapshotBlob(
    snapshotId: number,
    data: Uint8Array,
  ): Effect.Effect<void, PersistenceClosedError | PersistenceQueryError> {
    return this.withOpen("store snapshot blob", () =>
      Effect.try({
        try: () => {
          const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
          this.database
            .prepare(
              `
                INSERT INTO snapshot_data (snapshot_id, data, byte_len, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT (snapshot_id) DO UPDATE SET
                  data = excluded.data,
                  byte_len = excluded.byte_len,
                  updated_at = excluded.updated_at
              `,
            )
            .run(snapshotId, buffer, data.byteLength, nowIso());
        },
        catch: (cause) => this.queryError("store snapshot blob", cause),
      }),
    );
  }

  loadSnapshotBlob(
    snapshotId: number,
  ): Effect.Effect<SnapshotBlob | null, PersistenceClosedError | PersistenceQueryError> {
    return this.withOpen("load snapshot blob", () =>
      Effect.try({
        try: () => {
          const row = this.database
            .prepare("SELECT data, byte_len FROM snapshot_data WHERE snapshot_id = ?")
            .get(snapshotId) as SnapshotDataRow | undefined;

          if (!row) {
            return null;
          }

          const bytes = toUint8Array(row.data);
          const byteLength = typeof row.byte_len === "number" ? row.byte_len : bytes.byteLength;
          return {
            data: bytes.slice(0, Math.min(byteLength, bytes.byteLength)),
            byteLength,
          };
        },
        catch: (cause) => this.queryError("load snapshot blob", cause),
      }),
    );
  }

  private getSnapshot(
    id: number,
  ): Effect.Effect<
    SnapshotRecord,
    PersistenceClosedError | PersistenceQueryError | SnapshotNotFoundError
  > {
    return this.withOpen("get snapshot", () =>
      Effect.try({
        try: () => {
          const row = this.database
            .prepare(
              `
                SELECT
                  id,
                  name,
                  device_names_json,
                  channel_count,
                  sample_count,
                  divider,
                  pre_trig,
                  channel_map_json,
                  trigger_threshold,
                  trigger_channel,
                  trigger_mode,
                  rt_values_json,
                  metadata_json,
                  created_at,
                  updated_at
                FROM snapshot_meta
                WHERE id = ?
              `,
            )
            .get(id);

          if (!row) {
            throw new SnapshotNotFoundError({ id });
          }

          return toSnapshotRecord(row);
        },
        catch: (cause) => {
          if (cause instanceof SnapshotNotFoundError) {
            return cause;
          }

          return this.queryError("get snapshot", cause);
        },
      }),
    );
  }

  private readSingleton<T>(options: {
    readonly table: "settings" | "preferences";
    readonly label: string;
    readonly defaults: T;
    readonly decode: (input: unknown) => T;
    readonly recoveryMessage: string;
  }): Effect.Effect<
    { readonly value: T; readonly recoveryState: SettingsState["recovery"] },
    PersistenceClosedError | PersistenceQueryError
  > {
    return Effect.gen(
      function* (this: PersistenceDatabase) {
        const row = yield* this.withOpen(`read ${options.label}`, () =>
          Effect.try({
            try: () =>
              this.database
                .prepare(`SELECT data_json, recovery_pending FROM ${options.table} WHERE id = 1`)
                .get() as SingletonRow | undefined,
            catch: (cause) => this.queryError(`read ${options.label}`, cause),
          }),
        );

        if (!row) {
          yield* this.writeSingleton(options.table, options.defaults, false);
          return {
            value: options.defaults,
            recoveryState: noRecovery,
          };
        }

        try {
          const value = parseJson(String(row.data_json), options.decode);
          return {
            value,
            recoveryState: toRecoveryPending(row.recovery_pending)
              ? recovery(options.recoveryMessage)
              : noRecovery,
          };
        } catch {
          yield* this.writeSingleton(options.table, options.defaults, true);
          return {
            value: options.defaults,
            recoveryState: recovery(options.recoveryMessage),
          };
        }
      }.bind(this),
    );
  }

  private writeSingleton(
    table: "settings" | "preferences",
    value: unknown,
    recoveryPending: boolean,
  ): Effect.Effect<void, PersistenceClosedError | PersistenceQueryError> {
    return this.withOpen(`write ${table}`, () =>
      Effect.try({
        try: () => {
          this.database
            .prepare(
              `
                INSERT INTO ${table} (id, data_json, recovery_pending, updated_at)
                VALUES (1, ?, ?, ?)
                ON CONFLICT (id) DO UPDATE SET
                  data_json = excluded.data_json,
                  recovery_pending = excluded.recovery_pending,
                  updated_at = excluded.updated_at
              `,
            )
            .run(JSON.stringify(value), recoveryPending ? 1 : 0, nowIso());
        },
        catch: (cause) => this.queryError(`write ${table}`, cause),
      }),
    );
  }

  private validate<T>(
    operation: string,
    run: () => T,
  ): Effect.Effect<T, PersistenceValidationError> {
    return Effect.try({
      try: run,
      catch: (cause) =>
        new PersistenceValidationError({
          operation,
          reason: errorReason(cause),
          cause,
        }),
    });
  }

  private withOpen<A, E>(
    operation: string,
    run: () => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | PersistenceClosedError> {
    if (this.#closed) {
      return Effect.fail(new PersistenceClosedError({ operation }));
    }

    return run();
  }

  private queryError(operation: string, cause: unknown): PersistenceQueryError {
    return new PersistenceQueryError({
      operation,
      reason: errorReason(cause),
      cause,
    });
  }
}

export function openPersistence(
  options: string | OpenPersistenceOptions,
): Effect.Effect<
  PersistenceDatabase,
  PersistenceOpenError | MigrationError | PersistenceClosedError | PersistenceQueryError
> {
  const resolved = toOpenOptions(options);
  const shouldMigrate = resolved.migrate !== false;

  return Effect.gen(function* () {
    const database = yield* Effect.tryPromise({
      try: async () => {
        fs.mkdirSync(nodePath.dirname(resolved.path), { recursive: true });
        const database = await openSqliteDatabase(resolved.path);
        database.exec("PRAGMA journal_mode = WAL");
        database.exec("PRAGMA foreign_keys = ON");
        return new PersistenceDatabase(resolved.path, database);
      },
      catch: (cause) =>
        new PersistenceOpenError({
          path: resolved.path,
          reason: errorReason(cause),
          cause,
        }),
    });

    if (!shouldMigrate) {
      return database;
    }

    const migrated = yield* Effect.result(database.runMigrations());
    if (migrated._tag === "Failure") {
      yield* database.close().pipe(Effect.orElseSucceed(() => undefined));
      return yield* migrated.failure;
    }

    return database;
  });
}

export function initializePersistence(
  options: string | OpenPersistenceOptions,
): Effect.Effect<
  void,
  PersistenceOpenError | MigrationError | PersistenceClosedError | PersistenceQueryError
> {
  return Effect.gen(function* () {
    const database = yield* openPersistence(options);
    yield* database.close();
  });
}
