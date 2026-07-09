import {
  RuntimeActiveDevice,
  RuntimeAppDto,
  RuntimeControlStatus,
  RuntimeDeviceConfigPayload,
  RuntimePortInfo,
  SnapshotRecord,
  TriggerMode,
  errorReason,
  makeRuntimeRpcClient,
  runtimeRpcUrl,
} from "@vscope/shared";
import { Cause, Effect, Match, Schema } from "effect";
import * as Command from "foldkit/command";
import { m } from "foldkit/message";

// Which grouped-settings popover is open. Ephemeral view state, but kept in the
// Model so open/close is explicit, testable, and survives a render.
export const MenuId = Schema.Literals(["timing", "trigger"]);
export type MenuId = Schema.Schema.Type<typeof MenuId>;

// Request/response view of the runtime read-model. Device status is deliberately
// absent here: it is the one value that changes autonomously on the device, so
// it rides the live `device.status` subscription instead (see subscriptions.ts).
export const RuntimeSnapshot = Schema.Struct({
  app: Schema.NullOr(RuntimeAppDto),
  ports: Schema.Array(RuntimePortInfo),
  activeDevice: Schema.NullOr(RuntimeActiveDevice),
  config: Schema.NullOr(RuntimeDeviceConfigPayload),
  snapshots: Schema.Array(SnapshotRecord),
});
export type RuntimeSnapshot = Schema.Schema.Type<typeof RuntimeSnapshot>;

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
  appName: Schema.String,
  runtime: RuntimeSnapshot,
  // Live device state, owned by the `device.status` subscription.
  status: Schema.NullOr(RuntimeControlStatus),
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
  lastUpdatedAt: Schema.NullOr(Schema.String),
});

export type Model = Schema.Schema.Type<typeof Model>;

export const RuntimeLoaded = m("RuntimeLoaded", {
  snapshot: RuntimeSnapshot,
});
export const RuntimeCommandFailed = m("RuntimeCommandFailed", {
  message: Schema.String,
});
export const DeviceStatusReceived = m("DeviceStatusReceived", {
  status: Schema.NullOr(RuntimeControlStatus),
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
export const RefreshRequested = m("RefreshRequested");
export const ConnectRequested = m("ConnectRequested");
export const DisconnectRequested = m("DisconnectRequested");
export const RunRequested = m("RunRequested");
export const StopRequested = m("StopRequested");
export const TriggerRequested = m("TriggerRequested");
export const SaveSnapshotRequested = m("SaveSnapshotRequested");
export const SetTimingRequested = m("SetTimingRequested");
export const SetTriggerRequested = m("SetTriggerRequested");

export const Message = Schema.Union([
  RuntimeLoaded,
  RuntimeCommandFailed,
  DeviceStatusReceived,
  MenuToggled,
  MenuClosed,
  SelectedPortChanged,
  TimingTotalChanged,
  TimingPreTriggerChanged,
  TriggerChannelChanged,
  TriggerThresholdChanged,
  TriggerModeChanged,
  SnapshotLabelChanged,
  RefreshRequested,
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

const emptyRuntimeSnapshot: RuntimeSnapshot = RuntimeSnapshot.make({
  app: null,
  ports: [],
  activeDevice: null,
  config: null,
  snapshots: [],
});

export const init = (): readonly [Model, ReadonlyArray<Command.Command<Message>>] => [
  {
    appName: "vscope",
    runtime: emptyRuntimeSnapshot,
    status: null,
    selectedPort: "",
    timingTotalSecondsDraft: "",
    timingPreTriggerSecondsDraft: "",
    triggerChannelDraft: "",
    triggerThresholdDraft: "",
    triggerModeDraft: "disabled",
    snapshotLabelDraft: "",
    openMenu: null,
    busy: "refresh",
    error: null,
    lastUpdatedAt: null,
  },
  [RefreshRuntime()],
];

type RuntimeRpc = Effect.Success<ReturnType<typeof makeRuntimeRpcClient>>;

export const rpcUrl = Effect.sync(() => runtimeRpcUrl(globalThis.location.href));

// Every command follows the same shape: run the mutation (if any), re-read the
// snapshot, and fold the outcome into a Message so the command fiber can never
// leave `busy` set: timeouts and defects land as RuntimeCommandFailed too,
// since foldkit drops a dead command fiber without dispatching anything.
const runtimeCommand: (
  run?: (rpc: RuntimeRpc) => Effect.Effect<unknown, unknown, never>,
) => Effect.Effect<Message, never, never> = Effect.fn("ui.runtimeCommand")(function* (run) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const rpc = yield* makeRuntimeRpcClient(yield* rpcUrl);
      if (run !== undefined) {
        yield* run(rpc);
      }
      return yield* readSnapshot(rpc);
    }),
  ).pipe(
    Effect.timeout("15 seconds"),
    Effect.matchCause({
      onFailure: (cause) => RuntimeCommandFailed({ message: errorReason(Cause.squash(cause)) }),
      onSuccess: (snapshot) => RuntimeLoaded({ snapshot }),
    }),
  );
});

