import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  DEFAULT_SERIAL_CONFIG,
  DEFAULT_SETTINGS,
  Persistence,
  SavedDeviceDraft,
  SavedDeviceIdentity,
  SNAPSHOT_SAMPLE_FORMAT,
  SerialConfig,
  SnapshotDraft,
  SnapshotSamplesWrite,
  SnapshotTrigger,
  UsbIdentity,
  initializePersistence,
  makePersistenceLayer,
} from "./index.ts";

function withTempPath<A, E, R>(run: (path: string) => Effect.Effect<A, E, R>) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "vscope-persistence-"));
      return { dir, path: nodePath.join(dir, "state.sqlite") };
    }),
    ({ dir }) => Effect.sync(() => fs.rmSync(dir, { recursive: true, force: true })),
  ).pipe(Effect.flatMap(({ path }) => run(path)));
}

function runWithPersistence<A, E>(path: string, effect: Effect.Effect<A, E, Persistence>) {
  return Effect.scoped(effect.pipe(Effect.provide(makePersistenceLayer({ path }))));
}

function runWithSql<A, E>(path: string, effect: Effect.Effect<A, E, SqlClient.SqlClient>) {
  return Effect.scoped(effect.pipe(Effect.provide(SqliteClient.layer({ filename: path }))));
}

function snapshotDraft(label: string, sampleCount: number): SnapshotDraft {
  return SnapshotDraft.make({
    label,
    device: {
      name: "probe-a",
    },
    channelCount: 2,
    sampleCount,
    sampleRateHz: 1_000,
    totalDurationSeconds: sampleCount / 1_000,
    preTriggerSeconds: 0.001,
    channelMap: [0, 1],
    trigger: SnapshotTrigger.make({
      threshold: 0.5,
      channel: 1,
      mode: "rising",
    }),
    rtValues: [0, 1],
    metadata: {
      note: "first capture",
    },
  });
}

function floatBytes(values: ReadonlyArray<number>): Uint8Array {
  const floats = new Float32Array(values);
  return new Uint8Array(floats.buffer.slice(0));
}

