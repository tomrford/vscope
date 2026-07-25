import {
  SerialParity,
  Theme,
  TriggerMode,
  type PersistentId,
  type RuntimeDeviceState,
  type RuntimePortInfo,
} from "@vscope/shared";
import { Effect, Match, Option, Schema } from "effect";
import type { Document, Html } from "foldkit/html";
import { html } from "foldkit/html";
import * as Mount from "foldkit/mount";

import {
  ActivityClearRequested,
  ChannelMapChanged,
  ConnectRequested,
  DisconnectRequested,
  LivePlotMounted,
  MenuClosed,
  MenuToggled,
  Model,
  RefreshPortsRequested,
  RtValueChanged,
  RtValueCommitted,
  RunRequested,
  SaveSnapshotRequested,
  SelectedPortChanged,
  SetChannelMapRequested,
  SetTimingRequested,
  SetTriggerRequested,
  SettingsApplyRequested,
  SettingsDataBitsChanged,
  SettingsDtrToggled,
  SettingsParityChanged,
  SettingsRtsToggled,
  SettingsStopBitsChanged,
  SettingsTextChanged,
  SettingsThemeChanged,
  SnapshotCompareToggled,
  SnapshotDeleteConfirmed,
  SnapshotDeleteToggled,
  SnapshotFavoriteChanged,
  SnapshotLabelChanged,
  SnapshotPlotMounted,
  StopRequested,
  TimingPreTriggerChanged,
  TimingTotalChanged,
  TriggerChannelChanged,
  TriggerModeChanged,
  TriggerRequested,
  TriggerThresholdChanged,
  init,
  resolvedTheme,
  update,
} from "./model.ts";
import type { MenuId, Message } from "./model.ts";
import { acquireLivePlot, channelColor, releaseLivePlot } from "./liveplot.ts";
import { liveHref, routeSnapshotIds, snapshotsHref, type SnapshotsRoute } from "./route.ts";
import {
  acquireSnapshotPlot,
  releaseSnapshotPlot,
  snapshotChannelLabels,
  snapshotsCompatible,
} from "./snapshotplot.ts";
import { appStyles, sx } from "./styles.ts";
import { darkColors, darkShadows } from "./theme.stylex.ts";

export { Model, init, update };
export type { Message };

type H = ReturnType<typeof html<Message>>;
type ButtonVariant = "default" | "primary" | "run" | "stop" | "active";
type ControlWidth =
  | "runStop"
  | "triggerAction"
  | "timebase"
  | "trigger"
  | "channels"
  | "rt"
  | "snapshots"
  | "save";

const triggerModes: ReadonlyArray<TriggerMode> = TriggerMode.literals;
const themes: ReadonlyArray<Theme> = Theme.literals;
const parities: ReadonlyArray<SerialParity> = SerialParity.literals;

const MountLivePlot = Mount.define(
  "MountLivePlot",
  { channel: Schema.Int },
  LivePlotMounted,
)(
  ({ channel }) =>
    (element) =>
      Effect.acquireRelease(acquireLivePlot(element, channel), releaseLivePlot).pipe(
        Effect.as(LivePlotMounted()),
      ),
);

const MountSnapshotPlot = Mount.define(
  "MountSnapshotPlot",
  { channel: Schema.Int },
  SnapshotPlotMounted,
)(
  ({ channel }) =>
    (element) =>
      Effect.acquireRelease(acquireSnapshotPlot(element, channel), releaseSnapshotPlot).pipe(
        Effect.as(SnapshotPlotMounted()),
      ),
);

const isConnected = (model: Model): boolean =>
  model.linkUp && model.activeDevice?.connected === true;
const isBusy = (model: Model): boolean => model.busy !== null;
const deviceState = (model: Model): RuntimeDeviceState | null => model.status?.state ?? null;
const canRun = (model: Model): boolean =>
  isConnected(model) && deviceState(model) === "halted" && !isBusy(model);
const canStop = (model: Model): boolean => {
  const state = deviceState(model);
  return isConnected(model) && (state === "running" || state === "acquiring") && !isBusy(model);
};
const canTrigger = (model: Model): boolean =>
  isConnected(model) && deviceState(model) === "running" && !isBusy(model);
const canConfigure = (model: Model): boolean =>
  isConnected(model) && deviceState(model) === "halted" && !isBusy(model);
const canConfigureTrigger = (model: Model): boolean => {
  const state = deviceState(model);
  return isConnected(model) && (state === "halted" || state === "running") && !isBusy(model);
};
const canWriteRt = (model: Model): boolean => isConnected(model) && !isBusy(model);
const canSnapshot = (model: Model): boolean =>
  isConnected(model) && model.status?.snapshotValid === true && !isBusy(model);

const controlWidthStyle = (width: ControlWidth | undefined) =>
  width === "runStop"
    ? appStyles.controlRunStop
    : width === "triggerAction"
      ? appStyles.controlTriggerAction
      : width === "timebase"
        ? appStyles.controlTimebase
        : width === "trigger"
          ? appStyles.controlTrigger
          : width === "channels"
            ? appStyles.controlChannels
            : width === "rt"
              ? appStyles.controlRt
              : width === "snapshots"
                ? appStyles.controlSnapshots
                : width === "save"
                  ? appStyles.controlSave
                  : null;

const viewButton = (
  h: H,
  label: string,
  onClick: Message,
  options: {
    readonly variant?: ButtonVariant;
    readonly disabled?: boolean;
    readonly small?: boolean;
    readonly title?: string;
    readonly width?: ControlWidth | undefined;
    readonly leading?: Html | undefined;
    readonly busy?: boolean;
  } = {},
): Html =>
  h.button(
    [
      h.Type("button"),
      h.OnClick(onClick),
      h.Disabled(options.disabled ?? false),
      ...(options.busy ? [h.Attribute("aria-busy", "true")] : []),
      ...(options.title ? [h.Title(options.title)] : []),
      ...sx(
        h,
        appStyles.controlShape,
        appStyles.btn,
        options.small && appStyles.btnSmall,
        options.variant === "primary" && appStyles.btnPrimary,
        options.variant === "run" && appStyles.btnRun,
        options.variant === "stop" && appStyles.btnStop,
        options.variant === "active" && appStyles.btnActive,
        controlWidthStyle(options.width),
      ),
    ],
    [options.leading ?? null, label],
  );

