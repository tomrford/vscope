import { Cause, Deferred, Effect, Exit, Queue, Ref, Semaphore, Stream } from "effect";
import type * as Scope from "effect/Scope";
import type { TriggerMode } from "@vscope/shared";

import {
  VScopeDecodeError,
  type VScopeDeviceError,
  VScopeFirmwareError,
  VScopeInvalidArgumentError,
  VScopeResponseTimeoutError,
  VScopeSessionClosedError,
  VScopeTransportError,
  VScopeUnexpectedResponseError,
} from "./errors";
import {
  fixedString,
  readF32,
  readU16,
  readU32,
  VScopeEndianness,
  VScopeFrameParseError,
  type VScopeFrameParseEvent,
  VScopeFrameParser,
  VScopeMessageType,
  VSCOPE_MAX_PAYLOAD,
  VScopeStatusFlag,
  VScopeState,
  type VScopeState as VScopeStateValue,
  VScopeStatus,
  type VScopeStatus as VScopeStatusValue,
  VScopeTriggerMode,
  type VScopeTriggerMode as VScopeWireTriggerMode,
  writeF32,
  writeU16,
  writeU32,
  encodeVScopeFrame,
} from "./protocol";
import {
  SerialConnectionClosedError,
  openSerialTransport,
  type SerialOpenError,
  type SerialTransport,
} from "./transport";
import type {
  OpenVScopeDeviceOptions,
  SnapshotBytesOptions,
  StateWaitOptions,
  VScopeControlStatus,
  VScopeDevice,
  VScopeDeviceInfo,
  VScopeSnapshotHeader,
  VScopeStaticMetadata,
  VScopeTiming,
  VScopeTrigger,
} from "./types";

interface VScopeClient {
  readonly request: (
    requestType: VScopeMessageType,
    responseType: VScopeMessageType,
    payload?: Uint8Array,
  ) => Effect.Effect<Uint8Array, VScopeDeviceError>;
  readonly closed: Effect.Effect<void, VScopeDeviceError>;
  readonly close: <E>(closeTransport: Effect.Effect<void, E>) => Effect.Effect<void, E>;
}

const UINT32_MAX = 0xffff_ffff;

type ClientClosedState =
  | {
      readonly _tag: "Open";
    }
  | {
      readonly _tag: "Closing";
      readonly pendingError: VScopeDeviceError | undefined;
    }
  | {
      readonly _tag: "Closed";
      readonly reason: string;
    };

type SessionCompletion =
  | {
      readonly _tag: "None";
    }
  | {
      readonly _tag: "Success";
    }
  | {
      readonly _tag: "Failure";
      readonly error: VScopeDeviceError;
    };

type CloseStart =
  | {
      readonly _tag: "AlreadyClosed";
    }
  | {
      readonly _tag: "StartClose";
    };

export const openVScopeDevice = (
  options: OpenVScopeDeviceOptions,
): Effect.Effect<VScopeDevice, SerialOpenError | VScopeDeviceError, Scope.Scope> =>
  Effect.gen(function* () {
    const transport = yield* openSerialTransport(options);
    const client = yield* makeVScopeClient(transport, {
      requestTimeoutMillis: options.requestTimeoutMillis,
      crcRetryAttempts: options.crcRetryAttempts,
    });
    yield* Effect.addFinalizer(() => client.close(transport.close).pipe(Effect.ignore));
    const info = yield* getInfo(transport.path, client);
    const littleEndian = info.endianness === VScopeEndianness.Little;
    const status = yield* getStatus(transport.path, client);
    const state = status.state;
    const variables = yield* getNames(transport.path, client, {
      requestType: VScopeMessageType.GetVarList,
      expectedTotal: info.variableCount,
      nameLength: info.nameLength,
    });
    const rtLabels =
      state === VScopeState.Misconfigured
        ? []
        : yield* getNames(transport.path, client, {
            requestType: VScopeMessageType.GetRtLabels,
            expectedTotal: info.rtCount,
            nameLength: info.nameLength,
          });
    const channelMap =
      state === VScopeState.Misconfigured ? [] : yield* getChannelMap(transport.path, client, info);
    const metadataRef = yield* Ref.make<VScopeStaticMetadata>({
      info,
      variables,
      rtLabels,
      channelMap,
    });

    return makeDevice({
      transport,
      client,
      info,
      littleEndian,
      metadataRef,
    });
  });

