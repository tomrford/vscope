import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import {
  DEFAULT_PREFERENCES,
  DEFAULT_SETTINGS,
  type PersistenceDatabase,
  initializePersistence,
  openPersistence,
} from ".";
import { openSqliteDatabase } from "./sqlite";

async function withTempPath<T>(run: (path: string) => Promise<T>) {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "vscope-persistence-"));
  const path = nodePath.join(dir, "state.sqlite");

  try {
    return await run(path);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function withTempDatabase<T>(
  run: (database: PersistenceDatabase, path: string) => Promise<T>,
) {
  return await withTempPath(async (path) => {
    const database = await Effect.runPromise(openPersistence(path));

    try {
      return await run(database, path);
    } finally {
      await Effect.runPromise(database.close());
    }
  });
}

describe("@vscope/persistence", () => {
  test("migrations create the persistence tables", async () => {
    await withTempPath(async (path) => {
      await Effect.runPromise(initializePersistence(path));
      const sqlite = await openSqliteDatabase(path);
      const rows = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>;
      sqlite.close();

      expect(rows.map((row) => row.name)).toEqual([
        "persistence_migrations",
        "preferences",
        "saved_ports",
        "settings",
        "snapshot_data",
        "snapshot_meta",
      ]);
    });
  });

  test("settings round-trip, recover from corrupt data, and reset", async () => {
    await withTempDatabase(async (database, path) => {
      expect(await Effect.runPromise(database.readSettings())).toEqual(DEFAULT_SETTINGS);

      const updated = await Effect.runPromise(
        database.updateSettings({
          theme: "dark",
          defaultDivider: 4,
          triggerThreshold: 1.5,
        }),
      );

      expect(updated).toEqual({
        ...DEFAULT_SETTINGS,
        theme: "dark",
        defaultDivider: 4,
        triggerThreshold: 1.5,
      });
      expect(await Effect.runPromise(database.readSettings())).toEqual(updated);

      await Effect.runPromise(database.close());
      const sqlite = await openSqliteDatabase(path);
      sqlite.prepare("UPDATE settings SET data_json = ? WHERE id = 1").run("{");
      sqlite.close();

      const reopened = await Effect.runPromise(openPersistence(path));
      const recovered = await Effect.runPromise(reopened.readSettingsState());

      expect(recovered).toEqual({
        settings: DEFAULT_SETTINGS,
        recovery: {
          pending: true,
          message: "Corrupt settings were reset to defaults.",
        },
      });

      expect(await Effect.runPromise(reopened.resetSettings())).toEqual(DEFAULT_SETTINGS);
      expect(await Effect.runPromise(reopened.readSettingsState())).toEqual({
        settings: DEFAULT_SETTINGS,
        recovery: {
          pending: false,
          message: null,
        },
      });
      await Effect.runPromise(reopened.close());
    });
  });

  test("preferences and saved ports round-trip", async () => {
    await withTempDatabase(async (database) => {
      const preferences = await Effect.runPromise(
        database.updatePreferences({
          recentPortPaths: ["/dev/tty.usbserial"],
          lastPortPath: "/dev/tty.usbserial",
          favoriteSnapshotIds: [1, 2],
          showAdvancedControls: true,
        }),
      );

      expect(preferences).toEqual({
        recentPortPaths: ["/dev/tty.usbserial"],
        lastPortPath: "/dev/tty.usbserial",
        favoriteSnapshotIds: [1, 2],
        showAdvancedControls: true,
      });

      const savedPort = await Effect.runPromise(
        database.saveSavedPort("/dev/tty.usbserial", {
          baudRate: 115200,
          dataBits: 8,
        }),
      );

      expect(savedPort.path).toBe("/dev/tty.usbserial");
      expect(await Effect.runPromise(database.listSavedPorts())).toEqual([savedPort]);
      await Effect.runPromise(database.forgetSavedPort("/dev/tty.usbserial"));
      expect(await Effect.runPromise(database.listSavedPorts())).toEqual([]);
      expect(await Effect.runPromise(database.resetPreferences())).toEqual(DEFAULT_PREFERENCES);
    });
  });

  test("snapshots save, list, load, rename, overwrite data, and delete", async () => {
    await withTempDatabase(async (database) => {
      const snapshot = await Effect.runPromise(
        database.saveSnapshot(
          {
            label: "Boot trace",
            deviceNames: ["probe-a"],
            channelCount: 2,
            sampleCount: 3,
            divider: 1,
            preTrig: 1,
            channelMap: [0, 1],
            triggerThreshold: 0.5,
            triggerChannel: 1,
            triggerMode: "rising",
            rtValues: [0, 1],
            metadata: {
              note: "first capture",
            },
            createdAt: "2026-06-13T08:00:00.000Z",
          },
          [
            [1, 2],
            [3.5, 4.5],
            [5, 6],
          ],
        ),
      );

      expect(snapshot.id).toBeGreaterThan(0);
      expect(await Effect.runPromise(database.listSnapshots())).toEqual([snapshot]);
      expect(await Effect.runPromise(database.loadSnapshotSamples(snapshot))).toEqual([
        [1, 2],
        [3.5, 4.5],
        [5, 6],
      ]);

      const renamed = await Effect.runPromise(database.renameSnapshot(snapshot.id, "Renamed"));
      expect(renamed.label).toBe("Renamed");
      expect((await Effect.runPromise(database.listSnapshots()))[0].label).toBe("Renamed");

      await Effect.runPromise(
        database.storeSnapshotSamples(renamed, [
          [7, 8],
          [9, 10],
          [11, 12],
        ]),
      );
      expect(await Effect.runPromise(database.loadSnapshotSamples(renamed))).toEqual([
        [7, 8],
        [9, 10],
        [11, 12],
      ]);

      const raw = new Uint8Array([1, 2, 3, 4]);
      await Effect.runPromise(database.storeSnapshotBlob(renamed.id, raw));
      const loadedBlob = await Effect.runPromise(database.loadSnapshotBlob(renamed.id));
      expect(loadedBlob?.byteLength).toBe(4);
      expect(Array.from(loadedBlob?.data ?? [])).toEqual([1, 2, 3, 4]);

      await Effect.runPromise(database.deleteSnapshot(snapshot.id));
      expect(await Effect.runPromise(database.listSnapshots())).toEqual([]);
      expect(await Effect.runPromise(database.loadSnapshotBlob(snapshot.id))).toBeNull();
    });
  });

  test("corrupt snapshot metadata is dropped without wiping the database", async () => {
    await withTempDatabase(async (database, path) => {
      const snapshot = await Effect.runPromise(
        database.saveSnapshot({
          label: "Valid trace",
          deviceNames: ["probe-a"],
          channelCount: 1,
          sampleCount: 1,
          divider: 1,
          preTrig: 0,
          channelMap: [0],
          triggerThreshold: 0,
          triggerChannel: 0,
          triggerMode: "rising",
          rtValues: [0],
          metadata: {},
          createdAt: "2026-06-13T08:00:00.000Z",
        }),
      );

      await Effect.runPromise(database.close());
      const sqlite = await openSqliteDatabase(path);
      sqlite
        .prepare(
          `
            INSERT INTO snapshot_meta (
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
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          99,
          "Corrupt trace",
          "{",
          1,
          1,
          1,
          0,
          "[0]",
          0,
          0,
          "rising",
          "[0]",
          "{}",
          "2026-06-13T09:00:00.000Z",
          "2026-06-13T09:00:00.000Z",
        );
      sqlite.close();

      const reopened = await Effect.runPromise(openPersistence(path));
      expect(await Effect.runPromise(reopened.listSnapshots())).toEqual([snapshot]);
      await Effect.runPromise(reopened.close());

      const verified = await openSqliteDatabase(path);
      const rows = verified.prepare("SELECT id FROM snapshot_meta ORDER BY id").all() as Array<{
        id: number;
      }>;
      verified.close();
      expect(rows).toEqual([{ id: snapshot.id }]);
    });
  });
});
