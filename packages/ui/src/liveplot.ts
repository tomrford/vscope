import {
  createLivePlotEngine,
  type LivePlotEngine,
  type LivePoint,
  type LiveSeries,
} from "@vscope/liveplot";
import { Effect } from "effect";

import { chartColors } from "./theme.stylex.ts";

export interface LiveFrameInput {
  readonly path: string;
  readonly labels: ReadonlyArray<string>;
  readonly mapping: ReadonlyArray<number>;
  readonly values: ReadonlyArray<number> | null;
  readonly windowSeconds: number;
}

export interface MountedLivePlot {
  readonly channel: number;
  readonly engine: LivePlotEngine;
}

const engines = new Map<number, LivePlotEngine>();
let activePath: string | null = null;
let channelHistory: Array<Array<LivePoint>> = [];
let labels: ReadonlyArray<string> = [];
let mapping: ReadonlyArray<number> = [];
let windowSeconds = 30;

const seriesFor = (channel: number): Array<LiveSeries> => [
  {
    id: `channel-${channel}`,
    label: labels[channel] ?? `Channel ${channel + 1}`,
    color: chartColors[channel % chartColors.length] ?? chartColors[0],
    points: channelHistory[channel] ?? [],
  },
];

const configFor = (channel: number, loading = false) => ({
  series: seriesFor(channel),
  windowSecs: windowSeconds,
  paused: false,
  loading,
  emptyText: activePath === null ? "Connect a device" : "Waiting for data",
  theme: "light" as const,
  scrubEnabled: false,
  showGrid: true,
  showFill: false,
});

const render = (loading = false): void => {
  for (const [channel, engine] of engines) {
    engine.setConfig(configFor(channel, loading && (channelHistory[channel]?.length ?? 0) === 0));
  }
};

export const acquireLivePlot = (
  element: Element,
  channel: number,
): Effect.Effect<MountedLivePlot | null> =>
  Effect.sync(() => {
    if (!(element instanceof HTMLCanvasElement)) return null;
    const container = element.parentElement;
    if (!(container instanceof HTMLElement)) return null;

    const engine = createLivePlotEngine(
      element,
      container,
      configFor(channel, activePath !== null),
    );
    engines.set(channel, engine);
    return { channel, engine };
  });

export const releaseLivePlot = (mounted: MountedLivePlot | null): Effect.Effect<void> =>
  Effect.sync(() => {
    if (!mounted) return;
    mounted.engine.destroy();
    if (engines.get(mounted.channel) === mounted.engine) engines.delete(mounted.channel);
  });

export const ingestLiveFrame = (input: LiveFrameInput): void => {
  const channelCount = Math.max(input.labels.length, input.values?.length ?? 0);
  const continuingDevice = activePath === input.path && channelHistory.length === channelCount;
  if (!continuingDevice) {
    activePath = input.path;
    channelHistory = Array.from({ length: channelCount }, () => []);
  } else {
    for (let channel = 0; channel < channelCount; channel += 1) {
      if (mapping[channel] !== input.mapping[channel]) channelHistory[channel] = [];
    }
  }

  labels = input.labels;
  mapping = input.mapping;
  windowSeconds = Math.max(1, input.windowSeconds);
  const at = Date.now() / 1000;
  const cutoff = at - windowSeconds - 1;

  if (input.values !== null) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const value = input.values[channel];
      if (value === undefined || !Number.isFinite(value)) continue;
      channelHistory[channel]?.push({ time: at, value });
    }
  }

  for (const points of channelHistory) {
    let firstVisible = 0;
    while (firstVisible < points.length && (points[firstVisible]?.time ?? at) < cutoff) {
      firstVisible += 1;
    }
    if (firstVisible > 0) points.splice(0, firstVisible);
  }

  render(input.values === null);
};

export const resetLivePlot = (): void => {
  activePath = null;
  channelHistory = [];
  labels = [];
  mapping = [];
  render();
};
