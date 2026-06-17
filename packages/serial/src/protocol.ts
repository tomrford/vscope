import { Data, Effect } from "effect";

export const VSCOPE_SYNC_BYTE = 0xc8;
export const VSCOPE_MAX_PAYLOAD = 252;
export const VSCOPE_FRAME_TIMEOUT_MICROS = 100_000;
export const VSCOPE_FRAME_TIMEOUT_MILLIS = VSCOPE_FRAME_TIMEOUT_MICROS / 1000;

export const VScopeEndianness = {
  Little: 0,
  Big: 1,
} as const;

export type VScopeEndianness = (typeof VScopeEndianness)[keyof typeof VScopeEndianness];

export const VScopeState = {
  Halted: 0,
  Running: 1,
  Acquiring: 2,
  Misconfigured: 3,
} as const;

export type VScopeState = (typeof VScopeState)[keyof typeof VScopeState];

export const VScopeTriggerMode = {
  Disabled: 0,
  Rising: 1,
  Falling: 2,
  Both: 3,
} as const;

export type VScopeTriggerMode = (typeof VScopeTriggerMode)[keyof typeof VScopeTriggerMode];

export const VScopeStatus = {
  BadLen: 1,
  BadParam: 2,
  Range: 4,
  NotReady: 5,
} as const;

export type VScopeStatus = (typeof VScopeStatus)[keyof typeof VScopeStatus];

export const VScopeStatusFlag = {
  SnapshotValid: 1 << 0,
  RequestPending: 1 << 1,
  TriggerEnabled: 1 << 2,
} as const;

export type VScopeStatusFlag = (typeof VScopeStatusFlag)[keyof typeof VScopeStatusFlag];

export const VScopeMessageType = {
  GetInfo: 0x01,
  GetTiming: 0x02,
  SetTiming: 0x03,
  GetStatus: 0x04,
  SetState: 0x05,
  Trigger: 0x06,
  GetFrame: 0x07,
  GetSnapshotHeader: 0x08,
  GetSnapshotData: 0x09,
  GetVarList: 0x0a,
  GetChannelMap: 0x0b,
  SetChannelMap: 0x0c,
  GetRtLabels: 0x0d,
  GetRtBuffer: 0x0e,
  SetRtBuffer: 0x0f,
  GetTrigger: 0x10,
  SetTrigger: 0x11,
  Error: 0xff,
} as const;

export type VScopeMessageType = (typeof VScopeMessageType)[keyof typeof VScopeMessageType];

export interface VScopeFrame {
  readonly type: VScopeMessageType;
  readonly payload: Uint8Array;
}

export class VScopeFrameEncodeError extends Data.TaggedError("VScopeFrameEncodeError")<{
  readonly reason: string;
}> {}

