import {
  PersistentId,
  RuntimeActiveDevice,
  RuntimeControlStatus,
  RuntimeDeviceConfigPayload,
  RuntimeFramePayload,
  RuntimePortInfo,
  RuntimeSetTimingRequest,
  RuntimeSetTriggerRequest,
  SnapshotRecord,
  Timestamp,
} from "@vscope/shared";
import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";
import * as Url from "foldkit/url";

import {
  ActiveDeviceChanged,
  DeviceConfigChanged,
  DeviceStatusReceived,
  FrameReceived,
  ChannelMapChanged,
  PortsLoaded,
  PortsRescanned,
  PortsRescanFailed,
  RefreshPortsRequested,
  RuntimeLinkDown,
  SaveSnapshotRequested,
  SnapshotDeleteConfirmed,
  SnapshotDeleteToggled,
  SnapshotFavoriteChanged,
  SnapshotLabelChanged,
  SnapshotSamplesLoaded,
  SnapshotsChanged,
  SetTimingRequested,
  SetTriggerRequested,
  SetChannelMapRequested,
  TimingTotalChanged,
  RtValueChanged,
  RtValueCommitted,
  TriggerChannelChanged,
  TriggerThresholdChanged,
  init,
  update,
} from "./model.ts";

const testUrl = Option.getOrThrow(Url.fromString("http://127.0.0.1:5173/"));

const activeDevice = (connected: boolean) =>
  RuntimeActiveDevice.make({
    path: "/dev/tty.test",
    deviceName: "test-device",
    connected,
    info: null,
    variables: ["a", "b", "c"],
    rtLabels: [],
    error: null,
  });

