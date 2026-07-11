import { TriggerMode, type RuntimeDeviceState } from "@vscope/shared";
import { Effect, Match, Schema } from "effect";
import type { Document, Html } from "foldkit/html";
import { html } from "foldkit/html";
import * as Mount from "foldkit/mount";

import {
  ChannelMapChanged,
  ConnectRequested,
  DisconnectRequested,
  LivePlotMounted,
  MenuClosed,
  MenuToggled,
  Model,
  RefreshPortsRequested,
  RtValueChanged,
  RunRequested,
  SaveSnapshotRequested,
  SelectedPortChanged,
  SetChannelMapRequested,
  SetRtValuesRequested,
  SetTimingRequested,
  SetTriggerRequested,
  SnapshotLabelChanged,
  StopRequested,
  TimingPreTriggerChanged,
  TimingTotalChanged,
  TriggerChannelChanged,
  TriggerModeChanged,
  TriggerRequested,
  TriggerThresholdChanged,
  init,
  update,
} from "./model.ts";
import type { MenuId, Message } from "./model.ts";
import { acquireLivePlot, releaseLivePlot } from "./liveplot.ts";
import { appStyles, chartColors, sx } from "./styles.ts";

export { Model, init, update };
export type { Message };

type H = ReturnType<typeof html<Message>>;
type ButtonVariant = "default" | "primary" | "run" | "stop" | "active";

const triggerModes: ReadonlyArray<TriggerMode> = TriggerMode.literals;

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
const canWriteRt = (model: Model): boolean => isConnected(model) && !isBusy(model);
const canSnapshot = (model: Model): boolean =>
  isConnected(model) && model.status?.snapshotValid === true && !isBusy(model);

const viewButton = (
  h: H,
  label: string,
  onClick: Message,
  options: {
    readonly variant?: ButtonVariant;
    readonly disabled?: boolean;
    readonly small?: boolean;
    readonly title?: string;
  } = {},
): Html =>
  h.button(
    [
      h.Type("button"),
      h.OnClick(onClick),
      h.Disabled(options.disabled ?? false),
      ...(options.title ? [h.Title(options.title)] : []),
      ...sx(
        h,
        appStyles.btn,
        options.small && appStyles.btnSmall,
        options.variant === "primary" && appStyles.btnPrimary,
        options.variant === "run" && appStyles.btnRun,
        options.variant === "stop" && appStyles.btnStop,
        options.variant === "active" && appStyles.btnActive,
      ),
    ],
    [label],
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
        ...sx(h, appStyles.input),
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
      h.div(
        [...sx(h, appStyles.brand)],
        [
          h.div([...sx(h, appStyles.brandMark)], []),
          h.div(
            [],
            [
              h.h1([...sx(h, appStyles.brandName)], ["vscope"]),
              h.p([...sx(h, appStyles.brandSub)], [appReadiness(model)]),
            ],
          ),
        ],
      ),
      h.div([...sx(h, appStyles.spacer)], []),
      viewConnection(model, h),
      viewStateBadge(model, h),
    ],
  );

const appReadiness = (model: Model): string => {
  const busy = model.busy ? ` · ${model.busy}…` : "";
  return `${model.app?.status ?? "connecting"}${busy}`;
};

const viewConnection = (model: Model, h: H): Html => {
  const active = model.activeDevice;
  if (isConnected(model) && active) {
    return h.div(
      [...sx(h, appStyles.cluster)],
      [
        h.span([...sx(h, appStyles.miniStatus)], [`${active.deviceName} · ${active.path}`]),
        viewButton(h, "Disconnect", DisconnectRequested(), {
          small: true,
          disabled: isBusy(model),
        }),
      ],
    );
  }

  return h.div(
    [...sx(h, appStyles.cluster)],
    [
      h.select(
        [
          ...sx(h, appStyles.select, appStyles.portSelect),
          h.Attribute("value", model.selectedPort),
          h.OnChange((path) => SelectedPortChanged({ path })),
          h.Disabled(isBusy(model)),
        ],
        [
          h.option(
            [h.Attribute("value", ""), h.Selected(model.selectedPort === "")],
            ["Select port"],
          ),
          ...model.ports.map((port) =>
            h.option(
              [
                h.Key(port.path),
                h.Attribute("value", port.path),
                h.Selected(port.path === model.selectedPort),
              ],
              [portLabel(port.path, port.manufacturer)],
            ),
          ),
        ],
      ),
      viewButton(h, "Connect", ConnectRequested(), {
        variant: "primary",
        small: true,
        disabled: !model.linkUp || isBusy(model) || model.selectedPort === "",
      }),
      viewButton(h, "Refresh", RefreshPortsRequested(), { small: true, disabled: isBusy(model) }),
    ],
  );
};

