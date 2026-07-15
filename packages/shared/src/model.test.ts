import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import { DEFAULT_SERIAL_CONFIG, Timestamp } from "./model.ts";

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
