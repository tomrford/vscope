import type * as Effect from "effect/Effect";
import type { TriggerMode } from "@vscope/shared";

import type { VScopeDeviceError } from "./errors";
import type { VScopeEndianness, VScopeState as VScopeStateValue } from "./protocol";
import type { OpenSerialTransportOptions, SerialCloseError } from "./transport";

export interface VScopeDeviceInfo {
  readonly channelCount: number;
  readonly bufferSize: number;
  readonly isrKHz: number;
  readonly variableCount: number;
  readonly rtCount: number;
  readonly nameLength: number;
  readonly endianness: VScopeEndianness;
  readonly deviceName: string;
}

export interface VScopeTiming {
  readonly totalDurationSeconds: number;
  readonly preTriggerSeconds: number;
}

export interface VScopeTrigger {
  readonly threshold: number;
  readonly channel: number;
  readonly mode: TriggerMode;
}

export interface VScopeControlStatus {
  readonly state: VScopeStateValue;
  readonly snapshotValid: boolean;
}

export interface VScopeSnapshotHeader {
  readonly channelMap: ReadonlyArray<number>;
  readonly sampleRateHz: number;
  readonly totalDurationSeconds: number;
  readonly preTriggerSeconds: number;
  readonly trigger: VScopeTrigger;
  readonly rtValues: ReadonlyArray<number>;
  readonly channelCount: number;
  readonly sampleCount: number;
}

export interface VScopeStaticMetadata {
  readonly info: VScopeDeviceInfo;
  readonly variables: ReadonlyArray<string>;
  readonly rtLabels: ReadonlyArray<string>;
  readonly channelMap: ReadonlyArray<number>;
}

export interface SnapshotBytesOptions {
  readonly header?: VScopeSnapshotHeader | undefined;
}

export interface OpenVScopeDeviceOptions extends OpenSerialTransportOptions {
  readonly requestTimeoutMillis: number;
  readonly retryAttempts?: number | undefined;
}

export interface VScopeRequestOptions {
  readonly retryAttempts?: number | undefined;
}

export interface VScopeDevice {
  readonly path: string;
  readonly deviceName: string;
  readonly info: VScopeDeviceInfo;
  readonly metadata: Effect.Effect<VScopeStaticMetadata>;
  readonly getTiming: Effect.Effect<VScopeTiming, VScopeDeviceError>;
  readonly setTiming: (timing: VScopeTiming) => Effect.Effect<VScopeTiming, VScopeDeviceError>;
  readonly getStatus: (
    options?: VScopeRequestOptions,
  ) => Effect.Effect<VScopeControlStatus, VScopeDeviceError>;
  readonly start: Effect.Effect<VScopeControlStatus, VScopeDeviceError>;
  readonly stop: Effect.Effect<VScopeControlStatus, VScopeDeviceError>;
  readonly trigger: Effect.Effect<VScopeControlStatus, VScopeDeviceError>;
  readonly getFrame: (
    options?: VScopeRequestOptions,
  ) => Effect.Effect<ReadonlyArray<number>, VScopeDeviceError>;
  readonly getSnapshotHeader: Effect.Effect<VScopeSnapshotHeader, VScopeDeviceError>;
  readonly collectSnapshotBytes: (
    options?: SnapshotBytesOptions,
  ) => Effect.Effect<Uint8Array, VScopeDeviceError>;
  readonly getChannelMap: Effect.Effect<ReadonlyArray<number>, VScopeDeviceError>;
  readonly setChannelMap: (
    channel: number,
    variable: number,
  ) => Effect.Effect<ReadonlyArray<number>, VScopeDeviceError>;
  readonly getRtValue: (index: number) => Effect.Effect<number, VScopeDeviceError>;
  readonly setRtValue: (index: number, value: number) => Effect.Effect<number, VScopeDeviceError>;
  readonly getTrigger: Effect.Effect<VScopeTrigger, VScopeDeviceError>;
  readonly setTrigger: (trigger: VScopeTrigger) => Effect.Effect<VScopeTrigger, VScopeDeviceError>;
  readonly closed: Effect.Effect<void, VScopeDeviceError>;
  readonly close: Effect.Effect<void, SerialCloseError>;
}
