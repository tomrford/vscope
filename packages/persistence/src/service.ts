import { Buffer } from "node:buffer";

import { Effect, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

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
  SnapshotTrigger,
  noRecovery,
  snapshotSampleByteLength,
  recovery,
  type SettingsPatch,
} from "@vscope/shared";
import {
  SingletonRow,
  SnapshotRow,
  SnapshotSampleRow,
  createId,
  createTimestamp,
  decodeJson,
  decodeWith,
  runSql,
  stringifyJson,
  stringProperty,
  toUint8Array,
  transactionError,
  validateSamplesForDescriptor,
  validateSnapshotDraftShape,
} from "./codec.ts";

export const makePersistence = Effect.fn("Persistence.make")(function* (
  path: string,
): Effect.fn.Return<PersistenceService, never, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient;

  const writeSingleton = Effect.fn("Persistence.writeSingleton")(function* (
    table: "settings",
    value: Settings,
    recoveryPending: boolean,
  ) {
    const json = yield* stringifyJson(`write ${table}`, value);
    const updatedAt = yield* createTimestamp();

    yield* runSql(
      `write ${table}`,
      sql`
        INSERT INTO ${sql(table)} (id, data_json, recovery_pending, updated_at)
        VALUES (1, ${json}, ${recoveryPending ? 1 : 0}, ${updatedAt})
        ON CONFLICT (id) DO UPDATE SET
          data_json = excluded.data_json,
          recovery_pending = excluded.recovery_pending,
          updated_at = excluded.updated_at
      `,
    );
  });

  const readSettings = Effect.fn("Persistence.readSettings")(function* () {
    const rows = yield* runSql(
      "read settings",
      sql`
        SELECT data_json, recovery_pending
        FROM settings
        WHERE id = 1
      `,
    );

    const row = rows[0];
    if (row === undefined) {
      yield* writeSingleton("settings", DEFAULT_SETTINGS, false);
      return SettingsState.make({ settings: DEFAULT_SETTINGS, recovery: noRecovery });
    }

    const decodedRow = yield* decodeWith(SingletonRow, "decode settings row", row).pipe(
      Effect.matchEffect({
        onFailure: () =>
          Effect.gen(function* () {
            yield* writeSingleton("settings", DEFAULT_SETTINGS, true);
            return {
              settings: DEFAULT_SETTINGS,
              recoveryState: recovery("Corrupt settings were reset to defaults."),
            };
          }),
        onSuccess: (value) =>
          decodeJson(Settings, "decode settings", value.data_json).pipe(
            Effect.matchEffect({
              onFailure: () =>
                Effect.gen(function* () {
                  yield* writeSingleton("settings", DEFAULT_SETTINGS, true);
                  return {
                    settings: DEFAULT_SETTINGS,
                    recoveryState: recovery("Corrupt settings were reset to defaults."),
                  };
                }),
              onSuccess: (settings) =>
                Effect.succeed({
                  settings,
                  recoveryState:
                    value.recovery_pending === 1
                      ? recovery("Corrupt settings were reset to defaults.")
                      : noRecovery,
                }),
            }),
          ),
      }),
    );

    return SettingsState.make({
      settings: decodedRow.settings,
      recovery: decodedRow.recoveryState,
    });
  });

  const writeSettings = Effect.fn("Persistence.writeSettings")(function* (settings: Settings) {
    yield* writeSingleton("settings", settings, false);
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
          });
          return yield* writeSettings(merged);
        }),
      )
      .pipe(Effect.mapError((cause) => transactionError("patch settings transaction", cause)));
  });

  const decodeSnapshotRow = Effect.fn("Persistence.decodeSnapshotRow")(function* (row: unknown) {
    const decodedRow = yield* decodeWith(SnapshotRow, "decode snapshot row", row);
    const channelMap = yield* decodeJson(
      Schema.Array(Schema.Number),
      "decode snapshot channel map",
      decodedRow.channel_map_json,
    );
    const trigger = yield* decodeJson(
      SnapshotTrigger,
      "decode snapshot trigger",
      decodedRow.trigger_json,
    );
    const rtValues = yield* decodeJson(
      Schema.Array(Schema.Number),
      "decode snapshot rt values",
      decodedRow.rt_values_json,
    );
    const metadata = yield* decodeJson(
      Schema.Record(Schema.String, Schema.Json),
      "decode snapshot metadata",
      decodedRow.metadata_json,
    );

    return yield* decodeWith(SnapshotRecord, "decode snapshot record", {
      id: decodedRow.id,
      label: decodedRow.label,
      device: {
        name: decodedRow.device_name,
      },
      sample: {
        format: decodedRow.sample_format,
        channelCount: decodedRow.channel_count,
        sampleCount: decodedRow.sample_count,
        byteLength: snapshotSampleByteLength(decodedRow.channel_count, decodedRow.sample_count),
        stored: decodedRow.has_samples === 1,
      },
      sampleRateHz: decodedRow.sample_rate_hz,
      totalDurationSeconds: decodedRow.total_duration_seconds,
      preTriggerSeconds: decodedRow.pre_trigger_seconds,
      channelMap,
      trigger,
      rtValues,
      metadata,
      createdAt: decodedRow.created_at,
      updatedAt: decodedRow.updated_at,
    });
  });

  const getSnapshot = Effect.fn("Persistence.getSnapshot")(function* (id: PersistentId) {
    const rows = yield* runSql(
      "get snapshot",
      sql`
        SELECT
          snapshots.*,
          CASE WHEN snapshot_samples.snapshot_id IS NULL THEN 0 ELSE 1 END AS has_samples
        FROM snapshots
        LEFT JOIN snapshot_samples ON snapshot_samples.snapshot_id = snapshots.id
        WHERE snapshots.id = ${id}
      `,
    );

    const row = rows[0];
    if (row === undefined) {
      return Option.none<SnapshotRecord>();
    }

    return Option.some(yield* decodeSnapshotRow(row));
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
          yield* runSql(
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
          yield* runSql(
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
    yield* validateSnapshotDraftShape(draft);
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
      createdAt,
      updatedAt: createdAt,
    });
    const decodedSamples =
      samples === undefined
        ? undefined
        : yield* validateSamplesForDescriptor(record.sample, samples).pipe(Effect.as(samples));
    const channelMapJson = yield* stringifyJson("encode snapshot channel map", record.channelMap);
    const triggerJson = yield* stringifyJson("encode snapshot trigger", record.trigger);
    const rtValuesJson = yield* stringifyJson("encode snapshot rt values", record.rtValues);
    const metadataJson = yield* stringifyJson("encode snapshot metadata", record.metadata);

    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* runSql(
            "create snapshot",
            sql`
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
              created_at,
              updated_at
            ) VALUES (
              ${record.id},
              ${record.label},
              ${record.device.name},
              ${record.sample.channelCount},
              ${record.sample.sampleCount},
              ${record.sample.format},
              ${record.sampleRateHz},
              ${record.totalDurationSeconds},
              ${record.preTriggerSeconds},
              ${channelMapJson},
              ${triggerJson},
              ${rtValuesJson},
              ${metadataJson},
              ${record.createdAt},
              ${record.updatedAt}
            )
          `,
          );

          if (decodedSamples !== undefined) {
            yield* runSql(
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
    const rows = yield* runSql(
      "list snapshots",
      query.limit === undefined
        ? sql`
            SELECT
              snapshots.*,
              CASE WHEN snapshot_samples.snapshot_id IS NULL THEN 0 ELSE 1 END AS has_samples
            FROM snapshots
            LEFT JOIN snapshot_samples ON snapshot_samples.snapshot_id = snapshots.id
            ORDER BY snapshots.created_at DESC, snapshots.id DESC
          `
        : sql`
            SELECT
              snapshots.*,
              CASE WHEN snapshot_samples.snapshot_id IS NULL THEN 0 ELSE 1 END AS has_samples
            FROM snapshots
            LEFT JOIN snapshot_samples ON snapshot_samples.snapshot_id = snapshots.id
            ORDER BY snapshots.created_at DESC, snapshots.id DESC
            LIMIT ${query.limit}
          `,
    );

    const snapshots: Array<SnapshotRecord> = [];
    const corruptIds: Array<string> = [];

    for (const row of rows) {
      const decoded = yield* decodeSnapshotRow(row).pipe(
        Effect.match({
          onFailure: () => null,
          onSuccess: (snapshot) => snapshot,
        }),
      );

      if (decoded === null) {
        const id = stringProperty(row, "id");
        if (id !== null) {
          corruptIds.push(id);
        }
      } else {
        snapshots.push(decoded);
      }
    }

    for (const id of corruptIds) {
      yield* runSql("drop corrupt snapshot", sql`DELETE FROM snapshots WHERE id = ${id}`);
      yield* Effect.logWarning(`Corrupt snapshot metadata dropped: ${id}`);
    }

    return snapshots;
  });

  const renameSnapshot = Effect.fn("Persistence.renameSnapshot")(function* (
    id: PersistentId,
    label: string,
  ) {
    const current = yield* requireSnapshot(id);
    const updatedAt = yield* createTimestamp();
    const updated = yield* decodeWith(SnapshotRecord, "rename snapshot", {
      ...current,
      label,
      updatedAt,
    });

    yield* runSql(
      "rename snapshot",
      sql`UPDATE snapshots SET label = ${updated.label}, updated_at = ${updated.updatedAt} WHERE id = ${updated.id}`,
    );

    return updated;
  });

  const deleteSnapshot = Effect.fn("Persistence.deleteSnapshot")(function* (id: PersistentId) {
    yield* runSql("delete snapshot", sql`DELETE FROM snapshots WHERE id = ${id}`);
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
    const rows = yield* runSql(
      "read snapshot samples",
      sql`
        SELECT format, byte_len, data, updated_at
        FROM snapshot_samples
        WHERE snapshot_id = ${record.id}
      `,
    );
    const row = rows[0];

    if (row === undefined) {
      return Option.none<SnapshotSampleBlob>();
    }

    const decodedRow = yield* decodeWith(SnapshotSampleRow, "decode snapshot samples row", row);
    const bytes = yield* toUint8Array("decode snapshot samples blob", decodedRow.data);
    const trimmed = bytes.slice(0, Math.min(bytes.byteLength, decodedRow.byte_len));
    const blob = yield* decodeWith(SnapshotSampleBlob, "decode snapshot samples", {
      snapshotId: record.id,
      format: decodedRow.format,
      channelCount: record.sample.channelCount,
      sampleCount: record.sample.sampleCount,
      byteLength: decodedRow.byte_len,
      data: trimmed,
      updatedAt: decodedRow.updated_at,
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
    renameSnapshot,
    deleteSnapshot,
    writeSnapshotSamples,
    readSnapshotSamples,
  };
});
