import { describe, expect, layer } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import { VScopeEndianness, VScopeState } from "@vscope/serial";
import type { SerialPortInfo, VScopeTiming, VScopeTrigger } from "@vscope/serial";
import { DEFAULT_SETTINGS, RuntimeRpcs, noRecovery } from "@vscope/shared";
import { Effect, Layer, Stream } from "effect";
import {
  Headers,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
} from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";

import { makeRuntimeConfig } from "./config";
import type {
  ActiveDeviceState,
  CoreCommand,
  CoreQueryResult,
  DeviceConfigState,
  RuntimeAppState,
} from "./core/model";
import { RuntimeCore } from "./core/service";
import type { RuntimeCoreService } from "./core/service";
import { makeRuntimeHttpLayer } from "./server";

describe("@vscope/runtime server", () => {
  layer(testServerLayer(), { excludeTestServices: true })((it) => {
    it.effect("serves health, JSON RPC, and MCP tool listing", () =>
      Effect.gen(function* () {
        const health = yield* HttpClient.get("/health").pipe(Effect.flatMap(readJson));
        const rpcState = yield* Effect.scoped(
          Effect.gen(function* () {
            const rpc = yield* RpcClient.make(RuntimeRpcs).pipe(
              Effect.provide(
                RpcClient.layerProtocolHttp({
                  url: "",
                  transformClient: (client) =>
                    HttpClient.mapRequest(client, HttpClientRequest.appendUrl("/rpc")),
                }).pipe(Layer.provideMerge(RpcSerialization.layerJson)),
              ),
            );
            const app = yield* rpc["runtime.getApp"]();
            const activeDevice = yield* rpc["device.active.get"]();
            const config = yield* rpc["device.config.get"]();
            return { app, activeDevice, config };
          }),
        );

        const initialized = yield* HttpClient.post("/mcp", {
          body: HttpBody.jsonUnsafe({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: {
                name: "vscope-test",
                version: "0.0.0",
              },
            },
          }),
        });
        const sessionId = yield* Effect.fromOption(
          Headers.get(initialized.headers, "Mcp-Session-Id"),
        );
        const tools = yield* HttpClientRequest.post("/mcp").pipe(
          HttpClientRequest.setHeaders({
            "Mcp-Session-Id": sessionId,
          }),
          HttpClientRequest.bodyJsonUnsafe({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/list",
            params: {},
          }),
          HttpClient.execute,
          Effect.flatMap(readJson),
        );

        expect(health).toEqual({ status: "ok" });
        expect(rpcState.app.status).toBe("ready");
        expect(rpcState.activeDevice?.deviceName).toBe("fake-scope");
        expect(rpcState.config?.rtValues).toEqual([
          [0, 1.5],
          [1, 2.5],
        ]);
        expect(JSON.stringify(tools)).toContain("vscope_write_config");
        expect(JSON.stringify(tools)).toContain("vscope_read_rt_buffers");
        expect(JSON.stringify(tools)).toContain("vscope_write_rt_buffers");
        expect(JSON.stringify(tools)).toContain("vscope_read_channel_catalog");
        expect(JSON.stringify(tools)).toContain("vscope_read_channel_map");
        expect(JSON.stringify(tools)).toContain("vscope_write_channel_map");
        expect(JSON.stringify(tools)).not.toContain("vscope_set_rt_value");
        expect(JSON.stringify(tools)).toContain("vscope_save_snapshot");
        expect(JSON.stringify(tools)).not.toContain("vscope_capture_snapshot");
      }),
    );
  });

  layer(testServerLayer(), { excludeTestServices: true })((it) => {
    it.effect("applies MCP config patches through core commands", () =>
      Effect.gen(function* () {
        const commands = activeCommands();
        const sessionId = yield* initializeMcp();

        yield* callMcpTool(sessionId, 2, "vscope_write_config", {
          timing: {
            totalDurationSeconds: 0.1,
          },
        });

        expect(commands).toEqual([
          {
            type: "devices/setTiming",
            timing: {
              totalDurationSeconds: 0.1,
              preTriggerSeconds: 0.00002,
            },
          },
        ]);
      }),
    );

    it.effect("rejects no-op MCP config patches before dispatch", () =>
      Effect.gen(function* () {
        const commands = activeCommands();
        const sessionId = yield* initializeMcp();

        const result = yield* callMcpTool(sessionId, 2, "vscope_write_config", {});

        expect(JSON.stringify(result)).toContain("At least one of timing or trigger");
        expect(commands).toEqual([]);
      }),
    );

    it.effect("reads and writes MCP RT buffers by index", () =>
      Effect.gen(function* () {
        const commands = activeCommands();
        const sessionId = yield* initializeMcp();

        const readResult = yield* callMcpTool(sessionId, 2, "vscope_read_rt_buffers", {});
        yield* callMcpTool(sessionId, 3, "vscope_write_rt_buffers", {
          values: {
            "1": 3.5,
          },
        });

        expect(JSON.stringify(readResult)).toContain('"0"');
        expect(JSON.stringify(readResult)).toContain("gain");
        expect(JSON.stringify(readResult)).toContain("1.5");
        expect(commands).toEqual([
          {
            type: "devices/setRtValue",
            index: 1,
            value: 3.5,
          },
        ]);
      }),
    );

    it.effect("rejects empty and invalid MCP RT buffer writes before dispatch", () =>
      Effect.gen(function* () {
        const commands = activeCommands();
        const sessionId = yield* initializeMcp();

        const emptyResult = yield* callMcpTool(sessionId, 2, "vscope_write_rt_buffers", {
          values: {},
        });
        const invalidResult = yield* callMcpTool(sessionId, 3, "vscope_write_rt_buffers", {
          values: {
            gain: 3.5,
          },
        });

        expect(JSON.stringify(emptyResult)).toContain("values must contain at least one");
        expect(JSON.stringify(invalidResult)).toContain("RT buffer index must be");
        expect(commands).toEqual([]);
      }),
    );

    it.effect("reads channel catalog and map, then writes MCP channel map by index", () =>
      Effect.gen(function* () {
        const commands = activeCommands();
        const sessionId = yield* initializeMcp();

        const catalogResult = yield* callMcpTool(sessionId, 2, "vscope_read_channel_catalog", {});
        const mapResult = yield* callMcpTool(sessionId, 3, "vscope_read_channel_map", {});
        yield* callMcpTool(sessionId, 4, "vscope_write_channel_map", {
          channels: {
            "1": 3,
          },
        });

        expect(JSON.stringify(catalogResult)).toContain("a");
        expect(JSON.stringify(catalogResult)).toContain("d");
        expect(JSON.stringify(mapResult)).toContain("catalogIndex");
        expect(JSON.stringify(mapResult)).toContain("catalogName");
        expect(commands).toEqual([
          {
            type: "devices/setChannelMap",
            channel: 1,
            variable: 3,
          },
        ]);
      }),
    );

    it.effect("rejects no-op and invalid MCP channel map writes before dispatch", () =>
      Effect.gen(function* () {
        const commands = activeCommands();
        const sessionId = yield* initializeMcp();

        const noOpResult = yield* callMcpTool(sessionId, 2, "vscope_write_channel_map", {
          channels: {
            "1": 1,
          },
        });
        const invalidResult = yield* callMcpTool(sessionId, 3, "vscope_write_channel_map", {
          channels: {
            offset: 3,
          },
        });

        expect(JSON.stringify(noOpResult)).toContain("did not change");
        expect(JSON.stringify(invalidResult)).toContain("channel index must be");
        expect(commands).toEqual([]);
      }),
    );

    it.effect("filters MCP port listings by VID and PID", () =>
      Effect.gen(function* () {
        const sessionId = yield* initializeMcp();

        const result = yield* callMcpTool(sessionId, 2, "vscope_list_ports", {
          vendorId: "0002",
          productId: "0001",
        });

        expect(JSON.stringify(result)).toContain("/dev/tty.vscope");
        expect(JSON.stringify(result)).not.toContain("/dev/tty.other");
      }),
    );

    it.effect("saves snapshots through the renamed MCP tool", () =>
      Effect.gen(function* () {
        const commands = activeCommands();
        const sessionId = yield* initializeMcp();

        yield* callMcpTool(sessionId, 2, "vscope_save_snapshot", {
          label: "bench capture",
        });

        expect(commands).toEqual([
          {
            type: "snapshots/capture",
            label: "bench capture",
          },
        ]);
      }),
    );
  });
});

