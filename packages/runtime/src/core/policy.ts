import { VScopeState } from "@vscope/serial";

import type { CoreDevice, DeviceControlCommand } from "./model";

export type ControlMode =
  | "empty"
  | "disconnected"
  | "lost"
  | "syncing"
  | "halted"
  | "running"
  | "acquiring"
  | "misconfigured";

export interface CommandPermissions {
  readonly mode: ControlMode;
  readonly connect: boolean;
  readonly disconnect: boolean;
  readonly setTiming: boolean;
  readonly setTrigger: boolean;
  readonly setRtValue: boolean;
  readonly setChannelMap: boolean;
  readonly trigger: boolean;
  readonly run: boolean;
  readonly stop: boolean;
  readonly captureSnapshot: boolean;
}

export type CommandDecision =
  | {
      readonly allowed: true;
      readonly device: CoreDevice;
    }
  | {
      readonly allowed: false;
      readonly reason: string;
    };

export function controlModeForDevice(device: CoreDevice | null): ControlMode {
  if (!device) {
    return "empty";
  }

  if (device.connectionStatus === "disconnected") {
    return "disconnected";
  }

  if (device.connectionStatus === "lost") {
    return "lost";
  }

  if (!device.status) {
    return "syncing";
  }

  switch (device.status.state) {
    case VScopeState.Halted:
      if (device.requestPending || device.intent?.status === "pending") {
        return "syncing";
      }
      return "halted";
    case VScopeState.Running:
      if (device.requestPending || device.intent?.status === "pending") {
        return "syncing";
      }
      return "running";
    case VScopeState.Acquiring:
      if (device.requestPending || device.intent?.status === "pending") {
        return "syncing";
      }
      return "acquiring";
    case VScopeState.Misconfigured:
      return "misconfigured";
  }
}

export function permissionsForMode(mode: ControlMode): CommandPermissions {
  const connected =
    mode === "halted" || mode === "running" || mode === "acquiring" || mode === "syncing";
  const halted = mode === "halted";
  const running = mode === "running";

  return {
    mode,
    connect: mode === "empty" || mode === "disconnected" || mode === "lost",
    disconnect: connected || mode === "misconfigured",
    setTiming: halted,
    setTrigger: halted,
    setRtValue: halted,
    setChannelMap: halted,
    trigger: running,
    run: halted,
    stop: connected,
    captureSnapshot: false,
  };
}

export function permissionsForDevice(device: CoreDevice | null): CommandPermissions {
  const permissions = permissionsForMode(controlModeForDevice(device));
  return {
    ...permissions,
    captureSnapshot:
      device?.connectionStatus === "connected" &&
      device.snapshotAvailability === "ready" &&
      !device.requestPending &&
      device.intent?.status !== "pending",
  };
}

export function decideDeviceControl(
  command: DeviceControlCommand,
  device: CoreDevice | null,
  permissions: CommandPermissions,
): CommandDecision {
  if (!device || device.connectionStatus !== "connected") {
    return {
      allowed: false,
      reason: "No connected device is available.",
    };
  }

  if (command.type === "devices/stop") {
    return permissions.stop
      ? {
          allowed: true,
          device,
        }
      : {
          allowed: false,
          reason: "The connected device cannot be stopped from its current state.",
        };
  }

  if (command.type === "devices/run") {
    return permissions.run
      ? {
          allowed: true,
          device,
        }
      : {
          allowed: false,
          reason: "Run is available only when the connected device is halted and settled.",
        };
  }

  if (command.type === "devices/trigger") {
    return permissions.trigger
      ? {
          allowed: true,
          device,
        }
      : {
          allowed: false,
          reason: "Trigger is available only while the connected device is running and settled.",
        };
  }

  if (isDeviceConfigurationAllowed(command, permissions)) {
    return {
      allowed: true,
      device,
    };
  }

  return {
    allowed: false,
    reason:
      "Device configuration commands are available only while the connected device is halted and settled.",
  };
}

function isDeviceConfigurationAllowed(
  command: Exclude<
    DeviceControlCommand,
    { readonly type: "devices/run" | "devices/stop" | "devices/trigger" }
  >,
  permissions: CommandPermissions,
): boolean {
  switch (command.type) {
    case "devices/setTiming":
      return permissions.setTiming;
    case "devices/setTrigger":
      return permissions.setTrigger;
    case "devices/setRtValue":
      return permissions.setRtValue;
    case "devices/setChannelMap":
      return permissions.setChannelMap;
  }
}
