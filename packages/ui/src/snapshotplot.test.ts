import { expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";

import { loadSnapshotSamples } from "./snapshotplot.ts";

it.effect("aborts an interrupted snapshot download", () =>
  Effect.gen(function* () {
    const requestStarted = Promise.withResolvers<AbortSignal>();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (_input, init) => {
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) {
        return Promise.reject(new Error("Snapshot request did not provide an AbortSignal"));
      }
      requestStarted.resolve(signal);
      return new Promise<Response>(() => {});
    };
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        globalThis.fetch = originalFetch;
      }),
    );

    const fiber = yield* loadSnapshotSamples({
      id: "snapshot:test",
      durationSeconds: 1,
      sampleRateHz: null,
    }).pipe(Effect.forkChild);
    const signal = yield* Effect.promise(() => requestStarted.promise);

    yield* Fiber.interrupt(fiber);

    expect(signal.aborted).toBe(true);
  }),
);
