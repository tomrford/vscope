import {
  createLivePlotEngine,
  type LiveHoverPayload,
  type LivePlotEngine,
  type LivePoint,
  type LiveSeries,
  type TimeDomain,
} from "@vscope/liveplot";
import { RuntimeEndpoint, type SnapshotRecord, type Theme } from "@vscope/shared";
import { Effect } from "effect";

import { channelColor } from "./liveplot.ts";

// Snapshot sample data and the shared viewport live outside the Foldkit model,
// mirroring liveplot.ts: the model tracks load status and route only, while
// the canvases and their pan/zoom interactions render from this store.

export interface SnapshotViewEntry {
  readonly id: string;
  readonly label: string;
  readonly durationSeconds: number;
  readonly sampleRateHz: number | null;
  readonly channelCount: number;
  readonly channelLabels: ReadonlyArray<string>;
}

interface LoadedSamples {
  readonly channels: ReadonlyArray<Array<LivePoint>>;
  readonly durationSeconds: number;
}

const samplesById = new Map<string, LoadedSamples>();
const plots = new Map<number, LivePlotEngine>();
let viewEntries: ReadonlyArray<SnapshotViewEntry> = [];
let viewKey = "";
let viewport: TimeDomain | null = null;
let theme: Exclude<Theme, "system"> = "light";

// Later snapshots in a comparison reuse the channel colour at reduced alpha so
// per-channel identity stays primary and capture identity reads as depth.
const compareAlpha = ["", "8c", "59", "40"] as const;
const compareColor = (channel: number, snapshotIndex: number): string =>
  `${channelColor(channel)}${compareAlpha[Math.min(snapshotIndex, compareAlpha.length - 1)]}`;

const fullDomain = (): TimeDomain => {
  const end = viewEntries.reduce((max, entry) => Math.max(max, entry.durationSeconds), 0);
  return { start: 0, end: end > 0 ? end : 1 };
};

const currentDomain = (): TimeDomain => viewport ?? fullDomain();

const seriesFor = (channel: number): Array<LiveSeries> =>
  viewEntries.flatMap((entry, index) => {
    const points = samplesById.get(entry.id)?.channels[channel];
    if (!points || points.length === 0) return [];
    return [
      {
        id: `${entry.id}:${channel}`,
        label: entry.label,
        color: compareColor(channel, index),
        points,
      },
    ];
  });

// The engine emits gesture intents; applying them here (rather than per
// engine) is what keeps the time axis synced across every channel row.
const onDomainChange = (domain: TimeDomain | null): void => {
  viewport = domain;
  render();
};

// Shared x-cursor: hovering one row imposes the same scrub time on the
// others, so every channel reads out at the hovered instant. setScrubTime is
// the hot path; configFor carries the cursor too so re-renders preserve it.
let cursor: { readonly channel: number; readonly time: number } | null = null;

const onHoverFor =
  (channel: number) =>
  (payload: LiveHoverPayload | null): void => {
    cursor = payload ? { channel, time: payload.time } : null;
    for (const [entry, engine] of plots) {
      if (entry !== channel) engine.setScrubTime(payload ? payload.time : null);
    }
  };

const configFor = (channel: number) => {
  const domain = currentDomain();
  return {
    series: seriesFor(channel),
    windowSecs: domain.end - domain.start,
    paused: true,
    loading: viewEntries.some((entry) => !samplesById.has(entry.id)),
    emptyText: viewEntries.length === 0 ? "No snapshots selected" : "No data for this channel",
    theme,
    scrubEnabled: true,
    showGrid: true,
    showFill: false,
    domain,
    domainBounds: fullDomain(),
    onDomainChange,
    scrubTime: cursor !== null && cursor.channel !== channel ? cursor.time : null,
    onHover: onHoverFor(channel),
  };
};

const render = (): void => {
  for (const [channel, engine] of plots) {
    engine.setConfig(configFor(channel));
  }
};

export const configureSnapshotPlots = (entries: ReadonlyArray<SnapshotViewEntry>): void => {
  const key = entries.map((entry) => entry.id).join(",");
  if (key !== viewKey) {
    viewKey = key;
    viewport = null;
  }
  viewEntries = entries;
  render();
};

