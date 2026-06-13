import type { LivePoint, LiveSeries } from "./core";

export type LiveHistoryDeviceInput = {
  path: string;
  label: string;
  frameValues: number[] | null;
};

export type LiveHistoryChannelSeries = {
  id: string;
  label: string;
  color: string;
  points: LivePoint[];
};

type DeviceHistory = {
  path: string;
  label: string;
  color: string;
  channels: LivePoint[][];
};

export type LiveHistoryState = {
  channelCount: number;
  byPath: Map<string, DeviceHistory>;
};

export const createLiveHistoryState = (channelCount: number): LiveHistoryState => ({
  channelCount,
  byPath: new Map(),
});

const ensureChannels = (existing: LivePoint[][], channelCount: number): LivePoint[][] => {
  if (existing.length === channelCount) return existing;
  return Array.from({ length: channelCount }, (_, idx) => existing[idx] ?? []);
};

export const reconcileHistoryDevices = (
  state: LiveHistoryState,
  devices: LiveHistoryDeviceInput[],
  channelCount: number,
  colorForPath: (path: string) => string,
): void => {
  state.channelCount = channelCount;

  const keep = new Set(devices.map((d) => d.path));
  for (const path of state.byPath.keys()) {
    if (!keep.has(path)) state.byPath.delete(path);
  }

  for (const device of devices) {
    const current = state.byPath.get(device.path);
    if (!current) {
      state.byPath.set(device.path, {
        path: device.path,
        label: device.label,
        color: colorForPath(device.path),
        channels: Array.from({ length: channelCount }, () => []),
      });
      continue;
    }

    current.label = device.label;
    current.color = colorForPath(device.path);
    current.channels = ensureChannels(current.channels, channelCount);
  }
};

export const clearHistoryChannels = (state: LiveHistoryState, channelIndices: number[]): void => {
  if (channelIndices.length === 0) return;

  for (const device of state.byPath.values()) {
    for (const idx of channelIndices) {
      if (idx < 0 || idx >= device.channels.length) continue;
      device.channels[idx] = [];
    }
  }
};

export const ingestFrameTick = (
  state: LiveHistoryState,
  devices: LiveHistoryDeviceInput[],
  atSec: number,
  windowSecs: number,
): void => {
  const cutoff = atSec - windowSecs - 1;

  for (const input of devices) {
    const history = state.byPath.get(input.path);
    if (!history) continue;

    if (input.frameValues) {
      for (let i = 0; i < state.channelCount; i += 1) {
        const value = input.frameValues[i];
        if (!Number.isFinite(value)) continue;
        history.channels[i].push({ time: atSec, value });
      }
    }

    for (let i = 0; i < state.channelCount; i += 1) {
      const channel = history.channels[i];
      let firstKeep = 0;
      while (firstKeep < channel.length && channel[firstKeep].time < cutoff) {
        firstKeep += 1;
      }
      if (firstKeep > 0) {
        history.channels[i] = channel.slice(firstKeep);
      }
    }
  }
};

export const pruneHistoryWindow = (
  state: LiveHistoryState,
  atSec: number,
  windowSecs: number,
): void => {
  const cutoff = atSec - windowSecs - 1;
  for (const history of state.byPath.values()) {
    for (let i = 0; i < state.channelCount; i += 1) {
      const channel = history.channels[i];
      let firstKeep = 0;
      while (firstKeep < channel.length && channel[firstKeep].time < cutoff) {
        firstKeep += 1;
      }
      if (firstKeep > 0) {
        history.channels[i] = channel.slice(firstKeep);
      }
    }
  }
};

export const toChannelSeries = (state: LiveHistoryState, channelIndex: number): LiveSeries[] => {
  if (channelIndex < 0 || channelIndex >= state.channelCount) return [];

  const series: LiveSeries[] = [];
  for (const device of state.byPath.values()) {
    series.push({
      id: device.path,
      label: device.label,
      color: device.color,
      points: device.channels[channelIndex] ?? [],
    });
  }

  return series;
};
