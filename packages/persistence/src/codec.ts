import { randomUUID } from "node:crypto";

import { Effect, Schema, SchemaTransformation } from "effect";

import {
  PersistenceMigrationError,
  PersistenceOpenError,
  PersistenceQueryError,
  PersistenceValidationError,
  SnapshotNotFoundError,
  errorReason,
  type PersistenceError,
} from "./errors.ts";
import {
  JsonObject,
  PersistentId,
  SNAPSHOT_SAMPLE_FORMAT,
  Settings,
  SnapshotRecord,
  SnapshotSampleDescriptor,
  SnapshotSamplesWrite,
  SnapshotTrigger,
  Timestamp,
  snapshotSampleByteLength,
} from "@vscope/shared";

export const SettingsRow = Schema.Struct({
  settings: Schema.fromJsonString(Settings),
  recoveryPending: Schema.BooleanFromBit,
}).pipe(
  Schema.encodeKeys({
    settings: "data_json",
    recoveryPending: "recovery_pending",
  }),
);

export const SettingsWrite = Schema.Struct({
  settings: Schema.fromJsonString(Settings),
  recoveryPending: Schema.BooleanFromBit,
  updatedAt: Timestamp,
}).pipe(
  Schema.encodeKeys({
    settings: "data_json",
    recoveryPending: "recovery_pending",
    updatedAt: "updated_at",
  }),
);

const SnapshotSqlFields = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  device_name: Schema.String,
  channel_count: Schema.Number,
  sample_count: Schema.Number,
  sample_format: Schema.Literals([SNAPSHOT_SAMPLE_FORMAT]),
  sample_rate_hz: Schema.NullOr(Schema.Number),
  total_duration_seconds: Schema.Number,
  pre_trigger_seconds: Schema.Number,
  channel_map_json: Schema.fromJsonString(Schema.Array(Schema.Number)),
  trigger_json: Schema.fromJsonString(Schema.toEncoded(SnapshotTrigger)),
  rt_values_json: Schema.fromJsonString(Schema.Array(Schema.Number)),
  metadata_json: Schema.fromJsonString(JsonObject),
  favorite: Schema.BooleanFromBit,
  created_at: Schema.String,
  updated_at: Schema.String,
  has_samples: Schema.BooleanFromBit,
});

export const SnapshotSql = SnapshotSqlFields.pipe(
  Schema.decodeTo(
    SnapshotRecord,
    SchemaTransformation.transform({
      decode: (row) => ({
        id: row.id,
        label: row.label,
        device: {
          name: row.device_name,
        },
        sample: {
          format: row.sample_format,
          channelCount: row.channel_count,
          sampleCount: row.sample_count,
          byteLength: snapshotSampleByteLength(row.channel_count, row.sample_count),
          stored: row.has_samples,
        },
        sampleRateHz: row.sample_rate_hz,
        totalDurationSeconds: row.total_duration_seconds,
        preTriggerSeconds: row.pre_trigger_seconds,
        channelMap: row.channel_map_json,
        trigger: row.trigger_json,
        rtValues: row.rt_values_json,
        metadata: row.metadata_json,
        favorite: row.favorite,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }),
      encode: (record) => ({
        id: record.id,
        label: record.label,
        device_name: record.device.name,
        channel_count: record.sample.channelCount,
        sample_count: record.sample.sampleCount,
        sample_format: record.sample.format,
        sample_rate_hz: record.sampleRateHz,
        total_duration_seconds: record.totalDurationSeconds,
        pre_trigger_seconds: record.preTriggerSeconds,
        channel_map_json: record.channelMap,
        trigger_json: record.trigger,
        rt_values_json: record.rtValues,
        metadata_json: record.metadata,
        favorite: record.favorite,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
        has_samples: record.sample.stored,
      }),
    }),
  ),
);

export const SnapshotSampleRow = Schema.Struct({
  format: Schema.String,
  byte_len: Schema.Number,
  data: Schema.Unknown,
  updated_at: Schema.String,
});

export const SnapshotRowId = Schema.Struct({
  id: Schema.String,
});

