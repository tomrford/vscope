import { TriggerMode, type RuntimeDeviceState } from "@vscope/shared";
import { Match, Schema } from "effect";
import type { Document, Html } from "foldkit/html";
import { html } from "foldkit/html";

import {
  ConnectRequested,
  DisconnectRequested,
  MenuClosed,
  MenuToggled,
  Model,
  RefreshPortsRequested,
  RunRequested,
  SaveSnapshotRequested,
  SelectedPortChanged,
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
import { appStyles, chartColors, sx } from "./styles.ts";

export { Model, init, update };
export type { Message };

type H = ReturnType<typeof html<Message>>;
type ButtonVariant = "default" | "primary" | "run" | "stop" | "active";

const triggerModes: ReadonlyArray<TriggerMode> = TriggerMode.literals;

// ---- live device facts -----------------------------------------------------

const isConnected = (model: Model): boolean =>
  model.linkUp && model.activeDevice?.connected === true;
const isBusy = (model: Model): boolean => model.busy !== null;
const deviceState = (model: Model): RuntimeDeviceState | null => model.status?.state ?? null;

// Affordances mirror the runtime's control policy so the UI offers exactly the
// commands the device will accept in its current state.
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
const canSnapshot = (model: Model): boolean =>
  isConnected(model) && model.status?.snapshotValid === true && !isBusy(model);

// ---- primitives ------------------------------------------------------------

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
        ...sx(h, appStyles.input),
        h.Value(value),
        h.OnInput(onInput),
        h.Disabled(options.disabled ?? false),
        h.Placeholder(options.placeholder ?? ""),
      ]),
    ],
  );

// ---- header ----------------------------------------------------------------

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
      h.div([...sx(h, appStyles.dockDivider)], []),
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

const viewStateBadge = (model: Model, h: H): Html => {
  const descriptor = stateDescriptor(model);
  const animated = descriptor.tone === "run" || descriptor.tone === "acquire";

  return h.span(
    [...sx(h, appStyles.stateBadge, toneBadgeStyle(descriptor.tone))],
    [h.span([...sx(h, appStyles.dot, animated && appStyles.dotPulse)], []), descriptor.label],
  );
};

type Tone = "run" | "acquire" | "halt" | "fault" | "idle";

