import { expect, it } from "@effect/vitest";
import { PersistentId, SnapshotRecord, Timestamp } from "@vscope/shared";
import { Effect, Fiber } from "effect";

import { loadSnapshotSamples, partitionByCompatibility } from "./snapshotplot.ts";

const record = (id: string, totalDurationSeconds: number) =>
  SnapshotRecord.make({
    id: PersistentId.make(id),
    label: id,
    device: { name: "test-device" },
    sample: {
      format: "f32le-interleaved-v1",
      channelCount: 2,
      sampleCount: 1000,
      byteLength: 8000,
      stored: true,
    },
    sampleRateHz: 10_000,
    totalDurationSeconds,
    preTriggerSeconds: 0.025,
    channelMap: [0, 1],
    trigger: { threshold: 0.5, channel: 0, mode: "rising" },
    rtValues: [],
    metadata: { variables: ["voltage", "current"] },
    favorite: false,
    createdAt: Timestamp.make("2026-07-12T00:00:00.000Z"),
    updatedAt: Timestamp.make("2026-07-12T00:00:00.000Z"),
  });

it("keeps only the captures matching the leading one, whatever the route asks for", () => {
  const anchor = record("first", 0.1);
  const matching = record("matching", 0.1);
  const mismatched = record("mismatched", 0.2);

  const { compatible, incompatible } = partitionByCompatibility([anchor, mismatched, matching]);

  expect(compatible.map((entry) => entry.id)).toEqual([anchor.id, matching.id]);
  expect(incompatible.map((entry) => entry.id)).toEqual([mismatched.id]);
});

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
