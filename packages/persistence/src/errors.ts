import { Data } from "effect";

export class PersistenceOpenError extends Data.TaggedError("PersistenceOpenError")<{
  readonly path: string;
  readonly reason: string;
  readonly cause?: unknown;
}> {}

export class MigrationError extends Data.TaggedError("MigrationError")<{
  readonly migration: string;
  readonly reason: string;
  readonly cause?: unknown;
}> {}

export class PersistenceQueryError extends Data.TaggedError("PersistenceQueryError")<{
  readonly operation: string;
  readonly reason: string;
  readonly cause?: unknown;
}> {}

export class PersistenceValidationError extends Data.TaggedError("PersistenceValidationError")<{
  readonly operation: string;
  readonly reason: string;
  readonly cause?: unknown;
}> {}

export class SnapshotNotFoundError extends Data.TaggedError("SnapshotNotFoundError")<{
  readonly id: number;
}> {}

export class PersistenceClosedError extends Data.TaggedError("PersistenceClosedError")<{
  readonly operation: string;
}> {}

export type PersistenceError =
  | PersistenceOpenError
  | MigrationError
  | PersistenceQueryError
  | PersistenceValidationError
  | SnapshotNotFoundError
  | PersistenceClosedError;

export function errorReason(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
