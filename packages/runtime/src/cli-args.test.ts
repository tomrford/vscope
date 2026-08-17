import { describe, expect, it } from "@effect/vitest";

import { parseArgs } from "./cli-args";

describe("parseArgs", () => {
  it("starts the daemon with no arguments", () => {
    expect(parseArgs([])).toEqual({ kind: "serve", port: undefined });
  });

  it("accepts a port override", () => {
    expect(parseArgs(["--port", "6000"])).toEqual({ kind: "serve", port: 6000 });
    expect(parseArgs(["-p", "6000"])).toEqual({ kind: "serve", port: 6000 });
    expect(parseArgs(["--port=6000"])).toEqual({ kind: "serve", port: 6000 });
  });

  it("treats help and version as terminal flags", () => {
    expect(parseArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseArgs(["-h"])).toEqual({ kind: "help" });
    expect(parseArgs(["--version"])).toEqual({ kind: "version" });
    expect(parseArgs(["-v"])).toEqual({ kind: "version" });
  });

  it("parses device-setup before starting the daemon", () => {
    expect(parseArgs(["device-setup"])).toEqual({
      kind: "device-setup",
      help: false,
      force: false,
    });
    expect(parseArgs(["device-setup", "--force"])).toEqual({
      kind: "device-setup",
      help: false,
      force: true,
    });
    expect(parseArgs(["device-setup", "--help"])).toEqual({
      kind: "device-setup",
      help: true,
      force: false,
    });
  });

  it("rejects unknown daemon and device-setup arguments", () => {
    expect(() => parseArgs(["--wat"])).toThrow("Unknown option: --wat");
    expect(() => parseArgs(["serve"])).toThrow("Unknown command: serve");
    expect(() => parseArgs(["device-setup", "--port", "6000"])).toThrow("Unknown option: --port");
    expect(() => parseArgs(["--port"])).toThrow("--port requires a value.");
    expect(() => parseArgs(["--port", "nope"])).toThrow("Invalid port: nope");
  });
});
