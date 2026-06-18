import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";

import {
  encodeVScopeFrame,
  makeSerialDriver,
  openVScopeDevice,
  SerialCloseError,
  VScopeDeviceAlreadyOpenError,
  VScopeFirmwareError,
  VScopeFrameParseError,
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
  VScopeUnexpectedResponseError,
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
  it.effect("encodes and parses split C-compatible frames", () =>
    Effect.gen(function* () {
      const encoded = yield* encodeVScopeFrame({
        type: VScopeMessageType.GetStatus,
        payload: Uint8Array.of(1, 2, 3),
      });
      const parser = new VScopeFrameParser();

      expect(parser.push(encoded.subarray(0, 2))).toEqual([]);
      const frames = parser.push(encoded.subarray(2));

      expect(frames).toEqual([
        {
          type: VScopeMessageType.GetStatus,
          payload: Uint8Array.of(1, 2, 3),
        },
      ]);
    }),
  );

  it.effect("resets stale partial frames using the firmware RX timeout", () =>
    Effect.gen(function* () {
      const encoded = yield* encodeVScopeFrame({
        type: VScopeMessageType.GetStatus,
        payload: Uint8Array.of(1, 2, 3),
      });
      const parser = new VScopeFrameParser();

      expect(parser.push(encoded.subarray(0, 2), 0)).toEqual([]);

      const frames = parser.push(encoded, VSCOPE_FRAME_TIMEOUT_MILLIS + 1);

      expect(frames).toEqual([
        {
          type: VScopeMessageType.GetStatus,
          payload: Uint8Array.of(1, 2, 3),
        },
      ]);
    }),
  );

  it.effect("reports complete frames with invalid CRC as parse events", () =>
    Effect.gen(function* () {
      const encoded = yield* encodeVScopeFrame({
        type: VScopeMessageType.GetStatus,
        payload: Uint8Array.of(1, 2, 3),
      });
      encoded[encoded.byteLength - 1] ^= 0xff;
      const parser = new VScopeFrameParser();

      const events = parser.pushEvents(encoded);

      expect(events).toHaveLength(1);
      expect(events[0]?._tag).toBe("InvalidFrame");
      if (events[0]?._tag === "InvalidFrame") {
        expect(events[0].error).toBeInstanceOf(VScopeFrameParseError);
      }
    }),
  );
});