type Tone = "run" | "acquire" | "halt" | "fault" | "idle" | "ready";

const stateDescriptor = (model: Model): { readonly label: string; readonly tone: Tone } => {
  if (!model.linkUp) return { label: "Runtime offline", tone: "fault" };
  if (!isConnected(model)) return { label: "No link", tone: "idle" };
  if (model.status?.snapshotValid === true && deviceState(model) === "halted") {
    return { label: "Capture ready", tone: "ready" };
  }
  const state = deviceState(model);
  if (state === null) return { label: "Linking", tone: "idle" };
  return Match.value(state).pipe(
    Match.withReturnType<{ readonly label: string; readonly tone: Tone }>(),
    Match.when("running", () => ({ label: "Running", tone: "run" })),
    Match.when("acquiring", () => ({ label: "Acquiring", tone: "acquire" })),
    Match.when("halted", () => ({ label: "Halted", tone: "halt" })),
    Match.when("misconfigured", () => ({ label: "Misconfigured", tone: "fault" })),
    Match.exhaustive,
  );
};

const viewStateBadge = (model: Model, h: H): Html => {
  const descriptor = stateDescriptor(model);
  return h.span(
    [...sx(h, appStyles.stateBadge, toneBadgeStyle(descriptor.tone))],
    [h.span([...sx(h, appStyles.dot)], []), descriptor.label],
  );
};

const toneBadgeStyle = (tone: Tone) =>
  tone === "run"
    ? appStyles.stateRun
    : tone === "acquire"
      ? appStyles.stateAcquire
      : tone === "fault"
        ? appStyles.stateFault
        : tone === "ready"
          ? appStyles.stateReady
          : appStyles.stateHalt;

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

