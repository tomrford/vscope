import { describe, expect, layer } from "@effect/vitest";
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
import type {
  ActiveDeviceState,
  CoreQueryResult,
  DeviceConfigState,
  RuntimeAppState,
} from "./core/model";
import type { CommandPermissions } from "./core/policy";
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
      }),
    );
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
    Layer.provide(Layer.succeed(RuntimeCore, fakeCore())),
  );
}

function fakeCore(): RuntimeCoreService {
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
  const permissions = commandPermissions();
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
    permissions: Effect.succeed(permissions),
    readModel: Effect.succeed({
      app,
      snapshots: snapshots.snapshots,
      activeDevice,
      deviceStatus: status,
      deviceConfig: config,
      permissions,
    }),
    dispatch: () => Effect.void,
    query: (query) =>
      Effect.succeed(
        query.type === "ports/list"
          ? { type: "ports/list", ports: [] }
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
    preferences: DEFAULT_PREFERENCES,
    preferencesRecovery: noRecovery,
    savedDevices: [],
    warnings: [],
    logs: [],
  };
}

function initialActiveDevice(): ActiveDeviceState {
  return {
    path: "/dev/tty.fake",
    deviceName: "fake-scope",
    connectionStatus: "connected",
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
  const timing: VScopeTiming = { divider: 4, preTrig: 2 };
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

function commandPermissions(): CommandPermissions {
  return {
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
  };
}
