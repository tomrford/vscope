import { Data } from "effect";

import type {
  VScopeFrameEncodeError,
  VScopeMessageType,
  VScopeStatus as VScopeStatusValue,
} from "./protocol";
import type {
  SerialConnectionClosedError,
  SerialDrainError,
  SerialFlushError,
  SerialReadError,
  SerialWriteError,
} from "./transport";

export class VScopeTransportError extends Data.TaggedError("VScopeTransportError")<{
  readonly path: string;
  readonly cause:
    | SerialReadError
    | SerialWriteError
    | SerialDrainError
    | SerialFlushError
    | SerialConnectionClosedError;
}> {}

export class VScopeResponseTimeoutError extends Data.TaggedError("VScopeResponseTimeoutError")<{
  readonly path: string;
  readonly requestType: VScopeMessageType;
  readonly timeoutMillis: number;
}> {}

export class VScopeSessionClosedError extends Data.TaggedError("VScopeSessionClosedError")<{
  readonly path: string;
  readonly requestType: VScopeMessageType;
  readonly reason: string;
}> {}

export class VScopeFirmwareError extends Data.TaggedError("VScopeFirmwareError")<{
  readonly path: string;
  readonly requestType: VScopeMessageType;
  readonly status: VScopeStatusValue;
  readonly statusName: string;
}> {}

export class VScopeDecodeError extends Data.TaggedError("VScopeDecodeError")<{
  readonly path: string;
  readonly messageType: VScopeMessageType;
  readonly reason: string;
}> {}

export class VScopeUnexpectedResponseError extends Data.TaggedError(
  "VScopeUnexpectedResponseError",
)<{
  readonly path: string;
  readonly requestType: VScopeMessageType;
  readonly responseType: VScopeMessageType;
}> {}

export class VScopeInvalidArgumentError extends Data.TaggedError("VScopeInvalidArgumentError")<{
  readonly path: string;
  readonly operation: string;
  readonly reason: string;
}> {}

export type VScopeDeviceError =
  | VScopeTransportError
  | VScopeResponseTimeoutError
  | VScopeSessionClosedError
  | VScopeFirmwareError
  | VScopeDecodeError
  | VScopeFrameEncodeError
  | VScopeUnexpectedResponseError
  | VScopeInvalidArgumentError;
