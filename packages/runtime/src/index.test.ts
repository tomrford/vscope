import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import {
  DEFAULT_RUNTIME_HOST,
  DEFAULT_RUNTIME_PORT,
  RuntimeEndpoint,
  RuntimeNotImplementedError,
  makeRuntimeConfig,
  startRuntime,
} from ".";

describe("@vscope/runtime", () => {
  test("materializes default local runtime config", () => {
    expect(makeRuntimeConfig({ databasePath: "/tmp/vscope.sqlite" })).toEqual({
      host: DEFAULT_RUNTIME_HOST,
      port: DEFAULT_RUNTIME_PORT,
      databasePath: "/tmp/vscope.sqlite",
    });
  });

  test("keeps HTTP, RPC, MCP, and snapshot endpoints centralized", () => {
    expect(RuntimeEndpoint).toEqual({
      health: "/health",
      rpc: "/rpc",
      mcp: "/mcp",
      snapshots: "/snapshots",
    });
  });

  test("does not pretend the runtime server exists yet", async () => {
    const exit = await Effect.runPromiseExit(
      startRuntime(makeRuntimeConfig({ databasePath: "/tmp/vscope.sqlite" })),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") {
      throw new Error("Expected startRuntime to fail while the server is scaffolded");
    }
    expect(exit.cause.toString()).toContain(RuntimeNotImplementedError.name);
  });
});
