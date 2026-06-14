import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { TriggerMode } from ".";

const decodeTriggerMode = Schema.decodeUnknownSync(TriggerMode);

describe("@vscope/shared trigger contracts", () => {
  test("accepts the shared semantic trigger modes", () => {
    expect(decodeTriggerMode("disabled")).toBe("disabled");
    expect(decodeTriggerMode("rising")).toBe("rising");
    expect(decodeTriggerMode("falling")).toBe("falling");
    expect(decodeTriggerMode("both")).toBe("both");
  });

  test("rejects unknown trigger modes", () => {
    expect(() => decodeTriggerMode("edge")).toThrow();
  });
});
