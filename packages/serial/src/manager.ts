import { Context, Data, Effect, Exit, Layer, PubSub, Ref, Scope, Semaphore, Stream } from "effect";

import { openVScopeDevice } from "./device";
import type { VScopeDeviceError } from "./errors";
import {
  defaultSerialDriver,
  listSerialPorts,
  type SerialCloseError,
  type SerialDriver,
  type SerialListError,
  type SerialOpenError,
  type SerialPortInfo,
} from "./transport";
import type { OpenVScopeDeviceOptions, VScopeDevice, VScopeStaticMetadata } from "./types";

export interface VScopeDeviceSummary {
  readonly path: string;
  readonly deviceName: string;
  readonly metadata: VScopeStaticMetadata;
}

export const summarizeDevice = (device: VScopeDevice): Effect.Effect<VScopeDeviceSummary> =>
  device.metadata.pipe(
    Effect.map((metadata) => ({
      path: device.path,
      deviceName: device.deviceName,
      metadata,
    })),
  );

export type VScopeSerialEvent =
  | {
      readonly _tag: "DeviceOpened";
      readonly device: VScopeDeviceSummary;
    }
  | {
      readonly _tag: "DeviceRemoved";
      readonly device: VScopeDeviceSummary;
    }
  | {
      readonly _tag: "DeviceLost";
      readonly device: VScopeDeviceSummary;
      readonly cause: VScopeDeviceError;
    };

export interface VScopeSerialOptions {
  readonly driver?: SerialDriver | undefined;
}

export interface VScopeSerialService {
  readonly listPorts: Effect.Effect<ReadonlyArray<SerialPortInfo>, SerialListError>;
  readonly openDevice: (
    options: OpenVScopeDeviceOptions,
  ) => Effect.Effect<
    VScopeDevice,
    VScopeDeviceAlreadyOpenError | SerialOpenError | VScopeDeviceError
  >;
  readonly getDevice: (
    identifier: string,
  ) => Effect.Effect<VScopeDevice, VScopeDeviceNotFoundError>;
  readonly getDeviceByPath: (
    path: string,
  ) => Effect.Effect<VScopeDevice, VScopeDeviceNotFoundError>;
  readonly removeDevice: (
    identifier: string,
  ) => Effect.Effect<void, VScopeDeviceNotFoundError | SerialCloseError>;
  readonly closeAll: Effect.Effect<void, SerialCloseError>;
  readonly listDevices: Effect.Effect<ReadonlyArray<VScopeDeviceSummary>>;
  readonly events: Stream.Stream<VScopeSerialEvent>;
}

export class VScopeDeviceAlreadyOpenError extends Data.TaggedError("VScopeDeviceAlreadyOpenError")<{
  readonly path: string;
}> {}

export class VScopeDeviceNotFoundError extends Data.TaggedError("VScopeDeviceNotFoundError")<{
  readonly identifier: string;
}> {}

interface DeviceEntry {
  readonly token: symbol;
  readonly scope: Scope.Closeable;
  readonly device: VScopeDevice;
  readonly close: Effect.Effect<void, SerialCloseError>;
}

const VScopeSerialTag = Context.Service<VScopeSerialService>("@vscope/serial/VScopeSerial");

export const VScopeSerial = VScopeSerialTag;
export const VScopeSerialLayer = Layer.effect(VScopeSerial, makeVScopeSerial());
export const makeVScopeSerialLayer = (
  options: VScopeSerialOptions,
): Layer.Layer<VScopeSerialService> => Layer.effect(VScopeSerial, makeVScopeSerial(options));