describe("@vscope/serial device", () => {
  it.live("opens a vscope device and hydrates static firmware metadata", () =>
    Effect.gen(function* () {
      const firmware = fakeFirmware({
        path: "/dev/tty.vscope-a",
        deviceName: "scope-a",
        variables: ["voltage", "current", "speed", "torque", "temp", "phase"],
        rtLabels: ["kp", "ki"],
      });
      const driver = fakeDriver([firmware]);

      const device = yield* openVScopeDevice({
        path: "/dev/tty.vscope-a",
        baudRate: 115200,
        driver,
      });

      expect(device.path).toBe("/dev/tty.vscope-a");
      expect(device.deviceName).toBe("scope-a");
      expect(device.info).toMatchObject({
        channelCount: 5,
        bufferSize: 1000,
        variableCount: 6,
        rtCount: 2,
        deviceName: "scope-a",
      });

      const metadata = yield* device.metadata;
      expect(metadata.variables).toEqual([
        "voltage",
        "current",
        "speed",
        "torque",
        "temp",
        "phase",
      ]);
      expect(metadata.rtLabels).toEqual(["kp", "ki"]);
      expect(metadata.channelMap).toEqual([0, 1, 2, 3, 4]);
      expect(firmware.controlSignals).toEqual({ dtr: true, rts: true });
    }),
  );

  it.live("maps trigger modes between wire values and shared semantic values", () =>
    Effect.gen(function* () {
      const driver = fakeDriver([
        fakeFirmware({
          path: "/dev/tty.vscope-trigger",
          deviceName: "scope-trigger",
        }),
      ]);

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

      expect(trigger.mode).toBe("disabled");
      expect(updatedTrigger.mode).toBe("rising");
    }),
  );

  it.live("completes the device close signal when the opening scope is released", () =>
    Effect.gen(function* () {
      const firmware = fakeFirmware({
        path: "/dev/tty.vscope-scoped-close",
        deviceName: "scope-scoped-close",
      });
      const driver = fakeDriver([firmware]);
      let closed: Effect.Effect<void, unknown> | undefined;

      yield* Effect.scoped(
        Effect.gen(function* () {
          const device = yield* openVScopeDevice({
            path: "/dev/tty.vscope-scoped-close",
            baudRate: 115200,
            driver,
          });
          closed = device.closed;
        }),
      );

      if (!closed) {
        throw new Error("Device close signal was not captured");
      }

      const result = yield* closed.pipe(
        Effect.as("closed"),
        Effect.timeoutOrElse({
          duration: "100 millis",
          orElse: () => Effect.succeed("timeout"),
        }),
      );

      expect(result).toBe("closed");
      expect(firmware.closeAttempts).toBe(1);
    }),
  );

  it.live("streams snapshot data in firmware-sized dense byte chunks", () =>
    Effect.gen(function* () {
      const driver = fakeDriver([
        fakeFirmware({
          path: "/dev/tty.vscope-snapshot",
          deviceName: "scope-snapshot",
        }),
      ]);

      const device = yield* openVScopeDevice({
        path: "/dev/tty.vscope-snapshot",
        baudRate: 115200,
        driver,
      });
      const chunks = yield* device.snapshotBytes().pipe(Stream.runCollect);
      const bytes = yield* device.collectSnapshotBytes();

      expect(chunks.length).toBeGreaterThan(1);
      expect(bytes.byteLength).toBe(1000 * 5 * Float32Array.BYTES_PER_ELEMENT);

      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      expect(view.getFloat32(0, true)).toBe(0);
      expect(view.getFloat32(4, true)).toBe(1);
      expect(view.getFloat32((1000 * 5 - 1) * 4, true)).toBe(4999);
    }),
  );

  it.live("surfaces firmware errors as typed failures", () =>
    Effect.gen(function* () {
      const driver = fakeDriver([
        fakeFirmware({
          path: "/dev/tty.vscope-rt",
          deviceName: "scope-rt",
          rtLabels: ["gain"],
          failRtRead: true,
        }),
      ]);

      const device = yield* openVScopeDevice({
        path: "/dev/tty.vscope-rt",
        baudRate: 115200,
        driver,
      });

      const exit = yield* Effect.exit(device.getRtValue(0));

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
    }),
  );

  it.live("rejects values that JavaScript would coerce on the wire", () =>
    Effect.gen(function* () {
      const driver = fakeDriver([
        fakeFirmware({
          path: "/dev/tty.vscope-validation",
          deviceName: "scope-validation",
        }),
      ]);

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

      for (const exit of [oversizedDivider, fractionalState, invalidTriggerMode]) {
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          const errors = exit.cause.reasons
            .filter((reason) => reason._tag === "Fail")
            .map((reason) => reason.error);
          expect(errors[0]).toBeInstanceOf(VScopeInvalidArgumentError);
        }
      }
    }),
  );

  it.live(
    "fails the device session after a response timeout so late frames cannot poison later requests",
    () =>
      Effect.gen(function* () {
        const driver = fakeDriver([
          fakeFirmware({
            path: "/dev/tty.vscope-timeout",
            deviceName: "scope-timeout",
            frameResponseDelayMillis: 20,
          }),
        ]);

        const device = yield* openVScopeDevice({
          path: "/dev/tty.vscope-timeout",
          baudRate: 115200,
          driver,
          requestTimeoutMillis: 5,
        });

        const timedOutFrame = yield* Effect.exit(device.getFrame);
        yield* Effect.sleep("30 millis");
        const nextRequest = yield* Effect.exit(device.getState);

        expect(timedOutFrame._tag).toBe("Failure");
        if (timedOutFrame._tag === "Failure") {
          const errors = timedOutFrame.cause.reasons
            .filter((reason) => reason._tag === "Fail")
            .map((reason) => reason.error);
          expect(errors[0]).toBeInstanceOf(VScopeResponseTimeoutError);
        }

        expect(nextRequest._tag).toBe("Failure");
        if (nextRequest._tag === "Failure") {
          const errors = nextRequest.cause.reasons
            .filter((reason) => reason._tag === "Fail")
            .map((reason) => reason.error);
          expect(errors[0]).toBeInstanceOf(VScopeSessionClosedError);
        }
      }),
  );

  it.live("fails immediately when a valid response has the wrong message type", () =>
    Effect.gen(function* () {
      const driver = fakeDriver([
        fakeFirmware({
          path: "/dev/tty.vscope-wrong-response",
          deviceName: "scope-wrong-response",
          wrongResponseFor: VScopeMessageType.GetTiming,
        }),
      ]);

      const device = yield* openVScopeDevice({
        path: "/dev/tty.vscope-wrong-response",
        baudRate: 115200,
        driver,
      });

      const result = yield* Effect.exit(device.getTiming);

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        const errors = result.cause.reasons
          .filter((reason) => reason._tag === "Fail")
          .map((reason) => reason.error);
        expect(errors[0]).toBeInstanceOf(VScopeUnexpectedResponseError);
      }
    }),
  );

  it.live("retries the same request after a CRC-corrupted response", () =>
    Effect.gen(function* () {
      const firmware = fakeFirmware({
        path: "/dev/tty.vscope-crc-retry",
        deviceName: "scope-crc-retry",
        corruptFirstResponsesFor: [VScopeMessageType.GetTiming],
      });
      const driver = fakeDriver([firmware]);

      const device = yield* openVScopeDevice({
        path: "/dev/tty.vscope-crc-retry",
        baudRate: 115200,
        driver,
        crcRetryAttempts: 1,
      });

      const timing = yield* device.getTiming;

      expect(timing).toEqual({ divider: 1, preTrig: 0 });
      expect(firmware.requestCount(VScopeMessageType.GetTiming)).toBe(2);
    }),
  );

  it.live("still closes the native transport after a read-side session failure", () =>
    Effect.gen(function* () {
      const firmware = fakeFirmware({
        path: "/dev/tty.vscope-read-error",
        deviceName: "scope-read-error",
        errorAfterOpenMillis: 20,
      });
      const driver = fakeDriver([firmware]);

      const device = yield* openVScopeDevice({
        path: "/dev/tty.vscope-read-error",
        baudRate: 115200,
        driver,
      });

      const closedExit = yield* Effect.exit(device.closed);
      const closeExit = yield* Effect.exit(device.close);
      const closeAttempts = firmware.closeAttempts;

      expect(closedExit._tag).toBe("Failure");
      if (closedExit._tag === "Failure") {
        const errors = closedExit.cause.reasons
          .filter((reason) => reason._tag === "Fail")
          .map((reason) => reason.error);
        expect(errors[0]).toBeInstanceOf(VScopeTransportError);
      }
      expect(closeExit._tag).toBe("Success");
      expect(closeAttempts).toBe(1);
    }),
  );
});