const stateDescriptor = (model: Model): { readonly label: string; readonly tone: Tone } => {
  if (!model.linkUp) return { label: "Runtime offline", tone: "fault" };
  if (!isConnected(model)) return { label: "No link", tone: "idle" };
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

const toneBadgeStyle = (tone: Tone) =>
  tone === "run"
    ? appStyles.stateRun
    : tone === "acquire"
      ? appStyles.stateAcquire
      : tone === "fault"
        ? appStyles.stateFault
        : appStyles.stateHalt;

// ---- scope display ---------------------------------------------------------

const viewScreen = (model: Model, h: H): Html =>
  h.div(
    [...sx(h, appStyles.screen)],
    [
      h.div(
        [...sx(h, appStyles.osd, appStyles.osdTopLeft)],
        [
          h.div([...sx(h, appStyles.osdLine)], [connectionLabel(model)]),
          h.div(
            [...sx(h, appStyles.osdLine)],
            [`STATE  ${stateDescriptor(model).label.toUpperCase()}`],
          ),
        ],
      ),
      h.div(
        [...sx(h, appStyles.osd, appStyles.osdTopRight)],
        [
          h.div([...sx(h, appStyles.osdLine)], [triggerSummary(model)]),
          h.div(
            [...sx(h, appStyles.osdLine)],
            [model.status?.snapshotValid ? "SNAPSHOT READY" : "SNAPSHOT —"],
          ),
        ],
      ),
      h.div(
        [...sx(h, appStyles.screenCenter)],
        [
          h.p([...sx(h, appStyles.centerTitle)], ["Live trace idle"]),
          h.p([...sx(h, appStyles.centerHint)], ["Frame streaming is not wired up yet."]),
        ],
      ),
      h.div(
        [...sx(h, appStyles.osd, appStyles.osdBottom)],
        [
          h.div(
            [...sx(h, appStyles.osdScale)],
            [h.span([], [timebaseSummary(model)]), h.span([], [sampleSummary(model)])],
          ),
        ],
      ),
    ],
  );

// ---- command dock ----------------------------------------------------------

const viewDock = (model: Model, h: H): Html =>
  h.div(
    [...sx(h, appStyles.dock)],
    [
      h.div(
        [...sx(h, appStyles.dockGroup)],
        [
          viewButton(h, "Run", RunRequested(), { variant: "run", disabled: !canRun(model) }),
          viewButton(h, "Stop", StopRequested(), { variant: "stop", disabled: !canStop(model) }),
          viewButton(h, "Trigger", TriggerRequested(), {
            disabled: !canTrigger(model),
            title: "Force a trigger while running",
          }),
        ],
      ),
      h.div([...sx(h, appStyles.dockDivider)], []),
      h.div(
        [...sx(h, appStyles.dockGroup)],
        [
          viewMenuButton(model, h, "timing", "Timebase ▾", viewTimingPopover),
          viewMenuButton(model, h, "trigger", "Trigger ▾", viewTriggerPopover),
        ],
      ),
      h.div([...sx(h, appStyles.dockDivider)], []),
      h.div(
        [...sx(h, appStyles.dockGroup)],
        [
          h.input([
            ...sx(h, appStyles.input),
            h.Value(model.snapshotLabelDraft),
            h.OnInput((value) => SnapshotLabelChanged({ value })),
            h.Placeholder("snapshot label"),
            h.Disabled(!isConnected(model)),
          ]),
          viewButton(h, "Save snapshot", SaveSnapshotRequested(), {
            variant: "primary",
            disabled: !canSnapshot(model),
            title: "Available when the device holds a ready snapshot",
          }),
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
): Html =>
  h.div(
    [...sx(h, appStyles.popoverAnchor)],
    [
      viewButton(h, label, MenuToggled({ menu }), {
        variant: model.openMenu === menu ? "active" : "default",
        disabled: !isConnected(model),
      }),
      model.openMenu === menu ? panel(model, h) : null,
    ],
  );

const viewTimingPopover = (model: Model, h: H): Html =>
  h.div(
    [...sx(h, appStyles.popoverPanel)],
    [
      h.div(
        [...sx(h, appStyles.popoverHeader)],
        [
          h.span([...sx(h, appStyles.cardTitle)], ["Timebase"]),
          h.span([...sx(h, appStyles.cardMeta)], ["seconds"]),
        ],
      ),
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
      viewButton(h, "Apply timebase", SetTimingRequested(), {
        variant: "primary",
        disabled: !canConfigure(model),
        title: "Editable while halted",
      }),
    ],
  );

const viewTriggerPopover = (model: Model, h: H): Html =>
  h.div(
    [...sx(h, appStyles.popoverPanel)],
    [
      h.div(
        [...sx(h, appStyles.popoverHeader)],
        [
          h.span([...sx(h, appStyles.cardTitle)], ["Trigger"]),
          h.span([...sx(h, appStyles.cardMeta)], [model.triggerModeDraft]),
        ],
      ),
      h.div(
        [...sx(h, appStyles.popoverRow)],
        [
          viewField(h, "Channel", model.triggerChannelDraft, (value) =>
            TriggerChannelChanged({ value }),
          ),
          viewField(h, "Threshold", model.triggerThresholdDraft, (value) =>
            TriggerThresholdChanged({ value }),
          ),
        ],
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
      viewButton(h, "Apply trigger", SetTriggerRequested(), {
        variant: "primary",
        disabled: !canConfigure(model),
        title: "Editable while halted",
      }),
    ],
  );

// ---- instrument rail -------------------------------------------------------

const viewRail = (model: Model, h: H): Html =>
  h.aside(
    [...sx(h, appStyles.rail)],
    [
      viewChannelsCard(model, h),
      viewRtCard(model, h),
      viewSnapshotsCard(model, h),
      viewDeviceCard(model, h),
    ],
  );

const viewChannelsCard = (model: Model, h: H): Html => {
  const channelMap = model.config?.channelMap ?? [];
  const variables = model.activeDevice?.variables ?? [];

  return h.section(
    [...sx(h, appStyles.card)],
    [
      h.div(
        [...sx(h, appStyles.cardHeader)],
        [
          h.h2([...sx(h, appStyles.cardTitle)], ["Channels"]),
          h.span([...sx(h, appStyles.cardMeta)], [`${channelMap.length}`]),
        ],
      ),
      channelMap.length === 0
        ? h.p([...sx(h, appStyles.helperText)], ["No channel map loaded."])
        : h.div(
            [...sx(h, appStyles.field)],
            channelMap.map((variableIndex, channel) =>
              h.div(
                [h.Key(String(channel)), ...sx(h, appStyles.channelRow)],
                [
                  h.span(
                    [
                      ...sx(h, appStyles.swatch),
                      h.Style({ backgroundColor: channelColor(channel) }),
                    ],
                    [],
                  ),
                  h.span([...sx(h, appStyles.channelTag)], [`CH${channel}`]),
                  h.span(
                    [...sx(h, appStyles.channelVar)],
                    [variables[variableIndex] ?? `var ${variableIndex}`],
                  ),
                ],
              ),
            ),
          ),
    ],
  );
};

const viewRtCard = (model: Model, h: H): Html => {
  const rtValues = model.config?.rtValues ?? [];
  const rtLabels = model.activeDevice?.rtLabels ?? [];

  return h.section(
    [...sx(h, appStyles.card)],
    [
      h.div(
        [...sx(h, appStyles.cardHeader)],
        [
          h.h2([...sx(h, appStyles.cardTitle)], ["RT buffers"]),
          h.span([...sx(h, appStyles.cardMeta)], [`${rtValues.length}`]),
        ],
      ),
      rtValues.length === 0
        ? h.p([...sx(h, appStyles.helperText)], ["No RT buffer values."])
        : h.div(
            [...sx(h, appStyles.kvGrid)],
            rtValues.map(([index, value]) =>
              viewKv(h, String(index), rtLabels[index] ?? `RT ${index}`, formatNumber(value)),
            ),
          ),
    ],
  );
};

const viewSnapshotsCard = (model: Model, h: H): Html =>
  h.section(
    [...sx(h, appStyles.card)],
    [
      h.div(
        [...sx(h, appStyles.cardHeader)],
        [
          h.h2([...sx(h, appStyles.cardTitle)], ["Snapshots"]),
          h.span([...sx(h, appStyles.cardMeta)], [`${model.snapshots.length}`]),
        ],
      ),
      model.snapshots.length === 0
        ? h.p([...sx(h, appStyles.helperText)], ["No saved snapshots."])
        : h.div(
            [],
            model.snapshots.map((snapshot) =>
              h.div(
                [h.Key(snapshot.id), ...sx(h, appStyles.snapRow)],
                [
                  h.div(
                    [],
                    [
                      h.div([...sx(h, appStyles.snapTitle)], [snapshot.label]),
                      h.div(
                        [...sx(h, appStyles.snapMeta)],
                        [
                          `${formatDate(snapshot.createdAt)} · ${snapshot.sample.channelCount}ch · ${snapshot.sample.sampleCount} smpl`,
                        ],
                      ),
                    ],
                  ),
                  h.div(
                    [...sx(h, appStyles.snapMeta)],
                    [`${formatNumber(snapshot.totalDurationSeconds)}s`],
                  ),
                ],
              ),
            ),
          ),
    ],
  );

const viewDeviceCard = (model: Model, h: H): Html => {
  const active = model.activeDevice;
  const info = active?.info;
  const serial = model.app?.settings.defaultSerialConfig;

  return h.section(
    [...sx(h, appStyles.card)],
    [
      h.div(
        [...sx(h, appStyles.cardHeader)],
        [
          h.h2([...sx(h, appStyles.cardTitle)], ["Device"]),
          h.span([...sx(h, appStyles.cardMeta)], [active ? active.deviceName : "offline"]),
        ],
      ),
      h.div(
        [...sx(h, appStyles.kvGrid)],
        [
          viewKv(h, "ch", "Channels", info ? String(info.channelCount) : "—"),
          viewKv(h, "buf", "Buffer", info ? String(info.bufferSize) : "—"),
          viewKv(h, "isr", "ISR kHz", info ? String(info.isrKHz) : "—"),
          viewKv(h, "rt", "RT count", info ? String(info.rtCount) : "—"),
          viewKv(h, "baud", "Baud", serial ? String(serial.baudRate) : "—"),
          viewKv(h, "var", "Variables", info ? String(info.variableCount) : "—"),
        ],
      ),
    ],
  );
};

const viewKv = (h: H, key: string, label: string, value: string): Html =>
  h.div(
    [h.Key(key), ...sx(h, appStyles.kv)],
    [
      h.span([...sx(h, appStyles.kvLabel)], [label]),
      h.span([...sx(h, appStyles.kvValue)], [value]),
    ],
  );

// ---- root ------------------------------------------------------------------

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
            h.div(
              [...sx(h, appStyles.body)],
              [
                h.div(
                  [...sx(h, appStyles.displayCol)],
                  [
                    viewScreen(model, h),
                    model.error
                      ? h.div(
                          [...sx(h, appStyles.errorWrap)],
                          [h.div([...sx(h, appStyles.errorBanner)], [model.error])],
                        )
                      : null,
                    viewDock(model, h),
                  ],
                ),
                viewRail(model, h),
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

// ---- formatting ------------------------------------------------------------

const channelColor = (channel: number): string =>
  chartColors[channel % chartColors.length] ?? chartColors[0];

const connectionLabel = (model: Model): string => {
  const active = model.activeDevice;
  if (!active) return "NO DEVICE";
  if (!active.connected) return `${active.deviceName} OFFLINE`;
  return active.deviceName;
};

const triggerSummary = (model: Model): string => {
  const trigger = model.config?.trigger;
  if (!trigger) return "TRIG  —";
  return `TRIG  ${trigger.mode.toUpperCase()} CH${trigger.channel} @ ${formatNumber(trigger.threshold)}`;
};

const timebaseSummary = (model: Model): string => {
  const timing = model.config?.timing;
  if (!timing) return "—";
  return `${formatNumber(timing.totalDurationSeconds)}s window · ${formatNumber(timing.preTriggerSeconds)}s pre`;
};

const sampleSummary = (model: Model): string => {
  const info = model.activeDevice?.info;
  if (!info) return "";
  return `${info.channelCount} ch · ${info.isrKHz} kHz · ${info.bufferSize} smpl`;
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
