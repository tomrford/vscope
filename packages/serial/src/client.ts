import { Cause, Deferred, Effect, Exit, Queue, Ref, Schedule } from "effect";

import {
  type VScopeDeviceError,
  VScopeFirmwareError,
  VScopeResponseTimeoutError,
  VScopeSessionClosedError,
  VScopeTransportError,
  VScopeUnexpectedResponseError,
} from "./errors";
import {
  ByteReader,
  VScopeFrameParseError,
  type VScopeFrameParseEvent,
  VScopeFrameParser,
  VScopeMessageType,
  VScopeStatus,
  type VScopeStatus as VScopeStatusValue,
  encodeVScopeFrame,
} from "./protocol";
import { SerialConnectionClosedError, type SerialTransport } from "./transport";
import type { VScopeRequestOptions } from "./types";

export interface VScopeClient {
  readonly request: (
    requestType: VScopeMessageType,
    responseType: VScopeMessageType,
    payload?: Uint8Array,
    options?: VScopeRequestOptions,
  ) => Effect.Effect<Uint8Array, VScopeDeviceError>;
  readonly closed: Effect.Effect<void, VScopeDeviceError>;
  readonly close: <E>(closeTransport: Effect.Effect<void, E>) => Effect.Effect<void, E>;
}

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

export const makeVScopeClient = Effect.fn("VScopeClient.make")(function* (
  transport: SerialTransport,
  options: {
    readonly requestTimeoutMillis: number;
    readonly retryAttempts?: number | undefined;
  },
) {
  const events = yield* Queue.unbounded<VScopeFrameParseEvent, VScopeDeviceError | Cause.Done>();
  // Admission is explicitly FIFO: a cyclic poll queued during one snapshot
  // page runs before the snapshot stream can enqueue its following page.
  const requests = yield* Queue.unbounded<Effect.Effect<void>>();
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

  const dispatch = <A, E>(operation: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    Effect.gen(function* () {
      const result = yield* Deferred.make<A, E>();
      const run = Deferred.isDone(result).pipe(
        Effect.flatMap((done) =>
          done
            ? Effect.void
            : operation.pipe(
                Effect.exit,
                Effect.flatMap((exit) => Deferred.done(result, exit)),
                Effect.asVoid,
              ),
        ),
      );

      yield* Queue.offer(requests, run);
      return yield* Deferred.await(result).pipe(
        Effect.onInterrupt(() => Deferred.interrupt(result).pipe(Effect.asVoid)),
      );
    });

  yield* Effect.forever(Queue.take(requests).pipe(Effect.flatten)).pipe(Effect.forkScoped);

  const dispatchClose = <E>(closeTransport: Effect.Effect<void, E>): Effect.Effect<void, E> =>
    dispatch(
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
    );

  const close = <E>(closeTransport: Effect.Effect<void, E>): Effect.Effect<void, E> =>
    Effect.uninterruptible(
      Ref.get(closedState).pipe(
        Effect.flatMap((state) =>
          state._tag === "Closed" ? closeTransport : dispatchClose(closeTransport),
        ),
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
  ) => {
    const operation = Effect.gen(function* () {
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
    });

    return ensureOpen(requestType).pipe(Effect.andThen(dispatch(operation)));
  };

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
