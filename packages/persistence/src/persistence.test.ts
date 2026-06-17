import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { describe, expect, test } from "vitest";

import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  DEFAULT_PREFERENCES,
  DEFAULT_SERIAL_CONFIG,
  DEFAULT_SETTINGS,
  Persistence,
  SavedDeviceDraft,
  SavedDeviceIdentity,
  SNAPSHOT_SAMPLE_FORMAT,
  SerialConfig,
  SnapshotComparisonDraft,
  SnapshotDraft,
  SnapshotSamplesWrite,
  SnapshotTrigger,
  UsbIdentity,
  initializePersistence,
  makePersistenceLayer,
} from "./index.ts";

async function withTempPath<T>(run: (path: string) => Promise<T>) {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "vscope-persistence-"));
  const path = nodePath.join(dir, "state.sqlite");

  try {
    return await run(path);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function runWithPersistence<A, E>(
  path: string,
  effect: Effect.Effect<A, E, Persistence>,
): Promise<A> {
  return await Effect.runPromise(
    Effect.scoped(effect.pipe(Effect.provide(makePersistenceLayer({ path })))),
  );
}

async function runWithSql<A, E>(
  path: string,
  effect: Effect.Effect<A, E, SqlClient.SqlClient>,
): Promise<A> {
  return await Effect.runPromise(
    Effect.scoped(effect.pipe(Effect.provide(SqliteClient.layer({ filename: path })))),
  );
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
    divider: 1,
    preTriggerSamples: 1,
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
  test("reports SQLite open defects as typed open errors", async () => {
    await withTempPath(async (path) => {
      fs.mkdirSync(path);

      await expect(Effect.runPromise(initializePersistence({ path }))).rejects.toMatchObject({
        _tag: "PersistenceOpenError",
      });
    });
  });

  test("reports migration defects as typed migration errors", async () => {
    await withTempPath(async (path) => {
      await runWithSql(
        path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE saved_devices_port_path_idx (id INTEGER PRIMARY KEY)`;
        }),
      );

      await expect(Effect.runPromise(initializePersistence({ path }))).rejects.toMatchObject({
        _tag: "PersistenceMigrationError",
      });
    });
  });

  test("migrations create the persistence tables", async () => {
    await withTempPath(async (path) => {
      await Effect.runPromise(initializePersistence({ path }));

      const names = await runWithSql(
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
        "preferences",
        "saved_devices",
        "settings",
        "snapshot_comparison_snapshots",
        "snapshot_comparisons",
        "snapshot_samples",
        "snapshots",
      ]);
    });
  });

  test("settings and preferences round-trip, recover, and reset", async () => {
    await withTempPath(async (path) => {
      await runWithPersistence(
        path,
        Effect.gen(function* () {
          const persistence = yield* Persistence;

          const defaults = yield* persistence.readSettings;
          expect(defaults.settings).toEqual(DEFAULT_SETTINGS);
          expect(defaults.recovery.pending).toBe(false);
          expect(defaults.recovery.message).toBe(null);

          const settings = yield* persistence.patchSettings({ theme: "dark" });
          expect(settings.settings.theme).toBe("dark");

          const preferences = yield* persistence.patchPreferences({
            recentPortPaths: ["/dev/tty.usbserial"],
            showAdvancedControls: true,
          });
          expect(preferences.preferences.recentPortPaths).toEqual(["/dev/tty.usbserial"]);
          expect(preferences.preferences.showAdvancedControls).toBe(true);
        }),
      );

      await runWithSql(
        path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE settings SET data_json = ${"{"} WHERE id = 1`;
          yield* sql`UPDATE preferences SET data_json = ${"{"} WHERE id = 1`;
        }),
      );

      await runWithPersistence(
        path,
        Effect.gen(function* () {
          const persistence = yield* Persistence;
          const settings = yield* persistence.readSettings;
          const preferences = yield* persistence.readPreferences;

          expect(settings.settings).toEqual(DEFAULT_SETTINGS);
          expect(settings.recovery.pending).toBe(true);
          expect(settings.recovery.message).toBe("Corrupt settings were reset to defaults.");
          expect(preferences.preferences).toEqual(DEFAULT_PREFERENCES);
          expect(preferences.recovery.pending).toBe(true);
          expect(preferences.recovery.message).toBe("Corrupt preferences were reset to defaults.");

          const resetSettings = yield* persistence.resetSettings;
          expect(resetSettings.settings).toEqual(DEFAULT_SETTINGS);
          expect(resetSettings.recovery.pending).toBe(false);
          expect(resetSettings.recovery.message).toBe(null);

          const resetPreferences = yield* persistence.resetPreferences;
          expect(resetPreferences.preferences).toEqual(DEFAULT_PREFERENCES);
          expect(resetPreferences.recovery.pending).toBe(false);
          expect(resetPreferences.recovery.message).toBe(null);
        }),
      );
    });
  });

  test("settings and preferences patches validate instead of defecting", async () => {
    await withTempPath(async (path) => {
      await expect(
        runWithPersistence(
          path,
          Effect.gen(function* () {
            const persistence = yield* Persistence;
            yield* persistence.patchSettings({ theme: "purple" as never });
          }),
        ),
      ).rejects.toMatchObject({ _tag: "PersistenceValidationError" });

      await expect(
        runWithPersistence(
          path,
          Effect.gen(function* () {
            const persistence = yield* Persistence;
            yield* persistence.patchPreferences({
              favoriteSnapshotIds: ["" as never],
            });
          }),
        ),
      ).rejects.toMatchObject({ _tag: "PersistenceValidationError" });
    });
  });

  test("concurrent settings and preferences patches preserve independent fields", async () => {
    await withTempPath(async (path) => {
      await runWithPersistence(
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

          yield* Effect.all(
            [
              persistence.patchPreferences({ recentPortPaths: ["/dev/tty.usbserial-a"] }),
              persistence.patchPreferences({ showAdvancedControls: true }),
            ],
            { concurrency: 2 },
          );

          const preferences = yield* persistence.readPreferences;
          expect(preferences.preferences.recentPortPaths).toEqual(["/dev/tty.usbserial-a"]);
          expect(preferences.preferences.showAdvancedControls).toBe(true);
        }),
      );
    });
  });

  test("saved devices round-trip through typed records", async () => {
    await withTempPath(async (path) => {
      await runWithPersistence(
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
      );
    });
  });

  test("snapshots store metadata and Float32 sample blobs", async () => {
    await withTempPath(async (path) => {
      await runWithPersistence(
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
      );
    });
  });

  test("rejects impossible snapshot metadata", async () => {
    await withTempPath(async (path) => {
      await expect(
        runWithPersistence(
          path,
          Effect.gen(function* () {
            const persistence = yield* Persistence;
            const invalid = SnapshotDraft.make({
              ...snapshotDraft("Impossible trace", 1),
              preTriggerSamples: 99,
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
      ).rejects.toMatchObject({ _tag: "PersistenceValidationError" });

      await expect(
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
      ).rejects.toMatchObject({ _tag: "PersistenceValidationError" });

      await runWithPersistence(
        path,
        Effect.gen(function* () {
          const persistence = yield* Persistence;
          expect(yield* persistence.listSnapshots()).toEqual([]);
        }),
      );
    });
  });

  test("snapshot comparisons round-trip as typed records", async () => {
    await withTempPath(async (path) => {
      await runWithPersistence(
        path,
        Effect.gen(function* () {
          const persistence = yield* Persistence;
          const first = yield* persistence.createSnapshot(snapshotDraft("Trace A", 1));
          const second = yield* persistence.createSnapshot(snapshotDraft("Trace B", 1));
          const comparison = yield* persistence.createSnapshotComparison(
            SnapshotComparisonDraft.make({
              label: "A vs B",
              snapshotIds: [first.id, second.id],
              options: {
                align: "trigger",
              },
              metadata: {},
            }),
          );

          expect(comparison.id.startsWith("comparison:")).toBe(true);
          expect(yield* persistence.listSnapshotComparisons).toEqual([comparison]);

          const renamed = yield* persistence.renameSnapshotComparison(comparison.id, "Renamed");
          expect(renamed.label).toBe("Renamed");

          yield* persistence.deleteSnapshot(first.id);
          expect(yield* persistence.listSnapshotComparisons).toEqual([]);

          const third = yield* persistence.createSnapshot(snapshotDraft("Trace C", 1));
          const replacement = yield* persistence.createSnapshotComparison(
            SnapshotComparisonDraft.make({
              label: "B vs C",
              snapshotIds: [second.id, third.id],
              options: {},
              metadata: {},
            }),
          );
          yield* persistence.deleteSnapshotComparison(replacement.id);
          expect(yield* persistence.listSnapshotComparisons).toEqual([]);
        }),
      );
    });
  });

  test("snapshot comparisons reject duplicate member ids before SQLite insert", async () => {
    await withTempPath(async (path) => {
      await expect(
        runWithPersistence(
          path,
          Effect.gen(function* () {
            const persistence = yield* Persistence;
            const snapshot = yield* persistence.createSnapshot(snapshotDraft("Trace A", 1));

            yield* persistence.createSnapshotComparison(
              SnapshotComparisonDraft.make({
                label: "Duplicate trace",
                snapshotIds: [snapshot.id, snapshot.id],
                options: {},
                metadata: {},
              }),
            );
          }),
        ),
      ).rejects.toMatchObject({ _tag: "PersistenceValidationError" });
    });
  });

  test("corrupt snapshot metadata is dropped without wiping valid captures", async () => {
    await withTempPath(async (path) => {
      const snapshot = await runWithPersistence(
        path,
        Effect.gen(function* () {
          const persistence = yield* Persistence;
          return yield* persistence.createSnapshot(snapshotDraft("Valid trace", 1));
        }),
      );

      await runWithSql(
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
              divider,
              pre_trigger_samples,
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
              ${1},
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

      await runWithPersistence(
        path,
        Effect.gen(function* () {
          const persistence = yield* Persistence;
          expect(yield* persistence.listSnapshots()).toEqual([snapshot]);
        }),
      );

      const ids = await runWithSql(
        path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{ id: string }>`SELECT id FROM snapshots ORDER BY id`;
          return rows.map((row) => row.id);
        }),
      );

      expect(ids).toEqual([snapshot.id]);
    });
  });
});
