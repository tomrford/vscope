import { describe, expect, it } from "@effect/vitest";

import { DEFAULT_SERIAL_CONFIG } from "./model.ts";

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
