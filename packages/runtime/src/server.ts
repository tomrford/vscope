import { createServer } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { makePersistenceLayer } from "@vscope/persistence";
import { VScopeSerialLayer } from "@vscope/serial";
import {
  RuntimeActiveDevice,
  RuntimeAppDto,
  RuntimeConnectRequest,
  RuntimeApiError,
  RuntimeControlStatus,
  RuntimeDeviceConfigPayload,
  RuntimeFramePayload,
  RuntimeRpcs,
  RuntimeSnapshotCaptureRequest,
  RuntimeTimingPatch,
  RuntimeTriggerPatch,
  RuntimeSnapshotRecord,
  RuntimePortInfo,
  PersistentId,
  type Settings,
} from "@vscope/shared";
import { Context, Effect, Layer, Schema } from "effect";
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
import { RuntimeCorePolicyError, type RuntimeCoreError } from "./core/errors";

class RuntimeApiService extends Context.Service<RuntimeApiService, RuntimeApi>()(
  "@vscope/runtime/RuntimeApi",
) {}

const JsonContent = {
  "content-type": "application/json",
} as const;

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

class RuntimeWriteConfigRequest extends Schema.Class<RuntimeWriteConfigRequest>(
  "RuntimeWriteConfigRequest",
)({
  timing: Schema.optionalKey(RuntimeTimingPatch),
  trigger: Schema.optionalKey(RuntimeTriggerPatch),
  channelMap: Schema.optionalKey(Schema.Array(NonNegativeInt)),
  rtValues: Schema.optionalKey(Schema.Record(Schema.String, Schema.Finite)),
}) {}