export const setSnapshotPlotTheme = (nextTheme: Exclude<Theme, "system">): void => {
  theme = nextTheme;
  render();
};

// --- sample loading -----------------------------------------------------

export class SnapshotSamplesError extends Error {}

const decodeSamples = (
  buffer: ArrayBuffer,
  channelCount: number,
  sampleCount: number,
  durationSeconds: number,
  sampleRateHz: number | null,
): LoadedSamples => {
  const view = new DataView(buffer);
  const dt =
    sampleRateHz !== null && sampleRateHz > 0
      ? 1 / sampleRateHz
      : durationSeconds / Math.max(1, sampleCount - 1);
  const channels: Array<Array<LivePoint>> = Array.from({ length: channelCount }, () => []);
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const time = sample * dt;
    const base = sample * channelCount * Float32Array.BYTES_PER_ELEMENT;
    for (let channel = 0; channel < channelCount; channel += 1) {
      channels[channel].push({
        time,
        value: view.getFloat32(base + channel * Float32Array.BYTES_PER_ELEMENT, true),
      });
    }
  }
  return { channels, durationSeconds };
};

const headerInt = (response: Response, name: string): number => {
  const value = Number(response.headers.get(name));
  if (!Number.isInteger(value) || value < 0) {
    throw new SnapshotSamplesError(`Missing or invalid ${name} header.`);
  }
  return value;
};

export const loadSnapshotSamples = Effect.fn("SnapshotSamples.load")(function* (input: {
  readonly id: string;
  readonly durationSeconds: number;
  readonly sampleRateHz: number | null;
}) {
  yield* Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(
        `${RuntimeEndpoint.snapshots}/${encodeURIComponent(input.id)}/samples`,
        { signal },
      );
      if (!response.ok) {
        throw new SnapshotSamplesError(`Sample download failed (${response.status}).`);
      }
      const channelCount = headerInt(response, "x-vscope-channel-count");
      const sampleCount = headerInt(response, "x-vscope-sample-count");
      const buffer = await response.arrayBuffer();
      const expected = channelCount * sampleCount * Float32Array.BYTES_PER_ELEMENT;
      if (buffer.byteLength !== expected) {
        throw new SnapshotSamplesError(
          `Expected ${expected} sample bytes, received ${buffer.byteLength}.`,
        );
      }
      samplesById.set(
        input.id,
        decodeSamples(buffer, channelCount, sampleCount, input.durationSeconds, input.sampleRateHz),
      );
      render();
    },
    catch: (cause) =>
      cause instanceof SnapshotSamplesError
        ? cause
        : new SnapshotSamplesError(cause instanceof Error ? cause.message : String(cause)),
  });
});

// --- channel labels -----------------------------------------------------

const metadataVariables = (record: SnapshotRecord): ReadonlyArray<string> => {
  const variables = record.metadata["variables"];
  return Array.isArray(variables)
    ? variables.map((entry) => (typeof entry === "string" ? entry : ""))
    : [];
};

export const snapshotChannelLabels = (record: SnapshotRecord): ReadonlyArray<string> => {
  const variables = metadataVariables(record);
  return Array.from({ length: record.sample.channelCount }, (_, channel) => {
    const variable = record.channelMap[channel];
    const label = variable === undefined ? "" : (variables[variable] ?? "");
    return label || `CH${channel + 1}`;
  });
};

// --- mount ----------------------------------------------------------------

export const acquireSnapshotPlot = (
  element: Element,
  channel: number,
): Effect.Effect<{ readonly channel: number; readonly engine: LivePlotEngine } | null> =>
  Effect.sync(() => {
    if (!(element instanceof HTMLCanvasElement)) return null;
    const container = element.parentElement;
    if (!(container instanceof HTMLElement)) return null;

    const engine = createLivePlotEngine(element, container, configFor(channel));
    plots.set(channel, engine);
    return { channel, engine };
  });

export const releaseSnapshotPlot = (
  mounted: { readonly channel: number; readonly engine: LivePlotEngine } | null,
): Effect.Effect<void> =>
  Effect.sync(() => {
    if (!mounted) return;
    mounted.engine.destroy();
    if (plots.get(mounted.channel) === mounted.engine) plots.delete(mounted.channel);
  });