export function makeVScopeSerial(
  options: VScopeSerialOptions = {},
): Effect.Effect<VScopeSerialService, never, Scope.Scope> {
  return Effect.gen(function* () {
    const driver = options.driver ?? defaultSerialDriver;
    const parentScope = yield* Scope.Scope;
    const entriesRef = yield* Ref.make(new Map<string, DeviceEntry>());
    const lock = yield* Semaphore.make(1);
    const events = yield* PubSub.bounded<VScopeSerialEvent>({ capacity: 256, replay: 32 });

    const findEntryWithPath = (entries: ReadonlyMap<string, DeviceEntry>, identifier: string) => {
      const byPath = entries.get(identifier);
      if (byPath) {
        return [identifier, byPath] as const;
      }

      for (const [path, entry] of entries) {
        if (entry.device.deviceName === identifier) {
          return [path, entry] as const;
        }
      }

      return undefined;
    };

    const findEntry = (entries: ReadonlyMap<string, DeviceEntry>, identifier: string) =>
      findEntryWithPath(entries, identifier)?.[1];

    const deleteEntry = (path: string) =>
      Ref.update(entriesRef, (entries) => {
        const next = new Map(entries);
        next.delete(path);
        return next;
      });

    const closeEntry = (path: string, entry: DeviceEntry) =>
      Effect.gen(function* () {
        const summary = yield* summarizeDevice(entry.device);
        yield* entry.close;
        yield* Scope.close(entry.scope, Exit.void);
        yield* deleteEntry(path);
        const event: VScopeSerialEvent = { _tag: "DeviceRemoved", device: summary };
        yield* PubSub.publish(events, event);
      });

    const closeManagedDevice = (path: string, token: symbol) =>
      lock.withPermit(
        Effect.gen(function* () {
          const entries = yield* Ref.get(entriesRef);
          const entry = entries.get(path);
          if (!entry || entry.token !== token) {
            return;
          }

          yield* closeEntry(path, entry);
        }),
      );

    const publishLostDevice = (path: string, token: symbol, cause: VScopeDeviceError) =>
      lock.withPermit(
        Effect.gen(function* () {
          const entries = yield* Ref.get(entriesRef);
          const entry = entries.get(path);
          if (!entry || entry.token !== token) {
            return;
          }

          const summary = yield* summarizeDevice(entry.device);
          yield* Scope.close(entry.scope, Exit.fail(cause)).pipe(Effect.ignore);
          yield* deleteEntry(path);
          const event: VScopeSerialEvent = { _tag: "DeviceLost", device: summary, cause };
          yield* PubSub.publish(events, event);
        }),
      );

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const entries = yield* Ref.get(entriesRef);
        yield* Effect.forEach(
          entries,
          ([path, entry]) => closeEntry(path, entry).pipe(Effect.ignore),
          {
            discard: true,
          },
        );
        yield* PubSub.shutdown(events);
      }),
    );

    return {
      listPorts: listSerialPorts(driver),
      openDevice: (openOptions) =>
        lock.withPermit(
          Effect.gen(function* () {
            const entries = yield* Ref.get(entriesRef);
            if (entries.has(openOptions.path)) {
              return yield* new VScopeDeviceAlreadyOpenError({ path: openOptions.path });
            }

            const deviceScope = yield* Scope.fork(parentScope, "sequential");
            const openedDevice = yield* openVScopeDevice({ ...openOptions, driver }).pipe(
              Scope.provide(deviceScope),
              Effect.tapCause((cause) => Scope.close(deviceScope, Exit.failCause(cause))),
            );
            const token = Symbol(openedDevice.path);
            const device: VScopeDevice = {
              ...openedDevice,
              close: closeManagedDevice(openedDevice.path, token),
            };
            yield* Ref.update(entriesRef, (current) => {
              const next = new Map(current);
              next.set(device.path, {
                token,
                scope: deviceScope,
                device,
                close: openedDevice.close,
              });
              return next;
            });

            yield* openedDevice.closed.pipe(
              Effect.flip,
              Effect.flatMap((cause) => publishLostDevice(openedDevice.path, token, cause)),
              Effect.ignore,
              Effect.forkScoped,
              Scope.provide(deviceScope),
            );

            const summary = yield* summarizeDevice(device);
            const event: VScopeSerialEvent = { _tag: "DeviceOpened", device: summary };
            yield* PubSub.publish(events, event);
            return device;
          }),
        ),
      getDevice: (identifier) =>
        Ref.get(entriesRef).pipe(
          Effect.flatMap((entries) => {
            const entry = findEntry(entries, identifier);
            return entry
              ? Effect.succeed(entry.device)
              : Effect.fail(new VScopeDeviceNotFoundError({ identifier }));
          }),
        ),
      getDeviceByPath: (path) =>
        Ref.get(entriesRef).pipe(
          Effect.flatMap((entries) => {
            const entry = entries.get(path);
            return entry
              ? Effect.succeed(entry.device)
              : Effect.fail(new VScopeDeviceNotFoundError({ identifier: path }));
          }),
        ),
      removeDevice: (identifier) =>
        lock.withPermit(
          Effect.gen(function* () {
            const entries = yield* Ref.get(entriesRef);
            const found = findEntryWithPath(entries, identifier);
            if (!found) {
              return yield* new VScopeDeviceNotFoundError({ identifier });
            }

            const [path, entry] = found;
            yield* closeEntry(path, entry);
          }),
        ),
      closeAll: lock.withPermit(
        Effect.gen(function* () {
          const entries = yield* Ref.get(entriesRef);
          yield* Effect.forEach(entries, ([path, entry]) => closeEntry(path, entry), {
            discard: true,
          });
        }),
      ),
      listDevices: Ref.get(entriesRef).pipe(
        Effect.flatMap((entries) =>
          Effect.forEach(entries.values(), (entry) => summarizeDevice(entry.device)),
        ),
      ),
      events: Stream.fromPubSub(events),
    };
  });
}