describe("@vscope/serial manager", () => {
  it.live("manages devices by path and resolves duplicate names by first match", () => {
    const driver = fakeDriver([
      fakeFirmware({ path: "/dev/tty.vscope-a", deviceName: "same-name" }),
      fakeFirmware({ path: "/dev/tty.vscope-b", deviceName: "same-name" }),
    ]);

    return Effect.gen(function* () {
      const manager = yield* VScopeSerial;
      const first = yield* manager.openDevice({ path: "/dev/tty.vscope-a", baudRate: 115200 });
      const second = yield* manager.openDevice({ path: "/dev/tty.vscope-b", baudRate: 115200 });
      const byName = yield* manager.getDevice("same-name");
      const duplicateExit = yield* Effect.exit(
        manager.openDevice({ path: "/dev/tty.vscope-a", baudRate: 115200 }),
      );

      expect(first.path).toBe("/dev/tty.vscope-a");
      expect(second.path).toBe("/dev/tty.vscope-b");
      expect(byName.path).toBe("/dev/tty.vscope-a");
      expect(duplicateExit._tag).toBe("Failure");
      if (duplicateExit._tag === "Failure") {
        const errors = duplicateExit.cause.reasons
          .filter((reason) => reason._tag === "Fail")
          .map((reason) => reason.error);
        expect(errors[0]).toBeInstanceOf(VScopeDeviceAlreadyOpenError);
      }
    }).pipe(Effect.provide(makeVScopeSerialLayer({ driver })));
  });

  it.live("removes manager-owned devices when the returned device is closed", () => {
    const driver = fakeDriver([
      fakeFirmware({ path: "/dev/tty.vscope-managed", deviceName: "managed" }),
    ]);

    return Effect.gen(function* () {
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

      expect(afterClose).toEqual([]);
      expect(reopened.path).toBe("/dev/tty.vscope-managed");
    }).pipe(Effect.provide(makeVScopeSerialLayer({ driver })));
  });

  it.live(
    "keeps manager entries registered but closes the stale handle when serial close fails",
    () => {
      const driver = fakeDriver([
        fakeFirmware({
          path: "/dev/tty.vscope-close-fail",
          deviceName: "close-fail",
          closeFailures: 1,
        }),
      ]);

      return Effect.gen(function* () {
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

        expect(closeExit._tag).toBe("Failure");
        if (closeExit._tag === "Failure") {
          const errors = closeExit.cause.reasons
            .filter((reason) => reason._tag === "Fail")
            .map((reason) => reason.error);
          expect(errors[0]).toBeInstanceOf(SerialCloseError);
        }

        expect(afterFailedClose).toHaveLength(1);
        expect(afterFailedClose[0]?.path).toBe("/dev/tty.vscope-close-fail");
        expect(stateAfterFailedClose._tag).toBe("Failure");
        expect(retryExit._tag).toBe("Success");
        expect(afterRetry).toEqual([]);
      }).pipe(Effect.provide(makeVScopeSerialLayer({ driver })));
    },
  );

  it.live("does not let stale device handles close a newer device on the same path", () => {
    const driver = fakeDriver([
      fakeFirmware({ path: "/dev/tty.vscope-stale", deviceName: "stale" }),
    ]);

    return Effect.gen(function* () {
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

      expect(second.path).toBe("/dev/tty.vscope-stale");
      expect(devices).toHaveLength(1);
      expect(devices[0]?.path).toBe("/dev/tty.vscope-stale");
    }).pipe(Effect.provide(makeVScopeSerialLayer({ driver })));
  });

  it.live("publishes DeviceLost and removes the entry on involuntary serial close", () => {
    const driver = fakeDriver([
      fakeFirmware({
        path: "/dev/tty.vscope-lost",
        deviceName: "lost",
        closeAfterOpenMillis: 20,
      }),
    ]);

    return Effect.gen(function* () {
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

      expect(closedExit._tag).toBe("Failure");
      if (closedExit._tag === "Failure") {
        const errors = closedExit.cause.reasons
          .filter((reason) => reason._tag === "Fail")
          .map((reason) => reason.error);
        expect(errors[0]).toBeInstanceOf(VScopeTransportError);
      }

      expect(devices).toEqual([]);
      expect(events.map((event) => event._tag)).toEqual(["DeviceOpened", "DeviceLost"]);
      const lost = events[1];
      expect(lost?._tag).toBe("DeviceLost");
      if (lost?._tag === "DeviceLost") {
        expect(lost.device.path).toBe("/dev/tty.vscope-lost");
        expect(lost.cause).toBeInstanceOf(VScopeTransportError);
      }
    }).pipe(Effect.provide(makeVScopeSerialLayer({ driver })));
  });

  it.live("removes the entry when a close failure races with serial loss", () => {
    const driver = fakeDriver([
      fakeFirmware({
        path: "/dev/tty.vscope-close-race",
        deviceName: "close-race",
        closeFailures: 1,
        closeFailureEmitsClose: true,
      }),
    ]);

    return Effect.gen(function* () {
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

      expect(closeExit._tag).toBe("Failure");
      expect(events.map((event) => event._tag)).toEqual(["DeviceOpened", "DeviceLost"]);
      expect(afterLost).toEqual([]);
      expect(reopened.path).toBe("/dev/tty.vscope-close-race");
    }).pipe(Effect.provide(makeVScopeSerialLayer({ driver })));
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
  readonly wrongResponseFor?: VScopeMessageType | undefined;
  readonly corruptFirstResponsesFor?: ReadonlyArray<VScopeMessageType> | undefined;
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

  set(
    options: { readonly dtr?: boolean; readonly rts?: boolean },
    callback?: SerialCallback,
  ): void {
    this.#firmware.controlSignals = {
      dtr: options.dtr ?? this.#firmware.controlSignals.dtr,
      rts: options.rts ?? this.#firmware.controlSignals.rts,
    };
    queueMicrotask(() => callback?.(undefined));
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
  readonly wrongResponseFor: VScopeMessageType | undefined;
  readonly corruptFirstResponsesFor: ReadonlySet<VScopeMessageType>;
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
  controlSignals: { dtr: boolean; rts: boolean } = { dtr: false, rts: false };
  channelMap = [0, 1, 2, 3, 4];
  trigger: { threshold: number; channel: number; mode: VScopeTriggerModeValue } = {
    threshold: 0,
    channel: 0,
    mode: VScopeTriggerMode.Disabled,
  };
  rtValues: number[];
  readonly #requestCounts = new Map<VScopeMessageType, number>();

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
    this.wrongResponseFor = options.wrongResponseFor;
    this.corruptFirstResponsesFor = new Set(options.corruptFirstResponsesFor ?? []);
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

  requestCount(type: VScopeMessageType): number {
    return this.#requestCounts.get(type) ?? 0;
  }

  private handle(type: VScopeMessageType, payload: Uint8Array): FakeFirmwareResponse {
    const requestCount = this.requestCount(type) + 1;
    this.#requestCounts.set(type, requestCount);

    if (type === this.wrongResponseFor) {
      return this.response(VScopeMessageType.GetStatus, this.statusPayload());
    }

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
    const shouldCorrupt = this.corruptFirstResponsesFor.has(type) && this.requestCount(type) === 1;
    const bytes = Effect.runSync(encodeVScopeFrame({ type, payload }));
    if (shouldCorrupt) {
      bytes[bytes.byteLength - 1] ^= 0xff;
    }

    return {
      bytes,
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
