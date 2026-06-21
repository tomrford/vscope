import { SqliteMigrator } from "@effect/sql-sqlite-node";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const persistenceMigrations = SqliteMigrator.fromRecord({
  "1_foundation": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data_json TEXT NOT NULL,
        recovery_pending INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )
    `;

    yield* sql`
      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        device_name TEXT NOT NULL,
        channel_count INTEGER NOT NULL,
        sample_count INTEGER NOT NULL,
        sample_format TEXT NOT NULL,
        sample_rate_hz REAL,
        total_duration_seconds REAL NOT NULL,
        pre_trigger_seconds REAL NOT NULL,
        channel_map_json TEXT NOT NULL,
        trigger_json TEXT NOT NULL,
        rt_values_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;

    yield* sql`
      CREATE INDEX IF NOT EXISTS snapshots_created_at_idx
        ON snapshots(created_at DESC, id DESC)
    `;

    yield* sql`
      CREATE TABLE IF NOT EXISTS snapshot_samples (
        snapshot_id TEXT PRIMARY KEY,
        format TEXT NOT NULL,
        byte_len INTEGER NOT NULL,
        data BLOB NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
      )
    `;
  }),
});