const makeVScopeClient = (
  transport: SerialTransport,
  options: {
    readonly requestTimeoutMillis?: number | undefined;
    readonly crcRetryAttempts?: number | undefined;
  },
): Effect.Effect<VScopeClient, never, Scope.Scope> =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<VScopeFrameParseEvent, VScopeDeviceError | Cause.Done>();
    const requestLock = yield* Semaphore.make(1);
    const closed = yield* Deferred.make<void, VScopeDeviceError>();
    const closedState = yield* Ref.make<ClientClosedState>({ _tag: "Open" });
    const parser = new VScopeFrameParser();
    const timeoutMillis = options.requestTimeoutMillis ?? 1000;
    const crcRetryAttempts = options.crcRetryAttempts ?? 2;

    const ensureOpen = (requestType: VScopeMessageType) =>
      Ref.get(closedState).pipe(
        Effect.flatMap((state) =>
          state._tag !== "Open"
            ? Effect.fail(
                new VScopeSessionClosedError({
                  path: transport.path,
                  requestType,
                  reason: state._tag === "Closing" ? "closing" : state.reason,
                }),
              )
            : Effect.void,
        ),
      );

    const completeSession = (completion: SessionCompletion) =>
      completion._tag === "None"
        ? Effect.void
        : completion._tag === "Success"
          ? Queue.end(events).pipe(
              Effect.andThen(Deferred.succeed(closed, undefined)),
              Effect.asVoid,
            )
          : Queue.fail(events, completion.error).pipe(
              Effect.andThen(Deferred.fail(closed, completion.error)),
              Effect.asVoid,
            );

    const succeedSession = () =>
      Ref.modify(closedState, (state): readonly [SessionCompletion, ClientClosedState] =>
        state._tag === "Closed"
          ? [{ _tag: "None" }, state]
          : [{ _tag: "Success" }, { _tag: "Closed", reason: "closed" }],
      ).pipe(Effect.flatMap((completion) => completeSession(completion)));

    const failSession = (error: VScopeDeviceError) =>
      Ref.modify(closedState, (state): readonly [SessionCompletion, ClientClosedState] => {
        if (state._tag === "Closed") {
          return [{ _tag: "None" }, state];
        }

        if (state._tag === "Closing") {
          return [
            { _tag: "None" },
            {
              _tag: "Closing",
              pendingError: state.pendingError ?? error,
            },
          ];
        }

        return [
          { _tag: "Failure", error },
          { _tag: "Closed", reason: sessionCloseReason(error) },
        ];
      }).pipe(Effect.flatMap((completion) => completeSession(completion)));

    const close = <E>(closeTransport: Effect.Effect<void, E>): Effect.Effect<void, E> =>
      Effect.uninterruptible(
        requestLock.withPermit(
          Effect.gen(function* () {
            const closeStart = yield* Ref.modify(
              closedState,
              (state): readonly [CloseStart, ClientClosedState] =>
                state._tag === "Closed"
                  ? [{ _tag: "AlreadyClosed" }, state]
                  : [{ _tag: "StartClose" }, { _tag: "Closing", pendingError: undefined }],
            );
            if (closeStart._tag === "AlreadyClosed") {
              yield* closeTransport;
              return;
            }

            const closeExit = yield* Effect.exit(closeTransport);
            if (Exit.isFailure(closeExit)) {
              const pendingError = yield* Ref.modify(
                closedState,
                (state): readonly [VScopeDeviceError | undefined, ClientClosedState] => {
                  if (state._tag !== "Closing") {
                    return [undefined, state];
                  }

                  return state.pendingError
                    ? [
                        state.pendingError,
                        {
                          _tag: "Closed",
                          reason: sessionCloseReason(state.pendingError),
                        },
                      ]
                    : [undefined, { _tag: "Open" }];
                },
              );
              if (pendingError) {
                yield* completeSession({ _tag: "Failure", error: pendingError });
              }
              return yield* Effect.failCause(closeExit.cause);
            }

            yield* succeedSession();
          }),
        ),
      );
    yield* Effect.gen(function* () {
      while (true) {
        const chunk = yield* transport.read.pipe(
          Effect.mapError((cause) => new VScopeTransportError({ path: transport.path, cause })),
        );

        for (const event of parser.pushEvents(chunk)) {
          yield* Queue.offer(events, event);
        }
      }
    }).pipe(
      Effect.catch((error) => failSession(error)),
      Effect.forkScoped,
    );

    const request: VScopeClient["request"] = (
      requestType: VScopeMessageType,
      responseType: VScopeMessageType,
      payload = new Uint8Array(),
    ) =>
      requestLock.withPermit(
        Effect.gen(function* () {
          yield* ensureOpen(requestType);
          const encoded = yield* encodeVScopeFrame({ type: requestType, payload });

          const attempt = (
            remainingRetries: number,
          ): Effect.Effect<Uint8Array, VScopeDeviceError> =>
            Effect.gen(function* () {
              yield* transport
                .write(encoded)
                .pipe(
                  Effect.mapError(
                    (cause) => new VScopeTransportError({ path: transport.path, cause }),
                  ),
                );
              yield* transport.drain.pipe(
                Effect.mapError(
                  (cause) => new VScopeTransportError({ path: transport.path, cause }),
                ),
              );

              return yield* takeResponse(transport.path, events, requestType, responseType).pipe(
                Effect.timeoutOrElse({
                  duration: `${timeoutMillis} millis`,
                  orElse: () => {
                    const error = new VScopeResponseTimeoutError({
                      path: transport.path,
                      requestType,
                      timeoutMillis,
                    });

                    return failSession(error).pipe(
                      Effect.andThen(transport.close.pipe(Effect.ignore)),
                      Effect.andThen(Effect.fail(error)),
                    );
                  },
                }),
                Effect.catch((error) =>
                  error instanceof VScopeFrameParseError && remainingRetries > 0
                    ? attempt(remainingRetries - 1)
                    : Effect.fail(error),
                ),
              );
            });

          return yield* attempt(crcRetryAttempts);
        }),
      );

    return {
      request,
      closed: Deferred.await(closed),
      close,
    };
  });