const viewField = (
  h: H,
  label: string,
  value: string,
  onInput: (value: string) => Message,
  options: { readonly placeholder?: string; readonly disabled?: boolean } = {},
): Html =>
  h.label(
    [...sx(h, appStyles.field)],
    [
      h.span([...sx(h, appStyles.fieldLabel)], [label]),
      h.input([
        h.Attribute("type", "number"),
        ...sx(h, appStyles.controlShape, appStyles.input),
        h.Value(value),
        h.OnInput(onInput),
        h.Disabled(options.disabled ?? false),
        h.Placeholder(options.placeholder ?? ""),
      ]),
    ],
  );

const viewHeader = (model: Model, h: H): Html =>
  h.header(
    [...sx(h, appStyles.header)],
    [
      viewLiveBrand(model, h),
      h.div([...sx(h, appStyles.spacer)], []),
      viewConnection(model, h),
      viewActivityMenuButton(model, h),
      viewMenuButton(model, h, "settings", "Settings", viewSettingsDialog, false),
    ],
  );

const viewConnection = (model: Model, h: H): Html => {
  const active = model.activeDevice;
  const selectedPort = model.ports.find((port) => port.path === model.selectedPort);
  const selectedIsActive = active?.path === model.selectedPort;
  const connectedToSelection = active?.connected === true && selectedIsActive;
  const actionLabel = connectedToSelection
    ? "Disconnect"
    : active && selectedIsActive
      ? "Reconnect"
      : "Connect";
  const action = connectedToSelection ? DisconnectRequested() : ConnectRequested();
  const selectorLabel = selectedIsActive
    ? `${active.deviceName} · ${model.selectedPort}`
    : selectedPort
      ? portLabel(selectedPort.path, selectedPort.manufacturer)
      : model.selectedPort || "Select port";

  return h.div(
    [...sx(h, appStyles.cluster)],
    [
      h.div(
        [...sx(h, appStyles.popoverAnchor)],
        [
          h.button(
            [
              h.Type("button"),
              h.OnClick(MenuToggled({ menu: "ports" })),
              h.Disabled(!model.linkUp || isBusy(model)),
              h.Title(model.selectedPort || "Select a serial port"),
              ...sx(
                h,
                appStyles.controlShape,
                appStyles.btn,
                appStyles.btnSmall,
                appStyles.portSelector,
                model.openMenu === "ports" && appStyles.btnActive,
              ),
            ],
            [selectorLabel],
          ),
          model.openMenu === "ports" ? viewPortsPopover(model, h) : null,
        ],
      ),
      viewButton(h, actionLabel, action, {
        variant: connectedToSelection ? "default" : "primary",
        small: true,
        disabled: !model.linkUp || isBusy(model) || model.selectedPort === "",
      }),
    ],
  );
};

const viewPortsPopover = (model: Model, h: H): Html =>
  h.div(
    [...sx(h, appStyles.portsPopover)],
    [
      h.div(
        [...sx(h, appStyles.popoverHeader)],
        [
          h.span([...sx(h, appStyles.cardTitle)], ["Available ports"]),
          viewButton(h, "Refresh", RefreshPortsRequested(), {
            small: true,
            disabled: isBusy(model),
          }),
        ],
      ),
      h.div(
        [...sx(h, appStyles.portsTableWrap)],
        [
          h.table(
            [...sx(h, appStyles.table, appStyles.portsTable)],
            [
              h.thead(
                [],
                [
                  h.tr(
                    [],
                    ["Port", "Manufacturer", "USB ID", "Serial"].map((label) =>
                      h.th([...sx(h, appStyles.tableHead)], [label]),
                    ),
                  ),
                ],
              ),
              h.tbody(
                [],
                model.ports.length === 0
                  ? [
                      h.tr(
                        [],
                        [
                          h.td(
                            [h.Attribute("colspan", "4"), ...sx(h, appStyles.portsEmpty)],
                            ["No serial ports found."],
                          ),
                        ],
                      ),
                    ]
                  : model.ports.map((port) => viewPortRow(model, port, h)),
              ),
            ],
          ),
        ],
      ),
    ],
  );

const viewPortRow = (model: Model, port: RuntimePortInfo, h: H): Html => {
  const selected = model.selectedPort === port.path;
  return h.tr(
    [
      h.Key(port.path),
      ...sx(h, appStyles.tableRow, appStyles.portRow, selected && appStyles.portRowSelected),
    ],
    [
      h.td(
        [...sx(h, appStyles.tableCell)],
        [
          h.button(
            [
              h.Type("button"),
              h.OnClick(SelectedPortChanged({ path: port.path })),
              h.Disabled(isBusy(model)),
              ...sx(
                h,
                appStyles.controlShape,
                appStyles.portChoice,
                selected && appStyles.portChoiceSelected,
              ),
            ],
            [port.path],
          ),
        ],
      ),
      h.td([...sx(h, appStyles.tableCell)], [port.manufacturer ?? "—"]),
      h.td([...sx(h, appStyles.tableCell)], [usbId(port)]),
      h.td([...sx(h, appStyles.tableCell)], [port.serialNumber ?? "—"]),
    ],
  );
};

const usbId = (port: RuntimePortInfo): string =>
  port.vendorId || port.productId ? `${port.vendorId ?? "—"}:${port.productId ?? "—"}` : "—";

type Tone = "run" | "acquire" | "halt" | "fault" | "idle";

const stateDescriptor = (model: Model): { readonly label: string; readonly tone: Tone } => {
  if (!model.linkUp || !isConnected(model)) return { label: "Disconnected", tone: "idle" };
  const state = deviceState(model);
  if (state === null) return { label: "Connecting", tone: "idle" };
  return Match.value(state).pipe(
    Match.withReturnType<{ readonly label: string; readonly tone: Tone }>(),
    Match.when("running", () => ({ label: "Running", tone: "run" })),
    Match.when("acquiring", () => ({ label: "Acquiring", tone: "acquire" })),
    Match.when("halted", () => ({ label: "Halted", tone: "halt" })),
    Match.when("misconfigured", () => ({ label: "Misconfigured", tone: "fault" })),
    Match.exhaustive,
  );
};