let currentCommands: Array<CoreCommand> = [];

const fakePorts: ReadonlyArray<SerialPortInfo> = [
  {
    path: "/dev/tty.vscope",
    manufacturer: "vscope",
    serialNumber: "test-serial",
    pnpId: undefined,
    locationId: undefined,
    productId: "0001",
    vendorId: "0002",
  },
  {
    path: "/dev/tty.other",
    manufacturer: "other",
    serialNumber: "other-serial",
    pnpId: undefined,
    locationId: undefined,
    productId: "9999",
    vendorId: "0002",
  },
];

function activeCommands(): Array<CoreCommand> {
  currentCommands.length = 0;
  return currentCommands;
}

function initializeMcp() {
  return Effect.gen(function* () {
    const initialized = yield* HttpClient.post("/mcp", {
      body: HttpBody.jsonUnsafe({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: {
            name: "vscope-test",
            version: "0.0.0",
          },
        },
      }),
    });
    return yield* Effect.fromOption(Headers.get(initialized.headers, "Mcp-Session-Id"));
  });
}

function callMcpTool(sessionId: string, id: number, name: string, args: Record<string, unknown>) {
  return HttpClientRequest.post("/mcp").pipe(
    HttpClientRequest.setHeaders({
      "Mcp-Session-Id": sessionId,
    }),
    HttpClientRequest.bodyJsonUnsafe({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name,
        arguments: args,
      },
    }),
    HttpClient.execute,
    Effect.flatMap(readJson),
  );
}