const takeResponse = (
  path: string,
  events: Queue.Dequeue<VScopeFrameParseEvent, VScopeDeviceError | Cause.Done>,
  requestType: VScopeMessageType,
  responseType: VScopeMessageType,
): Effect.Effect<Uint8Array, VScopeDeviceError> =>
  Effect.gen(function* () {
    const event = yield* Queue.take(events).pipe(
      Effect.mapError((error) =>
        Cause.isDone(error)
          ? new VScopeTransportError({
              path,
              cause: new SerialConnectionClosedError({ path, operation: "read" }),
            })
          : error,
      ),
    );

    if (event._tag === "InvalidFrame") {
      return yield* event.error;
    }

    const { frame } = event;

    if (frame.type === VScopeMessageType.Error) {
      return yield* decodeFirmwareError(path, requestType, frame.payload);
    }

    if (frame.type !== responseType) {
      return yield* new VScopeUnexpectedResponseError({
        path,
        requestType,
        responseType: frame.type,
      });
    }

    return frame.payload;
  });

interface DeviceParts {
  readonly transport: SerialTransport;
  readonly client: VScopeClient;
  readonly info: VScopeDeviceInfo;
  readonly littleEndian: boolean;
  readonly metadataRef: Ref.Ref<VScopeStaticMetadata>;
}

const makeDevice = (parts: DeviceParts): VScopeDevice => {
  const { transport, client, info, littleEndian, metadataRef } = parts;
  const path = transport.path;

  const getTimingEffect = getTiming(path, client, littleEndian);
  const getStatusEffect = getStatus(path, client);
  const getStateEffect = getStatusEffect.pipe(Effect.map((status) => status.state));
  const getSnapshotHeaderEffect = getSnapshotHeader(path, client, info, littleEndian);
  const getVariableCatalogEffect = getNames(path, client, {
    requestType: VScopeMessageType.GetVarList,
    expectedTotal: info.variableCount,
    nameLength: info.nameLength,
  });
  const getRtLabelsEffect = getNames(path, client, {
    requestType: VScopeMessageType.GetRtLabels,
    expectedTotal: info.rtCount,
    nameLength: info.nameLength,
  });
  const getChannelMapEffect = getChannelMap(path, client, info);

  const setState = (state: VScopeStateValue) =>
    validateState(path, state).pipe(
      Effect.andThen(
        client
          .request(VScopeMessageType.SetState, VScopeMessageType.SetState, Uint8Array.of(state))
          .pipe(Effect.map((payload) => decodeStatus(path, VScopeMessageType.SetState, payload))),
      ),
      catchDecode(path, VScopeMessageType.SetState),
    );

  const waitForState = (state: VScopeStateValue, options?: StateWaitOptions) =>
    pollStatus(path, getStatusEffect, state, options);

  const setChannelMap = (channel: number, variable: number) =>
    validateChannelMap(path, info, channel, variable).pipe(
      Effect.andThen(
        client.request(
          VScopeMessageType.SetChannelMap,
          VScopeMessageType.SetChannelMap,
          Uint8Array.of(channel, variable),
        ),
      ),
      Effect.flatMap((payload) => decodeSetChannelMap(path, payload)),
      Effect.flatMap(([updatedChannel, updatedVariable]) =>
        Ref.updateAndGet(metadataRef, (current) => {
          const nextMap =
            current.channelMap.length === info.channelCount
              ? [...current.channelMap]
              : Array.from({ length: info.channelCount }, () => 0);
          nextMap[updatedChannel] = updatedVariable;
          return { ...current, channelMap: nextMap };
        }).pipe(Effect.map((metadata) => metadata.channelMap)),
      ),
    );

  const snapshotBytes = (
    options: SnapshotBytesOptions = {},
  ): Stream.Stream<Uint8Array, VScopeDeviceError> =>
    Stream.fromEffect(
      options.header ? Effect.succeed(options.header) : getSnapshotHeaderEffect,
    ).pipe(
      Stream.flatMap((header) =>
        Stream.unfold(0, (startSample) => {
          if (startSample >= header.sampleCount) {
            return Effect.sync(() => undefined);
          }

          const chunkSamples = snapshotChunkSamples(header.channelCount, options.samplesPerChunk);
          const count = Math.min(chunkSamples, header.sampleCount - startSample);

          return getSnapshotData(path, client, {
            startSample,
            count,
            channelCount: header.channelCount,
            littleEndian,
          }).pipe(Effect.map((bytes) => [bytes, startSample + count] as const));
        }),
      ),
    );

  const collectSnapshotBytes = (
    options?: SnapshotBytesOptions,
  ): Effect.Effect<Uint8Array, VScopeDeviceError> =>
    snapshotBytes(options).pipe(
      Stream.runCollect,
      Effect.map((chunks) => concatBytes(chunks)),
    );

  return {
    path,
    deviceName: info.deviceName,
    info,
    metadata: Ref.get(metadataRef),
    getTiming: getTimingEffect,
    setTiming: (timing) => setTiming(path, client, info, littleEndian, timing),
    getStatus: getStatusEffect,
    getState: getStateEffect,
    setState,
    start: (options) =>
      setState(VScopeState.Running).pipe(
        Effect.andThen(waitForState(VScopeState.Running, options)),
      ),
    stop: (options) =>
      setState(VScopeState.Halted).pipe(Effect.andThen(waitForState(VScopeState.Halted, options))),
    trigger: client.request(VScopeMessageType.Trigger, VScopeMessageType.Trigger).pipe(
      Effect.map((payload) => decodeStatus(path, VScopeMessageType.Trigger, payload)),
      catchDecode(path, VScopeMessageType.Trigger),
    ),
    getFrame: getFrame(path, client, info, littleEndian),
    getSnapshotHeader: getSnapshotHeaderEffect,
    snapshotBytes,
    collectSnapshotBytes,
    getVariableCatalog: getVariableCatalogEffect,
    getChannelMap: getChannelMapEffect,
    setChannelMap,
    getRtLabels: getRtLabelsEffect,
    getRtValue: (index) => getRtValue(path, client, info, littleEndian, index),
    setRtValue: (index, value) => setRtValue(path, client, info, littleEndian, index, value),
    getTrigger: getTrigger(path, client, littleEndian),
    setTrigger: (trigger) => setTrigger(path, client, info, littleEndian, trigger),
    closed: client.closed,
    close: client.close(transport.close),
  };
};

