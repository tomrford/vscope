import { describe, expect, test } from "bun:test";

import { DEFAULT_RUNTIME_HOST, DEFAULT_RUNTIME_PORT, RuntimeEndpoint, makeRuntimeConfig } from ".";

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

  test("keeps optional UI serving path in runtime config", () => {
    expect(
      makeRuntimeConfig({
        databasePath: "/tmp/vscope.sqlite",
        uiDistPath: "/tmp/vscope-ui",
      }),
    ).toEqual({
      host: DEFAULT_RUNTIME_HOST,
      port: DEFAULT_RUNTIME_PORT,
      databasePath: "/tmp/vscope.sqlite",
      uiDistPath: "/tmp/vscope-ui",
    });
  });
});
