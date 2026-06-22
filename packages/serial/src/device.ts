import { Cause, Deferred, Effect, Exit, Queue, Ref, Schedule, Semaphore, Stream } from "effect";
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
  ByteReader,
  ByteWriter,
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
  encodeVScopeFrame,
} from "./protocol";
import {
  SerialConnectionClosedError,
  openSerialTransport,
  type SerialTransport,
} from "./transport";
import type {
  OpenVScopeDeviceOptions,
  SnapshotBytesOptions,
  VScopeControlStatus,
  VScopeDevice,
  VScopeDeviceInfo,
  VScopeRequestOptions,
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
    options?: VScopeRequestOptions,
  ) => Effect.Effect<Uint8Array, VScopeDeviceError>;
  readonly closed: Effect.Effect<void, VScopeDeviceError>;
  readonly close: <E>(closeTransport: Effect.Effect<void, E>) => Effect.Effect<void, E>;
}

// Binary codec bound to the device's one endianness (the reference byte GetInfo
// reports). Every per-message read/write goes through it, so endianness is
// resolved once at connect rather than threaded as a boolean everywhere.
interface Codec {
  reader(bytes: Uint8Array): ByteReader;
  writer(length: number): ByteWriter;
}

const makeCodec = (littleEndian: boolean): Codec => ({
  reader: (bytes) => new ByteReader(bytes, littleEndian),
  writer: (length) => new ByteWriter(length, littleEndian),
});

// Runs a synchronous payload decoder, mapping any throw (cursor overrun or an
// enum-validation Error) onto a typed VScopeDecodeError carrying message context.
const decoding = <A>(
  path: string,
  messageType: VScopeMessageType,
  decode: () => A,
): Effect.Effect<A, VScopeDecodeError> =>
  Effect.try({
    try: decode,
    catch: (cause) =>
      cause instanceof VScopeDecodeError
        ? cause
        : new VScopeDecodeError({
            path,
            messageType,
            reason: cause instanceof Error ? cause.message : String(cause),
          }),
  });

// Reads a fixed-shape payload and asserts it was fully consumed.
const readPayload = <A>(
  codec: Codec,
  path: string,
  messageType: VScopeMessageType,
  payload: Uint8Array,
  read: (reader: ByteReader) => A,
): Effect.Effect<A, VScopeDecodeError> =>
  decoding(path, messageType, () => {
    const reader = codec.reader(payload);
    const value = read(reader);
    reader.end();
    return value;
  });

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

export const openVScopeDevice = Effect.fn("VScope.openDevice")(function* (
  options: OpenVScopeDeviceOptions,
) {
  const transport = yield* openSerialTransport(options);
  const client = yield* makeVScopeClient(transport, {
    requestTimeoutMillis: options.requestTimeoutMillis,
    retryAttempts: options.retryAttempts,
  });
  yield* Effect.addFinalizer(() => client.close(transport.close).pipe(Effect.ignore));
  const info = yield* getInfo(transport.path, client);
  const codec = makeCodec(info.endianness === VScopeEndianness.Little);
  const status = yield* getStatus(transport.path, client, codec);
  const state = status.state;
  const variables = yield* getNames(transport.path, client, codec, {
    requestType: VScopeMessageType.GetVarList,
    expectedTotal: info.variableCount,
    nameLength: info.nameLength,
  });
  const rtLabels =
    state === VScopeState.Misconfigured
      ? []
      : yield* getNames(transport.path, client, codec, {
          requestType: VScopeMessageType.GetRtLabels,
          expectedTotal: info.rtCount,
          nameLength: info.nameLength,
        });
  const channelMap =
    state === VScopeState.Misconfigured
      ? []
      : yield* getChannelMap(transport.path, client, codec, info);
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
    codec,
    metadataRef,
  });
});