const getInfo = (
  path: string,
  client: VScopeClient,
): Effect.Effect<VScopeDeviceInfo, VScopeDeviceError> =>
  client.request(VScopeMessageType.GetInfo, VScopeMessageType.GetInfo).pipe(
    Effect.map((payload) => {
      const expectedLength = 10 + 16;
      if (payload.byteLength !== expectedLength) {
        throw new VScopeDecodeError({
          path,
          messageType: VScopeMessageType.GetInfo,
          reason: `Expected ${expectedLength} bytes, got ${payload.byteLength}`,
        });
      }

      const endianness =
        payload[9] === VScopeEndianness.Big ? VScopeEndianness.Big : VScopeEndianness.Little;
      const littleEndian = endianness === VScopeEndianness.Little;
      const view = dataView(payload);

      return {
        channelCount: payload[0],
        bufferSize: readU16(view, 1, littleEndian),
        isrKHz: readU16(view, 3, littleEndian),
        variableCount: payload[5],
        rtCount: payload[6],
        rtBufferCapacity: payload[7],
        nameLength: payload[8],
        endianness,
        deviceName: fixedString(payload.subarray(10, 26)),
      };
    }),
    Effect.catchDefect((defect) =>
      defect instanceof VScopeDecodeError
        ? Effect.fail(defect)
        : Effect.fail(
            new VScopeDecodeError({
              path,
              messageType: VScopeMessageType.GetInfo,
              reason: String(defect),
            }),
          ),
    ),
  );

const getTiming = (
  path: string,
  client: VScopeClient,
  littleEndian: boolean,
): Effect.Effect<VScopeTiming, VScopeDeviceError> =>
  client.request(VScopeMessageType.GetTiming, VScopeMessageType.GetTiming).pipe(
    Effect.map((payload) => {
      expectLength(path, VScopeMessageType.GetTiming, payload, 8);
      const view = dataView(payload);
      return {
        divider: readU32(view, 0, littleEndian),
        preTrig: readU32(view, 4, littleEndian),
      };
    }),
    catchDecode(path, VScopeMessageType.GetTiming),
  );

const setTiming = (
  path: string,
  client: VScopeClient,
  info: VScopeDeviceInfo,
  littleEndian: boolean,
  timing: VScopeTiming,
): Effect.Effect<VScopeTiming, VScopeDeviceError> =>
  validateTiming(path, info, timing).pipe(
    Effect.andThen(
      Effect.sync(() => {
        const payload = new Uint8Array(8);
        writeU32(payload, 0, timing.divider, littleEndian);
        writeU32(payload, 4, timing.preTrig, littleEndian);
        return payload;
      }),
    ),
    Effect.flatMap((payload) =>
      client.request(VScopeMessageType.SetTiming, VScopeMessageType.SetTiming, payload),
    ),
    Effect.map((payload) => {
      expectLength(path, VScopeMessageType.SetTiming, payload, 8);
      const view = dataView(payload);
      return {
        divider: readU32(view, 0, littleEndian),
        preTrig: readU32(view, 4, littleEndian),
      };
    }),
    catchDecode(path, VScopeMessageType.SetTiming),
  );

