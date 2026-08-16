import { Data, Predicate } from "effect";
import type { PersistenceError } from "@vscope/persistence";
import type {
  SerialCloseError,
  SerialListError,
  SerialOpenError,
  VScopeDeviceAlreadyOpenError,
  VScopeDeviceError,
  VScopeDeviceNotFoundError,
} from "@vscope/serial";

export class RuntimeCorePersistenceError extends Data.TaggedError("RuntimeCorePersistenceError")<{
  readonly operation: string;
  readonly cause: PersistenceError;
}> {}

export class RuntimeCoreSerialError extends Data.TaggedError("RuntimeCoreSerialError")<{
  readonly operation: string;
  readonly cause:
    | SerialCloseError
    | SerialListError
    | SerialOpenError
    | VScopeDeviceAlreadyOpenError
    | VScopeDeviceError
    | VScopeDeviceNotFoundError;
}> {}

export class RuntimeCorePolicyError extends Data.TaggedError("RuntimeCorePolicyError")<{
  readonly command: string;
  readonly reason: string;
}> {}

export type RuntimeCoreError =
  | RuntimeCorePersistenceError
  | RuntimeCorePolicyError
  | RuntimeCoreSerialError;

export function describeRuntimeCoreError(error: RuntimeCoreError): string {
  switch (error._tag) {
    case "RuntimeCorePersistenceError":
      return `${error.operation}: ${describeError(error.cause)}`;
    case "RuntimeCorePolicyError":
      return `${error.command}: ${error.reason}`;
    case "RuntimeCoreSerialError":
      return `${error.operation}: ${describeError(error.cause)}`;
  }
}

export function describeError(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message || describeTaggedError(cause);
  }

  return describeTaggedError(cause);
}

function describeTaggedError(cause: unknown): string {
  if (!Predicate.hasProperty(cause, "_tag") || !Predicate.isString(cause._tag)) {
    return String(cause);
  }

  const fields = Object.entries(cause).filter(([key]) => key !== "_tag" && key !== "stack");
  const details = fields.map(([key, value]) => `${key}=${describeErrorField(value)}`);
  if (
    Predicate.hasProperty(cause, "cause") &&
    cause.cause !== null &&
    cause.cause !== undefined &&
    !fields.some(([key]) => key === "cause")
  ) {
    details.push(`cause=${describeErrorField(cause.cause)}`);
  }
  return details.length > 0 ? `${cause._tag}: ${details.join(", ")}` : cause._tag;
}

function describeErrorField(value: unknown): string {
  if (value instanceof Error) {
    return describeError(value);
  }

  if (Predicate.hasProperty(value, "_tag")) {
    return describeTaggedError(value);
  }

  return JSON.stringify(value) ?? String(value);
}
