import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";

import { describe, expect, test } from "vitest";
import { Effect, Fiber, Stream } from "effect";

import {
  encodeVScopeFrame,
  makeSerialDriver,
  openVScopeDevice,
  SerialCloseError,
  VScopeDeviceAlreadyOpenError,
  VScopeFirmwareError,
  VScopeFrameParser,
  VScopeInvalidArgumentError,
  VScopeResponseTimeoutError,
  VSCOPE_FRAME_TIMEOUT_MILLIS,
  VScopeMessageType,
  VScopeSerial,
  VScopeSessionClosedError,
  VScopeState,
  VScopeStatusFlag,
  VScopeStatus,
  VScopeTransportError,
  VScopeTriggerMode,
  makeVScopeSerialLayer,
  writeF32,
  writeFixedString,
  writeU16,
  writeU32,
  type SerialCallback,
  type SerialDriver,
  type SerialOpenOptions,
  type SerialPortConstructor,
  type SerialPortLike,
  type VScopeEndianness,
  type VScopeState as VScopeStateValue,
  type VScopeTriggerMode as VScopeTriggerModeValue,
} from ".";
import { readF32, readU16, VScopeEndianness as Endianness } from "./protocol";

describe("@vscope/serial protocol", () => {
  test("encodes and parses split C-compatible frames", () => {
    const encoded = Effect.runSync(
      encodeVScopeFrame({
        type: VScopeMessageType.GetStatus,
        payload: Uint8Array.of(1, 2, 3),
      }),
    );
    const parser = new VScopeFrameParser();

    expect(parser.push(encoded.subarray(0, 2))).toEqual([]);
    const frames = parser.push(encoded.subarray(2));

    expect(frames).toEqual([
      {
        type: VScopeMessageType.GetStatus,
        payload: Uint8Array.of(1, 2, 3),
      },
    ]);
  });

  test("resets stale partial frames using the firmware RX timeout", () => {
    const encoded = Effect.runSync(
      encodeVScopeFrame({
        type: VScopeMessageType.GetStatus,
        payload: Uint8Array.of(1, 2, 3),
      }),
    );
    const parser = new VScopeFrameParser();

    expect(parser.push(encoded.subarray(0, 2), 0)).toEqual([]);

    const frames = parser.push(encoded, VSCOPE_FRAME_TIMEOUT_MILLIS + 1);

    expect(frames).toEqual([
      {
        type: VScopeMessageType.GetStatus,
        payload: Uint8Array.of(1, 2, 3),
      },
    ]);
  });
});