const crc8Table = Uint8Array.from([
  0x00, 0xd5, 0x7f, 0xaa, 0xfe, 0x2b, 0x81, 0x54, 0x29, 0xfc, 0x56, 0x83, 0xd7, 0x02, 0xa8, 0x7d,
  0x52, 0x87, 0x2d, 0xf8, 0xac, 0x79, 0xd3, 0x06, 0x7b, 0xae, 0x04, 0xd1, 0x85, 0x50, 0xfa, 0x2f,
  0xa4, 0x71, 0xdb, 0x0e, 0x5a, 0x8f, 0x25, 0xf0, 0x8d, 0x58, 0xf2, 0x27, 0x73, 0xa6, 0x0c, 0xd9,
  0xf6, 0x23, 0x89, 0x5c, 0x08, 0xdd, 0x77, 0xa2, 0xdf, 0x0a, 0xa0, 0x75, 0x21, 0xf4, 0x5e, 0x8b,
  0x9d, 0x48, 0xe2, 0x37, 0x63, 0xb6, 0x1c, 0xc9, 0xb4, 0x61, 0xcb, 0x1e, 0x4a, 0x9f, 0x35, 0xe0,
  0xcf, 0x1a, 0xb0, 0x65, 0x31, 0xe4, 0x4e, 0x9b, 0xe6, 0x33, 0x99, 0x4c, 0x18, 0xcd, 0x67, 0xb2,
  0x39, 0xec, 0x46, 0x93, 0xc7, 0x12, 0xb8, 0x6d, 0x10, 0xc5, 0x6f, 0xba, 0xee, 0x3b, 0x91, 0x44,
  0x6b, 0xbe, 0x14, 0xc1, 0x95, 0x40, 0xea, 0x3f, 0x42, 0x97, 0x3d, 0xe8, 0xbc, 0x69, 0xc3, 0x16,
  0xef, 0x3a, 0x90, 0x45, 0x11, 0xc4, 0x6e, 0xbb, 0xc6, 0x13, 0xb9, 0x6c, 0x38, 0xed, 0x47, 0x92,
  0xbd, 0x68, 0xc2, 0x17, 0x43, 0x96, 0x3c, 0xe9, 0x94, 0x41, 0xeb, 0x3e, 0x6a, 0xbf, 0x15, 0xc0,
  0x4b, 0x9e, 0x34, 0xe1, 0xb5, 0x60, 0xca, 0x1f, 0x62, 0xb7, 0x1d, 0xc8, 0x9c, 0x49, 0xe3, 0x36,
  0x19, 0xcc, 0x66, 0xb3, 0xe7, 0x32, 0x98, 0x4d, 0x30, 0xe5, 0x4f, 0x9a, 0xce, 0x1b, 0xb1, 0x64,
  0x72, 0xa7, 0x0d, 0xd8, 0x8c, 0x59, 0xf3, 0x26, 0x5b, 0x8e, 0x24, 0xf1, 0xa5, 0x70, 0xda, 0x0f,
  0x20, 0xf5, 0x5f, 0x8a, 0xde, 0x0b, 0xa1, 0x74, 0x09, 0xdc, 0x76, 0xa3, 0xf7, 0x22, 0x88, 0x5d,
  0xd6, 0x03, 0xa9, 0x7c, 0x28, 0xfd, 0x57, 0x82, 0xff, 0x2a, 0x80, 0x55, 0x01, 0xd4, 0x7e, 0xab,
  0x84, 0x51, 0xfb, 0x2e, 0x7a, 0xaf, 0x05, 0xd0, 0xad, 0x78, 0xd2, 0x07, 0x53, 0x86, 0x2c, 0xf9,
]);

export const vscopeCrc8 = (bytes: Uint8Array): number => {
  let crc = 0;
  for (const byte of bytes) {
    crc = crc8Table[crc ^ byte];
  }
  return crc;
};

export const encodeVScopeFrame = (
  frame: VScopeFrame,
): Effect.Effect<Uint8Array, VScopeFrameEncodeError> =>
  frame.payload.byteLength > VSCOPE_MAX_PAYLOAD
    ? Effect.fail(
        new VScopeFrameEncodeError({
          reason: `Payload exceeds ${VSCOPE_MAX_PAYLOAD} bytes`,
        }),
      )
    : Effect.sync(() => encodeVScopeFrameSync(frame));

export const encodeVScopeFrameSync = (frame: VScopeFrame): Uint8Array => {
  if (frame.payload.byteLength > VSCOPE_MAX_PAYLOAD) {
    throw new VScopeFrameEncodeError({
      reason: `Payload exceeds ${VSCOPE_MAX_PAYLOAD} bytes`,
    });
  }

  const output = new Uint8Array(frame.payload.byteLength + 4);
  output[0] = VSCOPE_SYNC_BYTE;
  output[1] = frame.payload.byteLength + 2;
  output[2] = frame.type;
  output.set(frame.payload, 3);
  output[output.byteLength - 1] = vscopeCrc8(output.subarray(2, output.byteLength - 1));
  return output;
};