const viewDock = (model: Model, h: H): Html =>
  h.div(
    [...sx(h, appStyles.dock)],
    [
      h.div(
        [...sx(h, appStyles.dockGroup)],
        [
          viewButton(h, "Run", RunRequested(), { variant: "run", disabled: !canRun(model) }),
          viewButton(h, "Stop", StopRequested(), { variant: "stop", disabled: !canStop(model) }),
          viewButton(h, "Force trigger", TriggerRequested(), {
            disabled: !canTrigger(model),
            title: "Force a capture while running",
          }),
        ],
      ),
      h.div([...sx(h, appStyles.dockDivider)], []),
      h.div(
        [...sx(h, appStyles.dockGroup)],
        [
          viewMenuButton(model, h, "timing", timebaseButtonLabel(model), viewTimingPopover),
          viewMenuButton(model, h, "trigger", triggerButtonLabel(model), viewTriggerPopover),
          viewMenuButton(model, h, "channels", "Channels", viewChannelsPopover),
          viewMenuButton(model, h, "rt", "RT buffers", viewRtPopover),
          viewMenuButton(
            model,
            h,
            "snapshots",
            `Snapshots (${model.snapshots.length})`,
            viewSnapshotsPopover,
            false,
          ),
          viewMenuButton(
            model,
            h,
            "saveSnapshot",
            "Save snapshot",
            viewSaveSnapshotPopover,
            true,
            !canSnapshot(model),
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
): Html =>
  h.div(
    [...sx(h, appStyles.popoverAnchor)],
    [
      viewButton(h, label, MenuToggled({ menu }), {
        variant: model.openMenu === menu ? "active" : "default",
        disabled: disabled || (requiresDevice && !isConnected(model)),
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
              ...sx(h, appStyles.select),
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
              ...sx(h, appStyles.select),
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
        disabled: !canConfigure(model),
        title: "Editable while halted",
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
                  ...sx(h, appStyles.select),
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

const viewRtPopover = (model: Model, h: H): Html => {
  const labels = model.activeDevice?.rtLabels ?? [];
  return h.div(
    [...sx(h, appStyles.popoverPanel, appStyles.popoverWide)],
    [
      viewPopoverHeader(h, "RT buffers", `${model.rtValueDrafts.length} values`),
      h.div(
        [...sx(h, appStyles.popoverList)],
        model.rtValueDrafts.map((value, index) =>
          h.label(
            [h.Key(String(index)), ...sx(h, appStyles.rtRow)],
            [
              h.span([...sx(h, appStyles.mappingIndex)], [labels[index] || `RT ${index + 1}`]),
              h.input([
                h.Attribute("type", "number"),
                ...sx(h, appStyles.input),
                h.Value(value),
                h.OnInput((next) => RtValueChanged({ index, value: next })),
                h.Disabled(!canWriteRt(model)),
              ]),
            ],
          ),
        ),
      ),
      viewButton(h, "Write values", SetRtValuesRequested(), {
        variant: "primary",
        disabled: !canWriteRt(model),
      }),
    ],
  );
};

const viewSaveSnapshotPopover = (model: Model, h: H): Html =>
  h.div(
    [...sx(h, appStyles.popoverPanel, appStyles.saveSnapshotPopover)],
    [
      viewPopoverHeader(h, "Save snapshot", "capture ready"),
      h.input([
        ...sx(h, appStyles.input),
        h.Value(model.snapshotLabelDraft),
        h.OnInput((value) => SnapshotLabelChanged({ value })),
        h.Placeholder("Insert name"),
      ]),
      h.div(
        [...sx(h, appStyles.popoverActions)],
        [
          viewButton(h, "Cancel", MenuClosed()),
          viewButton(h, "OK", SaveSnapshotRequested(), {
            variant: "primary",
            disabled: model.snapshotLabelDraft.trim() === "" || !canSnapshot(model),
          }),
        ],
      ),
    ],
  );

const viewSnapshotsPopover = (model: Model, h: H): Html =>
  h.section(
    [...sx(h, appStyles.snapshotDialog)],
    [
      h.div(
        [...sx(h, appStyles.dialogHeader)],
        [
          h.div(
            [],
            [
              h.h2([...sx(h, appStyles.dialogTitle)], ["Snapshots"]),
              h.p([...sx(h, appStyles.helperText)], ["Saved high-resolution captures"]),
            ],
          ),
          viewButton(h, "Close", MenuClosed(), { small: true }),
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
                    ["Name", "Device", "Channels", "Samples", "Duration", "Created"].map((label) =>
                      h.th([...sx(h, appStyles.tableHead)], [label]),
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
                            [h.Attribute("colspan", "6"), ...sx(h, appStyles.tableEmpty)],
                            ["No saved snapshots."],
                          ),
                        ],
                      ),
                    ]
                  : model.snapshots.map((snapshot) =>
                      h.tr(
                        [h.Key(snapshot.id), ...sx(h, appStyles.tableRow)],
                        [
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
                        ],
                      ),
                    ),
              ),
            ],
          ),
        ],
      ),
    ],
  );

export const view = (model: Model): Document => {
  const h = html<Message>();
  return {
    title: "vscope",
    body: h.div(
      [...sx(h, appStyles.root)],
      [
        h.div(
          [...sx(h, appStyles.shell)],
          [
            viewHeader(model, h),
            h.main(
              [...sx(h, appStyles.body)],
              [
                viewScreen(model, h),
                model.error ? h.div([...sx(h, appStyles.errorBanner)], [model.error]) : null,
                viewDock(model, h),
              ],
            ),
          ],
        ),
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
      ],
    ),
  };
};

const channelColor = (channel: number): string =>
  chartColors[channel % chartColors.length] ?? chartColors[0];

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

const formatDate = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
};
