import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_PREFERENCES, DEFAULT_SETTINGS, noRecovery } from "@vscope/shared";
import { VScopeEndianness, VScopeState } from "@vscope/serial";
import type { VScopeTiming, VScopeTrigger } from "@vscope/serial";
import { Effect, Option, Stream } from "effect";

import { makeRuntimeApi } from "./api";
import type {
  ActiveDeviceState,
  CoreCommand,
  CoreQueryResult,
  DeviceConfigState,
  RuntimeAppState,
} from "./core/model";
import type { CommandPermissions } from "./core/policy";
import type { RuntimeCoreService } from "./core/service";

describe("@vscope/runtime api", () => {
  it.effect("exposes split device config as JSON-friendly DTOs", () =>
    Effect.gen(function* () {
      const api = makeRuntimeApi(fakeCore(initialStores()));

      const activeDevice = yield* api.rpc.getActiveDevice;
      const config = yield* api.rpc.getConfig;

      expect(activeDevice?.rtLabels).toEqual(["gain", "offset"]);
      expect(config?.rtValues).toEqual([
        [0, 1.5],
        [1, 2.5],
      ]);
    }),
  );

  it.effect("reads latest frame without timestamps or channel arguments", () =>
    Effect.gen(function* () {
      const api = makeRuntimeApi(fakeCore(initialStores()));

      const frame = yield* api.mcp.readFrame;

      expect(frame).toEqual({
        values: [10, 20],
      });
    }),
  );

  it.effect("exposes command permissions as a subscription", () =>
    Effect.gen(function* () {
      const api = makeRuntimeApi(fakeCore(initialStores()));

      const permissions = yield* api.subscriptions.permissions.pipe(Stream.runHead);

      expect(Option.isSome(permissions)).toBe(true);
      if (Option.isNone(permissions)) {
        throw new Error("Expected permissions emission");
      }
      expect(permissions.value.mode).toBe("halted");
    }),
  );
});

interface FakeStores {
  readonly app: RuntimeAppState;
  readonly activeDevice: ActiveDeviceState | null;
  readonly status: RuntimeCoreService["deviceStatus"] extends Effect.Effect<infer A> ? A : never;
  readonly config: DeviceConfigState | null;
}

function fakeCore(stores: FakeStores, commands: Array<CoreCommand> = []): RuntimeCoreService {
  let config = stores.config;
  const snapshots: Extract<CoreQueryResult, { readonly type: "snapshots/list" }> = {
    type: "snapshots/list",
    snapshots: [],
  };
  const permissions = commandPermissions();
  return {
    app: Effect.succeed(stores.app),
    appChanges: Stream.fromIterable([stores.app]),
    snapshots: Effect.succeed(snapshots.snapshots),
    snapshotChanges: Stream.fromIterable([snapshots.snapshots]),
    activeDevice: Effect.succeed(stores.activeDevice),
    activeDeviceChanges: Stream.fromIterable([stores.activeDevice]),
    deviceStatus: Effect.succeed(stores.status),
    deviceStatusChanges: Stream.fromIterable([stores.status]),
    deviceConfig: Effect.sync(() => config),
    deviceConfigChanges: Stream.fromIterable([config]),
    permissions: Effect.succeed(permissions),
    readModel: Effect.sync(() => ({
      app: stores.app,
      snapshots: snapshots.snapshots,
      activeDevice: stores.activeDevice,
      deviceStatus: stores.status,
      deviceConfig: config,
      permissions,
    })),
    dispatch: (command) =>
      Effect.sync(() => {
        commands.push(command);
        config = applyCommand(config, command);
      }),
    query: (query) =>
      Effect.sync((): CoreQueryResult => {
        switch (query.type) {
          case "ports/list":
            return {
              type: "ports/list",
              ports: [],
            };
          case "snapshots/list":
            return snapshots;
          case "snapshots/readSamples":
            return {
              type: "snapshots/readSamples",
              samples: null,
            };
        }
      }),
    shutdown: Effect.void,
    frames: Stream.empty,
    lastFrame: Effect.sync(() => (stores.activeDevice ? [10, 20] : null)),
  };
}

function applyCommand(
  config: DeviceConfigState | null,
  command: CoreCommand,
): DeviceConfigState | null {
  if (!config) {
    return config;
  }

  switch (command.type) {
    case "devices/setTiming":
      return {
        ...config,
        timing: command.timing,
      };
    case "devices/setTrigger":
      return {
        ...config,
        trigger: command.trigger,
      };
    case "devices/setChannelMap": {
      const channelMap = [...config.channelMap];
      channelMap[command.channel] = command.variable;
      return {
        ...config,
        channelMap,
      };
    }
    case "devices/setRtValue": {
      const rtValues = new Map(config.rtValues);
      rtValues.set(command.index, command.value);
      return {
        ...config,
        rtValues,
      };
    }
    default:
      return config;
  }
}

function initialStores(): FakeStores {
  const timing: VScopeTiming = { divider: 4, preTrig: 2 };
  const trigger: VScopeTrigger = { threshold: 1.25, channel: 0, mode: "rising" };
  return {
    app: {
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
    },
    activeDevice: {
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
      variables: ["a", "b", "c", "d", "e", "f", "g", "h"],
      rtLabels: ["gain", "offset"],
      error: null,
    },
    status: {
      state: VScopeState.Halted,
      requestedState: VScopeState.Halted,
      snapshotValid: false,
      requestPending: false,
      triggerEnabled: true,
      flags: 0,
    },
    config: {
      timing,
      trigger,
      channelMap: [3, 4],
      rtValues: new Map([
        [0, 1.5],
        [1, 2.5],
      ]),
    },
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
