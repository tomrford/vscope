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
  RuntimeDeviceInfo,
  RuntimeFramePayload,
  RuntimeRpcs,
  RuntimeSetTimingRequest,
  RuntimeSetTriggerRequest,
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

import {
  activeDeviceDto,
  appDto,
  configDto,
  framePayload,
  makeRuntimeApi,
  runtimePortInfo,
  snapshotDto,
  statusDto,
  type RuntimeApi,
} from "./api";
import { RuntimeEndpoint, type RuntimeConfig } from "./config";
import { RuntimeCore, RuntimeCoreLive } from "./core";
import { RuntimeCorePolicyError, type RuntimeCoreError } from "./core/errors";
import type { CoreCommand } from "./core/model";
import type { RuntimeCoreService } from "./core/service";

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
}) {}

class RuntimeMcpActiveDevice extends Schema.Class<RuntimeMcpActiveDevice>("RuntimeMcpActiveDevice")(
  {
    path: Schema.String,
    deviceName: Schema.String,
    connected: Schema.Boolean,
    info: Schema.NullOr(RuntimeDeviceInfo),
    error: Schema.NullOr(Schema.String),
  },
) {}

class RuntimeMcpDeviceConfigPayload extends Schema.Class<RuntimeMcpDeviceConfigPayload>(
  "RuntimeMcpDeviceConfigPayload",
)({
  timing: Schema.NullOr(RuntimeSetTimingRequest),
  trigger: Schema.NullOr(RuntimeSetTriggerRequest),
}) {}

class RuntimeRtBufferValue extends Schema.Class<RuntimeRtBufferValue>("RuntimeRtBufferValue")({
  label: Schema.NullOr(Schema.String),
  value: Schema.Finite,
}) {}

class RuntimeRtBuffersPayload extends Schema.Class<RuntimeRtBuffersPayload>(
  "RuntimeRtBuffersPayload",
)({
  values: Schema.Record(Schema.String, RuntimeRtBufferValue),
}) {}

class RuntimeWriteRtBuffersMcpRequest extends Schema.Class<RuntimeWriteRtBuffersMcpRequest>(
  "RuntimeWriteRtBuffersMcpRequest",
)({
  values: Schema.Record(Schema.String, Schema.Finite),
}) {}

class RuntimeChannelCatalogPayload extends Schema.Class<RuntimeChannelCatalogPayload>(
  "RuntimeChannelCatalogPayload",
)({
  catalog: Schema.Record(Schema.String, Schema.String),
}) {}

class RuntimeChannelMapValue extends Schema.Class<RuntimeChannelMapValue>("RuntimeChannelMapValue")(
  {
    catalogIndex: NonNegativeInt,
    catalogName: Schema.NullOr(Schema.String),
  },
) {}

class RuntimeChannelMapPayload extends Schema.Class<RuntimeChannelMapPayload>(
  "RuntimeChannelMapPayload",
)({
  channels: Schema.Record(Schema.String, RuntimeChannelMapValue),
}) {}

class RuntimeWriteChannelMapMcpRequest extends Schema.Class<RuntimeWriteChannelMapMcpRequest>(
  "RuntimeWriteChannelMapMcpRequest",
)({
  channels: Schema.Record(Schema.String, NonNegativeInt),
}) {}

