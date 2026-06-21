import type {
  RecoveryState,
  SerialConfig,
  Settings,
  SettingsPatch,
  SnapshotRecord,
} from "@vscope/shared";
import type {
  VScopeControlStatus,
  VScopeDeviceInfo,
  VScopeTiming,
  VScopeTrigger,
} from "@vscope/serial";

export type RuntimeStatus = "ready" | "degraded";

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

export interface RuntimeAppState {
  readonly bootedAt: string;
  readonly updatedAt: string;
  readonly status: RuntimeStatus;
  readonly settings: Settings;
  readonly settingsRecovery: RecoveryState;
  readonly warnings: ReadonlyArray<RuntimeWarning>;
  readonly logs: ReadonlyArray<RuntimeLogEntry>;
}

export interface ActiveDeviceState {
  readonly path: string;
  readonly deviceName: string;
  readonly connected: boolean;
  readonly info: VScopeDeviceInfo | null;
  readonly variables: ReadonlyArray<string>;
  readonly rtLabels: ReadonlyArray<string>;
  readonly error: string | null;
}

export interface DeviceConfigState {
  readonly timing: VScopeTiming | null;
  readonly trigger: VScopeTrigger | null;
  readonly channelMap: ReadonlyArray<number>;
  readonly rtValues: ReadonlyMap<number, number>;
}

export interface RuntimeReadModel {
  readonly app: RuntimeAppState;
  readonly snapshots: ReadonlyArray<SnapshotRecord>;
  readonly activeDevice: ActiveDeviceState | null;
  readonly deviceStatus: VScopeControlStatus | null;
  readonly deviceConfig: DeviceConfigState | null;
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
      readonly type: "devices/connect";
      readonly path: string;
      readonly serialConfig?: SerialConfig | undefined;
    }
  | {
      readonly type: "devices/disconnect";
    }
  | SnapshotCaptureCommand
  | DeviceControlCommand;