type ParserState = "idle" | "len" | "data";

export class VScopeFrameParser {
  #state: ParserState = "idle";
  #expectedLength = 0;
  #index = 0;
  #buffer = new Uint8Array(VSCOPE_MAX_PAYLOAD + 2);
  readonly #frameTimeoutMillis: number;
  #lastByteMillis = 0;

  constructor(options: { readonly frameTimeoutMillis?: number | undefined } = {}) {
    this.#frameTimeoutMillis = options.frameTimeoutMillis ?? VSCOPE_FRAME_TIMEOUT_MILLIS;
  }

  push(bytes: Uint8Array, nowMillis = Date.now()): ReadonlyArray<VScopeFrame> {
    const frames: VScopeFrame[] = [];

    if (this.#state !== "idle" && nowMillis - this.#lastByteMillis > this.#frameTimeoutMillis) {
      this.reset();
    }

    for (const byte of bytes) {
      if (this.#state === "idle") {
        if (byte === VSCOPE_SYNC_BYTE) {
          this.#state = "len";
          this.#lastByteMillis = nowMillis;
        }
        continue;
      }

      if (this.#state === "len") {
        this.#expectedLength = byte;
        if (this.#expectedLength < 2 || this.#expectedLength > VSCOPE_MAX_PAYLOAD + 2) {
          this.reset();
          continue;
        }

        this.#index = 0;
        this.#state = "data";
        this.#lastByteMillis = nowMillis;
        continue;
      }

      this.#buffer[this.#index] = byte;
      this.#index += 1;
      this.#lastByteMillis = nowMillis;

      if (this.#index < this.#expectedLength) {
        continue;
      }

      const data = this.#buffer.subarray(0, this.#expectedLength);
      const expectedCrc = data[this.#expectedLength - 1];
      const actualCrc = vscopeCrc8(data.subarray(0, this.#expectedLength - 1));

      if (expectedCrc === actualCrc) {
        frames.push({
          type: data[0] as VScopeMessageType,
          payload: Uint8Array.from(data.subarray(1, this.#expectedLength - 1)),
        });
      }

      this.reset();
    }

    return frames;
  }

  reset(): void {
    this.#state = "idle";
    this.#expectedLength = 0;
    this.#index = 0;
    this.#lastByteMillis = 0;
  }
}

export const fixedString = (bytes: Uint8Array): string => {
  const nul = bytes.indexOf(0);
  const end = nul >= 0 ? nul : bytes.byteLength;
  return new TextDecoder().decode(bytes.subarray(0, end));
};

export const writeFixedString = (value: string, length: number): Uint8Array => {
  const output = new Uint8Array(length);
  output.set(new TextEncoder().encode(value).subarray(0, length));
  return output;
};

export const readU16 = (view: DataView, offset: number, littleEndian: boolean): number =>
  view.getUint16(offset, littleEndian);

export const readU32 = (view: DataView, offset: number, littleEndian: boolean): number =>
  view.getUint32(offset, littleEndian);

export const readF32 = (view: DataView, offset: number, littleEndian: boolean): number =>
  view.getFloat32(offset, littleEndian);

export const writeU16 = (
  output: Uint8Array,
  offset: number,
  value: number,
  littleEndian: boolean,
): void =>
  new DataView(output.buffer, output.byteOffset, output.byteLength).setUint16(
    offset,
    value,
    littleEndian,
  );

export const writeU32 = (
  output: Uint8Array,
  offset: number,
  value: number,
  littleEndian: boolean,
): void =>
  new DataView(output.buffer, output.byteOffset, output.byteLength).setUint32(
    offset,
    value,
    littleEndian,
  );

export const writeF32 = (
  output: Uint8Array,
  offset: number,
  value: number,
  littleEndian: boolean,
): void =>
  new DataView(output.buffer, output.byteOffset, output.byteLength).setFloat32(
    offset,
    value,
    littleEndian,
  );