export function makeRuntimeHttpLayer(config: RuntimeConfig) {
  const apiLayer = Layer.effect(
    RuntimeApiService,
    RuntimeCore.pipe(Effect.map((core) => makeRuntimeApi(core))),
  );

  const apiRoutes = Layer.effectDiscard(
    Effect.gen(function* () {
      const api = yield* RuntimeApiService;
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
      const api = yield* RuntimeApiService;
      return RuntimeRpcs.of({
        "runtime.getApp": () => api.rpc.getApp,
        "runtime.app": () => api.subscriptions.app,
        "settings.patch": (patch) =>
          api.rpc.patchSettings(patch).pipe(Effect.mapError(runtimeApiError)),
        "preferences.patch": (patch) =>
          api.rpc.patchPreferences(patch).pipe(Effect.mapError(runtimeApiError)),
        "ports.list": () => api.rpc.listPorts.pipe(Effect.mapError(runtimeApiError)),
        "device.active.get": () => api.rpc.getActiveDevice,
        "device.active": () => api.subscriptions.activeDevice,
        "device.connect": ({ path }) =>
          api.rpc.connectDevice(path).pipe(Effect.mapError(runtimeApiError)),
        "device.disconnect": () => api.rpc.disconnectDevice.pipe(Effect.mapError(runtimeApiError)),
        "device.status.get": () => api.rpc.getDeviceStatus,
        "device.status": () => api.subscriptions.status,
        "device.permissions": () => api.subscriptions.permissions,
        "device.run": () => api.rpc.runDevice.pipe(Effect.mapError(runtimeApiError)),
        "device.stop": () => api.rpc.stopDevice.pipe(Effect.mapError(runtimeApiError)),
        "device.trigger": () => api.rpc.triggerDevice.pipe(Effect.mapError(runtimeApiError)),
        "device.config.get": () => api.rpc.getConfig,
        "device.config": () => api.subscriptions.config,
        "device.setTiming": (timing) =>
          api.rpc.setTiming(timing).pipe(Effect.mapError(runtimeApiError)),
        "device.setTrigger": (trigger) =>
          api.rpc.setTrigger(trigger).pipe(Effect.mapError(runtimeApiError)),
        "device.setRtValue": ({ index, value }) =>
          api.rpc.setRtValue(index, value).pipe(Effect.mapError(runtimeApiError)),
        "device.setChannelMap": ({ channel, variable }) =>
          api.rpc.setChannelMap(channel, variable).pipe(Effect.mapError(runtimeApiError)),
        "device.frame.get": () => api.rpc.readFrame,
        "device.frames": () => api.subscriptions.frames,
        "snapshots.capture": ({ label }) =>
          api.rpc.captureSnapshot(label).pipe(Effect.mapError(runtimeApiError)),
        "snapshots.list": () => api.rpc.listSnapshots.pipe(Effect.mapError(runtimeApiError)),
        "snapshots.index": () => api.subscriptions.snapshots,
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

  return Layer.mergeAll(apiRoutes, rpcRoutes, mcpRoutes, staticRoutes).pipe(
    Layer.provide(apiLayer),
  );
}

export function makeRuntimeServerLayer(config: RuntimeConfig): Layer.Layer<never, unknown> {
  const app = Layer.unwrap(
    Effect.gen(function* () {
      const core = yield* RuntimeCore;
      const appState = yield* core.app;
      const port = runtimeServerPort(config, appState.settings);
      return Layer.unwrap(
        HttpRouter.toHttpEffect(makeRuntimeHttpLayer(config)).pipe(
          Effect.map((handler) => HttpServer.serve(handler, HttpMiddleware.cors())),
        ),
      ).pipe(
        HttpServer.withLogAddress,
        Layer.provide(NodeHttpServer.layer(createServer, { host: config.host, port })),
      );
    }),
  );

  return app.pipe(
    Layer.provide(RuntimeCoreLive),
    Layer.provide(VScopeSerialLayer),
    Layer.provide(makePersistenceLayer({ path: config.databasePath })),
  );
}

export const runRuntimeServer = (config: RuntimeConfig): Effect.Effect<never, unknown> =>
  Layer.launch(makeRuntimeServerLayer(config));

export function runtimeServerPort(config: RuntimeConfig, settings: Settings): number {
  return config.portOverride ? config.port : settings.network.port;
}

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
    return error.message || describeTaggedError(error);
  }

  return describeTaggedError(error);
}

function describeTaggedError(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return String(error);
  }

  if ("_tag" in error && typeof error._tag === "string") {
    const details = Object.getOwnPropertyNames(error)
      .filter((key) => key !== "_tag" && key !== "stack")
      .map((key) => [key, (error as Record<string, unknown>)[key]] as const)
      .map(([key, value]) => `${key}=${describeErrorField(value)}`);
    return details.length > 0 ? `${error._tag}: ${details.join(", ")}` : error._tag;
  }

  return String(error);
}

function describeErrorField(value: unknown): string {
  if (value instanceof Error) {
    return describeError(value);
  }

  if (typeof value === "object" && value !== null && "_tag" in value) {
    return describeTaggedError(value);
  }

  return JSON.stringify(value);
}

function runtimeApiError(error: RuntimeCoreError): RuntimeApiError {
  return new RuntimeApiError({ message: describeError(error) });
}

function writeConfig(
  api: RuntimeApi,
  patch: RuntimeWriteConfigRequest,
): Effect.Effect<void, RuntimeCoreError> {
  return Effect.gen(function* () {
    if (patch.timing) {
      const config = yield* requireConfig(api, "devices/setTiming");
      const divider = patch.timing.divider ?? config.timing?.divider;
      const preTrig = patch.timing.preTrig ?? config.timing?.preTrig;
      if (divider !== undefined && preTrig !== undefined) {
        yield* api.rpc.setTiming({ divider, preTrig });
      }
    }

    if (patch.trigger) {
      const config = yield* requireConfig(api, "devices/setTrigger");
      const threshold = patch.trigger.threshold ?? config.trigger?.threshold;
      const channel = patch.trigger.channel ?? config.trigger?.channel;
      const mode = patch.trigger.mode ?? config.trigger?.mode;
      if (threshold !== undefined && channel !== undefined && mode !== undefined) {
        yield* api.rpc.setTrigger({ threshold, channel, mode });
      }
    }

    if (patch.channelMap) {
      const config = yield* requireConfig(api, "devices/setChannelMap");
      for (const [channel, variable] of patch.channelMap.entries()) {
        if (config.channelMap[channel] !== variable) {
          yield* api.rpc.setChannelMap(channel, variable);
        }
      }
    }

    if (patch.rtValues) {
      const config = yield* requireConfig(api, "devices/setRtValue");
      const currentRtValues = new Map(config.rtValues);
      for (const [index, value] of Object.entries(patch.rtValues)) {
        const numericIndex = Number(index);
        if (currentRtValues.get(numericIndex) !== value) {
          yield* api.rpc.setRtValue(numericIndex, value);
        }
      }
    }
  });
}

function requireConfig(
  api: RuntimeApi,
  command: string,
): Effect.Effect<RuntimeDeviceConfigPayload, RuntimeCoreError> {
  return api.rpc.getConfig.pipe(
    Effect.flatMap((config) =>
      config
        ? Effect.succeed(config)
        : Effect.fail(
            new RuntimeCorePolicyError({
              command,
              reason: "No editable device configuration is available.",
            }),
          ),
    ),
  );
}

const RuntimeMcpToolkit = Toolkit.make(
  Tool.make("vscope_get_app", {
    description: "Read runtime app settings, preferences, warnings, and logs.",
    success: RuntimeAppDto,
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
  Tool.make("vscope_get_active_device", {
    description: "Read active device identity and static catalog metadata.",
    success: Schema.NullOr(RuntimeActiveDevice),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("vscope_connect_device", {
    description: "Connect to a vscope device.",
    parameters: RuntimeConnectRequest,
    success: Schema.Void,
    failure: RuntimeApiError,
  }),
  Tool.make("vscope_disconnect_device", {
    description: "Disconnect the active vscope device.",
    success: Schema.Void,
    failure: RuntimeApiError,
  }),
  Tool.make("vscope_get_device_status", {
    description: "Read the latest device status flags.",
    success: Schema.NullOr(RuntimeControlStatus),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("vscope_run_device", {
    description: "Start the active vscope device.",
    success: Schema.Void,
    failure: RuntimeApiError,
  }),
  Tool.make("vscope_stop_device", {
    description: "Stop the active vscope device.",
    success: Schema.Void,
    failure: RuntimeApiError,
  }),
  Tool.make("vscope_trigger_device", {
    description: "Trigger the active vscope device.",
    success: Schema.Void,
    failure: RuntimeApiError,
  }),
  Tool.make("vscope_read_config", {
    description: "Read editable device configuration.",
    success: Schema.NullOr(RuntimeDeviceConfigPayload),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("vscope_write_config", {
    description: "Patch editable device configuration while halted.",
    parameters: RuntimeWriteConfigRequest,
    success: Schema.Void,
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
    success: Schema.Void,
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
    const api = yield* RuntimeApiService;
    return RuntimeMcpToolkit.of({
      vscope_get_app: () => api.mcp.getApp,
      vscope_list_ports: () => api.mcp.listPorts.pipe(Effect.mapError(runtimeApiError)),
      vscope_get_active_device: () => api.mcp.getActiveDevice,
      vscope_connect_device: ({ path }) =>
        api.mcp.connectDevice(path).pipe(Effect.mapError(runtimeApiError)),
      vscope_disconnect_device: () =>
        api.mcp.disconnectDevice.pipe(Effect.mapError(runtimeApiError)),
      vscope_get_device_status: () => api.mcp.getDeviceStatus,
      vscope_run_device: () => api.mcp.runDevice.pipe(Effect.mapError(runtimeApiError)),
      vscope_stop_device: () => api.mcp.stopDevice.pipe(Effect.mapError(runtimeApiError)),
      vscope_trigger_device: () => api.mcp.triggerDevice.pipe(Effect.mapError(runtimeApiError)),
      vscope_read_config: () => api.mcp.readConfig,
      vscope_write_config: (patch) =>
        writeConfig(api, patch).pipe(Effect.mapError(runtimeApiError)),
      vscope_read_frame: () => api.mcp.readFrame,
      vscope_capture_snapshot: ({ label }) =>
        api.mcp.captureSnapshot(label).pipe(Effect.mapError(runtimeApiError)),
      vscope_list_snapshots: () => api.mcp.listSnapshots.pipe(Effect.mapError(runtimeApiError)),
    });
  }),
);