function readJson(response: HttpClientResponse.HttpClientResponse) {
  return response.json;
}

function testServerLayer() {
  currentCommands = [];
  return HttpRouter.serve(makeRuntimeHttpLayer(makeRuntimeConfig({ databasePath: ":memory:" })), {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provide(Layer.succeed(RuntimeCore, fakeCore(currentCommands))),
  );
}

function fakeCore(commands: Array<CoreCommand>): RuntimeCoreService {
  const app = initialApp();
  const activeDevice = initialActiveDevice();
  const status = {
    state: VScopeState.Halted,
    requestedState: VScopeState.Halted,
    snapshotValid: false,
    requestPending: false,
    triggerEnabled: true,
    flags: 0,
  };
  const config = initialConfig();
  const snapshots: Extract<CoreQueryResult, { readonly type: "snapshots/list" }> = {
    type: "snapshots/list",
    snapshots: [],
  };
  return {
    app: Effect.succeed(app),
    appChanges: Stream.fromIterable([app]),
    snapshots: Effect.succeed(snapshots.snapshots),
    snapshotChanges: Stream.fromIterable([snapshots.snapshots]),
    activeDevice: Effect.succeed(activeDevice),
    activeDeviceChanges: Stream.fromIterable([activeDevice]),
    deviceStatus: Effect.succeed(status),
    deviceStatusChanges: Stream.fromIterable([status]),
    deviceConfig: Effect.succeed(config),
    deviceConfigChanges: Stream.fromIterable([config]),
    readModel: Effect.succeed({
      app,
      snapshots: snapshots.snapshots,
      activeDevice,
      deviceStatus: status,
      deviceConfig: config,
    }),
    dispatch: (command) =>
      Effect.sync(() => {
        commands.push(command);
      }),
    query: (query) =>
      Effect.succeed(
        query.type === "ports/list"
          ? { type: "ports/list", ports: fakePorts }
          : query.type === "snapshots/list"
            ? snapshots
            : { type: "snapshots/readSamples", samples: null },
      ),
    shutdown: Effect.void,
    frames: Stream.empty,
    lastFrame: Effect.succeed([10, 20]),
  };
}

function initialApp(): RuntimeAppState {
  return {
    bootedAt: "2026-06-16T00:00:00.000Z",
    updatedAt: "2026-06-16T00:00:00.000Z",
    status: "ready",
    settings: DEFAULT_SETTINGS,
    settingsRecovery: noRecovery,
    savedDevices: [],
    warnings: [],
    logs: [],
  };
}

function initialActiveDevice(): ActiveDeviceState {
  return {
    path: "/dev/tty.fake",
    deviceName: "fake-scope",
    connected: true,
    info: {
      channelCount: 2,
      bufferSize: 1024,
      isrKHz: 100,
      variableCount: 8,
      rtCount: 2,
      rtBufferCapacity: 2,
      nameLength: 32,
      endianness: VScopeEndianness.Little,
      deviceName: "fake-scope",
    },
    variables: ["a", "b", "c", "d"],
    rtLabels: ["gain", "offset"],
    error: null,
  };
}

function initialConfig(): DeviceConfigState {
  const timing: VScopeTiming = { totalDurationSeconds: 0.04096, preTriggerSeconds: 0.00002 };
  const trigger: VScopeTrigger = { threshold: 1.25, channel: 0, mode: "rising" };
  return {
    timing,
    trigger,
    channelMap: [0, 1],
    rtValues: new Map([
      [0, 1.5],
      [1, 2.5],
    ]),
  };
}
