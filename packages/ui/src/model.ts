import {
  RuntimeActiveDevice,
  RuntimeAppDto,
  RuntimeControlStatus,
  RuntimeDeviceConfigPayload,
  RuntimePortInfo,
  SnapshotRecord,
  TriggerMode,
  errorReason,
} from "@vscope/shared";
import { Cause, Effect, Match, Schema } from "effect";
import * as Command from "foldkit/command";
import { m } from "foldkit/message";

import { RuntimeClient, type RuntimeRpc } from "./client.ts";

// Which grouped-settings popover is open. Ephemeral view state, but kept in the
// Model so open/close is explicit, testable, and survives a render.
export const MenuId = Schema.Literals(["timing", "trigger"]);
export type MenuId = Schema.Schema.Type<typeof MenuId>;

export const ControlAction = Schema.Literals([
  "refresh",
  "connect",
  "disconnect",
  "run",
  "stop",
  "trigger",
  "saveSnapshot",
  "setTiming",
  "setTrigger",
]);
export type ControlAction = Schema.Schema.Type<typeof ControlAction>;

const BusyState = Schema.NullOr(ControlAction);

export const Model = Schema.Struct({
  app: Schema.NullOr(RuntimeAppDto),
  ports: Schema.Array(RuntimePortInfo),
  activeDevice: Schema.NullOr(RuntimeActiveDevice),
  config: Schema.NullOr(RuntimeDeviceConfigPayload),
  snapshots: Schema.Array(SnapshotRecord),
  status: Schema.NullOr(RuntimeControlStatus),
  linkUp: Schema.Boolean,
  selectedPort: Schema.String,
  timingTotalSecondsDraft: Schema.String,
  timingPreTriggerSecondsDraft: Schema.String,
  triggerChannelDraft: Schema.String,
  triggerThresholdDraft: Schema.String,
  triggerModeDraft: TriggerMode,
  snapshotLabelDraft: Schema.String,
  openMenu: Schema.NullOr(MenuId),
  busy: BusyState,
  error: Schema.NullOr(Schema.String),
});

export type Model = Schema.Schema.Type<typeof Model>;

export const AppChanged = m("AppChanged", {
  app: RuntimeAppDto,
});
export const PortsLoaded = m("PortsLoaded", {
  ports: Schema.Array(RuntimePortInfo),
});
export const PortsRescanned = m("PortsRescanned", {
  ports: Schema.Array(RuntimePortInfo),
});
export const ActiveDeviceChanged = m("ActiveDeviceChanged", {
  device: Schema.NullOr(RuntimeActiveDevice),
});
export const DeviceConfigChanged = m("DeviceConfigChanged", {
  config: Schema.NullOr(RuntimeDeviceConfigPayload),
});
export const SnapshotsChanged = m("SnapshotsChanged", {
  snapshots: Schema.Array(SnapshotRecord),
});
export const DeviceStatusReceived = m("DeviceStatusReceived", {
  status: Schema.NullOr(RuntimeControlStatus),
});
export const RuntimeLinkDown = m("RuntimeLinkDown");
export const CommandSettled = m("CommandSettled");
export const RefreshPortsFailed = m("RefreshPortsFailed", {
  message: Schema.String,
});
export const PortsRescanFailed = m("PortsRescanFailed", {
  message: Schema.String,
});
export const RuntimeCommandFailed = m("RuntimeCommandFailed", {
  message: Schema.String,
});
export const MenuToggled = m("MenuToggled", {
  menu: MenuId,
});
export const MenuClosed = m("MenuClosed");
export const SelectedPortChanged = m("SelectedPortChanged", {
  path: Schema.String,
});
export const TimingTotalChanged = m("TimingTotalChanged", {
  value: Schema.String,
});
export const TimingPreTriggerChanged = m("TimingPreTriggerChanged", {
  value: Schema.String,
});
export const TriggerChannelChanged = m("TriggerChannelChanged", {
  value: Schema.String,
});
export const TriggerThresholdChanged = m("TriggerThresholdChanged", {
  value: Schema.String,
});
export const TriggerModeChanged = m("TriggerModeChanged", {
  mode: TriggerMode,
});
export const SnapshotLabelChanged = m("SnapshotLabelChanged", {
  value: Schema.String,
});
export const RefreshPortsRequested = m("RefreshPortsRequested");
export const ConnectRequested = m("ConnectRequested");
export const DisconnectRequested = m("DisconnectRequested");
export const RunRequested = m("RunRequested");
export const StopRequested = m("StopRequested");
export const TriggerRequested = m("TriggerRequested");
export const SaveSnapshotRequested = m("SaveSnapshotRequested");
export const SetTimingRequested = m("SetTimingRequested");
export const SetTriggerRequested = m("SetTriggerRequested");

