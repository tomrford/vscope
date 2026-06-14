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
      CREATE TABLE IF NOT EXISTS preferences (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data_json TEXT NOT NULL,
        recovery_pending INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )
    `;

    yield* sql`
      CREATE TABLE IF NOT EXISTS saved_devices (
        id TEXT PRIMARY KEY,
        port_path TEXT,
        display_name TEXT,
        vendor_id TEXT,
        product_id TEXT,
        serial_number TEXT,
        manufacturer TEXT,
        serial_config_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;

    yield* sql`
      CREATE INDEX IF NOT EXISTS saved_devices_port_path_idx
        ON saved_devices(port_path)
    `;

    yield* sql`
      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        device_id TEXT,
        device_name TEXT NOT NULL,
        port_path TEXT,
        channel_count INTEGER NOT NULL,
        sample_count INTEGER NOT NULL,
        sample_format TEXT NOT NULL,
        sample_rate_hz REAL,
        divider INTEGER NOT NULL,
        pre_trigger_samples INTEGER NOT NULL,
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
      CREATE INDEX IF NOT EXISTS snapshots_device_id_idx
        ON snapshots(device_id)
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

    yield* sql`
      CREATE TABLE IF NOT EXISTS snapshot_comparisons (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        options_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;

    yield* sql`
      CREATE TABLE IF NOT EXISTS snapshot_comparison_snapshots (
        comparison_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (comparison_id, position),
        UNIQUE (comparison_id, snapshot_id),
        FOREIGN KEY (comparison_id) REFERENCES snapshot_comparisons(id) ON DELETE CASCADE,
        FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
      )
    `;

    yield* sql`
      CREATE INDEX IF NOT EXISTS snapshot_comparisons_created_at_idx
        ON snapshot_comparisons(created_at DESC, id DESC)
    `;

    yield* sql`
      CREATE INDEX IF NOT EXISTS snapshot_comparison_snapshots_snapshot_id_idx
        ON snapshot_comparison_snapshots(snapshot_id)
    `;
  }),
});