const getStatus = (
  path: string,
  client: VScopeClient,
): Effect.Effect<VScopeControlStatus, VScopeDeviceError> =>
  client.request(VScopeMessageType.GetStatus, VScopeMessageType.GetStatus).pipe(
    Effect.map((payload) => decodeStatus(path, VScopeMessageType.GetStatus, payload)),
    catchDecode(path, VScopeMessageType.GetStatus),
  );

const getFrame = (
  path: string,
  client: VScopeClient,
  info: VScopeDeviceInfo,
  littleEndian: boolean,
): Effect.Effect<Float32Array, VScopeDeviceError> =>
  client.request(VScopeMessageType.GetFrame, VScopeMessageType.GetFrame).pipe(
    Effect.map((payload) =>
      decodeFloatArray(path, VScopeMessageType.GetFrame, payload, info.channelCount, littleEndian),
    ),
    catchDecode(path, VScopeMessageType.GetFrame),
  );

const getSnapshotHeader = (
  path: string,
  client: VScopeClient,
  info: VScopeDeviceInfo,
  littleEndian: boolean,
): Effect.Effect<VScopeSnapshotHeader, VScopeDeviceError> =>
  client.request(VScopeMessageType.GetSnapshotHeader, VScopeMessageType.GetSnapshotHeader).pipe(
    Effect.map((payload) => {
      const expectedLength = info.channelCount + 14 + info.rtCount * 4;
      expectLength(path, VScopeMessageType.GetSnapshotHeader, payload, expectedLength);
      const view = dataView(payload);
      const offset = info.channelCount;
      return {
        channelMap: Array.from(payload.subarray(0, info.channelCount)),
        divider: readU32(view, offset, littleEndian),
        preTrig: readU32(view, offset + 4, littleEndian),
        trigger: {
          threshold: readF32(view, offset + 8, littleEndian),
          channel: payload[offset + 12],
          mode: decodeTriggerMode(path, VScopeMessageType.GetSnapshotHeader, payload[offset + 13]),
        },
        rtValues: Array.from(
          decodeFloatArray(
            path,
            VScopeMessageType.GetSnapshotHeader,
            payload.subarray(offset + 14),
            info.rtCount,
            littleEndian,
          ),
        ),
        channelCount: info.channelCount,
        sampleCount: info.bufferSize,
        byteLength: info.bufferSize * info.channelCount * Float32Array.BYTES_PER_ELEMENT,
      };
    }),
    catchDecode(path, VScopeMessageType.GetSnapshotHeader),
  );

const getSnapshotData = (
  path: string,
  client: VScopeClient,
  options: {
    readonly startSample: number;
    readonly count: number;
    readonly channelCount: number;
    readonly littleEndian: boolean;
  },
): Effect.Effect<Uint8Array, VScopeDeviceError> =>
  validateSnapshotRequest(path, options.channelCount, options.startSample, options.count).pipe(
    Effect.andThen(
      Effect.sync(() => {
        const request = new Uint8Array(3);
        writeU16(request, 0, options.startSample, options.littleEndian);
        request[2] = options.count;
        return request;
      }),
    ),
    Effect.flatMap((payload) =>
      client.request(VScopeMessageType.GetSnapshotData, VScopeMessageType.GetSnapshotData, payload),
    ),
    Effect.map((payload) => {
      const expectedLength = options.count * options.channelCount * Float32Array.BYTES_PER_ELEMENT;
      expectLength(path, VScopeMessageType.GetSnapshotData, payload, expectedLength);
      return normalizeF32Bytes(payload, options.littleEndian);
    }),
    catchDecode(path, VScopeMessageType.GetSnapshotData),
  );