export const Message = Schema.Union([
  AppChanged,
  PortsLoaded,
  PortsRescanned,
  ActiveDeviceChanged,
  DeviceConfigChanged,
  SnapshotsChanged,
  DeviceStatusReceived,
  RuntimeLinkDown,
  CommandSettled,
  RefreshPortsFailed,
  PortsRescanFailed,
  RuntimeCommandFailed,
  MenuToggled,
  MenuClosed,
  SelectedPortChanged,
  TimingTotalChanged,
  TimingPreTriggerChanged,
  TriggerChannelChanged,
  TriggerThresholdChanged,
  TriggerModeChanged,
  SnapshotLabelChanged,
  RefreshPortsRequested,
  ConnectRequested,
  DisconnectRequested,
  RunRequested,
  StopRequested,
  TriggerRequested,
  SaveSnapshotRequested,
  SetTimingRequested,
  SetTriggerRequested,
]);
export type Message = Schema.Schema.Type<typeof Message>;

type RuntimeOperation<A> = (rpc: RuntimeRpc) => Effect.Effect<A, unknown, never>;
type UiCommand = Command.Command<Message, never, RuntimeClient>;
type UpdateResult = readonly [Model, ReadonlyArray<UiCommand>];

const runtimeCommand: <A>(
  run: RuntimeOperation<A>,
  onSuccess: (value: A) => Message,
  onFailure: (message: string) => Message,
) => Effect.Effect<Message, never, RuntimeClient> = Effect.fn("ui.runtimeCommand")(function* <A>(
  run: RuntimeOperation<A>,
  onSuccess: (value: A) => Message,
  onFailure: (message: string) => Message,
) {
  const rpc = yield* RuntimeClient;
  return yield* run(rpc).pipe(
    Effect.timeout("15 seconds"),
    Effect.matchCause({
      onFailure: (cause) => onFailure(errorReason(Cause.squash(cause))),
      onSuccess,
    }),
  );
});

const settledCommand = (run: RuntimeOperation<unknown>) =>
  runtimeCommand(
    run,
    () => CommandSettled(),
    (message) => RuntimeCommandFailed({ message }),
  );

const RefreshPorts = Command.define(
  "RefreshPorts",
  { foreground: Schema.Boolean },
  Message,
)(({ foreground }) =>
  runtimeCommand(
    (rpc) => rpc["ports.list"](),
    (ports) => (foreground ? PortsLoaded({ ports }) : PortsRescanned({ ports })),
    (message) => (foreground ? RefreshPortsFailed({ message }) : PortsRescanFailed({ message })),
  ),
);

const ConnectDevice = Command.define(
  "ConnectDevice",
  { path: Schema.String },
  Message,
)(({ path }) => settledCommand((rpc) => rpc["device.connect"]({ path })));

const DisconnectDevice = Command.define(
  "DisconnectDevice",
  Message,
)(settledCommand((rpc) => rpc["device.disconnect"]()));

const RunDevice = Command.define(
  "RunDevice",
  Message,
)(settledCommand((rpc) => rpc["device.run"]()));

const StopDevice = Command.define(
  "StopDevice",
  Message,
)(settledCommand((rpc) => rpc["device.stop"]()));

const TriggerDevice = Command.define(
  "TriggerDevice",
  Message,
)(settledCommand((rpc) => rpc["device.trigger"]()));

