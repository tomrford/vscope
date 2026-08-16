import { Buffer } from "node:buffer";

import { Effect, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import type { PersistenceService } from "./api.ts";
import { SnapshotNotFoundError } from "./errors.ts";
import {
  DEFAULT_SETTINGS,
  PersistentId,
  Settings,
  SettingsState,
  SNAPSHOT_SAMPLE_FORMAT,
  SnapshotDraft,
  SnapshotListQuery,
  SnapshotRecord,
  SnapshotSampleBlob,
  SnapshotSampleDescriptor,
  SnapshotSamplesWrite,
  Timestamp,
  noRecovery,
  snapshotSampleByteLength,
  recovery,
  type SettingsPatch,
} from "@vscope/shared";
import {
  PrunedSnapshotId,
  SettingsRow,
  SettingsWrite,
  SnapshotFavoriteWrite,
  SnapshotRowId,
  SnapshotSampleRow,
  SnapshotSql,
  createId,
  createTimestamp,
  decodeWith,
  runBound,
  toUint8Array,
  transactionError,
  validateSamplesForDescriptor,
} from "./codec.ts";

export const makePersistence = Effect.fn("Persistence.make")(function* (
  path: string,
): Effect.fn.Return<PersistenceService, never, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient;

  const writeSettingsRow = SqlSchema.void({
    Request: SettingsWrite,
    execute: (row) => sql`
      INSERT INTO settings (id, data_json, recovery_pending, updated_at)
      VALUES (1, ${row.data_json}, ${row.recovery_pending}, ${row.updated_at})
      ON CONFLICT (id) DO UPDATE SET
        data_json = excluded.data_json,
        recovery_pending = excluded.recovery_pending,
        updated_at = excluded.updated_at
    `,
  });

  const findSettingsRow = SqlSchema.findOneOption({
    Request: Schema.Undefined,
    Result: SettingsRow,
    execute: () => sql`
      SELECT data_json, recovery_pending
      FROM settings
      WHERE id = 1
    `,
  });

  const findSnapshot = SqlSchema.findOneOption({
    Request: PersistentId,
    Result: SnapshotSql,
    execute: (id) => sql`
      SELECT
        snapshots.*,
        CASE WHEN snapshot_samples.snapshot_id IS NULL THEN 0 ELSE 1 END AS has_samples
      FROM snapshots
      LEFT JOIN snapshot_samples ON snapshot_samples.snapshot_id = snapshots.id
      WHERE snapshots.id = ${id}
    `,
  });

  const listSnapshotRows = SqlSchema.findAll({
    Request: SnapshotListQuery,
    Result: Schema.Unknown,
    execute: (query) =>
      query.limit === undefined
        ? sql`
            SELECT
              snapshots.*,
              CASE WHEN snapshot_samples.snapshot_id IS NULL THEN 0 ELSE 1 END AS has_samples
            FROM snapshots
            LEFT JOIN snapshot_samples ON snapshot_samples.snapshot_id = snapshots.id
            ORDER BY snapshots.favorite DESC, snapshots.created_at DESC, snapshots.id DESC
          `
        : sql`
            SELECT
              snapshots.*,
              CASE WHEN snapshot_samples.snapshot_id IS NULL THEN 0 ELSE 1 END AS has_samples
            FROM snapshots
            LEFT JOIN snapshot_samples ON snapshot_samples.snapshot_id = snapshots.id
            ORDER BY snapshots.favorite DESC, snapshots.created_at DESC, snapshots.id DESC
            LIMIT ${query.limit}
          `,
  });

  const insertSnapshotRow = SqlSchema.void({
    Request: SnapshotSql,
    execute: (row) => sql`
      INSERT INTO snapshots (
        id,
        label,
        device_name,
        channel_count,
        sample_count,
        sample_format,
        sample_rate_hz,
        total_duration_seconds,
        pre_trigger_seconds,
        channel_map_json,
        trigger_json,
        rt_values_json,
        metadata_json,
        favorite,
        created_at,
        updated_at
      ) VALUES (
        ${row.id},
        ${row.label},
        ${row.device_name},
        ${row.channel_count},
        ${row.sample_count},
        ${row.sample_format},
        ${row.sample_rate_hz},
        ${row.total_duration_seconds},
        ${row.pre_trigger_seconds},
        ${row.channel_map_json},
        ${row.trigger_json},
        ${row.rt_values_json},
        ${row.metadata_json},
        ${row.favorite},
        ${row.created_at},
        ${row.updated_at}
      )
    `,
  });

  const updateSnapshotFavorite = SqlSchema.void({
    Request: SnapshotFavoriteWrite,
    execute: (row) =>
      sql`UPDATE snapshots SET favorite = ${row.favorite}, updated_at = ${row.updated_at} WHERE id = ${row.id}`,
  });

  const pruneSnapshotRows = SqlSchema.findAll({
    Request: Timestamp,
    Result: PrunedSnapshotId,
    execute: (cutoff) => sql`
      DELETE FROM snapshots
      WHERE favorite = 0 AND created_at < ${cutoff}
      RETURNING id
    `,
  });

  const findSnapshotSamples = SqlSchema.findOneOption({
    Request: PersistentId,
    Result: SnapshotSampleRow,
    execute: (id) => sql`
      SELECT format, byte_len, data, updated_at
      FROM snapshot_samples
      WHERE snapshot_id = ${id}
    `,
  });

  const writeSingleton = Effect.fn("Persistence.writeSingleton")(function* (
    value: Settings,
    recoveryPending: boolean,
  ) {
    const updatedAt = yield* createTimestamp();
    yield* runBound(
      "write settings",
      writeSettingsRow({
        settings: value,
        recoveryPending,
        updatedAt,
      }),
    );
  });

  const readSettings = Effect.fn("Persistence.readSettings")(function* () {
    const row = yield* runBound(
      "read settings",
      findSettingsRow(undefined).pipe(
        Effect.catchIf(Schema.isSchemaError, () =>
          writeSingleton(DEFAULT_SETTINGS, true).pipe(Effect.as("corrupt" as const)),
        ),
      ),
    );

    if (row === "corrupt") {
      return SettingsState.make({
        settings: DEFAULT_SETTINGS,
        recovery: recovery("Corrupt settings were reset to defaults."),
      });
    }

    if (Option.isNone(row)) {
      yield* writeSingleton(DEFAULT_SETTINGS, false);
      return SettingsState.make({ settings: DEFAULT_SETTINGS, recovery: noRecovery });
    }

    return SettingsState.make({
      settings: row.value.settings,
      recovery: row.value.recoveryPending
        ? recovery("Corrupt settings were reset to defaults.")
        : noRecovery,
    });
  });

  const writeSettings = Effect.fn("Persistence.writeSettings")(function* (settings: Settings) {
    yield* writeSingleton(settings, false);
    return SettingsState.make({ settings, recovery: noRecovery });
  });

  const patchSettings = Effect.fn("Persistence.patchSettings")(function* (patch: SettingsPatch) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const current = yield* readSettings();
          const merged = yield* decodeWith(Settings, "patch settings", {
            ...current.settings,
            ...patch,
            defaultSerialConfig:
              patch.defaultSerialConfig === undefined
                ? current.settings.defaultSerialConfig
                : { ...current.settings.defaultSerialConfig, ...patch.defaultSerialConfig },
            polling:
              patch.polling === undefined
                ? current.settings.polling
                : { ...current.settings.polling, ...patch.polling },
            snapshots:
              patch.snapshots === undefined
                ? current.settings.snapshots
                : { ...current.settings.snapshots, ...patch.snapshots },
            liveView:
              patch.liveView === undefined
                ? current.settings.liveView
                : { ...current.settings.liveView, ...patch.liveView },
            network:
              patch.network === undefined
                ? current.settings.network
                : { ...current.settings.network, ...patch.network },
          });
          return yield* writeSettings(merged);
        }),
      )
      .pipe(Effect.mapError((cause) => transactionError("patch settings transaction", cause)));
  });

  const getSnapshot = Effect.fn("Persistence.getSnapshot")(function* (id: PersistentId) {
    return yield* runBound("get snapshot", findSnapshot(id));
  });

  const requireSnapshot = Effect.fn("Persistence.requireSnapshot")(function* (id: PersistentId) {
    const snapshot = yield* getSnapshot(id);
    return yield* Option.match(snapshot, {
      onNone: () => Effect.fail(SnapshotNotFoundError.make({ id })),
      onSome: Effect.succeed,
    });
  });

  const storeSnapshotSamples = Effect.fn("Persistence.storeSnapshotSamples")(function* (
    record: SnapshotRecord,
    samples: SnapshotSamplesWrite,
  ) {
    yield* validateSamplesForDescriptor(record.sample, samples);
    const updatedAt = yield* createTimestamp();
    const bytes = Buffer.from(samples.data);

    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* runBound(
            "write snapshot samples",
            sql`
            INSERT INTO snapshot_samples (snapshot_id, format, byte_len, data, updated_at)
            VALUES (${record.id}, ${samples.format}, ${samples.data.byteLength}, ${bytes}, ${updatedAt})
            ON CONFLICT (snapshot_id) DO UPDATE SET
              format = excluded.format,
              byte_len = excluded.byte_len,
              data = excluded.data,
              updated_at = excluded.updated_at
          `,
          );
          yield* runBound(
            "touch snapshot after sample write",
            sql`UPDATE snapshots SET updated_at = ${updatedAt} WHERE id = ${record.id}`,
          );
          return yield* requireSnapshot(record.id);
        }),
      )
      .pipe(
        Effect.mapError((cause) => transactionError("write snapshot samples transaction", cause)),
      );
  });

  const createSnapshot = Effect.fn("Persistence.createSnapshot")(function* (
    draft: SnapshotDraft,
    samples?: SnapshotSamplesWrite,
  ) {
    const id = draft.id ?? (yield* createId("snapshot"));
    const createdAt = draft.createdAt ?? (yield* createTimestamp());
    const descriptor = yield* decodeWith(
      SnapshotSampleDescriptor,
      "create snapshot sample descriptor",
      {
        format: SNAPSHOT_SAMPLE_FORMAT,
        channelCount: draft.channelCount,
        sampleCount: draft.sampleCount,
        byteLength: snapshotSampleByteLength(draft.channelCount, draft.sampleCount),
        stored: samples !== undefined,
      },
    );
    const record = yield* decodeWith(SnapshotRecord, "create snapshot record", {
      id,
      label: draft.label,
      device: draft.device,
      sample: descriptor,
      sampleRateHz: draft.sampleRateHz,
      totalDurationSeconds: draft.totalDurationSeconds,
      preTriggerSeconds: draft.preTriggerSeconds,
      channelMap: draft.channelMap,
      trigger: draft.trigger,
      rtValues: draft.rtValues,
      metadata: draft.metadata,
      favorite: false,
      createdAt,
      updatedAt: createdAt,
    });
    const decodedSamples =
      samples === undefined
        ? undefined
        : yield* validateSamplesForDescriptor(record.sample, samples).pipe(Effect.as(samples));

    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* runBound("create snapshot", insertSnapshotRow(record));

          if (decodedSamples !== undefined) {
            yield* runBound(
              "create snapshot samples",
              sql`
              INSERT INTO snapshot_samples (snapshot_id, format, byte_len, data, updated_at)
              VALUES (
                ${record.id},
                ${decodedSamples.format},
                ${decodedSamples.data.byteLength},
                ${Buffer.from(decodedSamples.data)},
                ${record.updatedAt}
              )
            `,
            );
          }
        }),
      )
      .pipe(Effect.mapError((cause) => transactionError("create snapshot transaction", cause)));

    return record;
  });

  const listSnapshots = Effect.fn("Persistence.listSnapshots")(function* (
    query: SnapshotListQuery = SnapshotListQuery.make({}),
  ) {
    const rows = yield* runBound("list snapshots", listSnapshotRows(query));
    const snapshots: Array<SnapshotRecord> = [];
    const corruptIds: Array<string> = [];

    for (const row of rows) {
      const decoded = yield* decodeWith(SnapshotSql, "decode snapshot row", row).pipe(
        Effect.match({
          onFailure: () => null,
          onSuccess: (snapshot) => snapshot,
        }),
      );

      if (decoded === null) {
        const id = yield* decodeWith(SnapshotRowId, "read corrupt snapshot id", row).pipe(
          Effect.match({
            onFailure: () => null,
            onSuccess: (candidate) => candidate.id,
          }),
        );
        if (id !== null) {
          corruptIds.push(id);
        }
      } else {
        snapshots.push(decoded);
      }
    }

    for (const id of corruptIds) {
      yield* runBound("drop corrupt snapshot", sql`DELETE FROM snapshots WHERE id = ${id}`);
      yield* Effect.logWarning(`Corrupt snapshot metadata dropped: ${id}`);
    }

    return snapshots;
  });

  const setSnapshotFavorite = Effect.fn("Persistence.setSnapshotFavorite")(function* (
    id: PersistentId,
    favorite: boolean,
  ) {
    const current = yield* requireSnapshot(id);
    if (current.favorite === favorite) {
      return current;
    }
    const updatedAt = yield* createTimestamp();
    const updated = yield* decodeWith(SnapshotRecord, "set snapshot favorite", {
      ...current,
      favorite,
      updatedAt,
    });

    yield* runBound(
      "set snapshot favorite",
      updateSnapshotFavorite({
        id: updated.id,
        favorite: updated.favorite,
        updatedAt: updated.updatedAt,
      }),
    );

    return updated;
  });

  const deleteSnapshot = Effect.fn("Persistence.deleteSnapshot")(function* (id: PersistentId) {
    yield* runBound("delete snapshot", sql`DELETE FROM snapshots WHERE id = ${id}`);
  });

  const pruneSnapshotsBefore = Effect.fn("Persistence.pruneSnapshotsBefore")(function* (
    cutoff: Timestamp,
  ) {
    const deleted = yield* runBound("prune snapshots", pruneSnapshotRows(cutoff));
    return deleted.length;
  });

  const writeSnapshotSamples = Effect.fn("Persistence.writeSnapshotSamples")(function* (
    id: PersistentId,
    samples: SnapshotSamplesWrite,
  ) {
    const record = yield* requireSnapshot(id);
    return yield* storeSnapshotSamples(record, samples);
  });

  const readSnapshotSamples = Effect.fn("Persistence.readSnapshotSamples")(function* (
    id: PersistentId,
  ) {
    const record = yield* requireSnapshot(id);
    const row = yield* runBound("read snapshot samples", findSnapshotSamples(record.id));

    if (Option.isNone(row)) {
      return Option.none<SnapshotSampleBlob>();
    }

    const bytes = yield* toUint8Array("decode snapshot samples blob", row.value.data);
    const trimmed = bytes.slice(0, Math.min(bytes.byteLength, row.value.byte_len));
    const blob = yield* decodeWith(SnapshotSampleBlob, "decode snapshot samples", {
      snapshotId: record.id,
      format: row.value.format,
      channelCount: record.sample.channelCount,
      sampleCount: record.sample.sampleCount,
      byteLength: row.value.byte_len,
      data: trimmed,
      updatedAt: row.value.updated_at,
    });
    yield* validateSamplesForDescriptor(
      record.sample,
      SnapshotSamplesWrite.make({ format: blob.format, data: blob.data }),
    );

    return Option.some(blob);
  });

  return {
    path,
    readSettings: readSettings(),
    writeSettings,
    patchSettings,
    resetSettings: writeSettings(DEFAULT_SETTINGS),
    createSnapshot,
    listSnapshots,
    getSnapshot,
    setSnapshotFavorite,
    deleteSnapshot,
    pruneSnapshotsBefore,
    writeSnapshotSamples,
    readSnapshotSamples,
  };
});