const makeVScopeClient = Effect.fn("VScopeClient.make")(function* (
  transport: SerialTransport,
  options: {
    readonly requestTimeoutMillis: number;
    readonly retryAttempts?: number | undefined;
  },
) {
  const events = yield* Queue.unbounded<VScopeFrameParseEvent, VScopeDeviceError | Cause.Done>();
  const requestLock = yield* Semaphore.make(1);
  const closed = yield* Deferred.make<void, VScopeDeviceError>();
  const closedState = yield* Ref.make<ClientClosedState>({ _tag: "Open" });
  const parser = new VScopeFrameParser();
  // One blanket timeout governs every request: without sequence IDs a late
  // reply poisons the next exchange, so all messages share the same deadline.
  const timeoutMillis = options.requestTimeoutMillis;
  const defaultRetryAttempts = options.retryAttempts ?? 2;

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
        ? Queue.end(events).pipe(Effect.andThen(Deferred.succeed(closed, undefined)), Effect.asVoid)
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
    requestOptions = {},
  ) =>
    requestLock.withPermit(
      Effect.gen(function* () {
        yield* ensureOpen(requestType);
        const encoded = yield* encodeVScopeFrame({ type: requestType, payload });
        const retryAttempts = requestOptions.retryAttempts ?? defaultRetryAttempts;

        // One write/drain/read exchange. A response timeout is fatal: without
        // sequence IDs a late reply would poison the next request, so we tear
        // the session down rather than recover.
        const exchange = Effect.gen(function* () {
          yield* transport
            .write(encoded)
            .pipe(
              Effect.mapError((cause) => new VScopeTransportError({ path: transport.path, cause })),
            );
          yield* transport.drain.pipe(
            Effect.mapError((cause) => new VScopeTransportError({ path: transport.path, cause })),
          );

          return yield* takeResponse(transport.path, events, requestType, responseType);
        }).pipe(
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
        );

        // A CRC-corrupted response is a complete frame fully consumed by the
        // parser, so the queue stays aligned and re-sending the same request is
        // safe. Only those failures retry; everything else fails through.
        return yield* exchange.pipe(
          Effect.retry({
            schedule: Schedule.recurs(retryAttempts),
            while: (error) => error instanceof VScopeFrameParseError,
          }),
        );
      }),
    );

  return {
    request,
    closed: Deferred.await(closed),
    close,
  };
});

const takeResponse = Effect.fn("VScopeClient.takeResponse")(function* (
  path: string,
  events: Queue.Dequeue<VScopeFrameParseEvent, VScopeDeviceError | Cause.Done>,
  requestType: VScopeMessageType,
  responseType: VScopeMessageType,
) {
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
  readonly codec: Codec;
  readonly metadataRef: Ref.Ref<VScopeStaticMetadata>;
}

const makeDevice = (parts: DeviceParts): VScopeDevice => {
  const { transport, client, info, codec, metadataRef } = parts;
  const path = transport.path;

  const getTimingEffect = getTiming(path, client, codec, info);
  const getStatusEffect = getStatus(path, client, codec);
  const getStateEffect = getStatusEffect.pipe(Effect.map((status) => status.state));
  const getSnapshotHeaderEffect = getSnapshotHeader(path, client, codec, info);
  const getVariableCatalogEffect = getNames(path, client, codec, {
    requestType: VScopeMessageType.GetVarList,
    expectedTotal: info.variableCount,
    nameLength: info.nameLength,
  });
  const getRtLabelsEffect = getNames(path, client, codec, {
    requestType: VScopeMessageType.GetRtLabels,
    expectedTotal: info.rtCount,
    nameLength: info.nameLength,
  });
  const getChannelMapEffect = getChannelMap(path, client, codec, info);

  const setState = Effect.fn("VScope.setState")(function* (state: VScopeStateValue) {
    yield* validateState(path, state);
    const payload = yield* client.request(
      VScopeMessageType.SetState,
      VScopeMessageType.SetState,
      Uint8Array.of(state),
    );
    return yield* readPayload(codec, path, VScopeMessageType.SetState, payload, decodeStatus);
  });

  const setChannelMap = Effect.fn("VScope.setChannelMap")(function* (
    channel: number,
    variable: number,
  ) {
    yield* validateChannelMap(path, info, channel, variable);
    const payload = yield* client.request(
      VScopeMessageType.SetChannelMap,
      VScopeMessageType.SetChannelMap,
      Uint8Array.of(channel, variable),
    );
    const [updatedChannel, updatedVariable] = yield* readPayload(
      codec,
      path,
      VScopeMessageType.SetChannelMap,
      payload,
      (reader) => {
        const updatedChannel = reader.u8();
        const updatedVariable = reader.u8();
        const result: readonly [number, number] = [updatedChannel, updatedVariable];
        return result;
      },
    );
    return yield* Ref.updateAndGet(metadataRef, (current) => {
      const nextMap =
        current.channelMap.length === info.channelCount
          ? [...current.channelMap]
          : Array.from({ length: info.channelCount }, () => 0);
      nextMap[updatedChannel] = updatedVariable;
      return { ...current, channelMap: nextMap };
    }).pipe(Effect.map((metadata) => metadata.channelMap));
  });

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

          return getSnapshotData(path, client, codec, {
            startSample,
            count,
            channelCount: header.channelCount,
          }).pipe(
            Effect.map((bytes): readonly [Uint8Array, number] => [bytes, startSample + count]),
          );
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
    setTiming: (timing) => setTiming(path, client, codec, info, timing),
    getStatus: (options) => getStatus(path, client, codec, options),
    getState: getStateEffect,
    start: setState(VScopeState.Running),
    stop: setState(VScopeState.Halted),
    trigger: setState(VScopeState.Acquiring).pipe(Effect.map(markAcquisitionRequested)),
    getFrame: (options) => getFrame(path, client, codec, info, options),
    getSnapshotHeader: getSnapshotHeaderEffect,
    snapshotBytes,
    collectSnapshotBytes,
    getVariableCatalog: getVariableCatalogEffect,
    getChannelMap: getChannelMapEffect,
    setChannelMap,
    getRtLabels: getRtLabelsEffect,
    getRtValue: (index) => getRtValue(path, client, codec, info, index),
    setRtValue: (index, value) => setRtValue(path, client, codec, info, index, value),
    getTrigger: getTrigger(path, client, codec),
    setTrigger: (trigger) => setTrigger(path, client, codec, info, trigger),
    closed: client.closed,
    close: client.close(transport.close),
  };
};