const SaveSnapshot = Command.define(
  "SaveSnapshot",
  { label: Schema.String },
  Message,
)(({ label }) =>
  settledCommand((rpc) => {
    const snapshotLabel = label.trim();
    return rpc["snapshots.capture"](snapshotLabel ? { label: snapshotLabel } : {});
  }),
);

const SetTiming = Command.define(
  "SetTiming",
  {
    totalDurationSeconds: Schema.Finite,
    preTriggerSeconds: Schema.Finite,
  },
  Message,
)((timing) => settledCommand((rpc) => rpc["device.setTiming"](timing)));

const SetTrigger = Command.define(
  "SetTrigger",
  {
    channel: Schema.Int,
    threshold: Schema.Finite,
    mode: TriggerMode,
  },
  Message,
)((trigger) => settledCommand((rpc) => rpc["device.setTrigger"](trigger)));

export const init = (): UpdateResult => [
  {
    app: null,
    ports: [],
    activeDevice: null,
    config: null,
    snapshots: [],
    status: null,
    linkUp: false,
    selectedPort: "",
    timingTotalSecondsDraft: "",
    timingPreTriggerSecondsDraft: "",
    triggerChannelDraft: "",
    triggerThresholdDraft: "",
    triggerModeDraft: "disabled",
    snapshotLabelDraft: "",
    openMenu: null,
    busy: null,
    error: null,
  },
  [RefreshPorts({ foreground: false })],
];

const nextSelectedPort = (
  current: string,
  ports: ReadonlyArray<RuntimePortInfo>,
  activeDevice: RuntimeActiveDevice | null,
): string => {
  if (activeDevice?.connected) {
    return activeDevice.path;
  }
  if (ports.some((port) => port.path === current)) {
    return current;
  }
  return ports[0]?.path ?? "";
};

const modelWithConfig = (model: Model, config: RuntimeDeviceConfigPayload | null): Model => {
  const timing = config?.timing;
  const trigger = config?.trigger;

  return {
    ...model,
    config,
    linkUp: true,
    timingTotalSecondsDraft: timing ? String(timing.totalDurationSeconds) : "",
    timingPreTriggerSecondsDraft: timing ? String(timing.preTriggerSeconds) : "",
    triggerChannelDraft: trigger ? String(trigger.channel) : "",
    triggerThresholdDraft: trigger ? String(trigger.threshold) : "",
    triggerModeDraft: trigger?.mode ?? "disabled",
  };
};

