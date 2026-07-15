import {
  DEFAULT_SETTINGS,
  LiveViewSettings,
  NetworkSettings,
  PollingSettings,
  PersistentId,
  RuntimeActiveDevice,
  RuntimeAppDto,
  RuntimeApiError,
  RuntimeControlStatus,
  RuntimeDeviceConfigPayload,
  RuntimeFramePayload,
  RuntimePortInfo,
  RuntimeSettingsPatchRequest,
  SerialConfig,
  SerialParity,
  Settings,
  SnapshotSettings,
  SnapshotRecord,
  Theme,
  TriggerMode,
  errorReason,
} from "@vscope/shared";
import { Cause, Effect, Match, Schema } from "effect";
import * as Command from "foldkit/command";
import { m } from "foldkit/message";
import * as Navigation from "foldkit/navigation";
import { UrlRequest } from "foldkit/navigation";
import * as UrlModule from "foldkit/url";
import { Url } from "foldkit/url";

import { RuntimeClient, type RuntimeRpc } from "./client.ts";
import { Route, parseRoute, routeSnapshotIds } from "./route.ts";
import { loadSnapshotSamples } from "./snapshotplot.ts";

// Which popover or dialog is open. Ephemeral view state, but kept in the
// Model so open/close is explicit, testable, and survives a render.
export const MenuId = Schema.Literals([
  "ports",
  "timing",
  "trigger",
  "channels",
  "rt",
  "snapshots",
  "saveSnapshot",
  "activity",
  "settings",
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
  "setChannelMap",
  "deleteSnapshot",
  "favoriteSnapshot",
  "clearActivity",
  "saveSettings",
]);
export type ControlAction = Schema.Schema.Type<typeof ControlAction>;

const BusyState = Schema.NullOr(ControlAction);

const SettingsTextField = Schema.Literals([
  "baudRate",
  "stateHz",
  "frameHz",
  "serialTimeoutMs",
  "retryAttempts",
  "retentionDays",
  "bufferDurationSeconds",
  "port",
]);
type SettingsTextField = Schema.Schema.Type<typeof SettingsTextField>;

export const SettingsDraft = Schema.Struct({
  theme: Theme,
  baudRate: Schema.String,
  dataBits: Schema.Literals([5, 6, 7, 8]),
  stopBits: Schema.Literals([1, 1.5, 2]),
  parity: SerialParity,
  dtr: Schema.Boolean,
  rts: Schema.Boolean,
  stateHz: Schema.String,
  frameHz: Schema.String,
  serialTimeoutMs: Schema.String,
  retryAttempts: Schema.String,
  retentionDays: Schema.String,
  bufferDurationSeconds: Schema.String,
  port: Schema.String,
});
export type SettingsDraft = Schema.Schema.Type<typeof SettingsDraft>;

// Load status per snapshot id on the viewer route. The decoded samples
// themselves live in the snapshotplot store, not the model.
export const SnapshotLoad = Schema.Struct({
  status: Schema.Literals(["loading", "loaded", "failed"]),
  message: Schema.NullOr(Schema.String),
});
export type SnapshotLoad = Schema.Schema.Type<typeof SnapshotLoad>;

export const Model = Schema.Struct({
  route: Route,
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
  compareSelection: Schema.Array(Schema.String),
  snapshotDeleteCandidate: Schema.NullOr(PersistentId),
  snapshotLoads: Schema.Record(Schema.String, SnapshotLoad),
  systemDark: Schema.Boolean,
  settingsDraft: SettingsDraft,
  openMenu: Schema.NullOr(MenuId),
  busy: BusyState,
  error: Schema.NullOr(Schema.String),
});

export type Model = Schema.Schema.Type<typeof Model>;

export const resolvedTheme = (model: Model): "light" | "dark" => {
  const preference = model.app?.settings.theme ?? "system";
  return preference === "system" ? (model.systemDark ? "dark" : "light") : preference;
};