const toneStyle = (tone: Tone) =>
  tone === "run"
    ? appStyles.stateRun
    : tone === "acquire"
      ? appStyles.stateAcquire
      : tone === "fault"
        ? appStyles.stateFault
        : tone === "halt"
          ? appStyles.stateHalt
          : appStyles.stateIdle;

const viewScreen = (model: Model, h: H): Html => {
  const channelMap = model.config?.channelMap ?? [];
  const variables = model.activeDevice?.variables ?? [];
  const channelCount = Math.max(channelMap.length, model.activeDevice?.info?.channelCount ?? 0);

  return h.div(
    [...sx(h, appStyles.screen)],
    channelCount === 0
      ? [h.div([...sx(h, appStyles.plotEmpty)], ["Connect a device to stream live channels."])]
      : Array.from({ length: channelCount }, (_, channel) => {
          const variableIndex = channelMap[channel];
          const label =
            variableIndex === undefined
              ? "Unassigned"
              : (variables[variableIndex] ?? `Variable ${variableIndex + 1}`);
          return h.section(
            [h.Key(String(channel)), ...sx(h, appStyles.signalRow)],
            [
              h.div(
                [...sx(h, appStyles.plotViewport)],
                [
                  h.div(
                    [...sx(h, appStyles.plotLegend), h.Style({ color: channelColor(channel) })],
                    [`${channel + 1}. ${label}`],
                  ),
                  h.canvas(
                    [
                      h.AriaLabel(`Live channel ${channel + 1}: ${label}`),
                      h.OnMount(MountLivePlot({ channel })),
                      ...sx(h, appStyles.plotCanvas),
                    ],
                    [],
                  ),
                ],
              ),
            ],
          );
        }),
  );
};

const viewActivityPopover = (model: Model, h: H): Html => {
  const activity = model.app?.activity ?? [];
  return h.div(
    [
      h.Role("dialog"),
      h.AriaLabel("Runtime activity"),
      ...sx(h, appStyles.popoverPanel, appStyles.activityPopover),
    ],
    [
      h.div(
        [...sx(h, appStyles.popoverHeader)],
        [
          h.div(
            [],
            [
              h.span([...sx(h, appStyles.cardTitle)], ["Activity"]),
              h.p(
                [...sx(h, appStyles.activityHint)],
                ["Runtime warnings and errors · newest first"],
              ),
            ],
          ),
          viewButton(h, "Clear", ActivityClearRequested(), {
            small: true,
            disabled: activity.length === 0 || isBusy(model),
          }),
        ],
      ),
      activity.length === 0
        ? h.div([...sx(h, appStyles.activityEmpty)], ["No warnings or errors."])
        : h.div(
            [h.Role("list"), ...sx(h, appStyles.activityList)],
            activity.map((entry) =>
              h.div(
                [h.Key(entry.id), h.Role("listitem"), ...sx(h, appStyles.activityEntry)],
                [
                  h.div(
                    [...sx(h, appStyles.activityEntryHeader)],
                    [
                      h.span(
                        [
                          ...sx(
                            h,
                            appStyles.activityLevel,
                            entry.level === "error"
                              ? appStyles.activityLevelError
                              : appStyles.activityLevelWarning,
                          ),
                        ],
                        [entry.level],
                      ),
                      h.time(
                        [h.Datetime(entry.createdAt), ...sx(h, appStyles.activityTime)],
                        [formatDate(entry.createdAt)],
                      ),
                    ],
                  ),
                  h.p([...sx(h, appStyles.activityMessage)], [entry.message]),
                ],
              ),
            ),
          ),
    ],
  );
};

const viewActivityMenuButton = (model: Model, h: H): Html => {
  const activity = model.app?.activity ?? [];
  const count = activity.length;
  const open = model.openMenu === "activity";
  const label = count === 0 ? "Activity" : `Activity, ${count} ${count === 1 ? "event" : "events"}`;
  return h.div(
    [...sx(h, appStyles.popoverAnchor)],
    [
      h.button(
        [
          h.Type("button"),
          h.OnClick(MenuToggled({ menu: "activity" })),
          h.AriaLabel(label),
          h.AriaExpanded(open),
          h.AriaHasPopup("dialog"),
          h.Title(label),
          ...sx(
            h,
            appStyles.controlShape,
            appStyles.btn,
            open && appStyles.btnActive,
            appStyles.activityButton,
          ),
        ],
        [
          "Activity",
          count > 0
            ? h.span(
                [
                  ...sx(
                    h,
                    appStyles.activityBadge,
                    activity.some((entry) => entry.level === "error")
                      ? null
                      : appStyles.activityBadgeWarning,
                  ),
                ],
                [count > 99 ? "99+" : String(count)],
              )
            : null,
        ],
      ),
      open ? viewActivityPopover(model, h) : null,
    ],
  );
};

const viewRunStopButton = (model: Model, h: H): Html => {
  const state = deviceState(model);
  const stopsDevice = state === "running" || state === "acquiring";
  return stopsDevice
    ? viewButton(h, "Stop", StopRequested(), {
        variant: "stop",
        disabled: !canStop(model),
        width: "runStop",
      })
    : viewButton(h, "Run", RunRequested(), {
        variant: "run",
        disabled: !canRun(model),
        width: "runStop",
      });
};