const getInfo = Effect.fn("VScope.getInfo")(function* (path: string, client: VScopeClient) {
  const payload = yield* client.request(VScopeMessageType.GetInfo, VScopeMessageType.GetInfo);
  return yield* decoding(path, VScopeMessageType.GetInfo, () => {
    // GetInfo is self-describing: its endianness byte (offset 9) governs the
    // multi-byte fields that precede it, so peek it before sequential reads.
    const littleEndian = new ByteReader(payload, true).peekU8(9) !== VScopeEndianness.Big;
    const reader = new ByteReader(payload, littleEndian);
    const channelCount = reader.u8();
    const bufferSize = reader.u16();
    const isrKHz = reader.u16();
    const variableCount = reader.u8();
    const rtCount = reader.u8();
    const rtBufferCapacity = reader.u8();
    const nameLength = reader.u8();
    reader.skip(1); // endianness byte, already resolved via peek
    const deviceName = reader.fixedString(16);
    reader.end();

    return {
      channelCount,
      bufferSize,
      isrKHz,
      variableCount,
      rtCount,
      rtBufferCapacity,
      nameLength,
      endianness: littleEndian ? VScopeEndianness.Little : VScopeEndianness.Big,
      deviceName,
    };
  });
});

const getTiming = Effect.fn("VScope.getTiming")(function* (
  path: string,
  client: VScopeClient,
  codec: Codec,
  info: VScopeDeviceInfo,
) {
  const payload = yield* client.request(VScopeMessageType.GetTiming, VScopeMessageType.GetTiming);
  return yield* readPayload(codec, path, VScopeMessageType.GetTiming, payload, (reader) =>
    decodeTimingResponse(reader, info),
  );
});

const setTiming = Effect.fn("VScope.setTiming")(function* (
  path: string,
  client: VScopeClient,
  codec: Codec,
  info: VScopeDeviceInfo,
  timing: VScopeTiming,
) {
  yield* validateTiming(path, info, timing);
  const firmwareTiming = encodeTiming(info, timing);
  const request = codec
    .writer(8)
    .u32(firmwareTiming.divider)
    .u32(firmwareTiming.preTrig)
    .toUint8Array();
  const payload = yield* client.request(
    VScopeMessageType.SetTiming,
    VScopeMessageType.SetTiming,
    request,
  );
  return yield* readPayload(codec, path, VScopeMessageType.SetTiming, payload, (reader) =>
    decodeTimingResponse(reader, info),
  );
});

const getStatus = Effect.fn("VScope.getStatus")(function* (
  path: string,
  client: VScopeClient,
  codec: Codec,
  options?: VScopeRequestOptions,
) {
  const payload = yield* client.request(
    VScopeMessageType.GetStatus,
    VScopeMessageType.GetStatus,
    undefined,
    options,
  );
  return yield* readPayload(codec, path, VScopeMessageType.GetStatus, payload, decodeStatus);
});

