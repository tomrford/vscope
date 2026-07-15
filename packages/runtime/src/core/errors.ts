import { Data } from "effect";
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

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || describeTaggedError(error);
  }

  return describeTaggedError(error);
}

function describeTaggedError(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return String(error);
  }

  if ("_tag" in error && typeof error._tag === "string") {
    const fields = Object.entries(error).filter(([key]) => key !== "_tag" && key !== "stack");
    const details = fields.map(([key, value]) => `${key}=${describeErrorField(value)}`);
    if (
      "cause" in error &&
      error.cause !== null &&
      error.cause !== undefined &&
      !fields.some(([key]) => key === "cause")
    ) {
      details.push(`cause=${describeErrorField(error.cause)}`);
    }
    return details.length > 0 ? `${error._tag}: ${details.join(", ")}` : error._tag;
  }

  return String(error);
}

function describeErrorField(value: unknown): string {
  if (value instanceof Error) {
    return describeError(value);
  }

  if (typeof value === "object" && value !== null && "_tag" in value) {
    return describeTaggedError(value);
  }

  return JSON.stringify(value) ?? String(value);
}
