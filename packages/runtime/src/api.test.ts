import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_PREFERENCES, DEFAULT_SETTINGS, noRecovery } from "@vscope/shared";
import { VScopeEndianness, VScopeState } from "@vscope/serial";
import type { VScopeTiming, VScopeTrigger } from "@vscope/serial";
import { Effect, Stream } from "effect";

import { makeRuntimeApi } from "./api";
import type { CoreCommand, CoreState } from "./core/model";
import type { RuntimeCoreService } from "./core/service";

describe("@vscope/runtime api", () => {
  it.effect("exposes runtime state as JSON-friendly DTOs", () =>
    Effect.gen(function* () {
      const api = makeRuntimeApi(fakeCore(initialState()));

      const state = yield* api.rpc.getState;

      expect(state.device?.rtValues).toEqual([
        [0, 1.5],
        [1, 2.5],
      ]);
    }),
  );

  it.effect("reads latest frame without timestamps or channel arguments", () =>
    Effect.gen(function* () {
      const api = makeRuntimeApi(fakeCore(initialState()));

      const frame = yield* api.mcp.readFrame;

      expect(frame).toEqual({
        values: [10, 20],
        channelMap: [3, 4],
      });
    }),
  );

  it.effect("shallow-merges MCP config writes in deterministic command order", () =>
    Effect.gen(function* () {
      const commands: Array<CoreCommand> = [];
      const api = makeRuntimeApi(fakeCore(initialState(), commands));

      const config = yield* api.mcp.writeConfig({
        timing: { divider: 8 },
        trigger: { mode: "falling" },
        channelMap: [3, 7],
        rtValues: { "1": 42 },
      });

      expect(commands).toEqual([
        { type: "devices/setTiming", timing: { divider: 8, preTrig: 2 } },
        {
          type: "devices/setTrigger",
          trigger: { threshold: 1.25, channel: 0, mode: "falling" },
        },
        { type: "devices/setChannelMap", channel: 1, variable: 7 },
        { type: "devices/setRtValue", index: 1, value: 42 },
      ]);
      expect(config.timing).toEqual({ divider: 8, preTrig: 2 });
      expect(config.trigger).toEqual({ threshold: 1.25, channel: 0, mode: "falling" });
      expect(config.channelMap).toEqual([3, 7]);
      expect(config.rtValues).toEqual([
        [0, 1.5],
        [1, 42],
      ]);
    }),
  );
});

function fakeCore(startingState: CoreState, commands: Array<CoreCommand> = []): RuntimeCoreService {
  let state = startingState;
  return {
    changes: Stream.fromIterable([state]),
    getSnapshot: Effect.sync(() => state),
    dispatch: (command) =>
      Effect.sync(() => {
        commands.push(command);
        state = applyCommand(state, command);
        return state;
      }),
    query: (query) =>
      Effect.sync(() => {
        switch (query.type) {
          case "ports/list":
            return {
              type: "ports/list",
              ports: [],
            };
          case "snapshots/list":
            return {
              type: "snapshots/list",
              snapshots: state.snapshots,
            };
          case "snapshots/readSamples":
            return {
              type: "snapshots/readSamples",
              samples: null,
            };
        }
      }),
    shutdown: Effect.void,
  };
}

function applyCommand(state: CoreState, command: CoreCommand): CoreState {
  if (!state.device) {
    return state;
  }

  switch (command.type) {
    case "devices/setTiming":
      return {
        ...state,
        device: {
          ...state.device,
          timing: command.timing,
        },
      };
    case "devices/setTrigger":
      return {
        ...state,
        device: {
          ...state.device,
          trigger: command.trigger,
        },
      };
    case "devices/setChannelMap": {
      const channelMap = [...(state.device.channelMap ?? [])];
      channelMap[command.channel] = command.variable;
      return {
        ...state,
        device: {
          ...state.device,
          channelMap,
        },
      };
    }
    case "devices/setRtValue": {
      const rtValues = new Map(state.device.rtValues);
      rtValues.set(command.index, command.value);
      return {
        ...state,
        device: {
          ...state.device,
          rtValues,
        },
      };
    }
    default:
      return state;
  }
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
        variables: ["a", "b", "c", "d", "e", "f", "g", "h"],
        rtLabels: ["gain", "offset"],
        channelMap: [3, 4],
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
      channelMap: [3, 4],
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