const getNames = (
  path: string,
  client: VScopeClient,
  options: {
    readonly requestType:
      | typeof VScopeMessageType.GetVarList
      | typeof VScopeMessageType.GetRtLabels;
    readonly expectedTotal: number;
    readonly nameLength: number;
  },
): Effect.Effect<ReadonlyArray<string>, VScopeDeviceError> => {
  const readPage = (
    start: number,
    names: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyArray<string>, VScopeDeviceError> =>
    client.request(options.requestType, options.requestType, Uint8Array.of(start, 0xff)).pipe(
      Effect.flatMap((payload) => {
        if (payload.byteLength < 3) {
          return Effect.fail(
            new VScopeDecodeError({
              path,
              messageType: options.requestType,
              reason: `Expected at least 3 bytes, got ${payload.byteLength}`,
            }),
          );
        }

        const total = payload[0];
        const pageStart = payload[1];
        const count = payload[2];
        const expectedLength = 3 + count * options.nameLength;
        if (payload.byteLength !== expectedLength) {
          return Effect.fail(
            new VScopeDecodeError({
              path,
              messageType: options.requestType,
              reason: `Expected ${expectedLength} bytes, got ${payload.byteLength}`,
            }),
          );
        }

        const pageNames = Array.from({ length: count }, (_, index) => {
          const offset = 3 + index * options.nameLength;
          return fixedString(payload.subarray(offset, offset + options.nameLength));
        });
        const nextNames = [...names, ...pageNames];

        if (count === 0 || nextNames.length >= total || nextNames.length >= options.expectedTotal) {
          return Effect.succeed(nextNames.slice(0, total));
        }

        return readPage(pageStart + count, nextNames);
      }),
    );

  return readPage(0, []);
};

const getChannelMap = (
  path: string,
  client: VScopeClient,
  info: VScopeDeviceInfo,
): Effect.Effect<ReadonlyArray<number>, VScopeDeviceError> =>
  client.request(VScopeMessageType.GetChannelMap, VScopeMessageType.GetChannelMap).pipe(
    Effect.map((payload) => {
      expectLength(path, VScopeMessageType.GetChannelMap, payload, info.channelCount);
      return Array.from(payload);
    }),
    catchDecode(path, VScopeMessageType.GetChannelMap),
  );

const getRtValue = (
  path: string,
  client: VScopeClient,
  info: VScopeDeviceInfo,
  littleEndian: boolean,
  index: number,
): Effect.Effect<number, VScopeDeviceError> =>
  validateRtIndex(path, info, index).pipe(
    Effect.andThen(
      client.request(
        VScopeMessageType.GetRtBuffer,
        VScopeMessageType.GetRtBuffer,
        Uint8Array.of(index),
      ),
    ),
    Effect.map((payload) =>
      decodeSingleF32(path, VScopeMessageType.GetRtBuffer, payload, littleEndian),
    ),
    catchDecode(path, VScopeMessageType.GetRtBuffer),
  );

const setRtValue = (
  path: string,
  client: VScopeClient,
  info: VScopeDeviceInfo,
  littleEndian: boolean,
  index: number,
  value: number,
): Effect.Effect<number, VScopeDeviceError> =>
  validateRtIndex(path, info, index).pipe(
    Effect.andThen(
      Effect.sync(() => {
        const payload = new Uint8Array(5);
        payload[0] = index;
        writeF32(payload, 1, value, littleEndian);
        return payload;
      }),
    ),
    Effect.flatMap((payload) =>
      client.request(VScopeMessageType.SetRtBuffer, VScopeMessageType.SetRtBuffer, payload),
    ),
    Effect.map((payload) =>
      decodeSingleF32(path, VScopeMessageType.SetRtBuffer, payload, littleEndian),
    ),
    catchDecode(path, VScopeMessageType.SetRtBuffer),
  );

const getTrigger = (
  path: string,
  client: VScopeClient,
  littleEndian: boolean,
): Effect.Effect<VScopeTrigger, VScopeDeviceError> =>
  client.request(VScopeMessageType.GetTrigger, VScopeMessageType.GetTrigger).pipe(
    Effect.map((payload) =>
      decodeTrigger(path, VScopeMessageType.GetTrigger, payload, littleEndian),
    ),
    catchDecode(path, VScopeMessageType.GetTrigger),
  );

const setTrigger = (
  path: string,
  client: VScopeClient,
  info: VScopeDeviceInfo,
  littleEndian: boolean,
  trigger: VScopeTrigger,
): Effect.Effect<VScopeTrigger, VScopeDeviceError> =>
  Effect.gen(function* () {
    const mode = yield* validateTrigger(path, info, trigger);
    const payload = new Uint8Array(6);
    writeF32(payload, 0, trigger.threshold, littleEndian);
    payload[4] = trigger.channel;
    payload[5] = mode;
    const response = yield* client.request(
      VScopeMessageType.SetTrigger,
      VScopeMessageType.SetTrigger,
      payload,
    );
    return decodeTrigger(path, VScopeMessageType.SetTrigger, response, littleEndian);
  }).pipe(catchDecode(path, VScopeMessageType.SetTrigger));

const pollStatus = (
  path: string,
  getStatusEffect: Effect.Effect<VScopeControlStatus, VScopeDeviceError>,
  target: VScopeStateValue,
  options: StateWaitOptions = {},
): Effect.Effect<VScopeControlStatus, VScopeDeviceError> => {
  const timeoutMillis = options.timeoutMillis ?? 2000;
  const pollIntervalMillis = options.pollIntervalMillis ?? 20;

  const loop: Effect.Effect<VScopeControlStatus, VScopeDeviceError> = Effect.gen(function* () {
    const status = yield* getStatusEffect;
    if (status.state === target) {
      return status;
    }

    yield* Effect.sleep(`${pollIntervalMillis} millis`);
    return yield* loop;
  });

  return loop.pipe(
    Effect.timeoutOrElse({
      duration: `${timeoutMillis} millis`,
      orElse: () =>
        Effect.fail(
          new VScopeResponseTimeoutError({
            path,
            requestType: VScopeMessageType.GetStatus,
            timeoutMillis,
          }),
        ),
    }),
  );
};

const decodeStatus = (
  path: string,
  messageType: VScopeMessageType,
  payload: Uint8Array,
): VScopeControlStatus => {
  expectLength(path, messageType, payload, 3);
  const state = payload[0];
  const requestedState = payload[1];
  const flags = payload[2];
  if (state > VScopeState.Misconfigured) {
    throw new VScopeDecodeError({
      path,
      messageType,
      reason: `Unknown state ${state}`,
    });
  }
  if (requestedState > VScopeState.Acquiring) {
    throw new VScopeDecodeError({
      path,
      messageType,
      reason: `Unknown requested state ${requestedState}`,
    });
  }
  return {
    state: state as VScopeStateValue,
    requestedState: requestedState as VScopeStateValue,
    snapshotValid: (flags & VScopeStatusFlag.SnapshotValid) !== 0,
    requestPending: (flags & VScopeStatusFlag.RequestPending) !== 0,
    triggerEnabled: (flags & VScopeStatusFlag.TriggerEnabled) !== 0,
    flags,
  };
};

const decodeSetChannelMap = (
  path: string,
  payload: Uint8Array,
): Effect.Effect<readonly [number, number], VScopeDecodeError> =>
  Effect.sync(() => {
    expectLength(path, VScopeMessageType.SetChannelMap, payload, 2);
    return [payload[0], payload[1]] as const;
  }).pipe(catchDecode(path, VScopeMessageType.SetChannelMap));

const decodeTrigger = (
  path: string,
  messageType: VScopeMessageType,
  payload: Uint8Array,
  littleEndian: boolean,
): VScopeTrigger => {
  expectLength(path, messageType, payload, 6);
  const view = dataView(payload);
  return {
    threshold: readF32(view, 0, littleEndian),
    channel: payload[4],
    mode: decodeTriggerMode(path, messageType, payload[5]),
  };
};

function encodeTriggerMode(mode: TriggerMode): VScopeWireTriggerMode | null {
  switch (mode) {
    case "disabled":
      return VScopeTriggerMode.Disabled;
    case "rising":
      return VScopeTriggerMode.Rising;
    case "falling":
      return VScopeTriggerMode.Falling;
    case "both":
      return VScopeTriggerMode.Both;
    default:
      return null;
  }
}

function decodeTriggerMode(
  path: string,
  messageType: VScopeMessageType,
  mode: number,
): TriggerMode {
  switch (mode) {
    case VScopeTriggerMode.Disabled:
      return "disabled";
    case VScopeTriggerMode.Rising:
      return "rising";
    case VScopeTriggerMode.Falling:
      return "falling";
    case VScopeTriggerMode.Both:
      return "both";
    default:
      throw new VScopeDecodeError({
        path,
        messageType,
        reason: `Invalid trigger mode ${mode}`,
      });
  }
}

const decodeFirmwareError = (
  path: string,
  requestType: VScopeMessageType,
  payload: Uint8Array,
): VScopeFirmwareError => {
  const status = payload[0] as VScopeStatusValue | undefined;
  return new VScopeFirmwareError({
    path,
    requestType,
    status: status ?? VScopeStatus.BadParam,
    statusName: statusName(status),
  });
};

const decodeSingleF32 = (
  path: string,
  messageType: VScopeMessageType,
  payload: Uint8Array,
  littleEndian: boolean,
): number => {
  expectLength(path, messageType, payload, 4);
  return readF32(dataView(payload), 0, littleEndian);
};

const decodeFloatArray = (
  path: string,
  messageType: VScopeMessageType,
  payload: Uint8Array,
  count: number,
  littleEndian: boolean,
): Float32Array => {
  expectLength(path, messageType, payload, count * Float32Array.BYTES_PER_ELEMENT);
  const view = dataView(payload);
  const output = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    output[index] = readF32(view, index * Float32Array.BYTES_PER_ELEMENT, littleEndian);
  }
  return output;
};

