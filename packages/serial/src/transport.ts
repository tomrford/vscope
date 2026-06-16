import { Buffer } from "node:buffer";
import { Cause, Data, Effect, Exit, Queue, Semaphore, Stream } from "effect";
import type * as Scope from "effect/Scope";
import { SerialPort } from "serialport";

export type SerialBytes = Uint8Array | Buffer;

export interface SerialPortInfo {
  readonly path: string;
  readonly manufacturer: string | undefined;
  readonly serialNumber: string | undefined;
  readonly pnpId: string | undefined;
  readonly locationId: string | undefined;
  readonly productId: string | undefined;
  readonly vendorId: string | undefined;
}

export interface SerialOpenOptions {
  readonly path: string;
  readonly baudRate: number;
  readonly dataBits?: 5 | 6 | 7 | 8 | undefined;
  readonly lock?: boolean | undefined;
  readonly stopBits?: 1 | 1.5 | 2 | undefined;
  readonly parity?: string | undefined;
  readonly rtscts?: boolean | undefined;
  readonly xon?: boolean | undefined;
  readonly xoff?: boolean | undefined;
  readonly xany?: boolean | undefined;
  readonly hupcl?: boolean | undefined;
  readonly highWaterMark?: number | undefined;
  readonly endOnClose?: boolean | undefined;
}

export interface OpenSerialTransportOptions extends SerialOpenOptions {
  readonly driver?: SerialDriver | undefined;
}

export type SerialOperation = "write" | "drain" | "flush" | "close" | "read";

export class SerialListError extends Data.TaggedError("SerialListError")<{
  readonly cause: unknown;
}> {}

export class SerialOpenError extends Data.TaggedError("SerialOpenError")<{
  readonly path: string;
  readonly cause: unknown;
}> {}

export class SerialWriteError extends Data.TaggedError("SerialWriteError")<{
  readonly path: string;
  readonly cause: unknown;
}> {}

export class SerialDrainError extends Data.TaggedError("SerialDrainError")<{
  readonly path: string;
  readonly cause: unknown;
}> {}

export class SerialFlushError extends Data.TaggedError("SerialFlushError")<{
  readonly path: string;
  readonly cause: unknown;
}> {}

export class SerialCloseError extends Data.TaggedError("SerialCloseError")<{
  readonly path: string;
  readonly cause: unknown;
}> {}

export class SerialReadError extends Data.TaggedError("SerialReadError")<{
  readonly path: string;
  readonly cause: unknown;
}> {}

export class SerialConnectionClosedError extends Data.TaggedError("SerialConnectionClosedError")<{
  readonly path: string;
  readonly operation: SerialOperation;
}> {}

export type SerialError =
  | SerialListError
  | SerialOpenError
  | SerialWriteError
  | SerialDrainError
  | SerialFlushError
  | SerialCloseError
  | SerialReadError
  | SerialConnectionClosedError;

export type SerialCallback = (error: Error | null | undefined) => void;

export interface SerialPortLike {
  readonly path: string;
  readonly baudRate: number;
  readonly isOpen: boolean;
  open(callback?: SerialCallback): void;
  write(chunk: SerialBytes, callback?: SerialCallback): boolean;
  drain(callback?: SerialCallback): void;
  flush(callback?: SerialCallback): void;
  close(callback?: SerialCallback): void;
  on(event: "data", listener: (chunk: Buffer) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: (error?: Error | null) => void): this;
  once(event: "open", listener: () => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "close", listener: (error?: Error | null) => void): this;
  off(event: "data", listener: (chunk: Buffer) => void): this;
  off(event: "error", listener: (error: Error) => void): this;
  off(event: "close", listener: (error?: Error | null) => void): this;
}

export interface SerialPortConstructor {
  readonly list: () => Promise<ReadonlyArray<unknown>>;
  new (
    options: SerialOpenOptions & { readonly autoOpen?: boolean },
    callback?: SerialCallback,
  ): SerialPortLike;
}

export interface SerialDriver {
  readonly list: () => Promise<ReadonlyArray<unknown>>;
  readonly open: (
    options: SerialOpenOptions & { readonly autoOpen: false },
    callback?: SerialCallback,
  ) => SerialPortLike;
}

