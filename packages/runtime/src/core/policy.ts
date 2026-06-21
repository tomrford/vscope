import { VScopeState, type VScopeControlStatus } from "@vscope/serial";

import type { ActiveDeviceState, DeviceControlCommand } from "./model";

export type CommandDecision =
  | {
      readonly allowed: true;
      readonly device: ActiveDeviceState;
    }
  | {
      readonly allowed: false;
      readonly reason: string;
    };

export function decideDeviceControl(
  command: DeviceControlCommand,
  device: ActiveDeviceState | null,
  status: VScopeControlStatus | null,
): CommandDecision {
  if (!device || !device.connected) {
    return deny("No connected device is available.");
  }

  if (!status) {
    return deny("Device status is not available yet.");
  }

  switch (command.type) {
    case "devices/run":
      return status.state === VScopeState.Halted
        ? allow(device)
        : deny("Run is available only when the connected device is halted.");
    case "devices/stop":
      return status.state === VScopeState.Running || status.state === VScopeState.Acquiring
        ? allow(device)
        : deny("Stop is available only while the connected device is running or acquiring.");
    case "devices/trigger":
      return status.state === VScopeState.Running
        ? allow(device)
        : deny("Trigger is available only while the connected device is running.");
    case "devices/setTiming":
    case "devices/setTrigger":
    case "devices/setRtValue":
    case "devices/setChannelMap":
      return status.state === VScopeState.Halted
        ? allow(device)
        : deny("Device configuration commands are available only while the device is halted.");
  }
}

export function canCaptureSnapshot(
  device: ActiveDeviceState | null,
  status: VScopeControlStatus | null,
): boolean {
  return device?.connected === true && status?.snapshotValid === true;
}

function allow(device: ActiveDeviceState): CommandDecision {
  return { allowed: true, device };
}

function deny(reason: string): CommandDecision {
  return { allowed: false, reason };
}
