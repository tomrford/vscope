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
import { errorReason } from "@vscope/shared";

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
      return `${error.operation}: ${describePersistenceError(error.cause)}`;
    case "RuntimeCorePolicyError":
      return `${error.command}: ${error.reason}`;
    case "RuntimeCoreSerialError":
      return `${error.operation}: ${describeSerialCoreCause(error.cause)}`;
  }
}

function describePersistenceError(error: PersistenceError): string {
  switch (error._tag) {
    case "SnapshotNotFoundError":
      return `${error._tag}: id=${JSON.stringify(error.id)}`;
    case "PersistenceOpenError":
      return joinTagged(error._tag, [
        `path=${JSON.stringify(error.path)}`,
        `reason=${JSON.stringify(error.reason)}`,
        ...(error.cause === undefined ? [] : [`cause=${errorReason(error.cause)}`]),
      ]);
    case "PersistenceMigrationError":
      return joinTagged(error._tag, [
        `migration=${JSON.stringify(error.migration)}`,
        `reason=${JSON.stringify(error.reason)}`,
        ...(error.cause === undefined ? [] : [`cause=${errorReason(error.cause)}`]),
      ]);
    case "PersistenceQueryError":
    case "PersistenceValidationError":
      return joinTagged(error._tag, [
        `operation=${JSON.stringify(error.operation)}`,
        `reason=${JSON.stringify(error.reason)}`,
        ...(error.cause === undefined ? [] : [`cause=${errorReason(error.cause)}`]),
      ]);
  }
}

function describeSerialCoreCause(error: RuntimeCoreSerialError["cause"]): string {
  switch (error._tag) {
    case "SerialListError":
      return joinTagged(error._tag, [`cause=${errorReason(error.cause)}`]);
    case "SerialCloseError":
    case "SerialOpenError":
      return joinTagged(error._tag, [
        `path=${JSON.stringify(error.path)}`,
        `cause=${errorReason(error.cause)}`,
      ]);
    case "VScopeDeviceAlreadyOpenError":
      return joinTagged(error._tag, [`path=${JSON.stringify(error.path)}`]);
    case "VScopeDeviceNotFoundError":
      return joinTagged(error._tag, [`identifier=${JSON.stringify(error.identifier)}`]);
    case "VScopeTransportError":
      return joinTagged(error._tag, [
        `path=${JSON.stringify(error.path)}`,
        `cause=${describeSerialIoError(error.cause)}`,
      ]);
    case "VScopeResponseTimeoutError":
      return joinTagged(error._tag, [
        `path=${JSON.stringify(error.path)}`,
        `requestType=${JSON.stringify(error.requestType)}`,
        `timeoutMillis=${JSON.stringify(error.timeoutMillis)}`,
      ]);
    case "VScopeSessionClosedError":
      return joinTagged(error._tag, [
        `path=${JSON.stringify(error.path)}`,
        `requestType=${JSON.stringify(error.requestType)}`,
        `reason=${JSON.stringify(error.reason)}`,
      ]);
    case "VScopeFirmwareError":
      return joinTagged(error._tag, [
        `path=${JSON.stringify(error.path)}`,
        `requestType=${JSON.stringify(error.requestType)}`,
        `status=${JSON.stringify(error.status)}`,
        `statusName=${JSON.stringify(error.statusName)}`,
      ]);
    case "VScopeDecodeError":
      return joinTagged(error._tag, [
        `path=${JSON.stringify(error.path)}`,
        `messageType=${JSON.stringify(error.messageType)}`,
        `reason=${JSON.stringify(error.reason)}`,
      ]);
    case "VScopeFrameEncodeError":
    case "VScopeFrameParseError":
      return joinTagged(error._tag, [`reason=${JSON.stringify(error.reason)}`]);
    case "VScopeUnexpectedResponseError":
      return joinTagged(error._tag, [
        `path=${JSON.stringify(error.path)}`,
        `requestType=${JSON.stringify(error.requestType)}`,
        `responseType=${JSON.stringify(error.responseType)}`,
      ]);
    case "VScopeInvalidArgumentError":
      return joinTagged(error._tag, [
        `path=${JSON.stringify(error.path)}`,
        `operation=${JSON.stringify(error.operation)}`,
        `reason=${JSON.stringify(error.reason)}`,
      ]);
  }
}

function describeSerialIoError(
  error: Extract<VScopeDeviceError, { readonly _tag: "VScopeTransportError" }>["cause"],
): string {
  switch (error._tag) {
    case "SerialConnectionClosedError":
      return joinTagged(error._tag, [
        `path=${JSON.stringify(error.path)}`,
        `operation=${JSON.stringify(error.operation)}`,
      ]);
    case "SerialReadError":
    case "SerialWriteError":
    case "SerialDrainError":
      return joinTagged(error._tag, [
        `path=${JSON.stringify(error.path)}`,
        `cause=${errorReason(error.cause)}`,
      ]);
  }
}

function joinTagged(tag: string, details: ReadonlyArray<string>): string {
  return details.length > 0 ? `${tag}: ${details.join(", ")}` : tag;
}
