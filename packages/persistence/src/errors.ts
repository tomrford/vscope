import { Schema } from "effect";

export class PersistenceOpenError extends Schema.TaggedErrorClass<PersistenceOpenError>()(
  "PersistenceOpenError",
  {
    path: Schema.String,
    reason: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export class PersistenceMigrationError extends Schema.TaggedErrorClass<PersistenceMigrationError>()(
  "PersistenceMigrationError",
  {
    migration: Schema.String,
    reason: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export class PersistenceQueryError extends Schema.TaggedErrorClass<PersistenceQueryError>()(
  "PersistenceQueryError",
  {
    operation: Schema.String,
    reason: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export class PersistenceValidationError extends Schema.TaggedErrorClass<PersistenceValidationError>()(
  "PersistenceValidationError",
  {
    operation: Schema.String,
    reason: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export class PersistenceClosedError extends Schema.TaggedErrorClass<PersistenceClosedError>()(
  "PersistenceClosedError",
  {
    operation: Schema.String,
  },
) {}

export class SnapshotNotFoundError extends Schema.TaggedErrorClass<SnapshotNotFoundError>()(
  "SnapshotNotFoundError",
  {
    id: Schema.String,
  },
) {}

export class SnapshotComparisonNotFoundError extends Schema.TaggedErrorClass<SnapshotComparisonNotFoundError>()(
  "SnapshotComparisonNotFoundError",
  {
    id: Schema.String,
  },
) {}

export type PersistenceError =
  | PersistenceOpenError
  | PersistenceMigrationError
  | PersistenceQueryError
  | PersistenceValidationError
  | PersistenceClosedError
  | SnapshotNotFoundError
  | SnapshotComparisonNotFoundError;

export function errorReason(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }

  return String(cause);
}