const normalizeF32Bytes = (payload: Uint8Array, littleEndian: boolean): Uint8Array => {
  if (littleEndian) {
    return Uint8Array.from(payload);
  }

  const output = new Uint8Array(payload.byteLength);
  const input = dataView(payload);
  const outputView = dataView(output);
  const count = payload.byteLength / Float32Array.BYTES_PER_ELEMENT;

  for (let index = 0; index < count; index += 1) {
    outputView.setFloat32(
      index * Float32Array.BYTES_PER_ELEMENT,
      input.getFloat32(index * Float32Array.BYTES_PER_ELEMENT, false),
      true,
    );
  }

  return output;
};

const validateTiming = (
  path: string,
  info: VScopeDeviceInfo,
  timing: VScopeTiming,
): Effect.Effect<void, VScopeInvalidArgumentError> => {
  if (!Number.isInteger(timing.divider) || timing.divider <= 0 || timing.divider > UINT32_MAX) {
    return invalid(path, "setTiming", "divider must be a positive uint32");
  }
  if (
    !Number.isInteger(timing.preTrig) ||
    timing.preTrig < 0 ||
    timing.preTrig > info.bufferSize ||
    timing.preTrig > UINT32_MAX
  ) {
    return invalid(path, "setTiming", `preTrig must be between 0 and ${info.bufferSize}`);
  }
  return Effect.void;
};