class RuntimeListPortsMcpRequest extends Schema.Class<RuntimeListPortsMcpRequest>(
  "RuntimeListPortsMcpRequest",
)({
  vendorId: Schema.optionalKey(Schema.String),
  productId: Schema.optionalKey(Schema.String),
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
        "ports.list": () => api.rpc.listPorts.pipe(Effect.mapError(runtimeApiError)),
        "device.active.get": () => api.rpc.getActiveDevice,
        "device.active": () => api.subscriptions.activeDevice,
        "device.connect": ({ path }) =>
          api.rpc.connectDevice(path).pipe(Effect.mapError(runtimeApiError)),
        "device.disconnect": () => api.rpc.disconnectDevice.pipe(Effect.mapError(runtimeApiError)),
        "device.status.get": () => api.rpc.getDeviceStatus,
        "device.status": () => api.subscriptions.status,
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
  core: RuntimeCoreService,
  patch: RuntimeWriteConfigRequest,
): Effect.Effect<void, RuntimeCoreError> {
  return Effect.gen(function* () {
    if (!patch.timing && !patch.trigger) {
      return yield* invalidMcpWrite(
        "vscope_write_config",
        "At least one of timing or trigger is required.",
      );
    }

    const config = yield* requireConfig(core, "vscope_write_config");
    const commands: Array<CoreCommand> = [];

    if (patch.timing) {
      const totalDurationSeconds =
        patch.timing.totalDurationSeconds ?? config.timing?.totalDurationSeconds;
      const preTriggerSeconds = patch.timing.preTriggerSeconds ?? config.timing?.preTriggerSeconds;
      if (totalDurationSeconds === undefined || preTriggerSeconds === undefined) {
        return yield* invalidMcpWrite(
          "devices/setTiming",
          "Timing patches must include totalDurationSeconds and preTriggerSeconds when no current timing is available.",
        );
      }
      if (
        config.timing?.totalDurationSeconds !== totalDurationSeconds ||
        config.timing.preTriggerSeconds !== preTriggerSeconds
      ) {
        commands.push({
          type: "devices/setTiming",
          timing: { totalDurationSeconds, preTriggerSeconds },
        });
      }
    }

    if (patch.trigger) {
      const threshold = patch.trigger.threshold ?? config.trigger?.threshold;
      const channel = patch.trigger.channel ?? config.trigger?.channel;
      const mode = patch.trigger.mode ?? config.trigger?.mode;
      if (threshold === undefined || channel === undefined || mode === undefined) {
        return yield* invalidMcpWrite(
          "devices/setTrigger",
          "Trigger patches must include threshold, channel, and mode when no current trigger is available.",
        );
      }
      if (
        config.trigger?.threshold !== threshold ||
        config.trigger.channel !== channel ||
        config.trigger.mode !== mode
      ) {
        commands.push({
          type: "devices/setTrigger",
          trigger: { threshold, channel, mode },
        });
      }
    }

    if (commands.length === 0) {
      return yield* invalidMcpWrite(
        "vscope_write_config",
        "Patch did not change device configuration.",
      );
    }

    for (const command of commands) {
      yield* core.dispatch(command);
    }
  });
}

function requireConfig(
  core: RuntimeCoreService,
  command: string,
): Effect.Effect<RuntimeDeviceConfigPayload, RuntimeCoreError> {
  return core.deviceConfig.pipe(
    Effect.map(configDto),
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

function mcpActiveDeviceDto(device: RuntimeActiveDevice | null): RuntimeMcpActiveDevice | null {
  return device
    ? new RuntimeMcpActiveDevice({
        path: device.path,
        deviceName: device.deviceName,
        connected: device.connected,
        info: device.info,
        error: device.error,
      })
    : null;
}

function mcpConfigDto(
  config: RuntimeDeviceConfigPayload | null,
): RuntimeMcpDeviceConfigPayload | null {
  return config
    ? new RuntimeMcpDeviceConfigPayload({
        timing: config.timing,
        trigger: config.trigger,
      })
    : null;
}

function readRtBuffers(core: RuntimeCoreService): Effect.Effect<RuntimeRtBuffersPayload | null> {
  return Effect.gen(function* () {
    const config = yield* core.deviceConfig.pipe(Effect.map(configDto));
    const device = yield* core.activeDevice;
    if (!config || !device) {
      return null;
    }
    return new RuntimeRtBuffersPayload({
      values: Object.fromEntries(
        config.rtValues.map(([index, value]) => [
          String(index),
          new RuntimeRtBufferValue({
            label: device.rtLabels[index] ?? null,
            value,
          }),
        ]),
      ),
    });
  });
}

function writeRtBuffers(
  core: RuntimeCoreService,
  request: RuntimeWriteRtBuffersMcpRequest,
): Effect.Effect<void, RuntimeCoreError> {
  return Effect.gen(function* () {
    const entries = Object.entries(request.values);
    if (entries.length === 0) {
      return yield* invalidMcpWrite(
        "vscope_write_rt_buffers",
        "values must contain at least one RT buffer assignment.",
      );
    }

    const config = yield* requireConfig(core, "vscope_write_rt_buffers");
    const device = yield* requireActiveDevice(core, "vscope_write_rt_buffers");
    const currentRtValues = new Map(config.rtValues);
    const commands: Array<CoreCommand> = [];
    for (const [key, value] of entries) {
      const index = yield* parseIndexKey("vscope_write_rt_buffers", key, "RT buffer");
      const rtCount = device.info?.rtCount ?? device.rtLabels.length;
      if (index >= rtCount) {
        return yield* invalidMcpWrite(
          "vscope_write_rt_buffers",
          `RT buffer index ${index} is outside the active device RT buffer range.`,
        );
      }
      if (currentRtValues.get(index) !== value) {
        commands.push({ type: "devices/setRtValue", index, value });
      }
    }

    if (commands.length === 0) {
      return yield* invalidMcpWrite(
        "vscope_write_rt_buffers",
        "RT buffer patch did not change device configuration.",
      );
    }

    for (const command of commands) {
      yield* core.dispatch(command);
    }
  });
}

function readChannelCatalog(
  core: RuntimeCoreService,
): Effect.Effect<RuntimeChannelCatalogPayload | null> {
  return core.activeDevice.pipe(
    Effect.map((device) =>
      device
        ? new RuntimeChannelCatalogPayload({
            catalog: Object.fromEntries(
              device.variables.map((variable, index) => [String(index), variable]),
            ),
          })
        : null,
    ),
  );
}

function readChannelMap(core: RuntimeCoreService): Effect.Effect<RuntimeChannelMapPayload | null> {
  return Effect.gen(function* () {
    const config = yield* core.deviceConfig.pipe(Effect.map(configDto));
    const device = yield* core.activeDevice;
    if (!config || !device) {
      return null;
    }
    return new RuntimeChannelMapPayload({
      channels: Object.fromEntries(
        config.channelMap.map((catalogIndex, channel) => [
          String(channel),
          new RuntimeChannelMapValue({
            catalogIndex,
            catalogName: device.variables[catalogIndex] ?? null,
          }),
        ]),
      ),
    });
  });
}

function writeChannelMap(
  core: RuntimeCoreService,
  request: RuntimeWriteChannelMapMcpRequest,
): Effect.Effect<void, RuntimeCoreError> {
  return Effect.gen(function* () {
    const entries = Object.entries(request.channels);
    if (entries.length === 0) {
      return yield* invalidMcpWrite(
        "vscope_write_channel_map",
        "channels must contain at least one channel assignment.",
      );
    }

    const config = yield* requireConfig(core, "vscope_write_channel_map");
    const device = yield* requireActiveDevice(core, "vscope_write_channel_map");
    const commands: Array<CoreCommand> = [];
    for (const [key, variable] of entries) {
      const channel = yield* parseIndexKey("vscope_write_channel_map", key, "channel");
      if (channel >= config.channelMap.length) {
        return yield* invalidMcpWrite(
          "vscope_write_channel_map",
          `Channel index ${channel} is outside the active device channel range.`,
        );
      }
      if (variable >= device.variables.length) {
        return yield* invalidMcpWrite(
          "vscope_write_channel_map",
          `Catalog index ${variable} is outside the active device variable catalog range.`,
        );
      }
      if (config.channelMap[channel] !== variable) {
        commands.push({ type: "devices/setChannelMap", channel, variable });
      }
    }

    if (commands.length === 0) {
      return yield* invalidMcpWrite(
        "vscope_write_channel_map",
        "Channel map patch did not change device configuration.",
      );
    }

    for (const command of commands) {
      yield* core.dispatch(command);
    }
  });
}

function requireActiveDevice(core: RuntimeCoreService, command: string) {
  return core.activeDevice.pipe(
    Effect.flatMap((device) => {
      if (!device) {
        return invalidMcpWrite(command, "No active device is available.");
      }

      return Effect.succeed(device);
    }),
  );
}

function parseIndexKey(
  command: string,
  key: string,
  label: string,
): Effect.Effect<number, RuntimeCoreError> {
  if (!/^(0|[1-9]\d*)$/.test(key)) {
    return invalidMcpWrite(
      command,
      `${label} index must be a non-negative integer string: ${key}.`,
    );
  }

  return Effect.succeed(Number(key));
}

function invalidMcpWrite(command: string, reason: string): Effect.Effect<never, RuntimeCoreError> {
  return Effect.fail(new RuntimeCorePolicyError({ command, reason }));
}

function matchesPortFilters(port: RuntimePortInfo, filters: RuntimeListPortsMcpRequest): boolean {
  return (
    (filters.vendorId === undefined || port.vendorId === filters.vendorId) &&
    (filters.productId === undefined || port.productId === filters.productId)
  );
}

const RuntimeMcpToolkit = Toolkit.make(
  Tool.make("vscope_get_app", {
    description: "Read runtime app settings, warnings, and logs.",
    success: RuntimeAppDto,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("vscope_list_ports", {
    description: "List available serial ports.",
    parameters: RuntimeListPortsMcpRequest,
    success: Schema.Array(RuntimePortInfo),
    failure: RuntimeApiError,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("vscope_get_active_device", {
    description: "Read active device identity.",
    success: Schema.NullOr(RuntimeMcpActiveDevice),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("vscope_connect_device", {
    description: "Connect to a vscope device.",
    parameters: RuntimeConnectRequest,
    success: Schema.String,
    failure: RuntimeApiError,
  }),
  Tool.make("vscope_disconnect_device", {
    description: "Disconnect the active vscope device.",
    success: Schema.String,
    failure: RuntimeApiError,
  }),
  Tool.make("vscope_get_device_status", {
    description: "Read the latest onboard device state and snapshot readiness.",
    success: Schema.NullOr(RuntimeControlStatus),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("vscope_run_device", {
    description: "Start the active vscope device.",
    success: Schema.String,
    failure: RuntimeApiError,
  }),
  Tool.make("vscope_stop_device", {
    description: "Stop the active vscope device.",
    success: Schema.String,
    failure: RuntimeApiError,
  }),
  Tool.make("vscope_trigger_device", {
    description: "Trigger the active vscope device.",
    success: Schema.String,
    failure: RuntimeApiError,
  }),
  Tool.make("vscope_read_config", {
    description: "Read editable timing and trigger configuration.",
    success: Schema.NullOr(RuntimeMcpDeviceConfigPayload),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("vscope_write_config", {
    description: "Patch editable timing and trigger configuration while halted.",
    parameters: RuntimeWriteConfigRequest,
    success: Schema.String,
    failure: RuntimeApiError,
  }),
  Tool.make("vscope_read_rt_buffers", {
    description: "Read RT buffer values keyed by RT buffer index.",
    success: Schema.NullOr(RuntimeRtBuffersPayload),
    failure: RuntimeApiError,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("vscope_write_rt_buffers", {
    description: "Patch RT buffer values by numeric RT buffer index while halted.",
    parameters: RuntimeWriteRtBuffersMcpRequest,
    success: Schema.String,
    failure: RuntimeApiError,
  }),
  Tool.make("vscope_read_channel_catalog", {
    description: "Read the active device variable catalog keyed by catalog index.",
    success: Schema.NullOr(RuntimeChannelCatalogPayload),
    failure: RuntimeApiError,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("vscope_read_channel_map", {
    description: "Read channel-to-catalog assignments keyed by channel index.",
    success: Schema.NullOr(RuntimeChannelMapPayload),
    failure: RuntimeApiError,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("vscope_write_channel_map", {
    description: "Patch channel-to-catalog assignments by channel index while halted.",
    parameters: RuntimeWriteChannelMapMcpRequest,
    success: Schema.String,
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
  Tool.make("vscope_save_snapshot", {
    description: "Save a ready vscope snapshot.",
    parameters: RuntimeSnapshotCaptureRequest,
    success: Schema.String,
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
    return RuntimeMcpToolkit.of({
      vscope_get_app: () => core.app.pipe(Effect.map(appDto)),
      vscope_list_ports: (filters) =>
        core.query({ type: "ports/list" }).pipe(
          Effect.map((result) => {
            const ports = result.type === "ports/list" ? result.ports.map(runtimePortInfo) : [];
            return ports.filter((port) => matchesPortFilters(port, filters));
          }),
          Effect.mapError(runtimeApiError),
        ),
      vscope_get_active_device: () =>
        core.activeDevice.pipe(Effect.map(activeDeviceDto), Effect.map(mcpActiveDeviceDto)),
      vscope_connect_device: ({ path }) =>
        core
          .dispatch({ type: "devices/connect", path })
          .pipe(Effect.as("ok"), Effect.mapError(runtimeApiError)),
      vscope_disconnect_device: () =>
        core
          .dispatch({ type: "devices/disconnect" })
          .pipe(Effect.as("ok"), Effect.mapError(runtimeApiError)),
      vscope_get_device_status: () => core.deviceStatus.pipe(Effect.map(statusDto)),
      vscope_run_device: () =>
        core
          .dispatch({ type: "devices/run" })
          .pipe(Effect.as("ok"), Effect.mapError(runtimeApiError)),
      vscope_stop_device: () =>
        core
          .dispatch({ type: "devices/stop" })
          .pipe(Effect.as("ok"), Effect.mapError(runtimeApiError)),
      vscope_trigger_device: () =>
        core
          .dispatch({ type: "devices/trigger" })
          .pipe(Effect.as("ok"), Effect.mapError(runtimeApiError)),
      vscope_read_config: () =>
        core.deviceConfig.pipe(Effect.map(configDto), Effect.map(mcpConfigDto)),
      vscope_write_config: (patch) =>
        writeConfig(core, patch).pipe(Effect.as("ok"), Effect.mapError(runtimeApiError)),
      vscope_read_rt_buffers: () => readRtBuffers(core),
      vscope_write_rt_buffers: (request) =>
        writeRtBuffers(core, request).pipe(Effect.as("ok"), Effect.mapError(runtimeApiError)),
      vscope_read_channel_catalog: () => readChannelCatalog(core),
      vscope_read_channel_map: () => readChannelMap(core),
      vscope_write_channel_map: (request) =>
        writeChannelMap(core, request).pipe(Effect.as("ok"), Effect.mapError(runtimeApiError)),
      vscope_read_frame: () => core.lastFrame.pipe(Effect.map(framePayload)),
      vscope_save_snapshot: ({ label }) =>
        core
          .dispatch({ type: "snapshots/capture", label })
          .pipe(Effect.as("ok"), Effect.mapError(runtimeApiError)),
      vscope_list_snapshots: () =>
        core.query({ type: "snapshots/list" }).pipe(
          Effect.map((result) =>
            result.type === "snapshots/list" ? result.snapshots.map(snapshotDto) : [],
          ),
          Effect.mapError(runtimeApiError),
        ),
    });
  }),
);
