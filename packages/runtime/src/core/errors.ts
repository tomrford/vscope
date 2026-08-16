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

type SerialIoError = Extract<VScopeDeviceError, { readonly _tag: "VScopeTransportError" }>["cause"];

type DescribedError = PersistenceError | RuntimeCoreSerialError["cause"] | SerialIoError;

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

function describeError(error: DescribedError): string {
  switch (error._tag) {
    case "PersistenceOpenError":
      return formatTag(error._tag, [
        field("path", error.path),
        field("reason", error.reason),
        ...optionalCause(error.cause),
      ]);
    case "PersistenceMigrationError":
      return formatTag(error._tag, [
        field("migration", error.migration),
        field("reason", error.reason),
        ...optionalCause(error.cause),
      ]);
    case "PersistenceQueryError":
    case "PersistenceValidationError":
      return formatTag(error._tag, [
        field("operation", error.operation),
        field("reason", error.reason),
        ...optionalCause(error.cause),
      ]);
    case "SnapshotNotFoundError":
      return formatTag(error._tag, [field("id", error.id)]);
    case "SerialListError":
      return formatTag(error._tag, [foreignCause(error.cause)]);
    case "SerialOpenError":
    case "SerialCloseError":
    case "SerialReadError":
    case "SerialWriteError":
    case "SerialDrainError":
      return formatTag(error._tag, [field("path", error.path), foreignCause(error.cause)]);
    case "SerialConnectionClosedError":
      return formatTag(error._tag, [
        field("path", error.path),
        field("operation", error.operation),
      ]);
    case "VScopeDeviceAlreadyOpenError":
      return formatTag(error._tag, [field("path", error.path)]);
    case "VScopeDeviceNotFoundError":
      return formatTag(error._tag, [field("identifier", error.identifier)]);
    case "VScopeTransportError":
      return formatTag(error._tag, [field("path", error.path), taggedCause(error.cause)]);
    case "VScopeResponseTimeoutError":
      return formatTag(error._tag, [
        field("path", error.path),
        field("requestType", error.requestType),
        field("timeoutMillis", error.timeoutMillis),
      ]);
    case "VScopeSessionClosedError":
      return formatTag(error._tag, [
        field("path", error.path),
        field("requestType", error.requestType),
        field("reason", error.reason),
      ]);
    case "VScopeFirmwareError":
      return formatTag(error._tag, [
        field("path", error.path),
        field("requestType", error.requestType),
        field("status", error.status),
        field("statusName", error.statusName),
      ]);
    case "VScopeDecodeError":
      return formatTag(error._tag, [
        field("path", error.path),
        field("messageType", error.messageType),
        field("reason", error.reason),
      ]);
    case "VScopeFrameEncodeError":
    case "VScopeFrameParseError":
      return formatTag(error._tag, [field("reason", error.reason)]);
    case "VScopeUnexpectedResponseError":
      return formatTag(error._tag, [
        field("path", error.path),
        field("requestType", error.requestType),
        field("responseType", error.responseType),
      ]);
    case "VScopeInvalidArgumentError":
      return formatTag(error._tag, [
        field("path", error.path),
        field("operation", error.operation),
        field("reason", error.reason),
      ]);
  }
}

function formatTag(tag: string, details: ReadonlyArray<string>): string {
  return details.length > 0 ? `${tag}: ${details.join(", ")}` : tag;
}

function field(name: string, value: string | number | boolean): string {
  return `${name}=${JSON.stringify(value)}`;
}

function taggedCause(cause: SerialIoError): string {
  return `cause=${describeError(cause)}`;
}

function optionalCause(cause: unknown): ReadonlyArray<string> {
  return cause === undefined ? [] : [foreignCause(cause)];
}

function foreignCause(cause: unknown): string {
  return `cause=${describeForeignCause(cause)}`;
}

function describeForeignCause(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message || cause.name;
  }

  return String(cause);
}