export interface SerialTransport {
  readonly path: string;
  readonly baudRate: number;
  readonly isOpen: Effect.Effect<boolean>;
  readonly read: Effect.Effect<Uint8Array, SerialReadError | SerialConnectionClosedError>;
  readonly readQueue: Queue.Dequeue<Uint8Array, SerialReadError | Cause.Done>;
  readonly chunks: Stream.Stream<Uint8Array, SerialReadError>;
  readonly write: (
    bytes: SerialBytes,
  ) => Effect.Effect<void, SerialWriteError | SerialConnectionClosedError>;
  readonly drain: Effect.Effect<void, SerialDrainError | SerialConnectionClosedError>;
  readonly flush: Effect.Effect<void, SerialFlushError | SerialConnectionClosedError>;
  readonly close: Effect.Effect<void, SerialCloseError>;
}

interface TransportState {
  closed: boolean;
}

const serialPortConstructor = SerialPort as unknown as SerialPortConstructor;

export const makeSerialDriver = (Port: SerialPortConstructor): SerialDriver => ({
  list: () => Port.list(),
  open: (options, callback) => new Port(options, callback),
});

export const defaultSerialDriver: SerialDriver = makeSerialDriver(serialPortConstructor);

export const mapSerialPortInfo = (info: unknown): SerialPortInfo => {
  const value = isRecord(info) ? info : {};

  return {
    path: stringField(value.path),
    manufacturer: optionalStringField(value.manufacturer),
    serialNumber: optionalStringField(value.serialNumber),
    pnpId: optionalStringField(value.pnpId),
    locationId: optionalStringField(value.locationId),
    productId: optionalStringField(value.productId),
    vendorId: optionalStringField(value.vendorId),
  };
};

export const listSerialPorts = (
  driver: SerialDriver = defaultSerialDriver,
): Effect.Effect<ReadonlyArray<SerialPortInfo>, SerialListError> =>
  Effect.tryPromise({
    try: () => driver.list(),
    catch: (cause) => new SerialListError({ cause }),
  }).pipe(Effect.map((ports) => ports.map(mapSerialPortInfo)));

export const openSerialTransport = (
  options: OpenSerialTransportOptions,
): Effect.Effect<SerialTransport, SerialOpenError, Scope.Scope> => {
  const { driver = defaultSerialDriver, ...openOptions } = options;

  return Effect.acquireRelease(
    Effect.gen(function* () {
      const port = yield* openPort(driver, openOptions);
      const queue = yield* Queue.unbounded<Uint8Array, SerialReadError | Cause.Done>();
      const operationLock = yield* Semaphore.make(1);
      const state: TransportState = { closed: false };

      return makeTransport(port, queue, operationLock, state);
    }),
    (transport) => transport.close.pipe(Effect.ignore),
  );
};

const openPort = (
  driver: SerialDriver,
  options: SerialOpenOptions,
): Effect.Effect<SerialPortLike, SerialOpenError> =>
  Effect.callback<SerialPortLike, SerialOpenError>((resume) => {
    let port: SerialPortLike | undefined;
    let settled = false;

    const finish = (effect: Effect.Effect<SerialPortLike, SerialOpenError>) => {
      if (settled) return;
      settled = true;
      if (port) {
        port.off("error", onError);
      }
      resume(effect);
    };

    const onError = (cause: Error) => {
      finish(Effect.fail(new SerialOpenError({ path: options.path, cause })));
    };

    try {
      port = driver.open({ ...options, autoOpen: false });
      port.once("error", onError);
      port.open((cause) => {
        if (cause) {
          finish(Effect.fail(new SerialOpenError({ path: options.path, cause })));
          return;
        }

        if (!port) {
          finish(
            Effect.fail(
              new SerialOpenError({
                path: options.path,
                cause: new Error("Serial port was not constructed"),
              }),
            ),
          );
          return;
        }

        finish(Effect.succeed(port));
      });
    } catch (cause) {
      finish(Effect.fail(new SerialOpenError({ path: options.path, cause })));
    }

    return Effect.sync(() => {
      if (!port) return;
      port.off("error", onError);
      if (!settled || port.isOpen) {
        closeNativeUnsafe(port);
      }
    });
  });