describe("@vscope/persistence", () => {
  it.effect("reports SQLite open defects as typed open errors", () =>
    withTempPath((path) =>
      Effect.gen(function* () {
        yield* Effect.sync(() => fs.mkdirSync(path));

        const error = yield* Effect.flip(initializePersistence({ path }));
        expect(error).toMatchObject({ _tag: "PersistenceOpenError" });
      }),
    ),
  );

  it.effect("reports migration defects as typed migration errors", () =>
    withTempPath((path) =>
      Effect.gen(function* () {
        yield* runWithSql(
          path,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`CREATE TABLE saved_devices_port_path_idx (id INTEGER PRIMARY KEY)`;
          }),
        );

        const error = yield* Effect.flip(initializePersistence({ path }));
        expect(error).toMatchObject({ _tag: "PersistenceMigrationError" });
      }),
    ),
  );

  it.effect("migrations create the persistence tables", () =>
    withTempPath((path) =>
      Effect.gen(function* () {
        yield* initializePersistence({ path });

        const names = yield* runWithSql(
          path,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const rows = yield* sql<{ name: string }>`
              SELECT name
              FROM sqlite_master
              WHERE type = 'table'
              ORDER BY name
            `;

            return rows.map((row) => row.name);
          }),
        );

        expect(names).toEqual([
          "persistence_migrations",
          "saved_devices",
          "settings",
          "snapshot_samples",
          "snapshots",
        ]);
      }),
    ),
  );

  it.effect("settings round-trip, recovers, and resets", () =>
    withTempPath((path) =>
      Effect.gen(function* () {
        yield* runWithPersistence(
          path,
          Effect.gen(function* () {
            const persistence = yield* Persistence;

            const defaults = yield* persistence.readSettings;
            expect(defaults.settings).toEqual(DEFAULT_SETTINGS);
            expect(defaults.recovery.pending).toBe(false);
            expect(defaults.recovery.message).toBe(null);

            const settings = yield* persistence.patchSettings({ theme: "dark" });
            expect(settings.settings.theme).toBe("dark");
          }),
        );

        yield* runWithSql(
          path,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`UPDATE settings SET data_json = ${"{"} WHERE id = 1`;
          }),
        );

        yield* runWithPersistence(
          path,
          Effect.gen(function* () {
            const persistence = yield* Persistence;
            const settings = yield* persistence.readSettings;

            expect(settings.settings).toEqual(DEFAULT_SETTINGS);
            expect(settings.recovery.pending).toBe(true);
            expect(settings.recovery.message).toBe("Corrupt settings were reset to defaults.");

            const resetSettings = yield* persistence.resetSettings;
            expect(resetSettings.settings).toEqual(DEFAULT_SETTINGS);
            expect(resetSettings.recovery.pending).toBe(false);
            expect(resetSettings.recovery.message).toBe(null);
          }),
        );
      }),
    ),
  );

  it.effect("settings patches validate instead of defecting", () =>
    withTempPath((path) =>
      Effect.gen(function* () {
        const settingsError = yield* Effect.flip(
          runWithPersistence(
            path,
            Effect.gen(function* () {
              const persistence = yield* Persistence;
              yield* persistence.patchSettings({ theme: "purple" as never });
            }),
          ),
        );
        expect(settingsError).toMatchObject({ _tag: "PersistenceValidationError" });
      }),
    ),
  );

  it.effect("concurrent settings patches preserve independent fields", () =>
    withTempPath((path) =>
      runWithPersistence(
        path,
        Effect.gen(function* () {
          const persistence = yield* Persistence;
          const serialConfig = SerialConfig.make({
            ...DEFAULT_SERIAL_CONFIG,
            baudRate: 57_600,
          });

          yield* Effect.all(
            [
              persistence.patchSettings({ theme: "dark" }),
              persistence.patchSettings({ defaultSerialConfig: serialConfig }),
            ],
            { concurrency: 2 },
          );

          const settings = yield* persistence.readSettings;
          expect(settings.settings.theme).toBe("dark");
          expect(settings.settings.defaultSerialConfig.baudRate).toBe(57_600);
          expect(settings.settings.defaultSerialConfig.dtr).toBe(true);
          expect(settings.settings.defaultSerialConfig.rts).toBe(true);
        }),
      ),
    ),
  );

  it.effect("saved devices round-trip through typed records", () =>
    withTempPath((path) =>
      runWithPersistence(
        path,
        Effect.gen(function* () {
          const persistence = yield* Persistence;
          const first = yield* persistence.upsertSavedDevice(
            SavedDeviceDraft.make({
              portPath: "/dev/tty.usbserial",
              displayName: "Probe A",
              usb: UsbIdentity.make({
                vendorId: "303a",
                productId: "1001",
                serialNumber: "abc",
                manufacturer: "vscope",
              }),
              serialConfig: DEFAULT_SERIAL_CONFIG,
              metadata: {
                role: "bench",
              },
            }),
          );

          expect(first.id.startsWith("device:")).toBe(true);
          expect(yield* persistence.listSavedDevices).toEqual([first]);
          const byId = yield* persistence.getSavedDevice(first.id);
          if (Option.isNone(byId)) {
            throw new Error("expected saved device by id");
          }
          expect(byId.value).toEqual(first);

          const byUsb = yield* persistence.findSavedDeviceByIdentity(
            SavedDeviceIdentity.make({
              portPath: "/dev/tty.reenumerated",
              usb: first.usb,
            }),
          );
          if (Option.isNone(byUsb)) {
            throw new Error("expected saved device by usb identity");
          }
          expect(byUsb.value).toEqual(first);

          const byPort = yield* persistence.findSavedDeviceByIdentity(
            SavedDeviceIdentity.make({
              portPath: first.portPath,
              usb: UsbIdentity.make({
                vendorId: null,
                productId: null,
                serialNumber: null,
                manufacturer: null,
              }),
            }),
          );
          if (Option.isNone(byPort)) {
            throw new Error("expected saved device by port path");
          }
          expect(byPort.value).toEqual(first);

          const updated = yield* persistence.upsertSavedDevice(
            SavedDeviceDraft.make({
              id: first.id,
              portPath: first.portPath,
              displayName: "Probe A1",
              usb: first.usb,
              serialConfig: first.serialConfig,
              metadata: first.metadata,
            }),
          );
          expect(updated.createdAt).toBe(first.createdAt);
          expect(updated.displayName).toBe("Probe A1");

          yield* persistence.forgetSavedDevice(first.id);
          expect(yield* persistence.listSavedDevices).toEqual([]);
        }),
      ),
    ),
  );

  it.effect("snapshots store metadata and Float32 sample blobs", () =>
    withTempPath((path) =>
      runWithPersistence(
        path,
        Effect.gen(function* () {
          const persistence = yield* Persistence;
          const samples = SnapshotSamplesWrite.make({
            format: SNAPSHOT_SAMPLE_FORMAT,
            data: floatBytes([1, 2, 3, 4, 5, 6]),
          });
          const snapshot = yield* persistence.createSnapshot(
            snapshotDraft("Boot trace", 3),
            samples,
          );

          expect(snapshot.sample.stored).toBe(true);
          expect(snapshot.sample.byteLength).toBe(Float32Array.BYTES_PER_ELEMENT * 2 * 3);
          expect(yield* persistence.listSnapshots()).toEqual([snapshot]);

          const loaded = yield* persistence.readSnapshotSamples(snapshot.id);
          if (Option.isNone(loaded)) {
            throw new Error("expected snapshot samples");
          }
          expect(Array.from(loaded.value.data)).toEqual(Array.from(samples.data));

          const renamed = yield* persistence.renameSnapshot(snapshot.id, "Renamed trace");
          expect(renamed.label).toBe("Renamed trace");

          const replacement = SnapshotSamplesWrite.make({
            format: SNAPSHOT_SAMPLE_FORMAT,
            data: floatBytes([7, 8, 9, 10, 11, 12]),
          });
          const rewritten = yield* persistence.writeSnapshotSamples(snapshot.id, replacement);
          expect(rewritten.sample.stored).toBe(true);

          const reloaded = yield* persistence.readSnapshotSamples(snapshot.id);
          if (Option.isNone(reloaded)) {
            throw new Error("expected rewritten snapshot samples");
          }
          expect(Array.from(reloaded.value.data)).toEqual(Array.from(replacement.data));

          yield* persistence.deleteSnapshot(snapshot.id);
          expect(yield* persistence.listSnapshots()).toEqual([]);
        }),
      ),
    ),
  );

  it.effect("rejects impossible snapshot metadata", () =>
    withTempPath((path) =>
      Effect.gen(function* () {
        const impossibleError = yield* Effect.flip(
          runWithPersistence(
            path,
            Effect.gen(function* () {
              const persistence = yield* Persistence;
              const invalid = SnapshotDraft.make({
                ...snapshotDraft("Impossible trace", 1),
                preTriggerSeconds: 99,
                trigger: SnapshotTrigger.make({
                  threshold: 0.5,
                  channel: 99,
                  mode: "rising",
                }),
                rtValues: [0],
              });

              yield* persistence.createSnapshot(invalid);
            }),
          ),
        );
        expect(impossibleError).toMatchObject({ _tag: "PersistenceValidationError" });

        const triggerModeError = yield* Effect.flip(
          runWithPersistence(
            path,
            Effect.gen(function* () {
              const persistence = yield* Persistence;
              const invalid = {
                ...snapshotDraft("Invalid trigger mode", 1),
                trigger: {
                  threshold: 0.5,
                  channel: 0,
                  mode: "edge" as never,
                },
              };

              yield* persistence.createSnapshot(invalid as never);
            }),
          ),
        );
        expect(triggerModeError).toMatchObject({ _tag: "PersistenceValidationError" });

        yield* runWithPersistence(
          path,
          Effect.gen(function* () {
            const persistence = yield* Persistence;
            expect(yield* persistence.listSnapshots()).toEqual([]);
          }),
        );
      }),
    ),
  );

  it.effect("corrupt snapshot metadata is dropped without wiping valid captures", () =>
    withTempPath((path) =>
      Effect.gen(function* () {
        const snapshot = yield* runWithPersistence(
          path,
          Effect.gen(function* () {
            const persistence = yield* Persistence;
            return yield* persistence.createSnapshot(snapshotDraft("Valid trace", 1));
          }),
        );

        yield* runWithSql(
          path,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`
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
              ${"snapshot:corrupt"},
              ${"Corrupt trace"},
              ${"probe-a"},
              ${0},
              ${1},
              ${SNAPSHOT_SAMPLE_FORMAT},
              ${1_000},
              ${0.001},
              ${0},
              ${"["},
              ${"{}"},
              ${"[0]"},
              ${"{}"},
              ${"2026-06-13T08:00:00.000Z"},
              ${"2026-06-13T08:00:00.000Z"}
            )
          `;
          }),
        );

        yield* runWithPersistence(
          path,
          Effect.gen(function* () {
            const persistence = yield* Persistence;
            expect(yield* persistence.listSnapshots()).toEqual([snapshot]);
          }),
        );

        const ids = yield* runWithSql(
          path,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const rows = yield* sql<{ id: string }>`SELECT id FROM snapshots ORDER BY id`;
            return rows.map((row) => row.id);
          }),
        );

        expect(ids).toEqual([snapshot.id]);
      }),
    ),
  );
});