const viewDock = (model: Model, h: H): Html =>
  h.div(
    [...sx(h, appStyles.dock)],
    [
      h.div(
        [...sx(h, appStyles.dockGroup)],
        [
          viewRunStopButton(model, h),
          viewButton(h, "Trigger", TriggerRequested(), {
            disabled: !canTrigger(model),
            title: "Force a capture while running",
            width: "triggerAction",
          }),
        ],
      ),
      h.div([...sx(h, appStyles.dockDivider)], []),
      h.div(
        [...sx(h, appStyles.dockGroup)],
        [
          viewMenuButton(
            model,
            h,
            "timing",
            timebaseButtonLabel(model),
            viewTimingPopover,
            true,
            !canConfigure(model),
            "timebase",
          ),
          viewMenuButton(
            model,
            h,
            "trigger",
            triggerButtonLabel(model),
            viewTriggerPopover,
            true,
            !canConfigureTrigger(model),
            "trigger",
          ),
          viewMenuButton(
            model,
            h,
            "channels",
            "Channels",
            viewChannelsPopover,
            true,
            !canConfigure(model),
            "channels",
          ),
          viewMenuButton(model, h, "rt", "RT buffers", viewRtDialog, true, false, "rt"),
          viewMenuButton(
            model,
            h,
            "snapshots",
            "Snapshots",
            viewSnapshotsDialog,
            false,
            false,
            "snapshots",
          ),
          viewMenuButton(
            model,
            h,
            "saveSnapshot",
            model.busy === "saveSnapshot" ? "Saving…" : "Save snapshot",
            viewSaveSnapshotPopover,
            true,
            !canSnapshot(model),
            "save",
            model.busy === "saveSnapshot"
              ? h.span([h.Attribute("aria-hidden", "true"), ...sx(h, appStyles.spinner)], [])
              : undefined,
            model.busy === "saveSnapshot",
          ),
        ],
      ),
    ],
  );

const viewMenuButton = (
  model: Model,
  h: H,
  menu: MenuId,
  label: string,
  panel: (model: Model, h: H) => Html,
  requiresDevice = true,
  disabled = false,
  width?: ControlWidth,
  leading?: Html,
  busy = false,
): Html =>
  h.div(
    [...sx(h, appStyles.popoverAnchor)],
    [
      viewButton(h, label, MenuToggled({ menu }), {
        variant: model.openMenu === menu ? "active" : "default",
        disabled: disabled || (requiresDevice && !isConnected(model)),
        width,
        leading,
        busy,
      }),
      model.openMenu === menu ? panel(model, h) : null,
    ],
  );

const viewPopoverHeader = (h: H, title: string, meta: string): Html =>
  h.div(
    [...sx(h, appStyles.popoverHeader)],
    [
      h.span([...sx(h, appStyles.cardTitle)], [title]),
      h.span([...sx(h, appStyles.cardMeta)], [meta]),
    ],
  );

const viewTimingPopover = (model: Model, h: H): Html =>
  h.div(
    [...sx(h, appStyles.popoverPanel)],
    [
      viewPopoverHeader(h, "Timebase", "seconds"),
      h.div(
        [...sx(h, appStyles.popoverRow)],
        [
          viewField(h, "Total", model.timingTotalSecondsDraft, (value) =>
            TimingTotalChanged({ value }),
          ),
          viewField(h, "Pre-trigger", model.timingPreTriggerSecondsDraft, (value) =>
            TimingPreTriggerChanged({ value }),
          ),
        ],
      ),
      viewButton(h, "Apply", SetTimingRequested(), {
        variant: "primary",
        disabled: !canConfigure(model),
        title: "Editable while halted",
      }),
    ],
  );

const viewTriggerPopover = (model: Model, h: H): Html => {
  const channelMap = model.config?.channelMap ?? [];
  const variables = model.activeDevice?.variables ?? [];
  return h.div(
    [...sx(h, appStyles.popoverPanel)],
    [
      viewPopoverHeader(h, "Trigger", model.config?.trigger?.mode ?? "not set"),
      h.label(
        [...sx(h, appStyles.field)],
        [
          h.span([...sx(h, appStyles.fieldLabel)], ["Channel"]),
          h.select(
            [
              ...sx(h, appStyles.controlShape, appStyles.select),
              h.Attribute("value", model.triggerChannelDraft),
              h.OnChange((value) => TriggerChannelChanged({ value })),
            ],
            channelMap.map((variableIndex, channel) =>
              h.option(
                [
                  h.Key(String(channel)),
                  h.Attribute("value", String(channel)),
                  h.Selected(String(channel) === model.triggerChannelDraft),
                ],
                [`${channel + 1} — ${variables[variableIndex] ?? `Variable ${variableIndex + 1}`}`],
              ),
            ),
          ),
        ],
      ),
      viewField(h, "Threshold", model.triggerThresholdDraft, (value) =>
        TriggerThresholdChanged({ value }),
      ),
      h.label(
        [...sx(h, appStyles.field)],
        [
          h.span([...sx(h, appStyles.fieldLabel)], ["Mode"]),
          h.select(
            [
              ...sx(h, appStyles.controlShape, appStyles.select),
              h.Attribute("value", model.triggerModeDraft),
              h.OnChange((mode) => TriggerModeChanged({ mode: parseTriggerMode(mode) })),
            ],
            triggerModes.map((mode) =>
              h.option(
                [
                  h.Key(mode),
                  h.Attribute("value", mode),
                  h.Selected(mode === model.triggerModeDraft),
                ],
                [mode],
              ),
            ),
          ),
        ],
      ),
      viewButton(h, "Apply", SetTriggerRequested(), {
        variant: "primary",
        disabled: !canConfigureTrigger(model),
        title: "Editable while halted or running",
      }),
    ],
  );
};

