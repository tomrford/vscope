import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import { TriggerMode } from ".";

const decodeTriggerMode = Schema.decodeUnknownSync(TriggerMode);

describe("@vscope/shared trigger contracts", () => {
  it("accepts the shared semantic trigger modes", () => {
    expect(decodeTriggerMode("disabled")).toBe("disabled");
    expect(decodeTriggerMode("rising")).toBe("rising");
    expect(decodeTriggerMode("falling")).toBe("falling");
    expect(decodeTriggerMode("both")).toBe("both");
  });

  it("rejects unknown trigger modes", () => {
    expect(() => decodeTriggerMode("edge")).toThrow();
  });
});