const validateState = (
  path: string,
  state: VScopeStateValue,
): Effect.Effect<void, VScopeInvalidArgumentError> =>
  !Number.isInteger(state) || state < VScopeState.Halted || state > VScopeState.Acquiring
    ? invalid(path, "setState", "state must be Halted, Running, or Acquiring")
    : Effect.void;

const validateChannelMap = (
  path: string,
  info: VScopeDeviceInfo,
  channel: number,
  variable: number,
): Effect.Effect<void, VScopeInvalidArgumentError> => {
  if (!Number.isInteger(channel) || channel < 0 || channel >= info.channelCount) {
    return invalid(path, "setChannelMap", `channel must be between 0 and ${info.channelCount - 1}`);
  }
  if (!Number.isInteger(variable) || variable < 0 || variable >= info.variableCount) {
    return invalid(
      path,
      "setChannelMap",
      `variable must be between 0 and ${info.variableCount - 1}`,
    );
  }
  return Effect.void;
};

const validateRtIndex = (
  path: string,
  info: VScopeDeviceInfo,
  index: number,
): Effect.Effect<void, VScopeInvalidArgumentError> =>
  Number.isInteger(index) && index >= 0 && index < info.rtCount
    ? Effect.void
    : invalid(path, "rtBuffer", `index must be between 0 and ${info.rtCount - 1}`);

const validateTrigger = (
  path: string,
  info: VScopeDeviceInfo,
  trigger: VScopeTrigger,
): Effect.Effect<VScopeWireTriggerMode, VScopeInvalidArgumentError> => {
  if (!Number.isFinite(trigger.threshold)) {
    return invalid(path, "setTrigger", "threshold must be finite");
  }
  if (
    !Number.isInteger(trigger.channel) ||
    trigger.channel < 0 ||
    trigger.channel >= info.channelCount
  ) {
    return invalid(path, "setTrigger", `channel must be between 0 and ${info.channelCount - 1}`);
  }
  const mode = encodeTriggerMode(trigger.mode);
  if (mode === null) {
    return invalid(path, "setTrigger", "mode must be disabled, rising, falling, or both");
  }
  return Effect.succeed(mode);
};

const validateSnapshotRequest = (
  path: string,
  channelCount: number,
  startSample: number,
  count: number,
): Effect.Effect<void, VScopeInvalidArgumentError> => {
  const maxSamples = snapshotChunkSamples(channelCount);
  if (!Number.isInteger(startSample) || startSample < 0) {
    return invalid(path, "getSnapshotData", "startSample must be a non-negative integer");
  }
  if (!Number.isInteger(count) || count <= 0 || count > maxSamples) {
    return invalid(path, "getSnapshotData", `count must be between 1 and ${maxSamples}`);
  }
  return Effect.void;
};

const snapshotChunkSamples = (channelCount: number, requested?: number): number => {
  const max = Math.floor(VSCOPE_MAX_PAYLOAD / (channelCount * Float32Array.BYTES_PER_ELEMENT));
  return requested === undefined ? max : Math.min(Math.max(1, Math.floor(requested)), max);
};

const invalid = (
  path: string,
  operation: string,
  reason: string,
): Effect.Effect<never, VScopeInvalidArgumentError> =>
  Effect.fail(new VScopeInvalidArgumentError({ path, operation, reason }));

const expectLength = (
  path: string,
  messageType: VScopeMessageType,
  payload: Uint8Array,
  expected: number,
): void => {
  if (payload.byteLength !== expected) {
    throw new VScopeDecodeError({
      path,
      messageType,
      reason: `Expected ${expected} bytes, got ${payload.byteLength}`,
    });
  }
};

const catchDecode =
  (path: string, messageType: VScopeMessageType) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catchDefect((defect) =>
        defect instanceof VScopeDecodeError
          ? Effect.fail(defect)
          : Effect.fail(
              new VScopeDecodeError({
                path,
                messageType,
                reason: String(defect),
              }),
            ),
      ),
    );

const concatBytes = (chunks: Iterable<Uint8Array>): Uint8Array => {
  const chunkArray = Array.from(chunks);
  const byteLength = chunkArray.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(byteLength);
  let offset = 0;

  for (const chunk of chunkArray) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return output;
};

const dataView = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const statusName = (status: VScopeStatusValue | undefined): string => {
  switch (status) {
    case VScopeStatus.BadLen:
      return "BAD_LEN";
    case VScopeStatus.BadParam:
      return "BAD_PARAM";
    case VScopeStatus.Range:
      return "RANGE";
    case VScopeStatus.NotReady:
      return "NOT_READY";
    default:
      return "UNKNOWN";
  }
};

const sessionCloseReason = (error: VScopeDeviceError): string => {
  switch (error._tag) {
    case "VScopeResponseTimeoutError":
      return `request ${error.requestType} timed out after ${error.timeoutMillis}ms`;
    case "VScopeTransportError":
      return `transport ${error.cause._tag}`;
    default:
      return error._tag;
  }
};
