import { describe, expect, test } from "bun:test";
import { NodeHttpServer } from "@effect/platform-node";
import { VScopeEndianness, VScopeState } from "@vscope/serial";
import type { VScopeTiming, VScopeTrigger } from "@vscope/serial";
import { DEFAULT_PREFERENCES, DEFAULT_SETTINGS, RuntimeRpcs, noRecovery } from "@vscope/shared";
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
import { makeRuntimeHttpLayer } from "./server";
import type { CoreCommand, CoreState } from "./core/model";
import { RuntimeCore } from "./core/service";
import type { RuntimeCoreService } from "./core/service";

describe("@vscope/runtime server", () => {
  test("serves health, JSON RPC, and MCP tool listing", async () => {
    const program = Effect.gen(function* () {
      const health = yield* HttpClient.get("/health").pipe(Effect.flatMap(readJson));
      const state = yield* Effect.scoped(
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
          return yield* rpc["runtime.getState"]();
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

      return { health, state, tools };
    }).pipe(Effect.provide(testServerLayer()));

    const result = await Effect.runPromise(program);

    expect(result.health).toEqual({ status: "ok" });
    expect(result.state).toMatchObject({
      device: {
        deviceName: "fake-scope",
        rtValues: [
          [0, 1.5],
          [1, 2.5],
        ],
      },
    });
    expect(JSON.stringify(result.tools)).toContain("vscope_write_config");
  });
});

function readJson(response: HttpClientResponse.HttpClientResponse) {
  return response.json;
}

function testServerLayer() {
  return HttpRouter.serve(makeRuntimeHttpLayer(makeRuntimeConfig({ databasePath: ":memory:" })), {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provide(Layer.succeed(RuntimeCore, fakeCore(initialState()))),
  );
}

function fakeCore(state: CoreState): RuntimeCoreService {
  return {
    changes: Stream.fromIterable([state]),
    getSnapshot: Effect.succeed(state),
    dispatch: (command) => Effect.succeed(applyCommand(state, command)),
    query: (query) =>
      Effect.succeed(
        query.type === "ports/list"
          ? { type: "ports/list", ports: [] }
          : query.type === "snapshots/list"
            ? { type: "snapshots/list", snapshots: state.snapshots }
            : { type: "snapshots/readSamples", samples: null },
      ),
    shutdown: Effect.void,
  };
}

function applyCommand(state: CoreState, _command: CoreCommand): CoreState {
  return state;
}

function initialState(): CoreState {
  const timing: VScopeTiming = { divider: 4, preTrig: 2 };
  const trigger: VScopeTrigger = { threshold: 1.25, channel: 0, mode: "rising" };
  return {
    bootedAt: "2026-06-16T00:00:00.000Z",
    updatedAt: "2026-06-16T00:00:00.000Z",
    status: "ready",
    settings: DEFAULT_SETTINGS,
    settingsRecovery: noRecovery,
    preferences: DEFAULT_PREFERENCES,
    preferencesRecovery: noRecovery,
    savedDevices: [],
    snapshots: [],
    device: {
      path: "/dev/tty.fake",
      deviceName: "fake-scope",
      connectionStatus: "connected",
      info: null,
      metadata: {
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
        channelMap: [0, 1],
      },
      status: {
        state: VScopeState.Halted,
        requestedState: VScopeState.Halted,
        snapshotValid: false,
        requestPending: false,
        triggerEnabled: true,
        flags: 0,
      },
      state: VScopeState.Halted,
      requestedState: VScopeState.Halted,
      requestPending: false,
      snapshotAvailability: "unknown",
      intent: null,
      timing,
      trigger,
      channelMap: [0, 1],
      frame: [10, 20],
      rtValues: new Map([
        [0, 1.5],
        [1, 2.5],
      ]),
      lastFrameAt: "2026-06-16T00:00:00.000Z",
      lastSeenAt: "2026-06-16T00:00:00.000Z",
      error: null,
    },
    permissions: {
      mode: "halted",
      connect: false,
      disconnect: true,
      setTiming: true,
      setTrigger: true,
      setRtValue: true,
      setChannelMap: true,
      trigger: false,
      run: true,
      stop: true,
      captureSnapshot: false,
    },
    warnings: [],
    logs: [],
  };
}
