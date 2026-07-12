export {
  VScopeDeviceAlreadyOpenError,
  VScopeDeviceNotFoundError,
  VScopeSerial,
  VScopeSerialLayer,
  summarizeDevice,
} from "./manager";
export type {
  VScopeDeviceSummary,
  VScopeOpenOptions,
  VScopeSerialEvent,
  VScopeSerialService,
} from "./manager";

export { VScopeEndianness, VScopeFrameParseError, VScopeState } from "./protocol";
export { SerialCloseError, SerialListError, SerialOpenError, SerialPortInfo } from "./transport";

export type { VScopeDeviceError } from "./errors";

export type {
  VScopeControlStatus,
  VScopeDevice,
  VScopeDeviceInfo,
  VScopeSnapshotHeader,
  VScopeStaticMetadata,
  VScopeTiming,
  VScopeTrigger,
} from "./types";