const makeTransport = (
  port: SerialPortLike,
  readQueue: Queue.Queue<Uint8Array, SerialReadError | Cause.Done>,
  operationLock: Semaphore.Semaphore,
  state: TransportState,
): SerialTransport => {
  const path = port.path;
  const endReadQueue = () => {
    Queue.endUnsafe(readQueue);
  };
  const failReadQueue = (cause: unknown) => {
    Queue.failCauseUnsafe(readQueue, Cause.fail(new SerialReadError({ path, cause })));
  };
  const onData = (chunk: Buffer) => {
    Queue.offerUnsafe(readQueue, copyBytes(chunk));
  };
  const onError = (cause: Error) => {
    failReadQueue(cause);
  };
  const onClose = (cause?: Error | null) => {
    state.closed = true;
    if (cause) {
      failReadQueue(cause);
      return;
    }
    endReadQueue();
  };
  const detachListeners = () => {
    port.off("data", onData);
    port.off("error", onError);
    port.off("close", onClose);
  };

  port.on("data", onData);
  port.on("error", onError);
  port.on("close", onClose);

  const ensureOpen = (operation: SerialOperation) =>
    state.closed || !port.isOpen
      ? Effect.fail(new SerialConnectionClosedError({ path, operation }))
      : Effect.void;

  const close = Effect.uninterruptible(
    operationLock.withPermit(
      Effect.gen(function* () {
        if (state.closed) {
          return;
        }

        if (!port.isOpen) {
          state.closed = true;
          detachListeners();
          endReadQueue();
          return;
        }

        const closeExit = yield* Effect.exit(
          serialCallback(
            port,
            (callback) => port.close(callback),
            (cause) => new SerialCloseError({ path, cause }),
          ),
        );

        if (Exit.isFailure(closeExit)) {
          state.closed = true;
          detachListeners();
          endReadQueue();
          return yield* Effect.failCause(closeExit.cause);
        }

        state.closed = true;
        detachListeners();
        endReadQueue();
      }),
    ),
  );

  return {
    path,
    baudRate: port.baudRate,
    isOpen: Effect.sync(() => !state.closed && port.isOpen),
    read: Queue.take(readQueue).pipe(
      Effect.mapError((cause) =>
        Cause.isDone(cause) ? new SerialConnectionClosedError({ path, operation: "read" }) : cause,
      ),
    ),
    readQueue: readQueue,
    chunks: Stream.fromQueue(readQueue),
    write: (bytes) =>
      operationLock.withPermit(
        Effect.gen(function* () {
          yield* ensureOpen("write");
          yield* serialCallback(
            port,
            (callback) => {
              port.write(toBuffer(bytes), callback);
            },
            (cause) => new SerialWriteError({ path, cause }),
          );
        }),
      ),
    drain: operationLock.withPermit(
      Effect.gen(function* () {
        yield* ensureOpen("drain");
        yield* serialCallback(
          port,
          (callback) => port.drain(callback),
          (cause) => new SerialDrainError({ path, cause }),
        );
      }),
    ),
    flush: operationLock.withPermit(
      Effect.gen(function* () {
        yield* ensureOpen("flush");
        yield* serialCallback(
          port,
          (callback) => port.flush(callback),
          (cause) => new SerialFlushError({ path, cause }),
        );
      }),
    ),
    close,
  };
};

const serialCallback = <E>(
  port: SerialPortLike,
  register: (callback: SerialCallback) => void,
  mapError: (cause: unknown) => E,
): Effect.Effect<void, E> =>
  Effect.callback<void, E>((resume) => {
    let settled = false;

    const finish = (effect: Effect.Effect<void, E>) => {
      if (settled) return;
      settled = true;
      port.off("error", onError);
      resume(effect);
    };
    const onError = (cause: Error) => {
      finish(Effect.fail(mapError(cause)));
    };

    port.once("error", onError);

    try {
      register((cause) => {
        if (cause) {
          finish(Effect.fail(mapError(cause)));
          return;
        }
        finish(Effect.void);
      });
    } catch (cause) {
      finish(Effect.fail(mapError(cause)));
    }

    return Effect.sync(() => {
      port.off("error", onError);
    });
  });

const closeNativeUnsafe = (port: SerialPortLike) => {
  try {
    port.close(() => {});
  } catch {
    // Best-effort cleanup for interrupted acquisition.
  }
};

const toBuffer = (bytes: SerialBytes): Buffer =>
  Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);

const copyBytes = (bytes: SerialBytes): Uint8Array => Uint8Array.from(bytes);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const stringField = (value: unknown): string =>
  typeof value === "string" ? value : String(value ?? "");

const optionalStringField = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
