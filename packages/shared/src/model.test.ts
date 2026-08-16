import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import {
  DEFAULT_SERIAL_CONFIG,
  PersistentId,
  SNAPSHOT_SAMPLE_FORMAT,
  SnapshotRecord,
  SnapshotSampleDescriptor,
  SnapshotTrigger,
  Timestamp,
} from "./model.ts";

describe("default serial configuration", () => {
  it("matches the vscope firmware link", () => {
    expect(DEFAULT_SERIAL_CONFIG).toMatchObject({
      baudRate: 312_500,
      dataBits: 8,
      parity: "none",
      stopBits: 1,
      dtr: true,
      rts: true,
    });
  });
});

describe("timestamp contract", () => {
  const decodeTimestamp = Schema.decodeUnknownSync(Timestamp);

  it("accepts canonical millisecond UTC timestamps", () => {
    expect(decodeTimestamp("2026-07-15T18:42:03.123Z")).toBe("2026-07-15T18:42:03.123Z");
  });

  it("rejects invalid or non-canonical timestamps", () => {
    expect(() => decodeTimestamp("not-a-date")).toThrow();
    expect(() => decodeTimestamp("2026-02-31T00:00:00.000Z")).toThrow();
    expect(() => decodeTimestamp("2026-07-15T20:42:03.123+02:00")).toThrow();
  });
});

describe("snapshot record contract", () => {
  const valid = {
    id: PersistentId.make("snapshot:test"),
    label: "Boot trace",
    device: { name: "probe-a" },
    sample: SnapshotSampleDescriptor.make({
      format: SNAPSHOT_SAMPLE_FORMAT,
      channelCount: 2,
      sampleCount: 1,
      byteLength: 8,
      stored: false,
    }),
    sampleRateHz: 1_000,
    totalDurationSeconds: 0.001,
    preTriggerSeconds: 0,
    channelMap: [0, 1],
    trigger: SnapshotTrigger.make({
      threshold: 0.5,
      channel: 1,
      mode: "rising",
    }),
    rtValues: [0, 1],
    metadata: {},
    favorite: false,
    createdAt: Timestamp.make("2026-06-13T08:00:00.000Z"),
    updatedAt: Timestamp.make("2026-06-13T08:00:00.000Z"),
  };

  it("accepts consistent channel and timing metadata", () => {
    expect(SnapshotRecord.make(valid).channelMap).toEqual([0, 1]);
  });

  it("rejects channel and timing mismatches", () => {
    expect(() =>
      SnapshotRecord.make({
        ...valid,
        channelMap: [0],
      }),
    ).toThrow();
    expect(() =>
      SnapshotRecord.make({
        ...valid,
        trigger: SnapshotTrigger.make({
          threshold: 0.5,
          channel: 2,
          mode: "rising",
        }),
      }),
    ).toThrow();
    expect(() =>
      SnapshotRecord.make({
        ...valid,
        preTriggerSeconds: 1,
      }),
    ).toThrow();
  });
});
