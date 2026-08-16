import {
  RuntimeActiveDevice,
  RuntimeActivityEntryDto,
  RuntimeAppDto,
  RuntimeControlStatus,
  RuntimeDeviceConfigPayload,
  RuntimeDeviceInfo,
  RuntimeFramePayload,
  RuntimeLogEntryDto,
  RuntimePortInfo,
  RuntimeSetTimingRequest,
  RuntimeSetTriggerRequest,
} from "@vscope/shared";
import type { VScopeState as VScopeStateValue, VScopeControlStatus } from "@vscope/serial";
import type { SerialPortInfo } from "@vscope/serial";
import { VScopeState } from "@vscope/serial";

import type { ActiveDeviceState, DeviceConfigState, RuntimeAppState } from "./core/model";

export function appDto(app: RuntimeAppState): RuntimeAppDto {
  return RuntimeAppDto.make({
    ...app,
    activity: app.activity.map((entry) => RuntimeActivityEntryDto.make(entry)),
    logs: app.logs.map((entry) => RuntimeLogEntryDto.make(entry)),
  });
}

export function activeDeviceDto(device: ActiveDeviceState | null): RuntimeActiveDevice | null {
  return device
    ? RuntimeActiveDevice.make({
        ...device,
        connected: device.connected,
        info: device.info ? RuntimeDeviceInfo.make(device.info) : null,
      })
    : null;
}

export function statusDto(status: DeviceStatusInput): RuntimeControlStatus | null {
  return status
    ? RuntimeControlStatus.make({
        state: stateDto(status.state),
        snapshotValid: status.snapshotValid,
      })
    : null;
}

export function configDto(config: DeviceConfigState | null): RuntimeDeviceConfigPayload | null {
  return config
    ? RuntimeDeviceConfigPayload.make({
        timing: timingDto(config.timing),
        trigger: triggerDto(config.trigger),
        channelMap: config.channelMap,
        rtValues: Array.from(config.rtValues.entries()),
      })
    : null;
}

export function framePayload(values: ReadonlyArray<number> | null): RuntimeFramePayload | null {
  return values === null ? null : RuntimeFramePayload.make({ values });
}

export function runtimePortInfo(port: SerialPortInfo): RuntimePortInfo {
  return RuntimePortInfo.make(port);
}

function timingDto(timing: DeviceConfigState["timing"]): RuntimeSetTimingRequest | null {
  return timing ? RuntimeSetTimingRequest.make(timing) : null;
}

function triggerDto(trigger: DeviceConfigState["trigger"]): RuntimeSetTriggerRequest | null {
  return trigger ? RuntimeSetTriggerRequest.make(trigger) : null;
}

type DeviceStatusInput = VScopeControlStatus | null;

function stateDto(state: VScopeStateValue): RuntimeControlStatus["state"] {
  switch (state) {
    case VScopeState.Halted:
      return "halted";
    case VScopeState.Running:
      return "running";
    case VScopeState.Acquiring:
      return "acquiring";
    case VScopeState.Misconfigured:
      return "misconfigured";
  }
}