const getFrame = Effect.fn("VScope.getFrame")(function* (
  path: string,
  client: VScopeClient,
  codec: Codec,
  info: VScopeDeviceInfo,
  options?: VScopeRequestOptions,
) {
  const payload = yield* client.request(
    VScopeMessageType.GetFrame,
    VScopeMessageType.GetFrame,
    undefined,
    options,
  );
  return yield* readPayload(codec, path, VScopeMessageType.GetFrame, payload, (reader) =>
    Array.from(reader.f32Array(info.channelCount)),
  );
});

const getSnapshotHeader = Effect.fn("VScope.getSnapshotHeader")(function* (
  path: string,
  client: VScopeClient,
  codec: Codec,
  info: VScopeDeviceInfo,
) {
  const payload = yield* client.request(
    VScopeMessageType.GetSnapshotHeader,
    VScopeMessageType.GetSnapshotHeader,
  );
  return yield* readPayload(codec, path, VScopeMessageType.GetSnapshotHeader, payload, (reader) =>
    decodeSnapshotHeader(reader, info),
  );
});

const getSnapshotData = Effect.fn("VScope.getSnapshotData")(function* (
  path: string,
  client: VScopeClient,
  codec: Codec,
  options: {
    readonly startSample: number;
    readonly count: number;
    readonly channelCount: number;
  },
) {
  yield* validateSnapshotRequest(path, options.channelCount, options.startSample, options.count);
  const request = codec.writer(3).u16(options.startSample).u8(options.count).toUint8Array();
  const payload = yield* client.request(
    VScopeMessageType.GetSnapshotData,
    VScopeMessageType.GetSnapshotData,
    request,
  );
  return yield* decoding(path, VScopeMessageType.GetSnapshotData, () => {
    const expectedLength = options.count * options.channelCount * Float32Array.BYTES_PER_ELEMENT;
    if (payload.byteLength !== expectedLength) {
      throw new VScopeDecodeError({
        path,
        messageType: VScopeMessageType.GetSnapshotData,
        reason: `Expected ${expectedLength} bytes, got ${payload.byteLength}`,
      });
    }
    return normalizeF32Bytes(codec, payload);
  });
});

const getNames = Effect.fn("VScope.getNames")(function* (
  path: string,
  client: VScopeClient,
  codec: Codec,
  options: {
    readonly requestType:
      | typeof VScopeMessageType.GetVarList
      | typeof VScopeMessageType.GetRtLabels;
    readonly expectedTotal: number;
    readonly nameLength: number;
  },
) {
  let start = 0;
  let names: ReadonlyArray<string> = [];

  while (true) {
    const payload = yield* client.request(
      options.requestType,
      options.requestType,
      Uint8Array.of(start, 0xff),
    );
    const page = yield* decoding(path, options.requestType, () => {
      const reader = codec.reader(payload);
      const total = reader.u8();
      const pageStart = reader.u8();
      const count = reader.u8();
      const pageNames = Array.from({ length: count }, () => reader.fixedString(options.nameLength));
      reader.end();
      return { total, pageStart, count, pageNames };
    });

    names = [...names, ...page.pageNames];
    if (page.count === 0 || names.length >= page.total || names.length >= options.expectedTotal) {
      return names.slice(0, page.total);
    }

    start = page.pageStart + page.count;
  }
});

const getChannelMap = Effect.fn("VScope.getChannelMap")(function* (
  path: string,
  client: VScopeClient,
  codec: Codec,
  info: VScopeDeviceInfo,
) {
  const payload = yield* client.request(
    VScopeMessageType.GetChannelMap,
    VScopeMessageType.GetChannelMap,
  );
  return yield* readPayload(codec, path, VScopeMessageType.GetChannelMap, payload, (reader) =>
    reader.u8Array(info.channelCount),
  );
});

const getRtValue = Effect.fn("VScope.getRtValue")(function* (
  path: string,
  client: VScopeClient,
  codec: Codec,
  info: VScopeDeviceInfo,
  index: number,
) {
  yield* validateRtIndex(path, info, index);
  const payload = yield* client.request(
    VScopeMessageType.GetRtBuffer,
    VScopeMessageType.GetRtBuffer,
    Uint8Array.of(index),
  );
  return yield* readPayload(codec, path, VScopeMessageType.GetRtBuffer, payload, (reader) =>
    reader.f32(),
  );
});