export const SnapshotFavoriteWrite = Schema.Struct({
  id: PersistentId,
  favorite: Schema.BooleanFromBit,
  updatedAt: Timestamp,
}).pipe(
  Schema.encodeKeys({
    updatedAt: "updated_at",
  }),
);

export const PrunedSnapshotId = Schema.Struct({
  id: Schema.String,
});

export const createTimestamp = Effect.fn("Persistence.createTimestamp")(function* () {
  return yield* decodeWith(Timestamp, "create timestamp", new Date().toISOString());
});

export const createId = Effect.fn("Persistence.createId")(function* (prefix: string) {
  return yield* decodeWith(PersistentId, "create persistent id", `${prefix}:${randomUUID()}`);
});

function validationError(operation: string, cause: unknown): PersistenceValidationError {
  return PersistenceValidationError.make({
    operation,
    reason: errorReason(cause),
    cause,
  });
}

export function decodeWith<S extends Schema.Top>(
  schema: S,
  operation: string,
  // SQL, JSON, and host values enter the typed application through this decoder.
  value: unknown,
): Effect.Effect<S["Type"], PersistenceValidationError, S["DecodingServices"]> {
  return Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((cause) => validationError(operation, cause)),
  );
}

function queryError(operation: string, cause: unknown): PersistenceQueryError {
  return PersistenceQueryError.make({
    operation,
    reason: errorReason(cause),
    cause,
  });
}

export function runBound<A, E, R>(
  operation: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, PersistenceError, R> {
  return effect.pipe(
    Effect.mapError((cause) => {
      if (isPersistenceError(cause)) {
        return cause;
      }

      return Schema.isSchemaError(cause)
        ? validationError(operation, cause)
        : queryError(operation, cause);
    }),
  );
}

function isPersistenceError(cause: unknown): cause is PersistenceError {
  return (
    cause instanceof PersistenceOpenError ||
    cause instanceof PersistenceMigrationError ||
    cause instanceof PersistenceQueryError ||
    cause instanceof PersistenceValidationError ||
    cause instanceof SnapshotNotFoundError
  );
}

export function transactionError(operation: string, cause: unknown): PersistenceError {
  return isPersistenceError(cause) ? cause : queryError(operation, cause);
}

export function toUint8Array(
  operation: string,
  // External boundary: Effect SQL may expose SQLite blobs in driver-native forms.
  value: unknown,
): Effect.Effect<Uint8Array, PersistenceValidationError> {
  if (value instanceof Uint8Array) {
    return Effect.succeed(Uint8Array.from(value));
  }

  if (value instanceof ArrayBuffer) {
    return Effect.succeed(new Uint8Array(value.slice(0)));
  }

  if (ArrayBuffer.isView(value)) {
    return Effect.succeed(
      Uint8Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
    );
  }

  if (Array.isArray(value)) {
    const bytes = new Uint8Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      const byte = value[index];
      if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
        return Effect.fail(
          PersistenceValidationError.make({
            operation,
            reason: "SQLite blob array contains a non-byte value",
          }),
        );
      }
      bytes[index] = byte;
    }
    return Effect.succeed(bytes);
  }

  return Effect.fail(
    PersistenceValidationError.make({
      operation,
      reason: "Unsupported SQLite blob value",
    }),
  );
}

export function validateSamplesForDescriptor(
  descriptor: SnapshotSampleDescriptor,
  samples: SnapshotSamplesWrite,
): Effect.Effect<void, PersistenceValidationError> {
  if (samples.format !== descriptor.format) {
    return Effect.fail(
      PersistenceValidationError.make({
        operation: "validate snapshot samples",
        reason: `sample format ${samples.format} does not match snapshot format ${descriptor.format}`,
      }),
    );
  }

  if (samples.data.byteLength !== descriptor.byteLength) {
    return Effect.fail(
      PersistenceValidationError.make({
        operation: "validate snapshot samples",
        reason: `sample byte length ${samples.data.byteLength} does not match expected ${descriptor.byteLength}`,
      }),
    );
  }

  return Effect.void;
}