describe("@vscope/serial device", () => {
  test("opens a vscope device and hydrates static firmware metadata", async () => {
    const driver = fakeDriver([
      fakeFirmware({
        path: "/dev/tty.vscope-a",
        deviceName: "scope-a",
        variables: ["voltage", "current", "speed", "torque", "temp", "phase"],
        rtLabels: ["kp", "ki"],
      }),
    ]);

    const device = await Effect.runPromise(
      Effect.scoped(
        openVScopeDevice({
          path: "/dev/tty.vscope-a",
          baudRate: 115200,
          driver,
        }),
      ),
    );

    expect(device.path).toBe("/dev/tty.vscope-a");
    expect(device.deviceName).toBe("scope-a");
    expect(device.info).toMatchObject({
      channelCount: 5,
      bufferSize: 1000,
      variableCount: 6,
      rtCount: 2,
      deviceName: "scope-a",
    });

    const metadata = await Effect.runPromise(device.metadata);
    expect(metadata.variables).toEqual(["voltage", "current", "speed", "torque", "temp", "phase"]);
    expect(metadata.rtLabels).toEqual(["kp", "ki"]);
    expect(metadata.channelMap).toEqual([0, 1, 2, 3, 4]);
  });

  test("maps trigger modes between wire values and shared semantic values", async () => {
    const driver = fakeDriver([
      fakeFirmware({
        path: "/dev/tty.vscope-trigger",
        deviceName: "scope-trigger",
      }),
    ]);

    const { trigger, updatedTrigger } = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const device = yield* openVScopeDevice({
            path: "/dev/tty.vscope-trigger",
            baudRate: 115200,
            driver,
          });
          const trigger = yield* device.getTrigger;
          const updatedTrigger = yield* device.setTrigger({
            threshold: 1,
            channel: 1,
            mode: "rising",
          });
          return { trigger, updatedTrigger };
        }),
      ),
    );

    expect(trigger.mode).toBe("disabled");
    expect(updatedTrigger.mode).toBe("rising");
  });

  test("completes the device close signal when the opening scope is released", async () => {
    const firmware = fakeFirmware({
      path: "/dev/tty.vscope-scoped-close",
      deviceName: "scope-scoped-close",
    });
    const driver = fakeDriver([firmware]);
    let closed: Effect.Effect<void, unknown> | undefined;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const device = yield* openVScopeDevice({
            path: "/dev/tty.vscope-scoped-close",
            baudRate: 115200,
            driver,
          });
          closed = device.closed;
        }),
      ),
    );

    if (!closed) {
      throw new Error("Device close signal was not captured");
    }

    const result = await Effect.runPromise(
      closed.pipe(
        Effect.as("closed"),
        Effect.timeoutOrElse({
          duration: "100 millis",
          orElse: () => Effect.succeed("timeout"),
        }),
      ),
    );

    expect(result).toBe("closed");
    expect(firmware.closeAttempts).toBe(1);
  });

  test("streams snapshot data in firmware-sized dense byte chunks", async () => {
    const driver = fakeDriver([
      fakeFirmware({
        path: "/dev/tty.vscope-snapshot",
        deviceName: "scope-snapshot",
      }),
    ]);

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const device = yield* openVScopeDevice({
            path: "/dev/tty.vscope-snapshot",
            baudRate: 115200,
            driver,
          });
          const chunks = yield* device.snapshotBytes().pipe(Stream.runCollect);
          const bytes = yield* device.collectSnapshotBytes();
          return { chunks, bytes };
        }),
      ),
    );

    expect(result.chunks.length).toBeGreaterThan(1);
    expect(result.bytes.byteLength).toBe(1000 * 5 * Float32Array.BYTES_PER_ELEMENT);

    const view = new DataView(
      result.bytes.buffer,
      result.bytes.byteOffset,
      result.bytes.byteLength,
    );
    expect(view.getFloat32(0, true)).toBe(0);
    expect(view.getFloat32(4, true)).toBe(1);
    expect(view.getFloat32((1000 * 5 - 1) * 4, true)).toBe(4999);
  });

  test("surfaces firmware errors as typed failures", async () => {
    const driver = fakeDriver([
      fakeFirmware({
        path: "/dev/tty.vscope-rt",
        deviceName: "scope-rt",
        rtLabels: ["gain"],
        failRtRead: true,
      }),
    ]);

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const device = yield* openVScopeDevice({
            path: "/dev/tty.vscope-rt",
            baudRate: 115200,
            driver,
          });

          yield* device.getRtValue(0);
        }),
      ),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const errors = exit.cause.reasons
        .filter((reason) => reason._tag === "Fail")
        .map((reason) => reason.error);

      expect(errors[0]).toBeInstanceOf(VScopeFirmwareError);
      expect(errors[0]).toMatchObject({
        _tag: "VScopeFirmwareError",
        status: VScopeStatus.Range,
      });
    }
  });

  test("rejects values that JavaScript would coerce on the wire", async () => {
    const driver = fakeDriver([
      fakeFirmware({
        path: "/dev/tty.vscope-validation",
        deviceName: "scope-validation",
      }),
    ]);

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const device = yield* openVScopeDevice({
            path: "/dev/tty.vscope-validation",
            baudRate: 115200,
            driver,
          });

          const oversizedDivider = yield* Effect.exit(
            device.setTiming({ divider: 0x1_0000_0000, preTrig: 0 }),
          );
          const fractionalState = yield* Effect.exit(device.setState(1.5 as VScopeStateValue));
          const invalidTriggerMode = yield* Effect.exit(
            device.setTrigger({
              threshold: 0,
              channel: 0,
              mode: "edge" as never,
            }),
          );

          return { oversizedDivider, fractionalState, invalidTriggerMode };
        }),
      ),
    );

    for (const exit of [
      result.oversizedDivider,
      result.fractionalState,
      result.invalidTriggerMode,
    ]) {
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const errors = exit.cause.reasons
          .filter((reason) => reason._tag === "Fail")
          .map((reason) => reason.error);
        expect(errors[0]).toBeInstanceOf(VScopeInvalidArgumentError);
      }
    }
  });

  test("fails the device session after a response timeout so late frames cannot poison later requests", async () => {
    const driver = fakeDriver([
      fakeFirmware({
        path: "/dev/tty.vscope-timeout",
        deviceName: "scope-timeout",
        frameResponseDelayMillis: 20,
      }),
    ]);

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const device = yield* openVScopeDevice({
            path: "/dev/tty.vscope-timeout",
            baudRate: 115200,
            driver,
            requestTimeoutMillis: 5,
          });

          const timedOutFrame = yield* Effect.exit(device.getFrame);
          yield* Effect.sleep("30 millis");
          const nextRequest = yield* Effect.exit(device.getState);

          return { timedOutFrame, nextRequest };
        }),
      ),
    );

    expect(result.timedOutFrame._tag).toBe("Failure");
    if (result.timedOutFrame._tag === "Failure") {
      const errors = result.timedOutFrame.cause.reasons
        .filter((reason) => reason._tag === "Fail")
        .map((reason) => reason.error);
      expect(errors[0]).toBeInstanceOf(VScopeResponseTimeoutError);
    }

    expect(result.nextRequest._tag).toBe("Failure");
    if (result.nextRequest._tag === "Failure") {
      const errors = result.nextRequest.cause.reasons
        .filter((reason) => reason._tag === "Fail")
        .map((reason) => reason.error);
      expect(errors[0]).toBeInstanceOf(VScopeSessionClosedError);
    }
  });

  test("still closes the native transport after a read-side session failure", async () => {
    const firmware = fakeFirmware({
      path: "/dev/tty.vscope-read-error",
      deviceName: "scope-read-error",
      errorAfterOpenMillis: 20,
    });
    const driver = fakeDriver([firmware]);

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const device = yield* openVScopeDevice({
            path: "/dev/tty.vscope-read-error",
            baudRate: 115200,
            driver,
          });

          const closedExit = yield* Effect.exit(device.closed);
          const closeExit = yield* Effect.exit(device.close);

          return { closedExit, closeExit, closeAttempts: firmware.closeAttempts };
        }),
      ),
    );

    expect(result.closedExit._tag).toBe("Failure");
    if (result.closedExit._tag === "Failure") {
      const errors = result.closedExit.cause.reasons
        .filter((reason) => reason._tag === "Fail")
        .map((reason) => reason.error);
      expect(errors[0]).toBeInstanceOf(VScopeTransportError);
    }
    expect(result.closeExit._tag).toBe("Success");
    expect(result.closeAttempts).toBe(1);
  });
});