describe("@vscope/ui model", () => {
  it("starts offline and scans ports without marking the UI busy", () => {
    const [model, commands] = init(testUrl);

    expect(model.linkUp).toBe(false);
    expect(model.busy).toBeNull();
    expect(model.ports).toHaveLength(0);
    expect(commands.map((command) => command.name)).toEqual(["RefreshPorts"]);
  });

  it("folds facet values independently and keeps stale data on link loss", () => {
    const [model] = init(testUrl);
    const port = RuntimePortInfo.make({ path: "/dev/tty.test" });
    const [refreshing] = update(model, RefreshPortsRequested());
    const [backgroundFailed] = update(
      refreshing,
      PortsRescanFailed({ message: "background scan failed" }),
    );
    const [withPorts] = update(backgroundFailed, PortsLoaded({ ports: [port] }));
    const [withStatus] = update(
      withPorts,
      DeviceStatusReceived({
        status: RuntimeControlStatus.make({ state: "running", snapshotValid: false }),
      }),
    );
    const [offline] = update(withStatus, RuntimeLinkDown());

    expect(withPorts.selectedPort).toBe(port.path);
    expect(backgroundFailed.busy).toBe("refresh");
    expect(backgroundFailed.error).toBeNull();
    expect(withPorts.busy).toBeNull();
    expect(withStatus.status?.state).toBe("running");
    expect(withStatus.linkUp).toBe(true);
    expect(offline.linkUp).toBe(false);
    expect(offline.status?.state).toBe("running");
    expect(offline.ports).toEqual([port]);
  });

  it("rescans ports and clears status when a connected device disappears", () => {
    const [model] = init(testUrl);
    const [connected] = update(model, ActiveDeviceChanged({ device: activeDevice(true) }));
    const [running] = update(
      connected,
      DeviceStatusReceived({
        status: RuntimeControlStatus.make({ state: "running", snapshotValid: false }),
      }),
    );
    const [named] = update(running, SnapshotLabelChanged({ value: "capture" }));
    const [capturing] = update(named, SaveSnapshotRequested());
    const [disconnected, commands] = update(
      capturing,
      ActiveDeviceChanged({ device: activeDevice(false) }),
    );
    const [rescanned] = update(disconnected, PortsRescanned({ ports: [] }));
    const [failedRescan] = update(disconnected, PortsRescanFailed({ message: "port scan failed" }));

    expect(disconnected.activeDevice?.connected).toBe(false);
    expect(disconnected.status).toBeNull();
    expect(commands.map((command) => command.name)).toEqual(["RefreshPorts"]);
    expect(rescanned.busy).toBe("saveSnapshot");
    expect(failedRescan.busy).toBe("saveSnapshot");
    expect(failedRescan.error).toBeNull();
  });

  it("reseeds drafts only when the device config facet changes", () => {
    const [model] = init(testUrl);
    const [editing] = update(model, TimingTotalChanged({ value: "edited" }));
    const config = RuntimeDeviceConfigPayload.make({
      timing: RuntimeSetTimingRequest.make({
        totalDurationSeconds: 2.5,
        preTriggerSeconds: 0.5,
      }),
      trigger: RuntimeSetTriggerRequest.make({
        channel: 3,
        threshold: 1.25,
        mode: "rising",
      }),
      channelMap: [0, 2],
      rtValues: [
        [0, 1],
        [1, 2],
      ],
    });
    const [configured] = update(editing, DeviceConfigChanged({ config }));

    expect(configured.timingTotalSecondsDraft).toBe("2.5");
    expect(configured.timingPreTriggerSecondsDraft).toBe("0.5");
    expect(configured.triggerChannelDraft).toBe("3");
    expect(configured.triggerThresholdDraft).toBe("1.25");
    expect(configured.triggerModeDraft).toBe("rising");
    expect(configured.channelMapDraft).toEqual(["0", "2"]);
    expect(configured.rtValueDrafts).toEqual(["1", "2"]);
  });

  it("creates batched commands for changed channel mappings", () => {
    const [model] = init(testUrl);
    const [connected] = update(model, ActiveDeviceChanged({ device: activeDevice(true) }));
    const config = RuntimeDeviceConfigPayload.make({
      timing: null,
      trigger: null,
      channelMap: [0, 1],
      rtValues: [
        [0, 1],
        [1, 2],
      ],
    });
    const [configured] = update(connected, DeviceConfigChanged({ config }));
    const [mapEdited] = update(configured, ChannelMapChanged({ channel: 1, value: "2" }));
    const [mapSaving, mapCommands] = update(mapEdited, SetChannelMapRequested());

    expect(mapSaving.busy).toBe("setChannelMap");
    expect(mapCommands.map((command) => command.name)).toEqual(["SetChannelMap"]);
  });

  it("writes RT values individually on commit, skipping unchanged and blank fields", () => {
    const [model] = init(testUrl);
    const [connected] = update(model, ActiveDeviceChanged({ device: activeDevice(true) }));
    const config = RuntimeDeviceConfigPayload.make({
      timing: null,
      trigger: null,
      channelMap: [0],
      rtValues: [
        [0, 1],
        [1, 2],
      ],
    });
    const [configured] = update(connected, DeviceConfigChanged({ config }));
    const [edited] = update(configured, RtValueChanged({ index: 1, value: "2.50" }));
    const [committed, writeCommands] = update(
      edited,
      RtValueCommitted({ index: 1, value: "2.50" }),
    );
    const [unchanged, unchangedCommands] = update(
      configured,
      RtValueCommitted({ index: 0, value: "1" }),
    );
    const [blank, blankCommands] = update(configured, RtValueCommitted({ index: 0, value: "  " }));
    const [invalid, invalidCommands] = update(
      configured,
      RtValueCommitted({ index: 0, value: "abc" }),
    );

    expect(committed.busy).toBeNull();
    expect(committed.rtValueDrafts).toEqual(["1", "2.5"]);
    expect(writeCommands.map((command) => command.name)).toEqual(["WriteRtValue"]);
    expect(unchanged.rtValueDrafts).toEqual(["1", "2"]);
    expect(unchangedCommands).toHaveLength(0);
    expect(blank.rtValueDrafts).toEqual(["1", "2"]);
    expect(blankCommands).toHaveLength(0);
    expect(invalid.error).toBe("RT 1 must be a number.");
    expect(invalidCommands).toHaveLength(0);
  });

  it("keeps dirty RT drafts when a config emission reseeds the rest", () => {
    const [model] = init(testUrl);
    const [connected] = update(model, ActiveDeviceChanged({ device: activeDevice(true) }));
    const config = RuntimeDeviceConfigPayload.make({
      timing: null,
      trigger: null,
      channelMap: [0],
      rtValues: [
        [0, 1],
        [1, 2],
      ],
    });
    const [configured] = update(connected, DeviceConfigChanged({ config }));
    const [editing] = update(configured, RtValueChanged({ index: 1, value: "9" }));
    const echo = RuntimeDeviceConfigPayload.make({
      timing: null,
      trigger: null,
      channelMap: [0],
      rtValues: [
        [0, 5],
        [1, 2],
      ],
    });
    const [reseeded] = update(editing, DeviceConfigChanged({ config: echo }));

    expect(reseeded.rtValueDrafts).toEqual(["5", "9"]);
  });

  it("retains the latest throttled live frame for channel readouts", () => {
    const [model] = init(testUrl);
    const frame = RuntimeFramePayload.make({ values: [1.25, -0.5] });
    const [withFrame, commands] = update(model, FrameReceived({ frame }));

    expect(withFrame.frame).toEqual(frame);
    expect(withFrame.linkUp).toBe(false);
    expect(commands).toHaveLength(0);
  });

  it("rejects blank numeric drafts before creating runtime commands", () => {
    const [model] = init(testUrl);
    const [invalidTiming, timingCommands] = update(model, SetTimingRequested());
    const [withChannel] = update(model, TriggerChannelChanged({ value: "0" }));
    const [thresholdCleared] = update(withChannel, TriggerThresholdChanged({ value: "   " }));
    const [invalidTrigger, triggerCommands] = update(thresholdCleared, SetTriggerRequested());

    expect(invalidTiming.error).toBe("Total duration must be a positive number.");
    expect(timingCommands).toHaveLength(0);
    expect(invalidTrigger.error).toBe("Trigger threshold must be a number.");
    expect(triggerCommands).toHaveLength(0);
  });

  it("starts sample downloads when the viewer route and records are both known", () => {
    const viewerUrl = Option.getOrThrow(
      Url.fromString("http://127.0.0.1:5173/snapshots?ids=snap-1,snap-2"),
    );
    const [model] = init(viewerUrl);
    expect(model.route._tag).toBe("SnapshotsRoute");

    const snapshot = SnapshotRecord.make({
      id: PersistentId.make("snap-1"),
      label: "capture",
      device: { name: "test-device" },
      sample: {
        format: "f32le-interleaved-v1",
        channelCount: 2,
        sampleCount: 4,
        byteLength: 32,
        stored: true,
      },
      sampleRateHz: 1000,
      totalDurationSeconds: 0.004,
      preTriggerSeconds: 0,
      channelMap: [0, 1],
      trigger: { threshold: 0, channel: 0, mode: "rising" },
      rtValues: [],
      metadata: { variables: ["a", "b"] },
      favorite: false,
      createdAt: Timestamp.make("2026-07-12T00:00:00.000Z"),
      updatedAt: Timestamp.make("2026-07-12T00:00:00.000Z"),
    });
    const [loading, commands] = update(model, SnapshotsChanged({ snapshots: [snapshot] }));

    expect(commands.map((command) => command.name)).toEqual(["LoadSnapshotSamples"]);
    expect(loading.snapshotLoads["snap-1"]?.status).toBe("loading");
    expect(loading.snapshotLoads["snap-2"]).toBeUndefined();

    const [loaded] = update(loading, SnapshotSamplesLoaded({ id: "snap-1" }));
    const [again, repeatCommands] = update(loaded, SnapshotsChanged({ snapshots: [snapshot] }));
    const [afterDeletion, deletionCommands] = update(loaded, SnapshotsChanged({ snapshots: [] }));
    expect(loaded.snapshotLoads["snap-1"]?.status).toBe("loaded");
    expect(repeatCommands).toHaveLength(0);
    expect(again.snapshotLoads["snap-1"]?.status).toBe("loaded");
    expect(afterDeletion.snapshots).toEqual([snapshot]);
    expect(deletionCommands).toHaveLength(0);
  });

  it("requires a snapshot name before starting a save", () => {
    const [model] = init(testUrl);
    const [blank, blankCommands] = update(model, SaveSnapshotRequested());
    const [named] = update(model, SnapshotLabelChanged({ value: "capture" }));
    const [saving, saveCommands] = update(named, SaveSnapshotRequested());

    expect(blank.error).toBe("Enter a snapshot name.");
    expect(blankCommands).toHaveLength(0);
    expect(saving.busy).toBe("saveSnapshot");
    expect(saveCommands.map((command) => command.name)).toEqual(["SaveSnapshot"]);
  });

  it("confirms deletion and toggles favorites through runtime commands", () => {
    const [model] = init(testUrl);
    const id = PersistentId.make("snapshot:test");
    const [confirming] = update(model, SnapshotDeleteToggled({ id }));
    const [deleting, deleteCommands] = update(confirming, SnapshotDeleteConfirmed({ id }));
    const [favoriting, favoriteCommands] = update(
      model,
      SnapshotFavoriteChanged({ id, favorite: true }),
    );

    expect(confirming.snapshotDeleteCandidate).toBe(id);
    expect(deleting.snapshotDeleteCandidate).toBeNull();
    expect(deleting.busy).toBe("deleteSnapshot");
    expect(deleteCommands.map((command) => command.name)).toEqual(["DeleteSnapshot"]);
    expect(favoriting.busy).toBe("favoriteSnapshot");
    expect(favoriteCommands.map((command) => command.name)).toEqual(["SetSnapshotFavorite"]);
  });
});
