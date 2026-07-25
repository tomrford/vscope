import {
  DEFAULT_SETTINGS,
  PersistentId,
  RuntimeActiveDevice,
  RuntimeControlStatus,
  RuntimeDeviceConfigPayload,
  RuntimeFramePayload,
  RuntimePortInfo,
  RuntimeAppDto,
  RuntimeSetTimingRequest,
  RuntimeSetTriggerRequest,
  SnapshotRecord,
  Timestamp,
  noRecovery,
} from "@vscope/shared";
import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";
import * as Url from "foldkit/url";

import {
  ActivityClearRequested,
  ActiveDeviceChanged,
  AppChanged,
  DeviceConfigChanged,
  DeviceStatusReceived,
  FrameReceived,
  ChannelMapChanged,
  ConnectRequested,
  PortsLoaded,
  PortsRescanned,
  PortsRescanFailed,
  RefreshPortsRequested,
  RuntimeLinkDown,
  RuntimeCommandFailed,
  SaveSnapshotRequested,
  SelectedPortChanged,
  SnapshotDeleteConfirmed,
  SnapshotDeleteToggled,
  SnapshotCompareToggled,
  SnapshotFavoriteChanged,
  SettingsApplyRequested,
  SettingsTextChanged,
  SettingsThemeChanged,
  SystemThemeChanged,
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
  MenuToggled,
  init,
  resolvedTheme,
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

const comparisonSnapshot = (
  id: string,
  options: {
    readonly totalDurationSeconds?: number;
    readonly variables?: ReadonlyArray<string>;
  } = {},
) =>
  SnapshotRecord.make({
    id: PersistentId.make(id),
    label: id,
    device: { name: "test-device" },
    sample: {
      format: "f32le-interleaved-v1",
      channelCount: 2,
      sampleCount: 1000,
      byteLength: 8000,
      stored: true,
    },
    sampleRateHz: 10_000,
    totalDurationSeconds: options.totalDurationSeconds ?? 0.1,
    preTriggerSeconds: 0.025,
    channelMap: [0, 1],
    trigger: { threshold: 0.5, channel: 0, mode: "rising" },
    rtValues: [],
    metadata: { variables: options.variables ?? ["voltage", "current"] },
    favorite: false,
    createdAt: Timestamp.make("2026-07-12T00:00:00.000Z"),
    updatedAt: Timestamp.make("2026-07-12T00:00:00.000Z"),
  });

describe("@vscope/ui model", () => {
  it("starts offline and scans ports without marking the UI busy", () => {
    const [model, commands] = init(testUrl);

    expect(model.linkUp).toBe(false);
    expect(model.busy).toBeNull();
    expect(model.ports).toHaveLength(0);
    expect(commands.map((command) => command.name)).toEqual(["RefreshPorts"]);
  });

  it("keeps recorded failures in Activity and surfaces client-side command failures", () => {
    const [model] = init(testUrl);
    const app = RuntimeAppDto.make({
      bootedAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:01.000Z",
      status: "degraded",
      settings: DEFAULT_SETTINGS,
      settingsRecovery: noRecovery,
      activity: [
        {
          id: "activity:1",
          level: "error",
          message: "devices/connect: timed out",
          createdAt: "2026-07-12T00:00:01.000Z",
        },
      ],
      logs: [],
    });
    const [withActivity] = update(model, AppChanged({ app }));
    const [opened] = update(withActivity, MenuToggled({ menu: "activity" }));
    const [clearing, commands] = update(opened, ActivityClearRequested());
    const [recordedFailure] = update(clearing, RuntimeCommandFailed({ message: null }));
    const [clientFailure] = update(
      clearing,
      RuntimeCommandFailed({ message: "activity clear request timed out" }),
    );

    expect(opened.openMenu).toBe("activity");
    expect(opened.app?.activity).toHaveLength(1);
    expect(clearing.busy).toBe("clearActivity");
    expect(commands.map((command) => command.name)).toEqual(["ClearActivity"]);
    expect(recordedFailure.busy).toBeNull();
    expect(recordedFailure.error).toBeNull();
    expect(clientFailure.busy).toBeNull();
    expect(clientFailure.error).toBe("activity clear request timed out");
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

    expect(withPorts.selectedPort).toBe("");
    expect(backgroundFailed.busy).toBe("refresh");
    expect(backgroundFailed.error).toBeNull();
    expect(withPorts.busy).toBeNull();
    expect(withStatus.status?.state).toBe("running");
    expect(withStatus.linkUp).toBe(true);
    expect(offline.linkUp).toBe(false);
    expect(offline.status?.state).toBe("running");
    expect(offline.ports).toEqual([port]);
  });

  it("selects the last successful path and switches a connected device on selection", () => {
    const [model] = init(testUrl);
    const remembered = RuntimeAppDto.make({
      bootedAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
      status: "ready",
      settings: { ...DEFAULT_SETTINGS, lastDevicePath: "/dev/tty.remembered" },
      settingsRecovery: noRecovery,
      activity: [],
      logs: [],
    });
    const [withRemembered] = update(model, AppChanged({ app: remembered }));
    const [connecting, connectCommands] = update(withRemembered, ConnectRequested());
    const [connected] = update(connecting, ActiveDeviceChanged({ device: activeDevice(true) }));
    const [switching, switchCommands] = update(
      connected,
      SelectedPortChanged({ path: "/dev/tty.second" }),
    );

    expect(withRemembered.selectedPort).toBe("/dev/tty.remembered");
    expect(connectCommands.map((command) => command.name)).toEqual(["ConnectDevice"]);
    expect(switching.selectedPort).toBe("/dev/tty.second");
    expect(switching.busy).toBe("connect");
    expect(switchCommands.map((command) => command.name)).toEqual(["ConnectDevice"]);
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

  it("validates and applies the complete settings draft through one RPC command", () => {
    const [model] = init(testUrl);
    const app = RuntimeAppDto.make({
      bootedAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
      status: "ready",
      settings: DEFAULT_SETTINGS,
      settingsRecovery: noRecovery,
      activity: [],
      logs: [],
    });
    const [withApp] = update(model, AppChanged({ app }));
    const [opened] = update(withApp, MenuToggled({ menu: "settings" }));
    const [dark] = update(opened, SettingsThemeChanged({ theme: "dark" }));
    const [invalidDraft] = update(dark, SettingsTextChanged({ field: "port", value: "70000" }));
    const [invalid, invalidCommands] = update(invalidDraft, SettingsApplyRequested());
    const [validDraft] = update(
      invalidDraft,
      SettingsTextChanged({ field: "port", value: "6000" }),
    );
    const [saving, commands] = update(validDraft, SettingsApplyRequested());

    expect(opened.settingsDraft.port).toBe("5174");
    expect(invalid.error).toBe("Network port must be between 1 and 65535.");
    expect(invalidCommands).toHaveLength(0);
    expect(saving.busy).toBe("saveSettings");
    expect(saving.openMenu).toBeNull();
    expect(commands.map((command) => command.name)).toEqual(["PatchSettings"]);
  });

  it("resolves system theme changes while explicit preferences stay fixed", () => {
    const [model] = init(testUrl);
    const [systemDark] = update(model, SystemThemeChanged({ dark: true }));
    const app = RuntimeAppDto.make({
      bootedAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
      status: "ready",
      settings: { ...DEFAULT_SETTINGS, theme: "light" },
      settingsRecovery: noRecovery,
      activity: [],
      logs: [],
    });
    const [explicitLight] = update(systemDark, AppChanged({ app }));

    expect(resolvedTheme(model)).toBe("light");
    expect(resolvedTheme(systemDark)).toBe("dark");
    expect(resolvedTheme(explicitLight)).toBe("light");
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

  it("allows only snapshots with matching timing and channel labels into a comparison", () => {
    const [model] = init(testUrl);
    const first = comparisonSnapshot("first");
    const compatible = comparisonSnapshot("compatible");
    const wrongTiming = comparisonSnapshot("wrong-timing", { totalDurationSeconds: 0.2 });
    const wrongChannels = comparisonSnapshot("wrong-channels", {
      variables: ["voltage", "temperature"],
    });
    const [withSnapshots] = update(
      model,
      SnapshotsChanged({ snapshots: [first, compatible, wrongTiming, wrongChannels] }),
    );
    const [selectedFirst] = update(withSnapshots, SnapshotCompareToggled({ id: first.id }));
    const [selectedPair] = update(selectedFirst, SnapshotCompareToggled({ id: compatible.id }));
    const [timingRejected] = update(selectedPair, SnapshotCompareToggled({ id: wrongTiming.id }));
    const [channelsRejected] = update(
      selectedPair,
      SnapshotCompareToggled({ id: wrongChannels.id }),
    );

    expect(selectedPair.compareSelection).toEqual([first.id, compatible.id]);
    expect(timingRejected.compareSelection).toEqual(selectedPair.compareSelection);
    expect(channelsRejected.compareSelection).toEqual(selectedPair.compareSelection);
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