describe("@vscope/serial manager", () => {
  test("manages devices by path and resolves duplicate names by first match", async () => {
    const driver = fakeDriver([
      fakeFirmware({ path: "/dev/tty.vscope-a", deviceName: "same-name" }),
      fakeFirmware({ path: "/dev/tty.vscope-b", deviceName: "same-name" }),
    ]);

    const program = Effect.gen(function* () {
      const manager = yield* VScopeSerial;
      const first = yield* manager.openDevice({ path: "/dev/tty.vscope-a", baudRate: 115200 });
      const second = yield* manager.openDevice({ path: "/dev/tty.vscope-b", baudRate: 115200 });
      const byName = yield* manager.getDevice("same-name");
      const duplicateExit = yield* Effect.exit(
        manager.openDevice({ path: "/dev/tty.vscope-a", baudRate: 115200 }),
      );

      return { first, second, byName, duplicateExit };
    }).pipe(Effect.provide(makeVScopeSerialLayer({ driver })));

    const result = await Effect.runPromise(program);

    expect(result.first.path).toBe("/dev/tty.vscope-a");
    expect(result.second.path).toBe("/dev/tty.vscope-b");
    expect(result.byName.path).toBe("/dev/tty.vscope-a");
    expect(result.duplicateExit._tag).toBe("Failure");
    if (result.duplicateExit._tag === "Failure") {
      const errors = result.duplicateExit.cause.reasons
        .filter((reason) => reason._tag === "Fail")
        .map((reason) => reason.error);
      expect(errors[0]).toBeInstanceOf(VScopeDeviceAlreadyOpenError);
    }
  });

  test("removes manager-owned devices when the returned device is closed", async () => {
    const driver = fakeDriver([
      fakeFirmware({ path: "/dev/tty.vscope-managed", deviceName: "managed" }),
    ]);

    const program = Effect.gen(function* () {
      const manager = yield* VScopeSerial;
      const first = yield* manager.openDevice({
        path: "/dev/tty.vscope-managed",
        baudRate: 115200,
      });
      yield* first.close;
      const afterClose = yield* manager.listDevices;
      const reopened = yield* manager.openDevice({
        path: "/dev/tty.vscope-managed",
        baudRate: 115200,
      });

      return { afterClose, reopened };
    }).pipe(Effect.provide(makeVScopeSerialLayer({ driver })));

    const result = await Effect.runPromise(program);

    expect(result.afterClose).toEqual([]);
    expect(result.reopened.path).toBe("/dev/tty.vscope-managed");
  });

  test("keeps manager entries registered but closes the stale handle when serial close fails", async () => {
    const driver = fakeDriver([
      fakeFirmware({
        path: "/dev/tty.vscope-close-fail",
        deviceName: "close-fail",
        closeFailures: 1,
      }),
    ]);

    const program = Effect.gen(function* () {
      const manager = yield* VScopeSerial;
      const device = yield* manager.openDevice({
        path: "/dev/tty.vscope-close-fail",
        baudRate: 115200,
      });
      const closeExit = yield* Effect.exit(device.close);
      const afterFailedClose = yield* manager.listDevices;
      const stateAfterFailedClose = yield* Effect.exit(device.getState);
      const retryExit = yield* Effect.exit(manager.removeDevice("/dev/tty.vscope-close-fail"));
      const afterRetry = yield* manager.listDevices;

      return { closeExit, afterFailedClose, stateAfterFailedClose, retryExit, afterRetry };
    }).pipe(Effect.provide(makeVScopeSerialLayer({ driver })));

    const result = await Effect.runPromise(program);

    expect(result.closeExit._tag).toBe("Failure");
    if (result.closeExit._tag === "Failure") {
      const errors = result.closeExit.cause.reasons
        .filter((reason) => reason._tag === "Fail")
        .map((reason) => reason.error);
      expect(errors[0]).toBeInstanceOf(SerialCloseError);
    }

    expect(result.afterFailedClose).toHaveLength(1);
    expect(result.afterFailedClose[0]?.path).toBe("/dev/tty.vscope-close-fail");
    expect(result.stateAfterFailedClose._tag).toBe("Failure");
    expect(result.retryExit._tag).toBe("Success");
    expect(result.afterRetry).toEqual([]);
  });

  test("does not let stale device handles close a newer device on the same path", async () => {
    const driver = fakeDriver([
      fakeFirmware({ path: "/dev/tty.vscope-stale", deviceName: "stale" }),
    ]);

    const program = Effect.gen(function* () {
      const manager = yield* VScopeSerial;
      const first = yield* manager.openDevice({
        path: "/dev/tty.vscope-stale",
        baudRate: 115200,
      });
      yield* first.close;
      const second = yield* manager.openDevice({
        path: "/dev/tty.vscope-stale",
        baudRate: 115200,
      });
      yield* first.close;
      const devices = yield* manager.listDevices;

      return { second, devices };
    }).pipe(Effect.provide(makeVScopeSerialLayer({ driver })));

    const result = await Effect.runPromise(program);

    expect(result.second.path).toBe("/dev/tty.vscope-stale");
    expect(result.devices).toHaveLength(1);
    expect(result.devices[0]?.path).toBe("/dev/tty.vscope-stale");
  });

  test("publishes DeviceLost and removes the entry on involuntary serial close", async () => {
    const driver = fakeDriver([
      fakeFirmware({
        path: "/dev/tty.vscope-lost",
        deviceName: "lost",
        closeAfterOpenMillis: 20,
      }),
    ]);

    const program = Effect.gen(function* () {
      const manager = yield* VScopeSerial;
      const eventsFiber = yield* manager.events.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const device = yield* manager.openDevice({ path: "/dev/tty.vscope-lost", baudRate: 115200 });
      const closedExit = yield* Effect.exit(device.closed);
      const events = yield* Fiber.join(eventsFiber);
      const devices = yield* manager.listDevices;

      return { closedExit, devices, events };
    }).pipe(Effect.provide(makeVScopeSerialLayer({ driver })));

    const result = await Effect.runPromise(Effect.scoped(program));

    expect(result.closedExit._tag).toBe("Failure");
    if (result.closedExit._tag === "Failure") {
      const errors = result.closedExit.cause.reasons
        .filter((reason) => reason._tag === "Fail")
        .map((reason) => reason.error);
      expect(errors[0]).toBeInstanceOf(VScopeTransportError);
    }

    expect(result.devices).toEqual([]);
    expect(result.events.map((event) => event._tag)).toEqual(["DeviceOpened", "DeviceLost"]);
    const lost = result.events[1];
    expect(lost?._tag).toBe("DeviceLost");
    if (lost?._tag === "DeviceLost") {
      expect(lost.device.path).toBe("/dev/tty.vscope-lost");
      expect(lost.cause).toBeInstanceOf(VScopeTransportError);
    }
  });

  test("removes the entry when a close failure races with serial loss", async () => {
    const driver = fakeDriver([
      fakeFirmware({
        path: "/dev/tty.vscope-close-race",
        deviceName: "close-race",
        closeFailures: 1,
        closeFailureEmitsClose: true,
      }),
    ]);

    const program = Effect.gen(function* () {
      const manager = yield* VScopeSerial;
      const eventsFiber = yield* manager.events.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const device = yield* manager.openDevice({
        path: "/dev/tty.vscope-close-race",
        baudRate: 115200,
      });
      const closeExit = yield* Effect.exit(device.close);
      const events = yield* Fiber.join(eventsFiber);
      const afterLost = yield* manager.listDevices;
      const reopened = yield* manager.openDevice({
        path: "/dev/tty.vscope-close-race",
        baudRate: 115200,
      });

      return { closeExit, events, afterLost, reopened };
    }).pipe(Effect.provide(makeVScopeSerialLayer({ driver })));

    const result = await Effect.runPromise(Effect.scoped(program));

    expect(result.closeExit._tag).toBe("Failure");
    expect(result.events.map((event) => event._tag)).toEqual(["DeviceOpened", "DeviceLost"]);
    expect(result.afterLost).toEqual([]);
    expect(result.reopened.path).toBe("/dev/tty.vscope-close-race");
  });
});