const readSnapshot: (rpc: RuntimeRpc) => Effect.Effect<RuntimeSnapshot, unknown, never> = Effect.fn(
  "ui.readSnapshot",
)(function* (rpc) {
  return RuntimeSnapshot.make(
    yield* Effect.all(
      {
        app: rpc["runtime.getApp"](),
        ports: rpc["ports.list"](),
        activeDevice: rpc["device.active.get"](),
        config: rpc["device.config.get"](),
        snapshots: rpc["snapshots.list"](),
      },
      { concurrency: "unbounded" },
    ),
  );
});

const RefreshRuntime = Command.define("RefreshRuntime", Message)(runtimeCommand());

const ConnectDevice = Command.define(
  "ConnectDevice",
  { path: Schema.String },
  Message,
)(({ path }) => runtimeCommand((rpc) => rpc["device.connect"]({ path })));

const DisconnectDevice = Command.define(
  "DisconnectDevice",
  Message,
)(runtimeCommand((rpc) => rpc["device.disconnect"]()));

const RunDevice = Command.define(
  "RunDevice",
  Message,
)(runtimeCommand((rpc) => rpc["device.run"]()));

const StopDevice = Command.define(
  "StopDevice",
  Message,
)(runtimeCommand((rpc) => rpc["device.stop"]()));

const TriggerDevice = Command.define(
  "TriggerDevice",
  Message,
)(runtimeCommand((rpc) => rpc["device.trigger"]()));

const SaveSnapshot = Command.define(
  "SaveSnapshot",
  { label: Schema.String },
  Message,
)(({ label }) =>
  runtimeCommand((rpc) => {
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
)((timing) => runtimeCommand((rpc) => rpc["device.setTiming"](timing)));

const SetTrigger = Command.define(
  "SetTrigger",
  {
    channel: Schema.Int,
    threshold: Schema.Finite,
    mode: TriggerMode,
  },
  Message,
)((trigger) => runtimeCommand((rpc) => rpc["device.setTrigger"](trigger)));

const modelWithSnapshot = (model: Model, snapshot: RuntimeSnapshot): Model => {
  const selectedPort = nextSelectedPort(model.selectedPort, snapshot);
  const connected = snapshot.activeDevice?.connected === true;
  const timing = snapshot.config?.timing;
  const trigger = snapshot.config?.trigger;

  return {
    ...model,
    runtime: snapshot,
    // The subscription owns live status; clear it when nothing is connected so a
    // disconnect can never leave a stale "running" badge on screen.
    status: connected ? model.status : null,
    selectedPort,
    timingTotalSecondsDraft: timing ? String(timing.totalDurationSeconds) : "",
    timingPreTriggerSecondsDraft: timing ? String(timing.preTriggerSeconds) : "",
    triggerChannelDraft: trigger ? String(trigger.channel) : "",
    triggerThresholdDraft: trigger ? String(trigger.threshold) : "",
    triggerModeDraft: trigger?.mode ?? "disabled",
    busy: null,
    error: null,
    lastUpdatedAt: new Date().toLocaleTimeString(),
  };
};

const nextSelectedPort = (current: string, snapshot: RuntimeSnapshot): string => {
  // A disconnected activeDevice may reference a port that is no longer
  // enumerated; only a live connection pins the selection to its path.
  if (snapshot.activeDevice?.connected) {
    return snapshot.activeDevice.path;
  }
  if (snapshot.ports.some((port) => port.path === current)) {
    return current;
  }
  return snapshot.ports[0]?.path ?? "";
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

const failLocal = (
  model: Model,
  message: string,
): readonly [Model, ReadonlyArray<Command.Command<Message>>] => [
  { ...model, busy: null, error: message },
  [],
];

export const update = (
  model: Model,
  message: Message,
): readonly [Model, ReadonlyArray<Command.Command<Message>>] =>
  Match.value(message).pipe(
    Match.withReturnType<readonly [Model, ReadonlyArray<Command.Command<Message>>]>(),
    Match.tagsExhaustive({
      RuntimeLoaded: ({ snapshot }) => [modelWithSnapshot(model, snapshot), []],
      RuntimeCommandFailed: ({ message }) => [{ ...model, busy: null, error: message }, []],
      DeviceStatusReceived: ({ status }) => [{ ...model, status }, []],
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
      RefreshRequested: () => [{ ...model, busy: "refresh", error: null }, [RefreshRuntime()]],
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
