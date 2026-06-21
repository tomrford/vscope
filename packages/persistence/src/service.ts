import { Buffer } from "node:buffer";

import { Effect, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { PersistenceService } from "./api.ts";
import { SnapshotNotFoundError } from "./errors.ts";
import {
  DEFAULT_SETTINGS,
  PersistentId,
  SavedDevice,
  SavedDeviceDraft,
  SavedDeviceIdentity,
  SerialConfig,
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
  Timestamp,
  noRecovery,
  snapshotSampleByteLength,
  recovery,
  type SettingsPatch,
} from "@vscope/shared";
import {
  CreatedAtRow,
  SavedDeviceRow,
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
    const decoded = yield* decodeWith(Settings, "write settings", settings);
    yield* writeSingleton("settings", decoded, false);
    return SettingsState.make({ settings: decoded, recovery: noRecovery });
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

  const decodeSavedDeviceRow = Effect.fn("Persistence.decodeSavedDeviceRow")(function* (
    row: unknown,
  ) {
    const decodedRow = yield* decodeWith(SavedDeviceRow, "decode saved device row", row);
    const serialConfig = yield* decodeJson(
      SerialConfig,
      "decode saved device serial config",
      decodedRow.serial_config_json,
    );
    const metadata = yield* decodeJson(
      Schema.Record(Schema.String, Schema.Json),
      "decode saved device metadata",
      decodedRow.metadata_json,
    );

    return yield* decodeWith(SavedDevice, "decode saved device", {
      id: decodedRow.id,
      portPath: decodedRow.port_path,
      displayName: decodedRow.display_name,
      usb: {
        vendorId: decodedRow.vendor_id,
        productId: decodedRow.product_id,
        serialNumber: decodedRow.serial_number,
        manufacturer: decodedRow.manufacturer,
      },
      serialConfig,
      metadata,
      createdAt: decodedRow.created_at,
      updatedAt: decodedRow.updated_at,
    });
  });

  const listSavedDevices = Effect.fn("Persistence.listSavedDevices")(function* () {
    const rows = yield* runSql(
      "list saved devices",
      sql`
        SELECT *
        FROM saved_devices
        ORDER BY updated_at DESC, id DESC
      `,
    );
    const devices: Array<SavedDevice> = [];
    const corruptIds: Array<string> = [];

    for (const row of rows) {
      const decoded = yield* decodeSavedDeviceRow(row).pipe(
        Effect.match({
          onFailure: () => null,
          onSuccess: (device) => device,
        }),
      );

      if (decoded === null) {
        const id = stringProperty(row, "id");
        if (id !== null) {
          corruptIds.push(id);
        }
      } else {
        devices.push(decoded);
      }
    }

    for (const id of corruptIds) {
      yield* runSql("drop corrupt saved device", sql`DELETE FROM saved_devices WHERE id = ${id}`);
      yield* Effect.logWarning(`Corrupt saved device dropped: ${id}`);
    }

    return devices;
  });

  const decodeSavedDeviceOption = Effect.fn("Persistence.decodeSavedDeviceOption")(function* (
    operation: string,
    row: unknown | undefined,
  ) {
    if (row === undefined) {
      return Option.none<SavedDevice>();
    }

    return yield* decodeSavedDeviceRow(row).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.gen(function* () {
            const id = stringProperty(row, "id");
            if (id === null) {
              return yield* error;
            }

            yield* runSql(
              `drop corrupt saved device during ${operation}`,
              sql`DELETE FROM saved_devices WHERE id = ${id}`,
            );
            yield* Effect.logWarning(`Corrupt saved device dropped: ${id}`);
            return Option.none<SavedDevice>();
          }),
        onSuccess: (device) => Effect.succeed(Option.some(device)),
      }),
    );
  });

  const getSavedDevice = Effect.fn("Persistence.getSavedDevice")(function* (id: PersistentId) {
    const decodedId = yield* decodeWith(PersistentId, "get saved device", id);
    const rows = yield* runSql(
      "get saved device",
      sql`
        SELECT *
        FROM saved_devices
        WHERE id = ${decodedId}
      `,
    );

    return yield* decodeSavedDeviceOption("get saved device", rows[0]);
  });

  const findSavedDeviceByIdentity = Effect.fn("Persistence.findSavedDeviceByIdentity")(function* (
    identity: SavedDeviceIdentity,
  ) {
    const decodedIdentity = yield* decodeWith(
      SavedDeviceIdentity,
      "find saved device by identity",
      identity,
    );
    const { productId, serialNumber, vendorId } = decodedIdentity.usb;

    if (vendorId !== null && productId !== null && serialNumber !== null) {
      const rows = yield* runSql(
        "find saved device by usb identity",
        sql`
          SELECT *
          FROM saved_devices
          WHERE vendor_id = ${vendorId}
            AND product_id = ${productId}
            AND serial_number = ${serialNumber}
          ORDER BY updated_at DESC, id DESC
          LIMIT 1
        `,
      );
      const device = yield* decodeSavedDeviceOption("find saved device by usb identity", rows[0]);

      if (Option.isSome(device) || decodedIdentity.portPath === null) {
        return device;
      }
    }

    if (decodedIdentity.portPath === null) {
      return Option.none<SavedDevice>();
    }

    const rows = yield* runSql(
      "find saved device by port path",
      sql`
        SELECT *
        FROM saved_devices
        WHERE port_path = ${decodedIdentity.portPath}
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
      `,
    );

    return yield* decodeSavedDeviceOption("find saved device by port path", rows[0]);
  });

  const upsertSavedDevice = Effect.fn("Persistence.upsertSavedDevice")(function* (
    draft: SavedDeviceDraft,
  ) {
    const decodedDraft = yield* decodeWith(SavedDeviceDraft, "upsert saved device", draft);
    const id = decodedDraft.id ?? (yield* createId("device"));
    const updatedAt = yield* createTimestamp();
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const createdRows = yield* runSql(
            "read saved device created_at",
            sql`SELECT created_at FROM saved_devices WHERE id = ${id}`,
          );
          const createdRow = createdRows[0];
          const createdAt =
            createdRow === undefined
              ? updatedAt
              : yield* decodeWith(CreatedAtRow, "decode saved device created_at", createdRow).pipe(
                  Effect.flatMap((row) =>
                    decodeWith(Timestamp, "decode saved device created timestamp", row.created_at),
                  ),
                );
          const device = yield* decodeWith(SavedDevice, "upsert saved device record", {
            id,
            portPath: decodedDraft.portPath,
            displayName: decodedDraft.displayName,
            usb: decodedDraft.usb,
            serialConfig: decodedDraft.serialConfig,
            metadata: decodedDraft.metadata,
            createdAt,
            updatedAt,
          });
          const serialConfigJson = yield* stringifyJson(
            "encode saved device serial config",
            device.serialConfig,
          );
          const metadataJson = yield* stringifyJson(
            "encode saved device metadata",
            device.metadata,
          );

          yield* runSql(
            "upsert saved device",
            sql`
              INSERT INTO saved_devices (
                id,
                port_path,
                display_name,
                vendor_id,
                product_id,
                serial_number,
                manufacturer,
                serial_config_json,
                metadata_json,
                created_at,
                updated_at
              ) VALUES (
                ${device.id},
                ${device.portPath},
                ${device.displayName},
                ${device.usb.vendorId},
                ${device.usb.productId},
                ${device.usb.serialNumber},
                ${device.usb.manufacturer},
                ${serialConfigJson},
                ${metadataJson},
                ${device.createdAt},
                ${device.updatedAt}
              )
              ON CONFLICT (id) DO UPDATE SET
                port_path = excluded.port_path,
                display_name = excluded.display_name,
                vendor_id = excluded.vendor_id,
                product_id = excluded.product_id,
                serial_number = excluded.serial_number,
                manufacturer = excluded.manufacturer,
                serial_config_json = excluded.serial_config_json,
                metadata_json = excluded.metadata_json,
                updated_at = excluded.updated_at
            `,
          );

          return device;
        }),
      )
      .pipe(Effect.mapError((cause) => transactionError("upsert saved device transaction", cause)));
  });

  const forgetSavedDevice = Effect.fn("Persistence.forgetSavedDevice")(function* (
    id: PersistentId,
  ) {
    const decodedId = yield* decodeWith(PersistentId, "forget saved device", id);
    yield* runSql("forget saved device", sql`DELETE FROM saved_devices WHERE id = ${decodedId}`);
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
    const decodedId = yield* decodeWith(PersistentId, "get snapshot", id);
    const rows = yield* runSql(
      "get snapshot",
      sql`
        SELECT
          snapshots.*,
          CASE WHEN snapshot_samples.snapshot_id IS NULL THEN 0 ELSE 1 END AS has_samples
        FROM snapshots
        LEFT JOIN snapshot_samples ON snapshot_samples.snapshot_id = snapshots.id
        WHERE snapshots.id = ${decodedId}
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
    const decodedSamples = yield* decodeWith(
      SnapshotSamplesWrite,
      "write snapshot samples",
      samples,
    );
    yield* validateSamplesForDescriptor(record.sample, decodedSamples);
    const updatedAt = yield* createTimestamp();
    const bytes = Buffer.from(decodedSamples.data);

    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* runSql(
            "write snapshot samples",
            sql`
            INSERT INTO snapshot_samples (snapshot_id, format, byte_len, data, updated_at)
            VALUES (${record.id}, ${decodedSamples.format}, ${decodedSamples.data.byteLength}, ${bytes}, ${updatedAt})
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
    const decodedDraft = yield* decodeWith(SnapshotDraft, "create snapshot", draft);
    yield* validateSnapshotDraftShape(decodedDraft);
    const id = decodedDraft.id ?? (yield* createId("snapshot"));
    const createdAt = decodedDraft.createdAt ?? (yield* createTimestamp());
    const descriptor = yield* decodeWith(
      SnapshotSampleDescriptor,
      "create snapshot sample descriptor",
      {
        format: SNAPSHOT_SAMPLE_FORMAT,
        channelCount: decodedDraft.channelCount,
        sampleCount: decodedDraft.sampleCount,
        byteLength: snapshotSampleByteLength(decodedDraft.channelCount, decodedDraft.sampleCount),
        stored: samples !== undefined,
      },
    );
    const record = yield* decodeWith(SnapshotRecord, "create snapshot record", {
      id,
      label: decodedDraft.label,
      device: decodedDraft.device,
      sample: descriptor,
      sampleRateHz: decodedDraft.sampleRateHz,
      totalDurationSeconds: decodedDraft.totalDurationSeconds,
      preTriggerSeconds: decodedDraft.preTriggerSeconds,
      channelMap: decodedDraft.channelMap,
      trigger: decodedDraft.trigger,
      rtValues: decodedDraft.rtValues,
      metadata: decodedDraft.metadata,
      createdAt,
      updatedAt: createdAt,
    });
    const decodedSamples =
      samples === undefined
        ? undefined
        : yield* decodeWith(SnapshotSamplesWrite, "create snapshot samples", samples).pipe(
            Effect.tap((payload) => validateSamplesForDescriptor(record.sample, payload)),
          );
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
    const decodedQuery = yield* decodeWith(SnapshotListQuery, "list snapshots query", query);
    const rows = yield* runSql(
      "list snapshots",
      decodedQuery.limit === undefined
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
            LIMIT ${decodedQuery.limit}
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
    const decodedId = yield* decodeWith(PersistentId, "delete snapshot", id);
    yield* runSql("delete snapshot", sql`DELETE FROM snapshots WHERE id = ${decodedId}`);
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
    listSavedDevices: listSavedDevices(),
    getSavedDevice,
    findSavedDeviceByIdentity,
    upsertSavedDevice,
    forgetSavedDevice,
    createSnapshot,
    listSnapshots,
    getSnapshot,
    renameSnapshot,
    deleteSnapshot,
    writeSnapshotSamples,
    readSnapshotSamples,
  };
});
