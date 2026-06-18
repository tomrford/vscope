import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_SETTINGS } from "@vscope/shared";

import { DEFAULT_RUNTIME_HOST, DEFAULT_RUNTIME_PORT, RuntimeEndpoint, makeRuntimeConfig } from ".";
import { runtimeServerPort } from "./server";

describe("@vscope/runtime", () => {
  it("materializes default local runtime config", () => {
    expect(makeRuntimeConfig({ databasePath: "/tmp/vscope.sqlite" })).toEqual({
      host: DEFAULT_RUNTIME_HOST,
      port: DEFAULT_RUNTIME_PORT,
      portOverride: false,
      databasePath: "/tmp/vscope.sqlite",
    });
  });

  it("uses persisted settings port unless the CLI overrides it", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      network: {
        port: 6000,
      },
    };

    expect(
      runtimeServerPort(makeRuntimeConfig({ databasePath: "/tmp/vscope.sqlite" }), settings),
    ).toBe(6000);
    expect(
      runtimeServerPort(
        makeRuntimeConfig({
          databasePath: "/tmp/vscope.sqlite",
          port: 7000,
          portOverride: true,
        }),
        settings,
      ),
    ).toBe(7000);
  });

  it("keeps HTTP, RPC, MCP, and snapshot endpoints centralized", () => {
    expect(RuntimeEndpoint).toEqual({
      health: "/health",
      rpc: "/rpc",
      mcp: "/mcp",
      snapshots: "/snapshots",
    });
  });

  it("keeps optional UI serving path in runtime config", () => {
    expect(
      makeRuntimeConfig({
        databasePath: "/tmp/vscope.sqlite",
        uiDistPath: "/tmp/vscope-ui",
      }),
    ).toEqual({
      host: DEFAULT_RUNTIME_HOST,
      port: DEFAULT_RUNTIME_PORT,
      portOverride: false,
      databasePath: "/tmp/vscope.sqlite",
      uiDistPath: "/tmp/vscope-ui",
    });
  });
});
