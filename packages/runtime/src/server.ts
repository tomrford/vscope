import { createServer } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { PersistentId, makePersistenceLayer } from "@vscope/persistence";
import { VScopeSerialLayer } from "@vscope/serial";
import {
  RuntimeConnectRequest,
  RuntimeApiError,
  RuntimeDeviceConfigPayload,
  RuntimeFramePayload,
  RuntimeRpcs,
  RuntimeSnapshotCaptureRequest,
  RuntimeWriteConfigRequest,
  RuntimeStateDto,
  RuntimeSnapshotRecord,
  RuntimePortInfo,
} from "@vscope/shared";
import { Effect, Layer, Schema } from "effect";
import { McpServer, Tool, Toolkit } from "effect/unstable/ai";
import {
  HttpMiddleware,
  HttpRouter,
  HttpServer,
  HttpServerResponse,
  HttpStaticServer,
} from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import { makeRuntimeApi, type RuntimeApi } from "./api";
import { RuntimeEndpoint, type RuntimeConfig } from "./config";
import { RuntimeCore, RuntimeCoreLive } from "./core";
import type { RuntimeCoreError } from "./core/errors";

const JsonContent = {
  "content-type": "application/json",
} as const;

export function makeRuntimeHttpLayer(config: RuntimeConfig) {
  const apiRoutes = Layer.effectDiscard(
    Effect.gen(function* () {
      const core = yield* RuntimeCore;
      const api = makeRuntimeApi(core);
      const router = yield* HttpRouter.HttpRouter;

      yield* router.add("GET", RuntimeEndpoint.health, jsonResponse({ status: "ok" }));
      yield* router.add(
        "GET",
        `${RuntimeEndpoint.snapshots}/:id/samples`,
        handleSnapshotSamples(api),
      );
    }),
  );

  const rpcHandlers = RuntimeRpcs.toLayer(
    Effect.gen(function* () {
      const core = yield* RuntimeCore;
      const api = makeRuntimeApi(core);
      return RuntimeRpcs.of({
        "runtime.getState": () => api.rpc.getState,
        "runtime.status": () => api.subscriptions.status,
        "ports.list": () => api.rpc.listPorts.pipe(Effect.mapError(runtimeApiError)),
        "device.connect": ({ path }) =>
          api.rpc.connectDevice(path).pipe(Effect.mapError(runtimeApiError)),
        "device.disconnect": () => api.rpc.disconnectDevice.pipe(Effect.mapError(runtimeApiError)),
        "device.run": () => api.rpc.runDevice.pipe(Effect.mapError(runtimeApiError)),
        "device.stop": () => api.rpc.stopDevice.pipe(Effect.mapError(runtimeApiError)),
        "device.trigger": () => api.rpc.triggerDevice.pipe(Effect.mapError(runtimeApiError)),
        "device.setTiming": (timing) =>
          api.rpc.setTiming(timing).pipe(Effect.mapError(runtimeApiError)),
        "device.setTrigger": (trigger) =>
          api.rpc.setTrigger(trigger).pipe(Effect.mapError(runtimeApiError)),
        "device.setRtValue": ({ index, value }) =>
          api.rpc.setRtValue(index, value).pipe(Effect.mapError(runtimeApiError)),
        "device.setChannelMap": ({ channel, variable }) =>
          api.rpc.setChannelMap(channel, variable).pipe(Effect.mapError(runtimeApiError)),
        "device.frame": () => api.subscriptions.frame,
        "snapshots.capture": ({ label }) =>
          api.rpc.captureSnapshot(label).pipe(Effect.mapError(runtimeApiError)),
        "snapshots.list": () => api.rpc.listSnapshots.pipe(Effect.mapError(runtimeApiError)),
      });
    }),
  );

  const rpcRoutes = RpcServer.layerHttp({
    group: RuntimeRpcs,
    path: RuntimeEndpoint.rpc,
    protocol: "http",
  }).pipe(Layer.provide(rpcHandlers), Layer.provide(RpcSerialization.layerJson));

  const mcpRoutes = McpServer.toolkit(RuntimeMcpToolkit).pipe(
    Layer.provide(makeRuntimeMcpToolkitLayer),
    Layer.provide(
      McpServer.layerHttp({
        name: "vscope",
        version: "0.0.1",
        path: RuntimeEndpoint.mcp,
      }),
    ),
  );

  const staticRoutes = config.uiDistPath
    ? HttpStaticServer.layer({
        root: config.uiDistPath,
        spa: true,
      })
    : Layer.empty;

  return Layer.mergeAll(apiRoutes, rpcRoutes, mcpRoutes, staticRoutes);
}

export function makeRuntimeServerLayer(config: RuntimeConfig): Layer.Layer<never, unknown> {
  const app = Layer.unwrap(
    HttpRouter.toHttpEffect(makeRuntimeHttpLayer(config)).pipe(
      Effect.map((handler) => HttpServer.serve(handler, HttpMiddleware.cors())),
    ),
  );

  return app.pipe(
    HttpServer.withLogAddress,
    Layer.provide(NodeHttpServer.layer(createServer, { host: config.host, port: config.port })),
    Layer.provide(RuntimeCoreLive),
    Layer.provide(VScopeSerialLayer),
    Layer.provide(makePersistenceLayer({ path: config.databasePath })),
  );
}

export const runRuntimeServer = (config: RuntimeConfig): Effect.Effect<never, unknown> =>
  Layer.launch(makeRuntimeServerLayer(config));

