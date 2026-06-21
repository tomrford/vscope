import { randomUUID } from "node:crypto";

import { Effect, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";

import {
  PersistenceQueryError,
  PersistenceValidationError,
  errorReason,
  type PersistenceError,
} from "./errors.ts";
import {
  PersistentId,
  SnapshotDraft,
  SnapshotSampleDescriptor,
  SnapshotSamplesWrite,
  Timestamp,
} from "@vscope/shared";

export const SingletonRow = Schema.Struct({
  data_json: Schema.String,
  recovery_pending: Schema.Number,
});

export const CreatedAtRow = Schema.Struct({
  created_at: Schema.String,
});

export const SavedDeviceRow = Schema.Struct({
  id: Schema.String,
  port_path: Schema.NullOr(Schema.String),
  display_name: Schema.NullOr(Schema.String),
  vendor_id: Schema.NullOr(Schema.String),
  product_id: Schema.NullOr(Schema.String),
  serial_number: Schema.NullOr(Schema.String),
  manufacturer: Schema.NullOr(Schema.String),
  serial_config_json: Schema.String,
  metadata_json: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
});

export const SnapshotRow = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  device_name: Schema.String,
  channel_count: Schema.Number,
  sample_count: Schema.Number,
  sample_format: Schema.String,
  sample_rate_hz: Schema.NullOr(Schema.Number),
  total_duration_seconds: Schema.Number,
  pre_trigger_seconds: Schema.Number,
  channel_map_json: Schema.String,
  trigger_json: Schema.String,
  rt_values_json: Schema.String,
  metadata_json: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
  has_samples: Schema.Number,
});

export const SnapshotSampleRow = Schema.Struct({
  format: Schema.String,
  byte_len: Schema.Number,
  data: Schema.Unknown,
  updated_at: Schema.String,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function stringProperty(value: unknown, key: string): string | null {
  if (!isRecord(value)) {
    return null;
  }

  const candidate = value[key];
  return typeof candidate === "string" ? candidate : null;
}

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
  value: unknown,
): Effect.Effect<S["Type"], PersistenceValidationError, S["DecodingServices"]> {
  return Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((cause) => validationError(operation, cause)),
  );
}

function parseJson(
  operation: string,
  source: string,
): Effect.Effect<unknown, PersistenceValidationError> {
  return Effect.try({
    try: () => {
      const parsed: unknown = JSON.parse(source);
      return parsed;
    },
    catch: (cause) => validationError(operation, cause),
  });
}

export function decodeJson<S extends Schema.Top>(
  schema: S,
  operation: string,
  source: string,
): Effect.Effect<S["Type"], PersistenceValidationError, S["DecodingServices"]> {
  return parseJson(operation, source).pipe(
    Effect.flatMap((value) => decodeWith(schema, operation, value)),
  );
}

export function stringifyJson(
  operation: string,
  value: unknown,
): Effect.Effect<string, PersistenceValidationError> {
  return Effect.try({
    try: () => {
      const json = JSON.stringify(value);
      if (typeof json !== "string") {
        throw new Error("JSON value cannot be stringified");
      }
      return json;
    },
    catch: (cause) => validationError(operation, cause),
  });
}

function queryError(operation: string, cause: unknown): PersistenceQueryError {
  return PersistenceQueryError.make({
    operation,
    reason: errorReason(cause),
    cause,
  });
}

export function runSql<A>(
  operation: string,
  effect: Effect.Effect<A, SqlError>,
): Effect.Effect<A, PersistenceQueryError> {
  return effect.pipe(Effect.mapError((cause) => queryError(operation, cause)));
}

function isPersistenceError(cause: unknown): cause is PersistenceError {
  if (!isRecord(cause)) {
    return false;
  }

  switch (cause._tag) {
    case "PersistenceOpenError":
    case "PersistenceMigrationError":
    case "PersistenceQueryError":
    case "PersistenceValidationError":
    case "SnapshotNotFoundError":
      return true;
    default:
      return false;
  }
}

export function transactionError(operation: string, cause: unknown): PersistenceError {
  return isPersistenceError(cause) ? cause : queryError(operation, cause);
}

export function toUint8Array(
  operation: string,
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

export function validateSnapshotDraftShape(
  draft: SnapshotDraft,
): Effect.Effect<void, PersistenceValidationError> {
  const invalid = (reason: string) =>
    Effect.fail(
      PersistenceValidationError.make({
        operation: "validate snapshot draft",
        reason,
      }),
    );

  if (draft.channelMap.length !== draft.channelCount) {
    return invalid(
      `channelMap length ${draft.channelMap.length} does not match channelCount ${draft.channelCount}`,
    );
  }

  if (draft.trigger.channel >= draft.channelCount) {
    return invalid(
      `trigger channel ${draft.trigger.channel} is outside channelCount ${draft.channelCount}`,
    );
  }

  if (draft.preTriggerSeconds > draft.totalDurationSeconds) {
    return invalid(
      `preTriggerSeconds ${draft.preTriggerSeconds} exceeds totalDurationSeconds ${draft.totalDurationSeconds}`,
    );
  }

  return Effect.void;
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
