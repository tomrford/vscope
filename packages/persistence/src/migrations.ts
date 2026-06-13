import { Effect } from "effect";

import { MigrationError, errorReason } from "./errors";
import type { SqliteDatabase } from "./sqlite";

export const MIGRATION_0001 = "1_Init";

export function runMigrations(database: SqliteDatabase): Effect.Effect<void, MigrationError> {
  return Effect.try({
    try: () => {
      const transaction = database.transaction(() => {
        database.exec(`
          CREATE TABLE IF NOT EXISTS persistence_migrations (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            applied_at TEXT NOT NULL
          );
        `);

        const applied = database
          .prepare("SELECT id FROM persistence_migrations WHERE name = ?")
          .get(MIGRATION_0001);

        if (applied) {
          return;
        }

        database.exec(`
          CREATE TABLE IF NOT EXISTS settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            data_json TEXT NOT NULL,
            recovery_pending INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS preferences (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            data_json TEXT NOT NULL,
            recovery_pending INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS saved_ports (
            path TEXT PRIMARY KEY,
            last_config_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS snapshot_meta (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            device_names_json TEXT NOT NULL,
            channel_count INTEGER NOT NULL,
            sample_count INTEGER NOT NULL,
            divider INTEGER NOT NULL,
            pre_trig INTEGER NOT NULL,
            channel_map_json TEXT NOT NULL,
            trigger_threshold REAL NOT NULL,
            trigger_channel INTEGER NOT NULL,
            trigger_mode TEXT NOT NULL,
            rt_values_json TEXT NOT NULL,
            metadata_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );

          CREATE INDEX IF NOT EXISTS snapshot_meta_created_at_idx
            ON snapshot_meta(created_at DESC, id DESC);

          CREATE TABLE IF NOT EXISTS snapshot_data (
            snapshot_id INTEGER PRIMARY KEY,
            data BLOB NOT NULL,
            byte_len INTEGER NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (snapshot_id) REFERENCES snapshot_meta(id) ON DELETE CASCADE
          );
        `);

        database
          .prepare("INSERT INTO persistence_migrations (id, name, applied_at) VALUES (?, ?, ?)")
          .run(1, MIGRATION_0001, new Date().toISOString());
      });

      transaction();
    },
    catch: (cause) =>
      new MigrationError({
        migration: MIGRATION_0001,
        reason: errorReason(cause),
        cause,
      }),
  });
}