const viewChannelsPopover = (model: Model, h: H): Html => {
  const variables = model.activeDevice?.variables ?? [];
  return h.div(
    [...sx(h, appStyles.popoverPanel, appStyles.popoverWide)],
    [
      viewPopoverHeader(h, "Channel map", `${model.channelMapDraft.length} channels`),
      h.div(
        [...sx(h, appStyles.popoverList)],
        model.channelMapDraft.map((value, channel) =>
          h.label(
            [h.Key(String(channel)), ...sx(h, appStyles.mappingRow)],
            [
              h.span([...sx(h, appStyles.mappingIndex)], [`Channel ${channel + 1}`]),
              h.select(
                [
                  ...sx(h, appStyles.controlShape, appStyles.select),
                  h.Attribute("value", value),
                  h.OnChange((next) => ChannelMapChanged({ channel, value: next })),
                  h.Disabled(!canConfigure(model)),
                ],
                variables.map((name, variable) =>
                  h.option(
                    [
                      h.Key(String(variable)),
                      h.Attribute("value", String(variable)),
                      h.Selected(String(variable) === value),
                    ],
                    [name || `Variable ${variable + 1}`],
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
      viewButton(h, "Apply channel map", SetChannelMapRequested(), {
        variant: "primary",
        disabled: !canConfigure(model),
      }),
    ],
  );
};

const viewRtDialog = (model: Model, h: H): Html => {
  const labels = model.activeDevice?.rtLabels ?? [];
  return h.section(
    [...sx(h, appStyles.dialog)],
    [
      h.div(
        [...sx(h, appStyles.dialogHeader)],
        [
          h.div(
            [],
            [
              h.h2([...sx(h, appStyles.dialogTitle)], ["RT buffers"]),
              h.p(
                [...sx(h, appStyles.helperText)],
                ["Each value writes to the device as soon as the field is committed"],
              ),
            ],
          ),
          viewButton(h, "Close", MenuClosed(), { small: true }),
        ],
      ),
      model.rtValueDrafts.length === 0
        ? h.div([...sx(h, appStyles.tableEmpty)], ["The connected device exposes no RT buffers."])
        : h.div(
            [...sx(h, appStyles.rtGrid)],
            model.rtValueDrafts.map((value, index) =>
              h.label(
                [h.Key(String(index)), ...sx(h, appStyles.field)],
                [
                  h.span([...sx(h, appStyles.fieldLabel)], [labels[index] || `RT ${index + 1}`]),
                  h.input([
                    h.Attribute("type", "number"),
                    ...sx(h, appStyles.controlShape, appStyles.input),
                    h.Value(value),
                    h.OnInput((next) => RtValueChanged({ index, value: next })),
                    h.OnChange((next) => RtValueCommitted({ index, value: next })),
                    h.Disabled(!canWriteRt(model)),
                  ]),
                ],
              ),
            ),
          ),
    ],
  );
};

const viewSettingsSelect = (
  h: H,
  label: string,
  value: string,
  options: ReadonlyArray<{ readonly value: string; readonly label: string }>,
  onChange: (value: string) => Message,
): Html =>
  h.label(
    [...sx(h, appStyles.field)],
    [
      h.span([...sx(h, appStyles.fieldLabel)], [label]),
      h.select(
        [
          ...sx(h, appStyles.controlShape, appStyles.select),
          h.Attribute("value", value),
          h.OnChange(onChange),
        ],
        options.map((option) =>
          h.option(
            [
              h.Key(option.value),
              h.Attribute("value", option.value),
              h.Selected(option.value === value),
            ],
            [option.label],
          ),
        ),
      ),
    ],
  );

const viewSettingsTextField = (
  h: H,
  label: string,
  field: Parameters<typeof SettingsTextChanged>[0]["field"],
  value: string,
  type: "number" | "text" = "number",
): Html =>
  h.label(
    [...sx(h, appStyles.field)],
    [
      h.span([...sx(h, appStyles.fieldLabel)], [label]),
      h.input([
        h.Attribute("type", type),
        ...sx(h, appStyles.controlShape, appStyles.input),
        h.Value(value),
        h.OnInput((next) => SettingsTextChanged({ field, value: next })),
      ]),
    ],
  );

const viewSettingsCheckbox = (h: H, label: string, checked: boolean, onClick: Message): Html =>
  h.label(
    [...sx(h, appStyles.checkboxField)],
    [
      h.input([h.Attribute("type", "checkbox"), h.Checked(checked), h.OnClick(onClick)]),
      h.span([], [label]),
    ],
  );

const viewSettingsSection = (h: H, title: string, content: ReadonlyArray<Html>): Html =>
  h.section(
    [...sx(h, appStyles.settingsSection)],
    [h.h3([...sx(h, appStyles.settingsSectionTitle)], [title]), ...content],
  );

const viewSettingsDialog = (model: Model, h: H): Html => {
  const draft = model.settingsDraft;
  return h.section(
    [...sx(h, appStyles.dialog)],
    [
      h.div(
        [...sx(h, appStyles.dialogHeader)],
        [
          h.div(
            [],
            [
              h.h2([...sx(h, appStyles.dialogTitle)], ["Settings"]),
              h.p(
                [...sx(h, appStyles.helperText)],
                ["Runtime defaults are stored locally and used by the daemon."],
              ),
            ],
          ),
          h.div(
            [...sx(h, appStyles.cluster)],
            [
              viewButton(h, "Cancel", MenuClosed(), { small: true }),
              viewButton(h, "Apply", SettingsApplyRequested(), {
                variant: "primary",
                small: true,
                disabled: isBusy(model),
              }),
            ],
          ),
        ],
      ),
      h.div(
        [...sx(h, appStyles.settingsGrid)],
        [
          viewSettingsSection(h, "Appearance", [
            viewSettingsSelect(
              h,
              "Theme",
              draft.theme,
              themes.map((theme) => ({
                value: theme,
                label: theme[0]?.toUpperCase() + theme.slice(1),
              })),
              (value) => SettingsThemeChanged({ theme: parseTheme(value) }),
            ),
          ]),
          viewSettingsSection(h, "Live view", [
            viewSettingsTextField(
              h,
              "Buffer duration (seconds)",
              "bufferDurationSeconds",
              draft.bufferDurationSeconds,
            ),
          ]),
          viewSettingsSection(h, "Default serial connection", [
            h.p(
              [...sx(h, appStyles.helperText)],
              ["These values are used the next time a device connects."],
            ),
            h.div(
              [...sx(h, appStyles.settingsFields)],
              [
                viewSettingsTextField(h, "Baud rate", "baudRate", draft.baudRate),
                viewSettingsSelect(
                  h,
                  "Data bits",
                  String(draft.dataBits),
                  [5, 6, 7, 8].map((value) => ({ value: String(value), label: String(value) })),
                  (value) => SettingsDataBitsChanged({ dataBits: parseDataBits(value) }),
                ),
                viewSettingsSelect(
                  h,
                  "Stop bits",
                  String(draft.stopBits),
                  [1, 1.5, 2].map((value) => ({ value: String(value), label: String(value) })),
                  (value) => SettingsStopBitsChanged({ stopBits: parseStopBits(value) }),
                ),
                viewSettingsSelect(
                  h,
                  "Parity",
                  draft.parity,
                  parities.map((parity) => ({ value: parity, label: parity })),
                  (value) => SettingsParityChanged({ parity: parseParity(value) }),
                ),
              ],
            ),
            viewSettingsCheckbox(h, "Assert DTR", draft.dtr, SettingsDtrToggled()),
            viewSettingsCheckbox(h, "Assert RTS", draft.rts, SettingsRtsToggled()),
          ]),
          viewSettingsSection(h, "Polling", [
            h.p(
              [...sx(h, appStyles.helperText)],
              ["These values are used the next time a device connects."],
            ),
            h.div(
              [...sx(h, appStyles.settingsFields)],
              [
                viewSettingsTextField(h, "State rate (Hz)", "stateHz", draft.stateHz),
                viewSettingsTextField(h, "Frame rate (Hz)", "frameHz", draft.frameHz),
                viewSettingsTextField(
                  h,
                  "Serial timeout (ms)",
                  "serialTimeoutMs",
                  draft.serialTimeoutMs,
                ),
                viewSettingsTextField(h, "Retry attempts", "retryAttempts", draft.retryAttempts),
              ],
            ),
          ]),
          viewSettingsSection(h, "Snapshots", [
            viewSettingsTextField(
              h,
              "Retention days",
              "retentionDays",
              draft.retentionDays,
              "text",
            ),
            h.p(
              [...sx(h, appStyles.helperText)],
              ["Enter ‘never’ to keep snapshots indefinitely."],
            ),
          ]),
          viewSettingsSection(h, "Network", [
            viewSettingsTextField(h, "Port", "port", draft.port),
            h.p(
              [...sx(h, appStyles.restartNote)],
              ["A port change takes effect after restarting vscope."],
            ),
          ]),
        ],
      ),
    ],
  );
};

const viewSaveSnapshotPopover = (model: Model, h: H): Html => {
  const canSubmit = model.snapshotLabelDraft.trim() !== "" && canSnapshot(model);

  return h.div(
    [...sx(h, appStyles.popoverPanel, appStyles.saveSnapshotPopover)],
    [
      viewPopoverHeader(h, "Save snapshot", "capture ready"),
      h.input([
        ...sx(h, appStyles.controlShape, appStyles.input),
        h.Value(model.snapshotLabelDraft),
        h.OnInput((value) => SnapshotLabelChanged({ value })),
        h.OnKeyDownPreventDefault((key) =>
          key === "Enter" && canSubmit ? Option.some(SaveSnapshotRequested()) : Option.none(),
        ),
        h.Placeholder("Insert name"),
      ]),
      h.div(
        [...sx(h, appStyles.popoverActions)],
        [
          viewButton(h, "Cancel", MenuClosed()),
          viewButton(h, "OK", SaveSnapshotRequested(), {
            variant: "primary",
            disabled: !canSubmit,
          }),
        ],
      ),
    ],
  );
};

const viewLinkButton = (
  h: H,
  label: string,
  href: string,
  options: { readonly primary?: boolean; readonly small?: boolean } = {},
): Html =>
  h.a(
    [
      h.Href(href),
      h.Target("_blank"),
      ...sx(
        h,
        appStyles.controlShape,
        appStyles.btn,
        appStyles.linkBtn,
        options.small && appStyles.btnSmall,
        options.primary && appStyles.btnPrimary,
      ),
    ],
    [label],
  );

const viewFavoriteButton = (
  h: H,
  label: string,
  favorite: boolean,
  onClick: Message,
  disabled: boolean,
): Html => {
  const actionLabel = favorite ? `Remove ${label} from favourites` : `Add ${label} to favourites`;
  return h.button(
    [
      h.Type("button"),
      h.OnClick(onClick),
      h.Disabled(disabled),
      h.AriaLabel(actionLabel),
      h.AriaPressed(String(favorite)),
      h.Title(actionLabel),
      ...sx(
        h,
        appStyles.controlShape,
        appStyles.btn,
        appStyles.btnSmall,
        appStyles.iconButton,
        favorite && appStyles.starred,
      ),
    ],
    [favorite ? "★" : "☆"],
  );
};

const viewBinIcon = (h: H): Html =>
  h.svg(
    [
      h.ViewBox("0 0 24 24"),
      h.Width("15"),
      h.Height("15"),
      h.Fill("none"),
      h.Stroke("currentColor"),
      h.StrokeWidth("1.8"),
      h.StrokeLinecap("round"),
      h.StrokeLinejoin("round"),
      h.AriaHidden(true),
    ],
    [h.path([h.D("M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5")], [])],
  );

const viewDeleteButton = (model: Model, h: H, id: PersistentId, label: string): Html => {
  const confirming = model.snapshotDeleteCandidate === id;
  const actionLabel = `Delete ${label}`;

  return h.div(
    [...sx(h, appStyles.deleteAnchor)],
    [
      h.button(
        [
          h.Type("button"),
          h.OnClick(SnapshotDeleteToggled({ id })),
          h.Disabled(isBusy(model)),
          h.AriaLabel(actionLabel),
          h.AriaExpanded(confirming),
          h.AriaHasPopup("dialog"),
          h.Title(actionLabel),
          ...sx(h, appStyles.controlShape, appStyles.btn, appStyles.btnSmall, appStyles.iconButton),
        ],
        [viewBinIcon(h)],
      ),
      confirming
        ? h.div(
            [
              h.Role("dialog"),
              h.AriaLabel(`Confirm deletion of ${label}`),
              ...sx(h, appStyles.deletePopover),
            ],
            [
              h.p([...sx(h, appStyles.deletePrompt)], [`Delete “${label}”?`]),
              h.div(
                [...sx(h, appStyles.popoverActions)],
                [
                  viewButton(h, "Cancel", SnapshotDeleteToggled({ id }), { small: true }),
                  viewButton(h, "Delete", SnapshotDeleteConfirmed({ id }), {
                    variant: "stop",
                    small: true,
                    disabled: isBusy(model),
                  }),
                ],
              ),
            ],
          )
        : null,
    ],
  );
};

const viewSnapshotsDialog = (model: Model, h: H): Html =>
  h.section(
    [...sx(h, appStyles.dialog)],
    [
      h.div(
        [...sx(h, appStyles.dialogHeader)],
        [
          h.div(
            [],
            [
              h.h2([...sx(h, appStyles.dialogTitle)], ["Snapshots"]),
              h.p(
                [...sx(h, appStyles.helperText)],
                [
                  "Saved high-resolution captures · comparisons require matching timing and channel labels",
                ],
              ),
            ],
          ),
          h.div(
            [...sx(h, appStyles.cluster)],
            [
              model.compareSelection.length >= 2
                ? viewLinkButton(
                    h,
                    `Compare (${model.compareSelection.length})`,
                    snapshotsHref(model.compareSelection),
                    { primary: true, small: true },
                  )
                : null,
              viewButton(h, "Close", MenuClosed(), { small: true }),
            ],
          ),
        ],
      ),
      h.div(
        [...sx(h, appStyles.tableWrap)],
        [
          h.table(
            [...sx(h, appStyles.table)],
            [
              h.thead(
                [],
                [
                  h.tr(
                    [],
                    [
                      "",
                      "Name",
                      "Device",
                      "Channels",
                      "Samples",
                      "Duration",
                      "Created",
                      "Actions",
                    ].map((label) =>
                      h.th(
                        [
                          ...sx(
                            h,
                            appStyles.tableHead,
                            label === "Actions" && appStyles.tableActions,
                          ),
                        ],
                        [label],
                      ),
                    ),
                  ),
                ],
              ),
              h.tbody(
                [],
                model.snapshots.length === 0
                  ? [
                      h.tr(
                        [],
                        [
                          h.td(
                            [h.Attribute("colspan", "8"), ...sx(h, appStyles.tableEmpty)],
                            ["No saved snapshots."],
                          ),
                        ],
                      ),
                    ]
                  : model.snapshots.map((snapshot) => {
                      const selected = model.compareSelection.includes(snapshot.id);
                      const anchor = model.snapshots.find(
                        (entry) => entry.id === model.compareSelection[0],
                      );
                      const compatible =
                        selected || !anchor || snapshotsCompatible(anchor, snapshot);
                      return h.tr(
                        [h.Key(snapshot.id), ...sx(h, appStyles.tableRow)],
                        [
                          h.td(
                            [...sx(h, appStyles.tableCell)],
                            [
                              h.input([
                                h.Attribute("type", "checkbox"),
                                h.Checked(selected),
                                h.Disabled(!compatible),
                                h.OnClick(SnapshotCompareToggled({ id: snapshot.id })),
                                h.Title(
                                  compatible
                                    ? `Select ${snapshot.label} for comparison`
                                    : "Timing or channel labels do not match the selected capture",
                                ),
                                h.AriaLabel(`Select ${snapshot.label} for comparison`),
                              ]),
                            ],
                          ),
                          h.td(
                            [...sx(h, appStyles.tableCell, appStyles.tableName)],
                            [snapshot.label],
                          ),
                          h.td([...sx(h, appStyles.tableCell)], [snapshot.device.name]),
                          h.td(
                            [...sx(h, appStyles.tableCell)],
                            [String(snapshot.sample.channelCount)],
                          ),
                          h.td(
                            [...sx(h, appStyles.tableCell)],
                            [String(snapshot.sample.sampleCount)],
                          ),
                          h.td(
                            [...sx(h, appStyles.tableCell)],
                            [`${formatNumber(snapshot.totalDurationSeconds)} s`],
                          ),
                          h.td([...sx(h, appStyles.tableCell)], [formatDate(snapshot.createdAt)]),
                          h.td(
                            [...sx(h, appStyles.tableCell, appStyles.tableActions)],
                            [
                              h.div(
                                [...sx(h, appStyles.cluster, appStyles.tableActionsCluster)],
                                [
                                  viewLinkButton(h, "View", snapshotsHref([snapshot.id]), {
                                    small: true,
                                  }),
                                  viewFavoriteButton(
                                    h,
                                    snapshot.label,
                                    snapshot.favorite,
                                    SnapshotFavoriteChanged({
                                      id: snapshot.id,
                                      favorite: !snapshot.favorite,
                                    }),
                                    isBusy(model),
                                  ),
                                  viewDeleteButton(model, h, snapshot.id, snapshot.label),
                                ],
                              ),
                            ],
                          ),
                        ],
                      );
                    }),
              ),
            ],
          ),
        ],
      ),
    ],
  );

const viewLiveBrand = (model: Model, h: H): Html => {
  const descriptor = stateDescriptor(model);
  return viewBrand(h, descriptor.label, descriptor.tone);
};

const viewBrand = (h: H, subtitle: string, tone?: Tone): Html =>
  h.div(
    [...sx(h, appStyles.brand)],
    [
      h.div([...sx(h, appStyles.brandMark, tone ? toneStyle(tone) : null)], []),
      h.div(
        [...sx(h, appStyles.brandCopy)],
        [
          h.h1([...sx(h, appStyles.brandName)], ["vscope"]),
          h.p([...sx(h, appStyles.brandSub, tone ? toneStyle(tone) : null)], [subtitle]),
        ],
      ),
    ],
  );

const viewViewerHeader = (h: H, subtitle: string, meta: string): Html =>
  h.header(
    [...sx(h, appStyles.header)],
    [
      viewBrand(h, subtitle),
      h.div([...sx(h, appStyles.spacer)], []),
      h.span([...sx(h, appStyles.miniStatus)], [meta]),
      h.a(
        [
          h.Href(liveHref()),
          ...sx(h, appStyles.controlShape, appStyles.btn, appStyles.btnSmall, appStyles.linkBtn),
        ],
        ["Live scope"],
      ),
    ],
  );

const viewerIssues = (model: Model, ids: ReadonlyArray<string>): ReadonlyArray<string> => {
  const missing =
    model.snapshots.length === 0
      ? []
      : ids
          .filter((id) => !model.snapshots.some((snapshot) => snapshot.id === id))
          .map((id) => `Unknown snapshot id ${id}`);
  const failed = ids.flatMap((id) => {
    const load = model.snapshotLoads[id];
    if (load?.status !== "failed") return [];
    const label = model.snapshots.find((snapshot) => snapshot.id === id)?.label ?? id;
    return [`${label}: ${load.message ?? "sample download failed"}`];
  });
  return [...missing, ...failed];
};

const viewerEmptyText = (model: Model, ids: ReadonlyArray<string>): string => {
  if (ids.length === 0) {
    return "No snapshots selected. Open one from the Snapshots dialog on the live scope.";
  }
  return model.snapshots.length === 0 ? "Loading snapshot index…" : "Snapshot not found.";
};

const viewSnapshotViewer = (model: Model, route: SnapshotsRoute, h: H): Html => {
  const ids = routeSnapshotIds(route);
  const records = ids.flatMap((id) => {
    const record = model.snapshots.find((snapshot) => snapshot.id === id);
    return record ? [record] : [];
  });
  const channelCount = records.reduce(
    (max, record) => Math.max(max, record.sample.channelCount),
    0,
  );
  const labels = records[0] ? snapshotChannelLabels(records[0]) : [];
  const issues = viewerIssues(model, ids);

  return h.div(
    [...sx(h, appStyles.shell)],
    [
      viewViewerHeader(h, "snapshot viewer", records.map((record) => record.label).join(" · ")),
      h.main(
        [...sx(h, appStyles.body)],
        [
          h.div(
            [...sx(h, appStyles.screen)],
            channelCount === 0
              ? [h.div([...sx(h, appStyles.plotEmpty)], [viewerEmptyText(model, ids)])]
              : Array.from({ length: channelCount }, (_, channel) =>
                  h.section(
                    [h.Key(String(channel)), ...sx(h, appStyles.signalRow)],
                    [
                      h.div(
                        [...sx(h, appStyles.plotViewport)],
                        [
                          h.div(
                            [
                              ...sx(h, appStyles.plotLegend),
                              h.Style({ color: channelColor(channel) }),
                            ],
                            [`${channel + 1}. ${labels[channel] ?? `CH${channel + 1}`}`],
                          ),
                          h.canvas(
                            [
                              h.AriaLabel(
                                `Snapshot channel ${channel + 1}: ${labels[channel] ?? ""}`,
                              ),
                              h.OnMount(MountSnapshotPlot({ channel })),
                              ...sx(h, appStyles.plotCanvas),
                            ],
                            [],
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
          ),
          issues.length > 0 ? h.div([...sx(h, appStyles.errorBanner)], [issues.join(" · ")]) : null,
          h.p(
            [...sx(h, appStyles.viewerHint)],
            [
              records.length > 1
                ? "Scroll to zoom · drag to pan · double-click to reset · later captures draw dimmed"
                : "Scroll to zoom · drag to pan · double-click to reset",
            ],
          ),
        ],
      ),
    ],
  );
};

const viewNotFound = (path: string, h: H): Html =>
  h.div(
    [...sx(h, appStyles.shell)],
    [
      viewViewerHeader(h, "not found", ""),
      h.main(
        [...sx(h, appStyles.body)],
        [h.div([...sx(h, appStyles.plotEmpty)], [`No page at ${path}.`])],
      ),
    ],
  );

const viewLiveContent = (model: Model, h: H): ReadonlyArray<Html | null> => [
  h.div(
    [...sx(h, appStyles.shell)],
    [
      viewHeader(model, h),
      h.main([...sx(h, appStyles.body)], [viewScreen(model, h), viewDock(model, h)]),
    ],
  ),
  model.error ? h.div([h.Role("alert"), ...sx(h, appStyles.localErrorToast)], [model.error]) : null,
  model.openMenu
    ? h.button(
        [
          h.Type("button"),
          h.OnClick(MenuClosed()),
          h.AriaLabel("Close menu"),
          ...sx(h, appStyles.backdrop),
        ],
        [],
      )
    : null,
];

export const view = (model: Model): Document => {
  const h = html<Message>();
  const dark = resolvedTheme(model) === "dark";
  const page = Match.value(model.route).pipe(
    Match.withReturnType<{
      readonly title: string;
      readonly content: ReadonlyArray<Html | null>;
    }>(),
    Match.tagsExhaustive({
      LiveRoute: () => ({ title: "vscope", content: viewLiveContent(model, h) }),
      SnapshotsRoute: (route) => ({
        title: "vscope · snapshots",
        content: [viewSnapshotViewer(model, route, h)],
      }),
      NotFoundRoute: ({ path }) => ({ title: "vscope", content: [viewNotFound(path, h)] }),
    }),
  );
  return {
    title: page.title,
    body: h.div(
      [
        ...sx(
          h,
          appStyles.root,
          dark && darkColors,
          dark && darkShadows,
          dark && appStyles.rootDark,
        ),
      ],
      [...page.content],
    ),
  };
};

const timebaseButtonLabel = (model: Model): string => {
  const timing = model.config?.timing;
  return timing ? `${formatNumber(timing.totalDurationSeconds)} s` : "Timebase";
};

const triggerButtonLabel = (model: Model): string => {
  const trigger = model.config?.trigger;
  return trigger ? `${trigger.mode} · channel ${trigger.channel + 1}` : "Trigger settings";
};

const formatNumber = (value: number): string =>
  Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)));

const portLabel = (path: string, manufacturer: string | undefined): string =>
  manufacturer ? `${path} · ${manufacturer}` : path;

const isTriggerMode = Schema.is(TriggerMode);
const parseTriggerMode = (value: string): TriggerMode =>
  isTriggerMode(value) ? value : "disabled";

const isTheme = Schema.is(Theme);
const parseTheme = (value: string): Theme => (isTheme(value) ? value : "system");

const isParity = Schema.is(SerialParity);
const parseParity = (value: string): SerialParity => (isParity(value) ? value : "none");

const parseDataBits = (value: string): 5 | 6 | 7 | 8 => {
  if (value === "5") return 5;
  if (value === "6") return 6;
  if (value === "7") return 7;
  return 8;
};

const parseStopBits = (value: string): 1 | 1.5 | 2 => {
  if (value === "1") return 1;
  if (value === "1.5") return 1.5;
  return 2;
};

const formatDate = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
};