const setRtValue = Effect.fn("VScope.setRtValue")(function* (
  path: string,
  client: VScopeClient,
  codec: Codec,
  info: VScopeDeviceInfo,
  index: number,
  value: number,
) {
  yield* validateRtIndex(path, info, index);
  const request = codec.writer(5).u8(index).f32(value).toUint8Array();
  const payload = yield* client.request(
    VScopeMessageType.SetRtBuffer,
    VScopeMessageType.SetRtBuffer,
    request,
  );
  return yield* readPayload(codec, path, VScopeMessageType.SetRtBuffer, payload, (reader) =>
    reader.f32(),
  );
});

const getTrigger = Effect.fn("VScope.getTrigger")(function* (
  path: string,
  client: VScopeClient,
  codec: Codec,
) {
  const payload = yield* client.request(VScopeMessageType.GetTrigger, VScopeMessageType.GetTrigger);
  return yield* readPayload(codec, path, VScopeMessageType.GetTrigger, payload, decodeTrigger);
});

const setTrigger = Effect.fn("VScope.setTrigger")(function* (
  path: string,
  client: VScopeClient,
  codec: Codec,
  info: VScopeDeviceInfo,
  trigger: VScopeTrigger,
) {
  const mode = yield* validateTrigger(path, info, trigger);
  const request = codec
    .writer(6)
    .f32(trigger.threshold)
    .u8(trigger.channel)
    .u8(mode)
    .toUint8Array();
  const payload = yield* client.request(
    VScopeMessageType.SetTrigger,
    VScopeMessageType.SetTrigger,
    request,
  );
  return yield* readPayload(codec, path, VScopeMessageType.SetTrigger, payload, decodeTrigger);
});

const decodeStatus = (reader: ByteReader): VScopeControlStatus => {
  const state = decodeStateByte(reader.u8());
  const requestedState = decodeRequestedStateByte(reader.u8());
  const flags = reader.u8();
  return {
    state,
    requestedState,
    snapshotValid: (flags & VScopeStatusFlag.SnapshotValid) !== 0,
    requestPending: (flags & VScopeStatusFlag.RequestPending) !== 0,
    triggerEnabled: (flags & VScopeStatusFlag.TriggerEnabled) !== 0,
    flags,
  };
};

const decodeStateByte = (value: number): VScopeStateValue => {
  switch (value) {
    case VScopeState.Halted:
    case VScopeState.Running:
    case VScopeState.Acquiring:
    case VScopeState.Misconfigured:
      return value;
    default:
      throw new Error(`Unknown state ${value}`);
  }
};

const decodeRequestedStateByte = (value: number): VScopeStateValue => {
  switch (value) {
    case VScopeState.Halted:
    case VScopeState.Running:
    case VScopeState.Acquiring:
      return value;
    default:
      throw new Error(`Unknown requested state ${value}`);
  }
};

const markAcquisitionRequested = (status: VScopeControlStatus): VScopeControlStatus => ({
  ...status,
  state: VScopeState.Acquiring,
  requestedState: VScopeState.Acquiring,
  snapshotValid: false,
  requestPending: false,
  flags: status.triggerEnabled ? VScopeStatusFlag.TriggerEnabled : 0,
});

const decodeTrigger = (reader: ByteReader): VScopeTrigger => {
  const threshold = reader.f32();
  const channel = reader.u8();
  const mode = decodeTriggerMode(reader.u8());
  return { threshold, channel, mode };
};

