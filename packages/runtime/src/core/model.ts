import type {
  Preferences,
  PreferencesPatch,
  PersistentId,
  RecoveryState,
  SavedDevice,
  SerialConfig,
  Settings,
  SettingsPatch,
  SnapshotSampleBlob,
  SnapshotRecord,
} from "@vscope/persistence";
import type {
  SerialPortInfo,
  VScopeControlStatus,
  VScopeDeviceInfo,
  VScopeState,
  VScopeStaticMetadata,
  VScopeTiming,
  VScopeTrigger,
} from "@vscope/serial";

import type { CommandPermissions } from "./policy";

export type RuntimeStatus = "ready" | "degraded";

export type CoreDeviceConnectionStatus = "connected" | "disconnected" | "lost";

export type SnapshotAvailability = "unknown" | "not-ready" | "ready";

export type DeviceIntentKind =
  | "run"
  | "stop"
  | "trigger"
  | "setTiming"
  | "setTrigger"
  | "setRtValue"
  | "setChannelMap"
  | "captureSnapshot";

export type DeviceIntentStatus = "pending" | "settled" | "failed";

export interface DeviceIntent {
  readonly kind: DeviceIntentKind;
  readonly status: DeviceIntentStatus;
  readonly sentAt: string;
  readonly settledAt: string | null;
  readonly error: string | null;
}

export interface RuntimeWarning {
  readonly id: string;
  readonly message: string;
  readonly createdAt: string;
}

export interface RuntimeLogEntry {
  readonly id: string;
  readonly message: string;
  readonly createdAt: string;
}

export interface CoreDevice {
  readonly path: string;
  readonly deviceName: string;
  readonly connectionStatus: CoreDeviceConnectionStatus;
  readonly info: VScopeDeviceInfo | null;
  readonly metadata: VScopeStaticMetadata | null;
  readonly status: VScopeControlStatus | null;
  readonly state: VScopeState | null;
  readonly requestedState: VScopeState | null;
  readonly requestPending: boolean;
  readonly snapshotAvailability: SnapshotAvailability;
  readonly intent: DeviceIntent | null;
  readonly timing: VScopeTiming | null;
  readonly trigger: VScopeTrigger | null;
  readonly channelMap: ReadonlyArray<number> | null;
  readonly frame: ReadonlyArray<number> | null;
  readonly rtValues: ReadonlyMap<number, number>;
  readonly lastFrameAt: string | null;
  readonly lastSeenAt: string;
  readonly error: string | null;
}

export interface CoreState {
  readonly bootedAt: string;
  readonly updatedAt: string;
  readonly status: RuntimeStatus;
  readonly settings: Settings;
  readonly settingsRecovery: RecoveryState;
  readonly preferences: Preferences;
  readonly preferencesRecovery: RecoveryState;
  readonly savedDevices: ReadonlyArray<SavedDevice>;
  readonly snapshots: ReadonlyArray<SnapshotRecord>;
  readonly device: CoreDevice | null;
  readonly permissions: CommandPermissions;
  readonly warnings: ReadonlyArray<RuntimeWarning>;
  readonly logs: ReadonlyArray<RuntimeLogEntry>;
}

export interface SnapshotCaptureCommand {
  readonly type: "snapshots/capture";
  readonly label?: string | undefined;
}

export type DeviceControlCommand =
  | {
      readonly type: "devices/run";
    }
  | {
      readonly type: "devices/stop";
    }
  | {
      readonly type: "devices/setTiming";
      readonly timing: VScopeTiming;
    }
  | {
      readonly type: "devices/setTrigger";
      readonly trigger: VScopeTrigger;
    }
  | {
      readonly type: "devices/setRtValue";
      readonly index: number;
      readonly value: number;
    }
  | {
      readonly type: "devices/setChannelMap";
      readonly channel: number;
      readonly variable: number;
    }
  | {
      readonly type: "devices/trigger";
    };

export type CoreCommand =
  | {
      readonly type: "warnings/clear";
    }
  | {
      readonly type: "settings/patch";
      readonly patch: SettingsPatch;
    }
  | {
      readonly type: "preferences/patch";
      readonly patch: PreferencesPatch;
    }
  | {
      readonly type: "devices/connect";
      readonly path: string;
      readonly serialConfig?: SerialConfig | undefined;
    }
  | {
      readonly type: "devices/disconnect";
    }
  | SnapshotCaptureCommand
  | DeviceControlCommand;

export type CoreQuery =
  | {
      readonly type: "ports/list";
    }
  | {
      readonly type: "snapshots/list";
    }
  | {
      readonly type: "snapshots/readSamples";
      readonly id: PersistentId;
    };

export type CoreQueryResult =
  | {
      readonly type: "ports/list";
      readonly ports: ReadonlyArray<SerialPortInfo>;
    }
  | {
      readonly type: "snapshots/list";
      readonly snapshots: ReadonlyArray<SnapshotRecord>;
    }
  | {
      readonly type: "snapshots/readSamples";
      readonly samples: SnapshotSampleBlob | null;
    };