export const UrlRequested = m("UrlRequested", {
  request: UrlRequest,
});
export const RouteChanged = m("RouteChanged", {
  url: Url,
});
export const NavigationDone = m("NavigationDone");
export const SnapshotSamplesLoaded = m("SnapshotSamplesLoaded", {
  id: Schema.String,
});
export const SnapshotSamplesFailed = m("SnapshotSamplesFailed", {
  id: Schema.String,
  message: Schema.String,
});
export const SnapshotCompareToggled = m("SnapshotCompareToggled", {
  id: Schema.String,
});
export const SnapshotDeleteToggled = m("SnapshotDeleteToggled", {
  id: PersistentId,
});
export const SnapshotDeleteConfirmed = m("SnapshotDeleteConfirmed", {
  id: PersistentId,
});
export const SnapshotFavoriteChanged = m("SnapshotFavoriteChanged", {
  id: PersistentId,
  favorite: Schema.Boolean,
});
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
export const SnapshotPlotMounted = m("SnapshotPlotMounted");
export const RuntimeLinkDown = m("RuntimeLinkDown");
export const SystemThemeChanged = m("SystemThemeChanged", {
  dark: Schema.Boolean,
});
export const CommandSettled = m("CommandSettled");
export const RtWriteSettled = m("RtWriteSettled");
export const RtWriteFailed = m("RtWriteFailed", {
  message: Schema.NullOr(Schema.String),
});
export const RefreshPortsFailed = m("RefreshPortsFailed", {
  message: Schema.NullOr(Schema.String),
});
export const PortsRescanFailed = m("PortsRescanFailed", {
  message: Schema.NullOr(Schema.String),
});
export const RuntimeCommandFailed = m("RuntimeCommandFailed", {
  message: Schema.NullOr(Schema.String),
});
export const ActivityClearRequested = m("ActivityClearRequested");
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
export const RtValueCommitted = m("RtValueCommitted", {
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
export const SettingsTextChanged = m("SettingsTextChanged", {
  field: SettingsTextField,
  value: Schema.String,
});
export const SettingsThemeChanged = m("SettingsThemeChanged", { theme: Theme });
export const SettingsDataBitsChanged = m("SettingsDataBitsChanged", {
  dataBits: Schema.Literals([5, 6, 7, 8]),
});
export const SettingsStopBitsChanged = m("SettingsStopBitsChanged", {
  stopBits: Schema.Literals([1, 1.5, 2]),
});
export const SettingsParityChanged = m("SettingsParityChanged", { parity: SerialParity });
export const SettingsDtrToggled = m("SettingsDtrToggled");
export const SettingsRtsToggled = m("SettingsRtsToggled");
export const SettingsApplyRequested = m("SettingsApplyRequested");
export const RefreshPortsRequested = m("RefreshPortsRequested");
export const ConnectRequested = m("ConnectRequested");
export const DisconnectRequested = m("DisconnectRequested");
export const RunRequested = m("RunRequested");
export const StopRequested = m("StopRequested");
export const TriggerRequested = m("TriggerRequested");
export const SaveSnapshotRequested = m("SaveSnapshotRequested");
export const SetTimingRequested = m("SetTimingRequested");
export const SetTriggerRequested = m("SetTriggerRequested");
export const SetChannelMapRequested = m("SetChannelMapRequested");

export const Message = Schema.Union([
  UrlRequested,
  RouteChanged,
  NavigationDone,
  SnapshotSamplesLoaded,
  SnapshotSamplesFailed,
  SnapshotCompareToggled,
  SnapshotDeleteToggled,
  SnapshotDeleteConfirmed,
  SnapshotFavoriteChanged,
  AppChanged,
  PortsLoaded,
  PortsRescanned,
  ActiveDeviceChanged,
  DeviceConfigChanged,
  SnapshotsChanged,
  DeviceStatusReceived,
  FrameReceived,
  LivePlotMounted,
  SnapshotPlotMounted,
  RuntimeLinkDown,
  SystemThemeChanged,
  CommandSettled,
  RtWriteSettled,
  RtWriteFailed,
  RefreshPortsFailed,
  PortsRescanFailed,
  RuntimeCommandFailed,
  ActivityClearRequested,
  MenuToggled,
  MenuClosed,
  SelectedPortChanged,
  TimingTotalChanged,
  TimingPreTriggerChanged,
  TriggerChannelChanged,
  TriggerThresholdChanged,
  TriggerModeChanged,
  RtValueChanged,
  RtValueCommitted,
  ChannelMapChanged,
  SnapshotLabelChanged,
  SettingsTextChanged,
  SettingsThemeChanged,
  SettingsDataBitsChanged,
  SettingsStopBitsChanged,
  SettingsParityChanged,
  SettingsDtrToggled,
  SettingsRtsToggled,
  SettingsApplyRequested,
  RefreshPortsRequested,
  ConnectRequested,
  DisconnectRequested,
  RunRequested,
  StopRequested,
  TriggerRequested,
  SaveSnapshotRequested,
  SetTimingRequested,
  SetTriggerRequested,
  SetChannelMapRequested,
]);
export type Message = Schema.Schema.Type<typeof Message>;

type RuntimeOperation<A> = (rpc: RuntimeRpc) => Effect.Effect<A, unknown, never>;
type UiCommand = Command.Command<Message, never, RuntimeClient>;
type UpdateResult = readonly [Model, ReadonlyArray<UiCommand>];

const runtimeCommand: <A>(
  run: RuntimeOperation<A>,
  onSuccess: (value: A) => Message,
  onFailure: (message: string | null) => Message,
) => Effect.Effect<Message, never, RuntimeClient> = Effect.fn("ui.runtimeCommand")(function* <A>(
  run: RuntimeOperation<A>,
  onSuccess: (value: A) => Message,
  onFailure: (message: string | null) => Message,
) {
  const rpc = yield* RuntimeClient;
  return yield* run(rpc).pipe(
    Effect.timeout("15 seconds"),
    Effect.matchCause({
      onFailure: (cause) => {
        const error = Cause.squash(cause);
        return onFailure(error instanceof RuntimeApiError ? null : errorReason(error));
      },
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

const PushUrl = Command.define(
  "PushUrl",
  { url: Schema.String },
  Message,
)(({ url }) => Navigation.pushUrl(url).pipe(Effect.as(NavigationDone())));

const LoadPage = Command.define(
  "LoadPage",
  { href: Schema.String },
  Message,
)(({ href }) => Navigation.load(href).pipe(Effect.as(NavigationDone())));

const LoadSnapshotSamples = Command.define(
  "LoadSnapshotSamples",
  {
    id: Schema.String,
    durationSeconds: Schema.Finite,
    sampleRateHz: Schema.NullOr(Schema.Finite),
  },
  Message,
)((payload) =>
  loadSnapshotSamples(payload).pipe(
    Effect.timeout("30 seconds"),
    Effect.matchCause({
      onFailure: (cause) =>
        SnapshotSamplesFailed({ id: payload.id, message: errorReason(Cause.squash(cause)) }),
      onSuccess: () => SnapshotSamplesLoaded({ id: payload.id }),
    }),
  ),
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

const DeleteSnapshot = Command.define(
  "DeleteSnapshot",
  { id: PersistentId },
  Message,
)(({ id }) => settledCommand((rpc) => rpc["snapshots.delete"]({ id })));

const SetSnapshotFavorite = Command.define(
  "SetSnapshotFavorite",
  { id: PersistentId, favorite: Schema.Boolean },
  Message,
)((payload) => settledCommand((rpc) => rpc["snapshots.favorite"](payload)));

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

// RT writes run without occupying the busy state so the dialog stays live
// while a write is in flight; they settle through their own messages so they
// never clear a concurrent command's busy marker.
const WriteRtValue = Command.define(
  "WriteRtValue",
  { index: Schema.Int, value: Schema.Finite },
  Message,
)(({ index, value }) =>
  runtimeCommand(
    (rpc) => rpc["device.setRtValue"]({ index, value }),
    () => RtWriteSettled(),
    (message) => RtWriteFailed({ message }),
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

const PatchSettings = Command.define(
  "PatchSettings",
  { patch: RuntimeSettingsPatchRequest },
  Message,
)(({ patch }) => settledCommand((rpc) => rpc["settings.patch"](patch)));

const ClearActivity = Command.define(
  "ClearActivity",
  Message,
)(settledCommand((rpc) => rpc["activity.clear"]()));

const settingsDraftFrom = (settings: Settings): SettingsDraft => ({
  theme: settings.theme,
  baudRate: String(settings.defaultSerialConfig.baudRate),
  dataBits: settings.defaultSerialConfig.dataBits,
  stopBits: settings.defaultSerialConfig.stopBits,
  parity: settings.defaultSerialConfig.parity,
  dtr: settings.defaultSerialConfig.dtr,
  rts: settings.defaultSerialConfig.rts,
  stateHz: String(settings.polling.stateHz),
  frameHz: String(settings.polling.frameHz),
  serialTimeoutMs: String(settings.polling.serialTimeoutMs),
  retryAttempts: String(settings.polling.retryAttempts),
  retentionDays: String(settings.snapshots.retentionDays),
  bufferDurationSeconds: String(settings.liveView.bufferDurationSeconds),
  port: String(settings.network.port),
});

export const init = (url: Url): UpdateResult => [
  {
    route: parseRoute(url),
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
    compareSelection: [],
    snapshotDeleteCandidate: null,
    snapshotLoads: {},
    systemDark: false,
    settingsDraft: settingsDraftFrom(DEFAULT_SETTINGS),
    openMenu: null,
    busy: null,
    error: null,
  },
  [RefreshPorts({ foreground: false })],
];

const nextSelectedPort = (
  current: string,
  activeDevice: RuntimeActiveDevice | null,
  lastDevicePath: string | null,
): string => activeDevice?.path ?? (current || lastDevicePath || "");

const seedRtValueDrafts = (
  config: RuntimeDeviceConfigPayload | null,
  rtCount: number,
): ReadonlyArray<string> => {
  if (!config) return [];
  const values = new Map(config.rtValues);
  const length = Math.max(rtCount, ...config.rtValues.map(([index]) => index + 1));
  return Array.from({ length }, (_, index) => {
    const value = values.get(index);
    return value === undefined ? "" : String(value);
  });
};

const modelWithConfig = (model: Model, config: RuntimeDeviceConfigPayload | null): Model => {
  const timing = config?.timing;
  const trigger = config?.trigger;
  const rtCount = model.activeDevice?.info?.rtCount ?? 0;
  // RT fields write on commit, so a config emission (e.g. the echo of a write
  // to another field) must not clobber an in-progress edit: reseed only the
  // drafts still matching their previous seed.
  const previousSeed = seedRtValueDrafts(model.config, rtCount);

  return {
    ...model,
    config,
    linkUp: true,
    timingTotalSecondsDraft: timing ? String(timing.totalDurationSeconds) : "",
    timingPreTriggerSecondsDraft: timing ? String(timing.preTriggerSeconds) : "",
    triggerChannelDraft: trigger ? String(trigger.channel) : "",
    triggerThresholdDraft: trigger ? String(trigger.threshold) : "",
    triggerModeDraft: trigger?.mode ?? "disabled",
    rtValueDrafts: seedRtValueDrafts(config, rtCount).map((seed, index) => {
      const draft = model.rtValueDrafts[index];
      return draft !== undefined && draft !== previousSeed[index] ? draft : seed;
    }),
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

const parseIntegerInRange = (value: string, minimum: number, maximum: number): number | null => {
  const parsed = parseFinite(value);
  return parsed !== null && Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : null;
};

const parseNumberInRange = (value: string, minimum: number, maximum: number): number | null => {
  const parsed = parseFinite(value);
  return parsed !== null && parsed >= minimum && parsed <= maximum ? parsed : null;
};

const updateSettingsText = (
  draft: SettingsDraft,
  field: SettingsTextField,
  value: string,
): SettingsDraft => {
  switch (field) {
    case "baudRate":
      return { ...draft, baudRate: value };
    case "stateHz":
      return { ...draft, stateHz: value };
    case "frameHz":
      return { ...draft, frameHz: value };
    case "serialTimeoutMs":
      return { ...draft, serialTimeoutMs: value };
    case "retryAttempts":
      return { ...draft, retryAttempts: value };
    case "retentionDays":
      return { ...draft, retentionDays: value };
    case "bufferDurationSeconds":
      return { ...draft, bufferDurationSeconds: value };
    case "port":
      return { ...draft, port: value };
  }
};

const settingsPatchFrom = (
  draft: SettingsDraft,
): { readonly patch: RuntimeSettingsPatchRequest } | { readonly error: string } => {
  const baudRate = parseIntegerInRange(draft.baudRate, 1, Number.MAX_SAFE_INTEGER);
  if (baudRate === null) return { error: "Baud rate must be a positive integer." };
  const stateHz = parseNumberInRange(draft.stateHz, 0.1, 50);
  if (stateHz === null) return { error: "State polling must be between 0.1 and 50 Hz." };
  const frameHz = parseNumberInRange(draft.frameHz, 0.1, 100);
  if (frameHz === null) return { error: "Frame polling must be between 0.1 and 100 Hz." };
  const serialTimeoutMs = parseIntegerInRange(draft.serialTimeoutMs, 1, Number.MAX_SAFE_INTEGER);
  if (serialTimeoutMs === null) return { error: "Serial timeout must be a positive integer." };
  const retryAttempts = parseIntegerInRange(draft.retryAttempts, 0, Number.MAX_SAFE_INTEGER);
  if (retryAttempts === null) return { error: "Retry attempts must be zero or greater." };
  const retentionDays =
    draft.retentionDays.trim() === "never"
      ? "never"
      : parseIntegerInRange(draft.retentionDays, 1, 3650);
  if (retentionDays === null) return { error: "Retention must be ‘never’ or 1–3650 days." };
  const bufferDurationSeconds = parseNumberInRange(draft.bufferDurationSeconds, 1, 3600);
  if (bufferDurationSeconds === null) {
    return { error: "Live buffer duration must be between 1 and 3600 seconds." };
  }
  const port = parseIntegerInRange(draft.port, 1, 65535);
  if (port === null) return { error: "Network port must be between 1 and 65535." };

  return {
    patch: RuntimeSettingsPatchRequest.make({
      theme: draft.theme,
      defaultSerialConfig: SerialConfig.make({
        baudRate,
        dataBits: draft.dataBits,
        stopBits: draft.stopBits,
        parity: draft.parity,
        dtr: draft.dtr,
        rts: draft.rts,
      }),
      polling: PollingSettings.make({ stateHz, frameHz, serialTimeoutMs, retryAttempts }),
      snapshots: SnapshotSettings.make({ retentionDays }),
      liveView: LiveViewSettings.make({ bufferDurationSeconds }),
      network: NetworkSettings.make({ port }),
    }),
  };
};

const failLocal = (model: Model, message: string): UpdateResult => [
  { ...model, busy: null, error: message },
  [],
];

// A sample download starts once the route names an id and its record is
// known; the route and the snapshots facet can arrive in either order.
const withSampleLoads = (model: Model): UpdateResult => {
  if (model.route._tag !== "SnapshotsRoute") return [model, []];
  const pending = routeSnapshotIds(model.route).flatMap((id) => {
    if (model.snapshotLoads[id] !== undefined) return [];
    const record = model.snapshots.find((snapshot) => snapshot.id === id);
    return record ? [{ id, record }] : [];
  });
  if (pending.length === 0) return [model, []];
  const snapshotLoads: Record<string, SnapshotLoad> = { ...model.snapshotLoads };
  for (const { id } of pending) snapshotLoads[id] = { status: "loading", message: null };
  return [
    { ...model, snapshotLoads },
    pending.map(({ id, record }) =>
      LoadSnapshotSamples({
        id,
        durationSeconds: record.totalDurationSeconds,
        sampleRateHz: record.sampleRateHz,
      }),
    ),
  ];
};

// A viewer owns samples after its one successful download. Keep the matching
// metadata in that tab if the live index later reports deletion; a fresh tab
// has no loaded entry and therefore renders the id as missing.
const withLoadedViewerSnapshots = (
  model: Model,
  snapshots: ReadonlyArray<SnapshotRecord>,
): ReadonlyArray<SnapshotRecord> => {
  if (model.route._tag !== "SnapshotsRoute") return snapshots;
  const routeIds = new Set(routeSnapshotIds(model.route));
  const retained = model.snapshots.filter(
    (snapshot) =>
      routeIds.has(snapshot.id) &&
      model.snapshotLoads[snapshot.id]?.status === "loaded" &&
      !snapshots.some((current) => current.id === snapshot.id),
  );
  return [...snapshots, ...retained];
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
      UrlRequested: ({ request }) =>
        request._tag === "Internal"
          ? [model, [PushUrl({ url: UrlModule.toString(request.url) })]]
          : [model, [LoadPage({ href: request.href })]],
      RouteChanged: ({ url }) => withSampleLoads({ ...model, route: parseRoute(url) }),
      NavigationDone: () => [model, []],
      SnapshotSamplesLoaded: ({ id }) => [
        {
          ...model,
          snapshotLoads: { ...model.snapshotLoads, [id]: { status: "loaded", message: null } },
        },
        [],
      ],
      SnapshotSamplesFailed: ({ id, message }) => [
        {
          ...model,
          snapshotLoads: { ...model.snapshotLoads, [id]: { status: "failed", message } },
        },
        [],
      ],
      SnapshotCompareToggled: ({ id }) => [
        {
          ...model,
          compareSelection: model.compareSelection.includes(id)
            ? model.compareSelection.filter((entry) => entry !== id)
            : [...model.compareSelection, id],
        },
        [],
      ],
      SnapshotDeleteToggled: ({ id }) => [
        {
          ...model,
          snapshotDeleteCandidate: model.snapshotDeleteCandidate === id ? null : id,
        },
        [],
      ],
      SnapshotDeleteConfirmed: ({ id }) => [
        {
          ...model,
          snapshotDeleteCandidate: null,
          busy: "deleteSnapshot",
          error: null,
        },
        [DeleteSnapshot({ id })],
      ],
      SnapshotFavoriteChanged: ({ id, favorite }) => [
        { ...model, busy: "favoriteSnapshot", error: null },
        [SetSnapshotFavorite({ id, favorite })],
      ],
      AppChanged: ({ app }) => [
        {
          ...model,
          app,
          selectedPort: nextSelectedPort(
            model.selectedPort,
            model.activeDevice,
            app.settings.lastDevicePath,
          ),
          linkUp: true,
          settingsDraft:
            model.openMenu === "settings" ? model.settingsDraft : settingsDraftFrom(app.settings),
        },
        [],
      ],
      PortsLoaded: ({ ports }) => {
        const refreshSettled = model.busy === "refresh";
        return [
          {
            ...model,
            ports,
            selectedPort: nextSelectedPort(
              model.selectedPort,
              model.activeDevice,
              model.app?.settings.lastDevicePath ?? null,
            ),
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
          selectedPort: nextSelectedPort(
            model.selectedPort,
            model.activeDevice,
            model.app?.settings.lastDevicePath ?? null,
          ),
          linkUp: true,
        },
        [],
      ],
      ActiveDeviceChanged: ({ device }) => {
        const connectionLost = model.activeDevice?.connected === true && device?.connected !== true;
        const nextModel = {
          ...model,
          activeDevice: device,
          selectedPort: device?.path ?? model.selectedPort,
          status: connectionLost ? null : model.status,
          frame: connectionLost ? null : model.frame,
          linkUp: true,
        };
        return connectionLost
          ? [nextModel, [RefreshPorts({ foreground: false })]]
          : [nextModel, []];
      },
      DeviceConfigChanged: ({ config }) => [modelWithConfig(model, config), []],
      SnapshotsChanged: ({ snapshots }) => {
        const visibleSnapshots = withLoadedViewerSnapshots(model, snapshots);
        return withSampleLoads({
          ...model,
          snapshots: visibleSnapshots,
          linkUp: true,
          compareSelection: model.compareSelection.filter((id) =>
            visibleSnapshots.some((snapshot) => snapshot.id === id),
          ),
          snapshotDeleteCandidate: visibleSnapshots.some(
            (snapshot) => snapshot.id === model.snapshotDeleteCandidate,
          )
            ? model.snapshotDeleteCandidate
            : null,
        });
      },
      DeviceStatusReceived: ({ status }) => [{ ...model, status, linkUp: true }, []],
      FrameReceived: ({ frame }) => [{ ...model, frame }, []],
      LivePlotMounted: () => [model, []],
      SnapshotPlotMounted: () => [model, []],
      RuntimeLinkDown: () => [{ ...model, linkUp: false }, []],
      SystemThemeChanged: ({ dark }) => [{ ...model, systemDark: dark }, []],
      CommandSettled: () => [{ ...model, busy: null, error: null }, []],
      RtWriteSettled: () => [{ ...model, error: null }, []],
      RtWriteFailed: ({ message }) => [{ ...model, error: message }, []],
      RefreshPortsFailed: ({ message }) =>
        model.busy === "refresh" ? [{ ...model, busy: null, error: message }, []] : [model, []],
      PortsRescanFailed: ({ message }) =>
        model.busy === null ? [{ ...model, error: message }, []] : [model, []],
      RuntimeCommandFailed: ({ message }) => [{ ...model, busy: null, error: message }, []],
      ActivityClearRequested: () => [
        { ...model, busy: "clearActivity", error: null },
        [ClearActivity()],
      ],
      MenuToggled: ({ menu }) => {
        const opening = model.openMenu !== menu;
        return [
          {
            ...model,
            openMenu: opening ? menu : null,
            snapshotLabelDraft: opening && menu === "saveSnapshot" ? "" : model.snapshotLabelDraft,
            settingsDraft:
              opening && menu === "settings" && model.app
                ? settingsDraftFrom(model.app.settings)
                : model.settingsDraft,
          },
          opening && menu === "ports" ? [RefreshPorts({ foreground: false })] : [],
        ];
      },
      MenuClosed: () => [{ ...model, openMenu: null, snapshotDeleteCandidate: null }, []],
      SelectedPortChanged: ({ path }) =>
        model.activeDevice?.connected === true && model.activeDevice.path !== path
          ? [
              { ...model, selectedPort: path, openMenu: null, busy: "connect", error: null },
              [ConnectDevice({ path })],
            ]
          : [{ ...model, selectedPort: path, openMenu: null }, []],
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
      RtValueCommitted: ({ index, value }) => {
        const seed = String(new Map(model.config?.rtValues ?? []).get(index) ?? "");
        const withDraft = (draft: string): Model => ({
          ...model,
          rtValueDrafts: model.rtValueDrafts.map((entry, position) =>
            position === index ? draft : entry,
          ),
        });
        if (value.trim() === "") return [withDraft(seed), []];
        const parsed = parseFinite(value);
        if (parsed === null) return [{ ...model, error: `RT ${index + 1} must be a number.` }, []];
        const normalized = withDraft(String(parsed));
        return String(parsed) === seed
          ? [normalized, []]
          : [{ ...normalized, error: null }, [WriteRtValue({ index, value: parsed })]];
      },
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
      SettingsTextChanged: ({ field, value }) => [
        { ...model, settingsDraft: updateSettingsText(model.settingsDraft, field, value) },
        [],
      ],
      SettingsThemeChanged: ({ theme }) => [
        { ...model, settingsDraft: { ...model.settingsDraft, theme } },
        [],
      ],
      SettingsDataBitsChanged: ({ dataBits }) => [
        { ...model, settingsDraft: { ...model.settingsDraft, dataBits } },
        [],
      ],
      SettingsStopBitsChanged: ({ stopBits }) => [
        { ...model, settingsDraft: { ...model.settingsDraft, stopBits } },
        [],
      ],
      SettingsParityChanged: ({ parity }) => [
        { ...model, settingsDraft: { ...model.settingsDraft, parity } },
        [],
      ],
      SettingsDtrToggled: () => [
        {
          ...model,
          settingsDraft: { ...model.settingsDraft, dtr: !model.settingsDraft.dtr },
        },
        [],
      ],
      SettingsRtsToggled: () => [
        {
          ...model,
          settingsDraft: { ...model.settingsDraft, rts: !model.settingsDraft.rts },
        },
        [],
      ],
      SettingsApplyRequested: () => {
        const result = settingsPatchFrom(model.settingsDraft);
        return "error" in result
          ? failLocal(model, result.error)
          : [
              { ...model, openMenu: null, busy: "saveSettings", error: null },
              [PatchSettings({ patch: result.patch })],
            ];
      },
      RefreshPortsRequested: () => [
        { ...model, busy: "refresh", error: null },
        [RefreshPorts({ foreground: true })],
      ],
      ConnectRequested: () =>
        model.selectedPort
          ? [
              { ...model, openMenu: null, busy: "connect", error: null },
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