// Number("") is 0, so blank drafts must be rejected before coercion.
const parseFinite = (value: string): number | null => {
  const trimmed = value.trim();
  if (trimmed === "") {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseNonNegativeInteger = (value: string): number | null => {
  const parsed = parseFinite(value);
  return parsed !== null && Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
};

const failLocal = (model: Model, message: string): UpdateResult => [
  { ...model, busy: null, error: message },
  [],
];

export const update = (model: Model, message: Message): UpdateResult =>
  Match.value(message).pipe(
    Match.withReturnType<UpdateResult>(),
    Match.tagsExhaustive({
      AppChanged: ({ app }) => [{ ...model, app, linkUp: true }, []],
      PortsLoaded: ({ ports }) => {
        const refreshSettled = model.busy === "refresh";
        return [
          {
            ...model,
            ports,
            selectedPort: nextSelectedPort(model.selectedPort, ports, model.activeDevice),
            linkUp: true,
            busy: refreshSettled ? null : model.busy,
            error: refreshSettled ? null : model.error,
          },
          [],
        ];
      },
      PortsRescanned: ({ ports }) => [
        {
          ...model,
          ports,
          selectedPort: nextSelectedPort(model.selectedPort, ports, model.activeDevice),
          linkUp: true,
        },
        [],
      ],
      ActiveDeviceChanged: ({ device }) => {
        const connectionLost = model.activeDevice?.connected === true && device?.connected !== true;
        const nextModel = {
          ...model,
          activeDevice: device,
          selectedPort: device?.connected ? device.path : model.selectedPort,
          status: connectionLost ? null : model.status,
          linkUp: true,
        };
        return connectionLost
          ? [nextModel, [RefreshPorts({ foreground: false })]]
          : [nextModel, []];
      },
      DeviceConfigChanged: ({ config }) => [modelWithConfig(model, config), []],
      SnapshotsChanged: ({ snapshots }) => [{ ...model, snapshots, linkUp: true }, []],
      DeviceStatusReceived: ({ status }) => [{ ...model, status, linkUp: true }, []],
      RuntimeLinkDown: () => [{ ...model, linkUp: false }, []],
      CommandSettled: () => [{ ...model, busy: null, error: null }, []],
      RefreshPortsFailed: ({ message }) =>
        model.busy === "refresh" ? [{ ...model, busy: null, error: message }, []] : [model, []],
      PortsRescanFailed: ({ message }) =>
        model.busy === null ? [{ ...model, error: message }, []] : [model, []],
      RuntimeCommandFailed: ({ message }) => [{ ...model, busy: null, error: message }, []],
      MenuToggled: ({ menu }) => [
        { ...model, openMenu: model.openMenu === menu ? null : menu },
        [],
      ],
      MenuClosed: () => [{ ...model, openMenu: null }, []],
      SelectedPortChanged: ({ path }) => [{ ...model, selectedPort: path }, []],
      TimingTotalChanged: ({ value }) => [{ ...model, timingTotalSecondsDraft: value }, []],
      TimingPreTriggerChanged: ({ value }) => [
        { ...model, timingPreTriggerSecondsDraft: value },
        [],
      ],
      TriggerChannelChanged: ({ value }) => [{ ...model, triggerChannelDraft: value }, []],
      TriggerThresholdChanged: ({ value }) => [{ ...model, triggerThresholdDraft: value }, []],
      TriggerModeChanged: ({ mode }) => [{ ...model, triggerModeDraft: mode }, []],
      SnapshotLabelChanged: ({ value }) => [{ ...model, snapshotLabelDraft: value }, []],
      RefreshPortsRequested: () => [
        { ...model, busy: "refresh", error: null },
        [RefreshPorts({ foreground: true })],
      ],
      ConnectRequested: () =>
        model.selectedPort
          ? [
              { ...model, busy: "connect", error: null },
              [ConnectDevice({ path: model.selectedPort })],
            ]
          : failLocal(model, "Select a serial port before connecting."),
      DisconnectRequested: () => [
        { ...model, busy: "disconnect", error: null },
        [DisconnectDevice()],
      ],
      RunRequested: () => [{ ...model, busy: "run", error: null }, [RunDevice()]],
      StopRequested: () => [{ ...model, busy: "stop", error: null }, [StopDevice()]],
      TriggerRequested: () => [{ ...model, busy: "trigger", error: null }, [TriggerDevice()]],
      SaveSnapshotRequested: () => [
        { ...model, busy: "saveSnapshot", error: null },
        [SaveSnapshot({ label: model.snapshotLabelDraft })],
      ],
      SetTimingRequested: () => {
        const totalDurationSeconds = parseFinite(model.timingTotalSecondsDraft);
        const preTriggerSeconds = parseFinite(model.timingPreTriggerSecondsDraft);
        if (totalDurationSeconds === null || totalDurationSeconds <= 0) {
          return failLocal(model, "Total duration must be a positive number.");
        }
        if (preTriggerSeconds === null || preTriggerSeconds < 0) {
          return failLocal(model, "Pre-trigger must be zero or greater.");
        }
        return [
          { ...model, openMenu: null, busy: "setTiming", error: null },
          [SetTiming({ totalDurationSeconds, preTriggerSeconds })],
        ];
      },
      SetTriggerRequested: () => {
        const channel = parseNonNegativeInteger(model.triggerChannelDraft);
        const threshold = parseFinite(model.triggerThresholdDraft);
        if (channel === null) {
          return failLocal(model, "Trigger channel must be a non-negative integer.");
        }
        if (threshold === null) {
          return failLocal(model, "Trigger threshold must be a number.");
        }
        return [
          { ...model, openMenu: null, busy: "setTrigger", error: null },
          [SetTrigger({ channel, threshold, mode: model.triggerModeDraft })],
        ];
      },
    }),
  );