const decodeSnapshotHeader = (reader: ByteReader, info: VScopeDeviceInfo): VScopeSnapshotHeader => {
  const channelMap = reader.u8Array(info.channelCount);
  const divider = reader.u32();
  const preTrig = reader.u32();
  const timing = decodeTiming(info, divider, preTrig);
  const threshold = reader.f32();
  const channel = reader.u8();
  const mode = decodeTriggerMode(reader.u8());
  const rtValues = Array.from(reader.f32Array(info.rtCount));
  return {
    channelMap,
    sampleRateHz: baseSampleRateHz(info) / divider,
    totalDurationSeconds: timing.totalDurationSeconds,
    preTriggerSeconds: timing.preTriggerSeconds,
    trigger: { threshold, channel, mode },
    rtValues,
    channelCount: info.channelCount,
    sampleCount: info.bufferSize,
    byteLength: info.bufferSize * info.channelCount * Float32Array.BYTES_PER_ELEMENT,
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

function decodeTriggerMode(mode: number): TriggerMode {
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
      throw new Error(`Invalid trigger mode ${mode}`);
  }
}

const decodeFirmwareError = (
  path: string,
  requestType: VScopeMessageType,
  payload: Uint8Array,
): VScopeFirmwareError => {
  const status = payload.byteLength >= 1 ? new ByteReader(payload, true).u8() : undefined;
  return new VScopeFirmwareError({
    path,
    requestType,
    status: decodeFirmwareStatus(status),
    statusName: statusName(status),
  });
};

const decodeFirmwareStatus = (value: number | undefined): VScopeStatusValue => {
  switch (value) {
    case VScopeStatus.BadLen:
    case VScopeStatus.BadParam:
    case VScopeStatus.Range:
    case VScopeStatus.NotReady:
      return value;
    default:
      return VScopeStatus.BadParam;
  }
};

const normalizeF32Bytes = (codec: Codec, payload: Uint8Array): Uint8Array => {
  const count = payload.byteLength / Float32Array.BYTES_PER_ELEMENT;
  const reader = codec.reader(payload);
  const writer = new ByteWriter(payload.byteLength, true);
  for (let index = 0; index < count; index += 1) {
    writer.f32(reader.f32());
  }
  return writer.toUint8Array();
};

const validateTiming = (
  path: string,
  info: VScopeDeviceInfo,
  timing: VScopeTiming,
): Effect.Effect<void, VScopeInvalidArgumentError> => {
  const sampleRateHz = baseSampleRateHz(info);
  if (!Number.isFinite(timing.totalDurationSeconds) || timing.totalDurationSeconds <= 0) {
    return invalid(path, "setTiming", "totalDurationSeconds must be a positive finite number");
  }

  const minimumDurationSeconds = info.bufferSize / sampleRateHz;
  const maximumDurationSeconds = (info.bufferSize * UINT32_MAX) / sampleRateHz;
  if (
    timing.totalDurationSeconds < minimumDurationSeconds ||
    timing.totalDurationSeconds > maximumDurationSeconds
  ) {
    return invalid(
      path,
      "setTiming",
      `totalDurationSeconds must be between ${minimumDurationSeconds} and ${maximumDurationSeconds}`,
    );
  }

  const firmwareTiming = encodeTiming(info, timing);
  if (firmwareTiming.divider <= 0 || firmwareTiming.divider > UINT32_MAX) {
    return invalid(
      path,
      "setTiming",
      "totalDurationSeconds maps outside the firmware divider range",
    );
  }

  const maximumPreTriggerSeconds = (info.bufferSize * firmwareTiming.divider) / sampleRateHz;
  if (!Number.isFinite(timing.preTriggerSeconds) || timing.preTriggerSeconds < 0) {
    return invalid(path, "setTiming", "preTriggerSeconds must be a non-negative finite number");
  }
  if (timing.preTriggerSeconds > maximumPreTriggerSeconds) {
    return invalid(
      path,
      "setTiming",
      `preTriggerSeconds must be between 0 and ${maximumPreTriggerSeconds}`,
    );
  }
  if (firmwareTiming.preTrig > info.bufferSize || firmwareTiming.preTrig > UINT32_MAX) {
    return invalid(path, "setTiming", `preTriggerSeconds maps above ${info.bufferSize} samples`);
  }

  return Effect.void;
};

const baseSampleRateHz = (info: VScopeDeviceInfo): number => info.isrKHz * 1000;

const decodeTiming = (info: VScopeDeviceInfo, divider: number, preTrig: number): VScopeTiming => {
  const sampleRateHz = baseSampleRateHz(info);
  return {
    totalDurationSeconds: (info.bufferSize * divider) / sampleRateHz,
    preTriggerSeconds: (preTrig * divider) / sampleRateHz,
  };
};

const decodeTimingResponse = (reader: ByteReader, info: VScopeDeviceInfo): VScopeTiming => {
  const divider = reader.u32();
  const preTrig = reader.u32();
  return decodeTiming(info, divider, preTrig);
};

const encodeTiming = (
  info: VScopeDeviceInfo,
  timing: VScopeTiming,
): { readonly divider: number; readonly preTrig: number } => {
  const sampleRateHz = baseSampleRateHz(info);
  const totalSamples = Math.round(timing.totalDurationSeconds * sampleRateHz);
  const divider = Math.round(totalSamples / info.bufferSize);
  return {
    divider,
    preTrig: Math.round((timing.preTriggerSeconds * sampleRateHz) / divider),
  };
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

const statusName = (status: number | undefined): string => {
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
