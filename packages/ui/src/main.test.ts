import { RuntimeControlStatus } from "@vscope/shared";
import { describe, expect, it } from "@effect/vitest";

import {
  ConnectRequested,
  DeviceStatusReceived,
  MenuToggled,
  SetTimingRequested,
  TimingTotalChanged,
  init,
  update,
} from "./model.ts";

describe("@vscope/ui model", () => {
  it("initializes with an explicit runtime refresh command", () => {
    const [model, commands] = init();

    expect(model.appName).toBe("vscope");
    expect(model.busy).toBe("refresh");
    expect(model.status).toBeNull();
    expect(model.openMenu).toBeNull();
    expect(model.runtime.ports).toHaveLength(0);
    expect(commands.map((command) => command.name)).toEqual(["RefreshRuntime"]);
  });

  it("applies live status pushed by the device.status subscription", () => {
    const [model] = init();
    const [running] = update(
      model,
      DeviceStatusReceived({
        status: RuntimeControlStatus.make({ state: "running", snapshotValid: false }),
      }),
    );

    expect(running.status?.state).toBe("running");
    expect(running.status?.snapshotValid).toBe(false);
  });

  it("toggles a single grouped-settings popover open and closed", () => {
    const [model] = init();
    const [opened] = update(model, MenuToggled({ menu: "timing" }));
    const [closed] = update(opened, MenuToggled({ menu: "timing" }));
    const [switched] = update(opened, MenuToggled({ menu: "trigger" }));

    expect(opened.openMenu).toBe("timing");
    expect(closed.openMenu).toBeNull();
    expect(switched.openMenu).toBe("trigger");
  });

  it("keeps local validation synchronous before runtime commands", () => {
    const [model] = init();
    const [noPort, noPortCommands] = update(model, ConnectRequested());
    const [edited] = update(model, TimingTotalChanged({ value: "0" }));
    const [invalidTiming, invalidTimingCommands] = update(edited, SetTimingRequested());

    expect(noPort.error).toBe("Select a serial port before connecting.");
    expect(noPortCommands).toHaveLength(0);
    expect(invalidTiming.error).toBe("Total duration must be a positive number.");
    expect(invalidTimingCommands).toHaveLength(0);
  });
});
