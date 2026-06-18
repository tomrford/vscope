import { describe, expect, it } from "@effect/vitest";
import {
  clearHistoryChannels,
  createLiveHistoryState,
  ingestFrameTick,
  pruneHistoryWindow,
  reconcileHistoryDevices,
  toChannelSeries,
} from "./history";

const colorForPath = (path: string): string => (path === "a" ? "#ff0000" : "#00ff00");

describe("live history", () => {
  it("ingests frames and exposes per-channel series", () => {
    const state = createLiveHistoryState(2);
    reconcileHistoryDevices(
      state,
      [{ path: "a", label: "Dev A", frameValues: null }],
      2,
      colorForPath,
    );

    ingestFrameTick(state, [{ path: "a", label: "Dev A", frameValues: [1, 2] }], 100, 10);

    const channel0 = toChannelSeries(state, 0);
    const channel1 = toChannelSeries(state, 1);

    expect(channel0).toHaveLength(1);
    expect(channel1).toHaveLength(1);
    expect(channel0[0].points[0]?.value).toBe(1);
    expect(channel1[0].points[0]?.value).toBe(2);
  });

  it("culls old points when window shrinks", () => {
    const state = createLiveHistoryState(1);
    reconcileHistoryDevices(
      state,
      [{ path: "a", label: "Dev A", frameValues: null }],
      1,
      colorForPath,
    );

    ingestFrameTick(state, [{ path: "a", label: "Dev A", frameValues: [1] }], 100, 30);
    ingestFrameTick(state, [{ path: "a", label: "Dev A", frameValues: [2] }], 140, 30);

    pruneHistoryWindow(state, 140, 10);
    const series = toChannelSeries(state, 0);

    expect(series[0].points).toHaveLength(1);
    expect(series[0].points[0]?.value).toBe(2);
  });

  it("clears channels on channel map changes", () => {
    const state = createLiveHistoryState(2);
    reconcileHistoryDevices(
      state,
      [{ path: "a", label: "Dev A", frameValues: null }],
      2,
      colorForPath,
    );

    ingestFrameTick(state, [{ path: "a", label: "Dev A", frameValues: [1, 2] }], 100, 10);

    clearHistoryChannels(state, [1]);

    expect(toChannelSeries(state, 0)[0].points).toHaveLength(1);
    expect(toChannelSeries(state, 1)[0].points).toHaveLength(0);
  });

  it("removes disconnected devices during reconcile", () => {
    const state = createLiveHistoryState(1);
    reconcileHistoryDevices(
      state,
      [
        { path: "a", label: "Dev A", frameValues: null },
        { path: "b", label: "Dev B", frameValues: null },
      ],
      1,
      colorForPath,
    );

    reconcileHistoryDevices(
      state,
      [{ path: "b", label: "Dev B", frameValues: null }],
      1,
      colorForPath,
    );

    const channel0 = toChannelSeries(state, 0);
    expect(channel0.map((s) => s.id)).toEqual(["b"]);
  });
});
