import {
  RuntimeActiveDevice,
  RuntimeControlStatus,
  RuntimeDeviceConfigPayload,
  RuntimePortInfo,
  RuntimeSetTimingRequest,
  RuntimeSetTriggerRequest,
} from "@vscope/shared";
import { describe, expect, it } from "@effect/vitest";

import {
  ActiveDeviceChanged,
  DeviceConfigChanged,
  DeviceStatusReceived,
  PortsLoaded,
  PortsRescanned,
  PortsRescanFailed,
  RefreshPortsRequested,
  RuntimeLinkDown,
  SaveSnapshotRequested,
  SetTimingRequested,
  SetTriggerRequested,
  TimingTotalChanged,
  TriggerChannelChanged,
  TriggerThresholdChanged,
  init,
  update,
} from "./model.ts";

const activeDevice = (connected: boolean) =>
  RuntimeActiveDevice.make({
    path: "/dev/tty.test",
    deviceName: "test-device",
    connected,
    info: null,
    variables: [],
    rtLabels: [],
    error: null,
  });

describe("@vscope/ui model", () => {
  it("starts offline and scans ports without marking the UI busy", () => {
    const [model, commands] = init();

    expect(model.linkUp).toBe(false);
    expect(model.busy).toBeNull();
    expect(model.ports).toHaveLength(0);
    expect(commands.map((command) => command.name)).toEqual(["RefreshPorts"]);
  });

  it("folds facet values independently and keeps stale data on link loss", () => {
    const [model] = init();
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
    const [model] = init();
    const [connected] = update(model, ActiveDeviceChanged({ device: activeDevice(true) }));
    const [running] = update(
      connected,
      DeviceStatusReceived({
        status: RuntimeControlStatus.make({ state: "running", snapshotValid: false }),
      }),
    );
    const [capturing] = update(running, SaveSnapshotRequested());
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
    const [model] = init();
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
      rtValues: [],
    });
    const [configured] = update(editing, DeviceConfigChanged({ config }));

    expect(configured.timingTotalSecondsDraft).toBe("2.5");
    expect(configured.timingPreTriggerSecondsDraft).toBe("0.5");
    expect(configured.triggerChannelDraft).toBe("3");
    expect(configured.triggerThresholdDraft).toBe("1.25");
    expect(configured.triggerModeDraft).toBe("rising");
  });

  it("rejects blank numeric drafts before creating runtime commands", () => {
    const [model] = init();
    const [invalidTiming, timingCommands] = update(model, SetTimingRequested());
    const [withChannel] = update(model, TriggerChannelChanged({ value: "0" }));
    const [thresholdCleared] = update(withChannel, TriggerThresholdChanged({ value: "   " }));
    const [invalidTrigger, triggerCommands] = update(thresholdCleared, SetTriggerRequested());

    expect(invalidTiming.error).toBe("Total duration must be a positive number.");
    expect(timingCommands).toHaveLength(0);
    expect(invalidTrigger.error).toBe("Trigger threshold must be a number.");
    expect(triggerCommands).toHaveLength(0);
  });
});
