import {
  RuntimeActiveDevice,
  RuntimeAppDto,
  RuntimeControlStatus,
  RuntimeDeviceConfigPayload,
  RuntimeFramePayload,
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
export const MenuId = Schema.Literals([
  "timing",
  "trigger",
  "channels",
  "rt",
  "snapshots",
  "saveSnapshot",
]);
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
  "setRtValues",
  "setChannelMap",
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
  frame: Schema.NullOr(RuntimeFramePayload),
  linkUp: Schema.Boolean,
  selectedPort: Schema.String,
  timingTotalSecondsDraft: Schema.String,
  timingPreTriggerSecondsDraft: Schema.String,
  triggerChannelDraft: Schema.String,
  triggerThresholdDraft: Schema.String,
  triggerModeDraft: TriggerMode,
  rtValueDrafts: Schema.Array(Schema.String),
  channelMapDraft: Schema.Array(Schema.String),
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
export const FrameReceived = m("FrameReceived", {
  frame: Schema.NullOr(RuntimeFramePayload),
});
export const LivePlotMounted = m("LivePlotMounted");
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
export const RtValueChanged = m("RtValueChanged", {
  index: Schema.Int,
  value: Schema.String,
});
export const ChannelMapChanged = m("ChannelMapChanged", {
  channel: Schema.Int,
  value: Schema.String,
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
export const SetRtValuesRequested = m("SetRtValuesRequested");
export const SetChannelMapRequested = m("SetChannelMapRequested");

export const Message = Schema.Union([
  AppChanged,
  PortsLoaded,
  PortsRescanned,
  ActiveDeviceChanged,
  DeviceConfigChanged,
  SnapshotsChanged,
  DeviceStatusReceived,
  FrameReceived,
  LivePlotMounted,
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
  RtValueChanged,
  ChannelMapChanged,
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
  SetRtValuesRequested,
  SetChannelMapRequested,
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

const RtValueWrite = Schema.Struct({
  index: Schema.Int,
  value: Schema.Finite,
});

const SetRtValues = Command.define(
  "SetRtValues",
  { writes: Schema.Array(RtValueWrite) },
  Message,
)(({ writes }) =>
  settledCommand((rpc) =>
    Effect.forEach(writes, ({ index, value }) => rpc["device.setRtValue"]({ index, value }), {
      discard: true,
    }),
  ),
);

const ChannelMapWrite = Schema.Struct({
  channel: Schema.Int,
  variable: Schema.Int,
});

const SetChannelMap = Command.define(
  "SetChannelMap",
  { writes: Schema.Array(ChannelMapWrite) },
  Message,
)(({ writes }) =>
  settledCommand((rpc) =>
    Effect.forEach(
      writes,
      ({ channel, variable }) => rpc["device.setChannelMap"]({ channel, variable }),
      { discard: true },
    ),
  ),
);

export const init = (): UpdateResult => [
  {
    app: null,
    ports: [],
    activeDevice: null,
    config: null,
    snapshots: [],
    status: null,
    frame: null,
    linkUp: false,
    selectedPort: "",
    timingTotalSecondsDraft: "",
    timingPreTriggerSecondsDraft: "",
    triggerChannelDraft: "",
    triggerThresholdDraft: "",
    triggerModeDraft: "disabled",
    rtValueDrafts: [],
    channelMapDraft: [],
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
    rtValueDrafts: config
      ? Array.from(
          {
            length: Math.max(
              model.activeDevice?.info?.rtCount ?? 0,
              ...config.rtValues.map(([index]) => index + 1),
            ),
          },
          (_, index) => String(config.rtValues.find(([entry]) => entry === index)?.[1] ?? ""),
        )
      : [],
    channelMapDraft: config?.channelMap.map(String) ?? [],
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

const changedRtValues = (
  model: Model,
):
  | { readonly writes: ReadonlyArray<{ readonly index: number; readonly value: number }> }
  | {
      readonly error: string;
    } => {
  const current = new Map(model.config?.rtValues ?? []);
  const writes: Array<{ readonly index: number; readonly value: number }> = [];
  for (const [index, draft] of model.rtValueDrafts.entries()) {
    const value = parseFinite(draft);
    if (value === null) return { error: `RT ${index + 1} must be a number.` };
    if (current.get(index) !== value) writes.push({ index, value });
  }
  return { writes };
};

const changedChannelMap = (
  model: Model,
):
  | { readonly writes: ReadonlyArray<{ readonly channel: number; readonly variable: number }> }
  | {
      readonly error: string;
    } => {
  const current = model.config?.channelMap ?? [];
  const variableCount = model.activeDevice?.variables.length ?? 0;
  const writes: Array<{ readonly channel: number; readonly variable: number }> = [];
  for (const [channel, draft] of model.channelMapDraft.entries()) {
    const variable = parseNonNegativeInteger(draft);
    if (variable === null || variable >= variableCount) {
      return { error: `Channel ${channel + 1} must select a valid variable.` };
    }
    if (current[channel] !== variable) writes.push({ channel, variable });
  }
  return { writes };
};

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
          frame: connectionLost ? null : model.frame,
          linkUp: true,
        };
        return connectionLost
          ? [nextModel, [RefreshPorts({ foreground: false })]]
          : [nextModel, []];
      },
      DeviceConfigChanged: ({ config }) => [modelWithConfig(model, config), []],
      SnapshotsChanged: ({ snapshots }) => [{ ...model, snapshots, linkUp: true }, []],
      DeviceStatusReceived: ({ status }) => [{ ...model, status, linkUp: true }, []],
      FrameReceived: ({ frame }) => [{ ...model, frame }, []],
      LivePlotMounted: () => [model, []],
      RuntimeLinkDown: () => [{ ...model, linkUp: false }, []],
      CommandSettled: () => [{ ...model, busy: null, error: null }, []],
      RefreshPortsFailed: ({ message }) =>
        model.busy === "refresh" ? [{ ...model, busy: null, error: message }, []] : [model, []],
      PortsRescanFailed: ({ message }) =>
        model.busy === null ? [{ ...model, error: message }, []] : [model, []],
      RuntimeCommandFailed: ({ message }) => [{ ...model, busy: null, error: message }, []],
      MenuToggled: ({ menu }) => {
        const opening = model.openMenu !== menu;
        return [
          {
            ...model,
            openMenu: opening ? menu : null,
            snapshotLabelDraft: opening && menu === "saveSnapshot" ? "" : model.snapshotLabelDraft,
          },
          [],
        ];
      },
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
      RtValueChanged: ({ index, value }) => [
        {
          ...model,
          rtValueDrafts: model.rtValueDrafts.map((draft, entry) =>
            entry === index ? value : draft,
          ),
        },
        [],
      ],
      ChannelMapChanged: ({ channel, value }) => [
        {
          ...model,
          channelMapDraft: model.channelMapDraft.map((draft, entry) =>
            entry === channel ? value : draft,
          ),
        },
        [],
      ],
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
      SaveSnapshotRequested: () =>
        model.snapshotLabelDraft.trim() === ""
          ? failLocal(model, "Enter a snapshot name.")
          : [
              {
                ...model,
                openMenu: null,
                snapshotLabelDraft: "",
                busy: "saveSnapshot",
                error: null,
              },
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
      SetRtValuesRequested: () => {
        const result = changedRtValues(model);
        if ("error" in result) return failLocal(model, result.error);
        if (result.writes.length === 0) return [{ ...model, openMenu: null, error: null }, []];
        return [
          { ...model, openMenu: null, busy: "setRtValues", error: null },
          [SetRtValues({ writes: result.writes })],
        ];
      },
      SetChannelMapRequested: () => {
        const result = changedChannelMap(model);
        if ("error" in result) return failLocal(model, result.error);
        if (result.writes.length === 0) return [{ ...model, openMenu: null, error: null }, []];
        return [
          { ...model, openMenu: null, busy: "setChannelMap", error: null },
          [SetChannelMap({ writes: result.writes })],
        ];
      },
    }),
  );
