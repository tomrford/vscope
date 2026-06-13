import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { VScopeDeviceError } from "./errors";
import type {
  VScopeEndianness,
  VScopeState as VScopeStateValue,
  VScopeTriggerMode,
} from "./protocol";
import type { OpenSerialTransportOptions, SerialCloseError } from "./transport";

export interface VScopeDeviceInfo {
  readonly channelCount: number;
  readonly bufferSize: number;
  readonly isrKHz: number;
  readonly variableCount: number;
  readonly rtCount: number;
  readonly rtBufferCapacity: number;
  readonly nameLength: number;
  readonly endianness: VScopeEndianness;
  readonly deviceName: string;
}

export interface VScopeTiming {
  readonly divider: number;
  readonly preTrig: number;
}

export interface VScopeTrigger {
  readonly threshold: number;
  readonly channel: number;
  readonly mode: VScopeTriggerMode;
}

export interface VScopeSnapshotHeader {
  readonly channelMap: ReadonlyArray<number>;
  readonly divider: number;
  readonly preTrig: number;
  readonly trigger: VScopeTrigger;
  readonly rtValues: ReadonlyArray<number>;
  readonly channelCount: number;
  readonly sampleCount: number;
  readonly byteLength: number;
}

export interface VScopeStaticMetadata {
  readonly info: VScopeDeviceInfo;
  readonly variables: ReadonlyArray<string>;
  readonly rtLabels: ReadonlyArray<string>;
  readonly channelMap: ReadonlyArray<number>;
}

export interface SnapshotBytesOptions {
  readonly header?: VScopeSnapshotHeader | undefined;
  readonly samplesPerChunk?: number | undefined;
}

export interface StateWaitOptions {
  readonly timeoutMillis?: number | undefined;
  readonly pollIntervalMillis?: number | undefined;
}

export interface OpenVScopeDeviceOptions extends OpenSerialTransportOptions {
  readonly requestTimeoutMillis?: number | undefined;
}

export interface VScopeDevice {
  readonly path: string;
  readonly deviceName: string;
  readonly info: VScopeDeviceInfo;
  readonly metadata: Effect.Effect<VScopeStaticMetadata>;
  readonly getTiming: Effect.Effect<VScopeTiming, VScopeDeviceError>;
  readonly setTiming: (timing: VScopeTiming) => Effect.Effect<VScopeTiming, VScopeDeviceError>;
  readonly getState: Effect.Effect<VScopeStateValue, VScopeDeviceError>;
  readonly setState: (
    state: VScopeStateValue,
  ) => Effect.Effect<VScopeStateValue, VScopeDeviceError>;
  readonly start: (
    options?: StateWaitOptions,
  ) => Effect.Effect<VScopeStateValue, VScopeDeviceError>;
  readonly stop: (options?: StateWaitOptions) => Effect.Effect<VScopeStateValue, VScopeDeviceError>;
  readonly trigger: Effect.Effect<void, VScopeDeviceError>;
  readonly getFrame: Effect.Effect<Float32Array, VScopeDeviceError>;
  readonly getSnapshotHeader: Effect.Effect<VScopeSnapshotHeader, VScopeDeviceError>;
  readonly snapshotBytes: (
    options?: SnapshotBytesOptions,
  ) => Stream.Stream<Uint8Array, VScopeDeviceError>;
  readonly collectSnapshotBytes: (
    options?: SnapshotBytesOptions,
  ) => Effect.Effect<Uint8Array, VScopeDeviceError>;
  readonly getVariableCatalog: Effect.Effect<ReadonlyArray<string>, VScopeDeviceError>;
  readonly getChannelMap: Effect.Effect<ReadonlyArray<number>, VScopeDeviceError>;
  readonly setChannelMap: (
    channel: number,
    variable: number,
  ) => Effect.Effect<ReadonlyArray<number>, VScopeDeviceError>;
  readonly getRtLabels: Effect.Effect<ReadonlyArray<string>, VScopeDeviceError>;
  readonly getRtValue: (index: number) => Effect.Effect<number, VScopeDeviceError>;
  readonly setRtValue: (index: number, value: number) => Effect.Effect<number, VScopeDeviceError>;
  readonly getTrigger: Effect.Effect<VScopeTrigger, VScopeDeviceError>;
  readonly setTrigger: (trigger: VScopeTrigger) => Effect.Effect<VScopeTrigger, VScopeDeviceError>;
  readonly close: Effect.Effect<void, SerialCloseError>;
}