function handleSnapshotSamples(api: RuntimeApi) {
  return Effect.gen(function* () {
    const params = yield* HttpRouter.schemaPathParams(
      Schema.Struct({
        id: Schema.String.check(Schema.isMinLength(1)),
      }),
    );
    const id = yield* Schema.decodeUnknownEffect(PersistentId)(params.id);
    const samples = yield* api.snapshots.readSamples(id);
    if (!samples) {
      return HttpServerResponse.jsonUnsafe(
        {
          ok: false,
          error: {
            message: "Snapshot samples not found.",
          },
        },
        { status: 404, headers: JsonContent },
      );
    }
    return HttpServerResponse.uint8Array(samples.data, {
      contentType: "application/octet-stream",
      headers: {
        "x-vscope-snapshot-id": samples.snapshotId,
        "x-vscope-sample-format": samples.format,
        "x-vscope-channel-count": String(samples.channelCount),
        "x-vscope-sample-count": String(samples.sampleCount),
        "x-vscope-byte-length": String(samples.byteLength),
      },
    });
  }).pipe(
    Effect.matchEffect({
      onFailure: errorResponse,
      onSuccess: Effect.succeed,
    }),
  );
}

function jsonResponse(body: unknown, status = 200) {
  return HttpServerResponse.jsonUnsafe(body, { status, headers: JsonContent });
}

function errorResponse(error: unknown) {
  return Effect.succeed(
    jsonResponse(
      {
        ok: false,
        error: {
          message: describeError(error),
        },
      },
      400,
    ),
  );
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function runtimeApiError(error: RuntimeCoreError): RuntimeApiError {
  return new RuntimeApiError({ message: describeError(error) });
}

const RuntimeMcpToolkit = Toolkit.make(
  Tool.make("vscope_get_state", {
    description: "Read the current vscope runtime state.",
    success: RuntimeStateDto,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("vscope_list_ports", {
    description: "List available serial ports.",
    success: Schema.Array(RuntimePortInfo),
    failure: RuntimeApiError,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("vscope_connect_device", {
    description: "Connect to a vscope device.",
    parameters: RuntimeConnectRequest,
    success: RuntimeStateDto,
    failure: RuntimeApiError,
  }),
  Tool.make("vscope_disconnect_device", {
    description: "Disconnect the active vscope device.",
    success: RuntimeStateDto,
    failure: RuntimeApiError,
  }),
  Tool.make("vscope_run_device", {
    description: "Start the active vscope device.",
    success: RuntimeStateDto,
    failure: RuntimeApiError,
  }),
  Tool.make("vscope_stop_device", {
    description: "Stop the active vscope device.",
    success: RuntimeStateDto,
    failure: RuntimeApiError,
  }),
  Tool.make("vscope_trigger_device", {
    description: "Trigger the active vscope device.",
    success: RuntimeStateDto,
    failure: RuntimeApiError,
  }),
  Tool.make("vscope_read_config", {
    description: "Read editable device configuration and catalog metadata.",
    success: RuntimeDeviceConfigPayload,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("vscope_write_config", {
    description: "Patch editable device configuration while halted.",
    parameters: RuntimeWriteConfigRequest,
    success: RuntimeDeviceConfigPayload,
    failure: RuntimeApiError,
  }),
  Tool.make("vscope_read_frame", {
    description: "Read the latest live frame values.",
    success: Schema.NullOr(RuntimeFramePayload),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("vscope_capture_snapshot", {
    description: "Capture a ready vscope snapshot.",
    parameters: RuntimeSnapshotCaptureRequest,
    success: RuntimeSnapshotRecord,
    failure: RuntimeApiError,
  }),
  Tool.make("vscope_list_snapshots", {
    description: "List saved snapshot metadata.",
    success: Schema.Array(RuntimeSnapshotRecord),
    failure: RuntimeApiError,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
);

const makeRuntimeMcpToolkitLayer = RuntimeMcpToolkit.toLayer(
  Effect.gen(function* () {
    const core = yield* RuntimeCore;
    const api = makeRuntimeApi(core);
    return RuntimeMcpToolkit.of({
      vscope_get_state: () => api.mcp.getState,
      vscope_list_ports: () => api.mcp.listPorts.pipe(Effect.mapError(runtimeApiError)),
      vscope_connect_device: ({ path }) =>
        api.mcp.connectDevice(path).pipe(Effect.mapError(runtimeApiError)),
      vscope_disconnect_device: () =>
        api.mcp.disconnectDevice.pipe(Effect.mapError(runtimeApiError)),
      vscope_run_device: () => api.mcp.runDevice.pipe(Effect.mapError(runtimeApiError)),
      vscope_stop_device: () => api.mcp.stopDevice.pipe(Effect.mapError(runtimeApiError)),
      vscope_trigger_device: () => api.mcp.triggerDevice.pipe(Effect.mapError(runtimeApiError)),
      vscope_read_config: () => api.mcp.readConfig,
      vscope_write_config: (patch) =>
        api.mcp.writeConfig(patch).pipe(Effect.mapError(runtimeApiError)),
      vscope_read_frame: () => api.mcp.readFrame,
      vscope_capture_snapshot: ({ label }) =>
        api.mcp.captureSnapshot(label).pipe(Effect.mapError(runtimeApiError)),
      vscope_list_snapshots: () => api.mcp.listSnapshots.pipe(Effect.mapError(runtimeApiError)),
    });
  }),
);