interface FakeFirmwareResponse {
  readonly bytes: Uint8Array;
  readonly delayMillis: number;
}

interface FakeFirmwareOptions {
  readonly path: string;
  readonly deviceName: string;
  readonly variables?: ReadonlyArray<string> | undefined;
  readonly rtLabels?: ReadonlyArray<string> | undefined;
  readonly endianness?: VScopeEndianness | undefined;
  readonly failRtRead?: boolean | undefined;
  readonly closeFailures?: number | undefined;
  readonly closeFailureEmitsClose?: boolean | undefined;
  readonly closeAfterOpenMillis?: number | undefined;
  readonly errorAfterOpenMillis?: number | undefined;
  readonly frameResponseDelayMillis?: number | undefined;
  readonly stateTransitionStatusReads?: number | undefined;
  readonly acquisitionStatusReads?: number | undefined;
  readonly snapshotValid?: boolean | undefined;
}

const fakeFirmware = (options: FakeFirmwareOptions): FakeFirmware => new FakeFirmware(options);

const fakeDriver = (devices: ReadonlyArray<FakeFirmware>): SerialDriver => {
  const byPath = new Map(devices.map((device) => [device.path, device]));

  class FakePort extends MemorySerialPort {
    constructor(
      options: SerialOpenOptions & { readonly autoOpen?: boolean },
      callback?: SerialCallback,
    ) {
      const firmware = byPath.get(options.path);
      if (!firmware) {
        throw new Error(`No fake firmware for ${options.path}`);
      }
      super(options, firmware);
      if (options.autoOpen !== false) {
        this.open(callback);
      }
    }
  }

  Object.defineProperty(FakePort, "list", {
    value: async () =>
      Array.from(byPath.values()).map((device) => ({
        path: device.path,
        manufacturer: "vscope-test",
      })),
  });

  return makeSerialDriver(FakePort as unknown as SerialPortConstructor);
};

