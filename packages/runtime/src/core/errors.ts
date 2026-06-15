import { Cause, Data } from "effect";
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
    | Cause.TimeoutError
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