class MemorySerialPort extends EventEmitter implements SerialPortLike {
  readonly path: string;
  readonly baudRate: number;
  readonly #firmware: FakeFirmware;
  #isOpen = false;

  constructor(options: SerialOpenOptions, firmware: FakeFirmware) {
    super();
    this.path = options.path;
    this.baudRate = options.baudRate;
    this.#firmware = firmware;
  }

  get isOpen(): boolean {
    return this.#isOpen;
  }

  open(callback?: SerialCallback): void {
    this.#isOpen = true;
    queueMicrotask(() => {
      this.emit("open");
      callback?.(undefined);
      if (this.#firmware.closeAfterOpenMillis !== undefined) {
        setTimeout(() => {
          if (!this.#isOpen) {
            return;
          }

          this.#isOpen = false;
          this.emit("close", null);
        }, this.#firmware.closeAfterOpenMillis);
      }
      if (this.#firmware.errorAfterOpenMillis !== undefined) {
        setTimeout(() => {
          if (this.#isOpen) {
            this.emit("error", new Error("read-side serial failure"));
          }
        }, this.#firmware.errorAfterOpenMillis);
      }
    });
  }

  write(chunk: Uint8Array | Buffer, callback?: SerialCallback): boolean {
    const responses = this.#firmware.receive(Uint8Array.from(chunk));
    queueMicrotask(() => {
      for (const response of responses) {
        const emitResponse = () => {
          if (this.#isOpen) {
            this.emit("data", Buffer.from(response.bytes));
          }
        };

        if (response.delayMillis > 0) {
          setTimeout(emitResponse, response.delayMillis);
        } else {
          queueMicrotask(emitResponse);
        }
      }
      callback?.(undefined);
    });
    return true;
  }

  drain(callback?: SerialCallback): void {
    queueMicrotask(() => callback?.(undefined));
  }

  flush(callback?: SerialCallback): void {
    queueMicrotask(() => callback?.(undefined));
  }

  close(callback?: SerialCallback): void {
    const closeError = this.#firmware.nextCloseError();
    queueMicrotask(() => {
      if (closeError) {
        if (this.#firmware.closeFailureEmitsClose) {
          this.#isOpen = false;
          this.emit("close", closeError);
        }
        callback?.(closeError);
        return;
      }

      this.#isOpen = false;
      callback?.(undefined);
      this.emit("close", null);
    });
  }
}

class FakeFirmware {
  readonly path: string;
  readonly deviceName: string;
  readonly variables: ReadonlyArray<string>;
  readonly rtLabels: ReadonlyArray<string>;
  readonly endianness: VScopeEndianness;
  readonly littleEndian: boolean;
  readonly snapshot = Float32Array.from({ length: 1000 * 5 }, (_, index) => index);
  readonly parser = new VScopeFrameParser();
  readonly failRtRead: boolean;
  readonly closeFailureEmitsClose: boolean;
  readonly closeAfterOpenMillis: number | undefined;
  readonly errorAfterOpenMillis: number | undefined;
  readonly frameResponseDelayMillis: number;
  readonly stateTransitionStatusReads: number;
  readonly acquisitionStatusReads: number;
  closeAttempts = 0;
  #closeFailures: number;
  timing = { divider: 1, preTrig: 0 };
  state: VScopeStateValue = VScopeState.Halted;
  requestedState: VScopeStateValue = VScopeState.Halted;
  stateTransitionReadsRemaining = 0;
  acquisitionReadsRemaining = 0;
  snapshotValid: boolean;
  channelMap = [0, 1, 2, 3, 4];
  trigger: { threshold: number; channel: number; mode: VScopeTriggerModeValue } = {
    threshold: 0,
    channel: 0,
    mode: VScopeTriggerMode.Disabled,
  };
  rtValues: number[];

  constructor(options: FakeFirmwareOptions) {
    this.path = options.path;
    this.deviceName = options.deviceName;
    this.variables = options.variables ?? ["a", "b", "c", "d", "e"];
    this.rtLabels = options.rtLabels ?? ["rt0", "rt1"];
    this.endianness = options.endianness ?? Endianness.Little;
    this.littleEndian = this.endianness === Endianness.Little;
    this.rtValues = Array.from({ length: this.rtLabels.length }, () => 0);
    this.failRtRead = options.failRtRead ?? false;
    this.closeFailureEmitsClose = options.closeFailureEmitsClose ?? false;
    this.closeAfterOpenMillis = options.closeAfterOpenMillis;
    this.errorAfterOpenMillis = options.errorAfterOpenMillis;
    this.frameResponseDelayMillis = options.frameResponseDelayMillis ?? 0;
    this.stateTransitionStatusReads = options.stateTransitionStatusReads ?? 1;
    this.acquisitionStatusReads = options.acquisitionStatusReads ?? 1;
    this.snapshotValid = options.snapshotValid ?? true;
    this.#closeFailures = options.closeFailures ?? 0;
  }

  nextCloseError(): Error | undefined {
    this.closeAttempts += 1;
    if (this.#closeFailures <= 0) {
      return undefined;
    }

    this.#closeFailures -= 1;
    return new Error("close failed");
  }

  receive(bytes: Uint8Array): ReadonlyArray<FakeFirmwareResponse> {
    return this.parser.push(bytes).map((frame) => this.handle(frame.type, frame.payload));
  }

  private handle(type: VScopeMessageType, payload: Uint8Array): FakeFirmwareResponse {
    switch (type) {
      case VScopeMessageType.GetInfo:
        return this.response(type, this.infoPayload());
      case VScopeMessageType.GetTiming:
        return this.response(type, this.timingPayload());
      case VScopeMessageType.SetTiming:
        this.timing = {
          divider: new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(
            0,
            this.littleEndian,
          ),
          preTrig: new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(
            4,
            this.littleEndian,
          ),
        };
        return this.response(type, this.timingPayload());
      case VScopeMessageType.GetStatus:
        this.advanceStatus();
        return this.response(type, this.statusPayload());
      case VScopeMessageType.SetState:
        return this.setRequestedState(payload[0] as VScopeStateValue, type);
      case VScopeMessageType.Trigger:
        if (this.state !== VScopeState.Running) {
          return this.error(VScopeStatus.NotReady);
        }
        this.requestedState = VScopeState.Acquiring;
        this.stateTransitionReadsRemaining = this.stateTransitionStatusReads;
        return this.response(type, this.statusPayload());
      case VScopeMessageType.GetFrame:
        return this.response(
          type,
          this.floatsPayload(this.snapshot.subarray(0, 5)),
          this.frameResponseDelayMillis,
        );
      case VScopeMessageType.GetSnapshotHeader:
        if (!this.snapshotValid) {
          return this.error(VScopeStatus.NotReady);
        }
        return this.response(type, this.snapshotHeaderPayload());
      case VScopeMessageType.GetSnapshotData:
        return this.snapshotData(payload);
      case VScopeMessageType.GetVarList:
        return this.namePage(type, this.variables, payload);
      case VScopeMessageType.GetChannelMap:
        return this.response(type, Uint8Array.from(this.channelMap));
      case VScopeMessageType.SetChannelMap:
        this.channelMap[payload[0]] = payload[1];
        return this.response(type, Uint8Array.of(payload[0], payload[1]));
      case VScopeMessageType.GetRtLabels:
        return this.namePage(type, this.rtLabels, payload);
      case VScopeMessageType.GetRtBuffer:
        return this.failRtRead || payload[0] >= this.rtValues.length
          ? this.error(VScopeStatus.Range)
          : this.response(type, this.floatsPayload(Float32Array.of(this.rtValues[payload[0]])));
      case VScopeMessageType.SetRtBuffer:
        if (payload[0] >= this.rtValues.length) {
          return this.error(VScopeStatus.Range);
        }
        this.rtValues[payload[0]] = readF32(
          new DataView(payload.buffer, payload.byteOffset, payload.byteLength),
          1,
          this.littleEndian,
        );
        return this.response(type, this.floatsPayload(Float32Array.of(this.rtValues[payload[0]])));
      case VScopeMessageType.GetTrigger:
        return this.response(type, this.triggerPayload());
      case VScopeMessageType.SetTrigger:
        this.trigger = {
          threshold: readF32(
            new DataView(payload.buffer, payload.byteOffset, payload.byteLength),
            0,
            this.littleEndian,
          ),
          channel: payload[4],
          mode: payload[5] as VScopeTriggerModeValue,
        };
        return this.response(type, this.triggerPayload());
      default:
        return this.error(VScopeStatus.BadParam);
    }
  }

  private setRequestedState(
    requestedState: VScopeStateValue,
    responseType: VScopeMessageType,
  ): FakeFirmwareResponse {
    if (requestedState === VScopeState.Running) {
      if (this.state !== VScopeState.Halted && this.state !== VScopeState.Running) {
        return this.error(VScopeStatus.NotReady);
      }
    }

    if (requestedState === VScopeState.Acquiring && this.state !== VScopeState.Running) {
      return this.error(VScopeStatus.NotReady);
    }

    this.requestedState = requestedState;
    this.stateTransitionReadsRemaining =
      requestedState === this.state ? 0 : this.stateTransitionStatusReads;
    return this.response(responseType, this.statusPayload());
  }

  private advanceStatus(): void {
    if (this.stateTransitionReadsRemaining > 0) {
      this.stateTransitionReadsRemaining -= 1;
      if (this.stateTransitionReadsRemaining === 0) {
        if (this.requestedState === VScopeState.Running) {
          this.state = VScopeState.Running;
          this.snapshotValid = false;
        } else if (this.requestedState === VScopeState.Halted) {
          this.state = VScopeState.Halted;
        } else {
          this.state = VScopeState.Acquiring;
          this.acquisitionReadsRemaining = this.acquisitionStatusReads;
        }
      }
      return;
    }

    if (this.state === VScopeState.Acquiring) {
      if (this.acquisitionReadsRemaining > 0) {
        this.acquisitionReadsRemaining -= 1;
      }
      if (this.acquisitionReadsRemaining === 0) {
        this.state = VScopeState.Halted;
        this.requestedState = VScopeState.Halted;
        this.snapshotValid = true;
      }
    }
  }

  private statusPayload(): Uint8Array {
    const flags =
      (this.snapshotValid ? VScopeStatusFlag.SnapshotValid : 0) |
      (this.state !== this.requestedState ? VScopeStatusFlag.RequestPending : 0) |
      (this.trigger.mode !== VScopeTriggerMode.Disabled ? VScopeStatusFlag.TriggerEnabled : 0);
    return Uint8Array.of(this.state, this.requestedState, flags);
  }

  private response(
    type: VScopeMessageType,
    payload: Uint8Array,
    delayMillis = 0,
  ): FakeFirmwareResponse {
    return {
      bytes: Effect.runSync(encodeVScopeFrame({ type, payload })),
      delayMillis,
    };
  }

  private error(status: VScopeStatus): FakeFirmwareResponse {
    return this.response(VScopeMessageType.Error, Uint8Array.of(status));
  }

  private infoPayload(): Uint8Array {
    const payload = new Uint8Array(26);
    payload[0] = 5;
    writeU16(payload, 1, 1000, this.littleEndian);
    writeU16(payload, 3, 20, this.littleEndian);
    payload[5] = this.variables.length;
    payload[6] = this.rtLabels.length;
    payload[7] = 16;
    payload[8] = 16;
    payload[9] = this.endianness;
    payload.set(writeFixedString(this.deviceName, 16), 10);
    return payload;
  }

  private timingPayload(): Uint8Array {
    const payload = new Uint8Array(8);
    writeU32(payload, 0, this.timing.divider, this.littleEndian);
    writeU32(payload, 4, this.timing.preTrig, this.littleEndian);
    return payload;
  }

  private triggerPayload(): Uint8Array {
    const payload = new Uint8Array(6);
    writeF32(payload, 0, this.trigger.threshold, this.littleEndian);
    payload[4] = this.trigger.channel;
    payload[5] = this.trigger.mode;
    return payload;
  }

  private snapshotHeaderPayload(): Uint8Array {
    const payload = new Uint8Array(5 + 14 + this.rtValues.length * 4);
    payload.set(this.channelMap, 0);
    writeU32(payload, 5, this.timing.divider, this.littleEndian);
    writeU32(payload, 9, this.timing.preTrig, this.littleEndian);
    writeF32(payload, 13, this.trigger.threshold, this.littleEndian);
    payload[17] = this.trigger.channel;
    payload[18] = this.trigger.mode;
    for (let index = 0; index < this.rtValues.length; index += 1) {
      writeF32(payload, 19 + index * 4, this.rtValues[index], this.littleEndian);
    }
    return payload;
  }

  private snapshotData(payload: Uint8Array): FakeFirmwareResponse {
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const startSample = readU16(view, 0, this.littleEndian);
    const count = payload[2];
    const start = startSample * 5;
    const end = start + count * 5;
    return this.response(
      VScopeMessageType.GetSnapshotData,
      this.floatsPayload(this.snapshot.subarray(start, end)),
    );
  }

  private namePage(
    type: VScopeMessageType,
    names: ReadonlyArray<string>,
    request: Uint8Array,
  ): FakeFirmwareResponse {
    const start = request[0];
    const requested = request[1];
    const maxEntries = Math.floor((252 - 3) / 16);
    const count = Math.min(requested, Math.max(0, names.length - start), maxEntries);
    const payload = new Uint8Array(3 + count * 16);
    payload[0] = names.length;
    payload[1] = start;
    payload[2] = count;

    for (let index = 0; index < count; index += 1) {
      payload.set(writeFixedString(names[start + index], 16), 3 + index * 16);
    }

    return this.response(type, payload);
  }

  private floatsPayload(values: Float32Array): Uint8Array {
    const payload = new Uint8Array(values.length * 4);
    for (let index = 0; index < values.length; index += 1) {
      writeF32(payload, index * 4, values[index], this.littleEndian);
    }
    return payload;
  }
}
