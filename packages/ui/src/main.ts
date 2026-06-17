import { Match } from "effect";
import type { Attribute, Document, Html } from "foldkit/html";
import { html } from "foldkit/html";

import {
  Model,
  RuntimeStateLoaded,
  SelectedPanel,
  SelectedSignal,
  ToggledRun,
  init,
  update,
} from "./model.ts";
import type { Channel, Message, PanelTab } from "./model.ts";
import { appStyles, colors, sx } from "./styles.ts";

export { Model, init, update };
export type { Message };

const viewButton = (
  h: ReturnType<typeof html<Message>>,
  label: string,
  onClick: Message,
  tone: "primary" | "default" | "danger" = "default",
): Html =>
  h.button(
    [
      h.Type("button"),
      h.OnClick(onClick),
      ...sx(
        h,
        appStyles.button,
        tone === "primary" && appStyles.primaryButton,
        tone === "danger" && appStyles.dangerButton,
      ),
    ],
    [label],
  );

const viewStatusPill = (h: ReturnType<typeof html<Message>>, label: string): Html =>
  h.span([...sx(h, appStyles.statusPill)], [h.span([...sx(h, appStyles.dot)], []), label]);

const viewField = (
  h: ReturnType<typeof html<Message>>,
  label: string,
  value: string,
  suffix = "",
): Html =>
  h.label(
    [...sx(h, appStyles.field)],
    [
      h.span([...sx(h, appStyles.label)], [suffix ? `${label} (${suffix})` : label]),
      h.input([...sx(h, appStyles.input), h.Value(value)]),
    ],
  );

const viewTabs = (model: Model, h: ReturnType<typeof html<Message>>): Html => {
  const tabs: ReadonlyArray<PanelTab> = ["Controls", "Snapshots", "Device"];

  return h.div(
    [...sx(h, appStyles.tabs)],
    [
      ...tabs.map((tab) =>
        h.button(
          [
            h.Type("button"),
            h.OnClick(SelectedPanel({ panel: tab })),
            ...sx(h, appStyles.tabButton, model.activePanel === tab && appStyles.tabButtonActive),
          ],
          [tab],
        ),
      ),
    ],
  );
};

const viewControlsPanel = (model: Model, h: ReturnType<typeof html<Message>>): Html =>
  h.div(
    [...sx(h, appStyles.panelBody)],
    [
      h.section(
        [...sx(h, appStyles.section)],
        [
          h.div(
            [...sx(h, appStyles.sectionHeader)],
            [
              h.h2([...sx(h, appStyles.sectionTitle)], ["Acquisition"]),
              viewStatusPill(h, model.isRunning ? "Streaming" : "Stopped"),
            ],
          ),
          h.p(
            [...sx(h, appStyles.helperText)],
            [
              "Always-used controls stay above the plots. This panel is for values that are still close to the live workflow but do not need permanent graph space.",
            ],
          ),
        ],
      ),
      h.section(
        [...sx(h, appStyles.section)],
        [
          h.div(
            [...sx(h, appStyles.sectionHeader)],
            [
              h.h2([...sx(h, appStyles.sectionTitle)], ["RT buffers"]),
              h.span([...sx(h, appStyles.rowMeta)], ["5 writable"]),
            ],
          ),
          h.div(
            [...sx(h, appStyles.fieldGrid)],
            [
              viewField(h, "Buffer 0", "128", "samples"),
              viewField(h, "Buffer 1", "512", "samples"),
              viewField(h, "Pre-trigger", "35", "%"),
              viewField(h, "Decimation", "4", "x"),
            ],
          ),
        ],
      ),
      h.section(
        [...sx(h, appStyles.section)],
        [
          h.div(
            [...sx(h, appStyles.sectionHeader)],
            [
              h.h2([...sx(h, appStyles.sectionTitle)], ["Trigger"]),
              h.span([...sx(h, appStyles.rowMeta)], ["armed"]),
            ],
          ),
          h.div(
            [...sx(h, appStyles.fieldGrid)],
            [
              viewField(h, "Mode", "Rising edge"),
              viewField(h, "Source", "Motor current"),
              viewField(h, "Level", "8.4", "A"),
              viewField(h, "Holdoff", "12", "ms"),
            ],
          ),
        ],
      ),
    ],
  );

const viewSnapshotsPanel = (model: Model, h: ReturnType<typeof html<Message>>): Html =>
  h.div(
    [...sx(h, appStyles.panelBody)],
    [
      h.section(
        [...sx(h, appStyles.section)],
        [
          h.div(
            [...sx(h, appStyles.sectionHeader)],
            [
              h.h2([...sx(h, appStyles.sectionTitle)], ["Snapshots"]),
              h.span([...sx(h, appStyles.rowMeta)], [`${model.snapshots.length} captures`]),
            ],
          ),
          h.p(
            [...sx(h, appStyles.helperText)],
            [
              "This wants to become the metadata table: capture time, device, trigger, channel map, notes, and comparison state.",
            ],
          ),
          h.div(
            [],
            [
              ...model.snapshots.map((snapshot) =>
                h.div(
                  [h.Key(snapshot.id), ...sx(h, appStyles.snapshotRow)],
                  [
                    h.div(
                      [],
                      [
                        h.div([...sx(h, appStyles.rowTitle)], [snapshot.label]),
                        h.div(
                          [...sx(h, appStyles.rowMeta)],
                          [
                            `${snapshot.capturedAt} · ${snapshot.channels} channels · ${snapshot.size}`,
                          ],
                        ),
                      ],
                    ),
                    viewButton(
                      h,
                      "Open",
                      RuntimeStateLoaded({ status: `Loaded ${snapshot.label}` }),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ],
      ),
    ],
  );

const viewDevicePanel = (model: Model, h: ReturnType<typeof html<Message>>): Html =>
  h.div(
    [...sx(h, appStyles.panelBody)],
    [
      h.section(
        [...sx(h, appStyles.section)],
        [
          h.div(
            [...sx(h, appStyles.sectionHeader)],
            [
              h.h2([...sx(h, appStyles.sectionTitle)], ["Connection"]),
              viewStatusPill(h, "USB serial"),
            ],
          ),
          h.div(
            [...sx(h, appStyles.fieldGrid)],
            [
              viewField(h, "Port", "/dev/tty.usbmodem101"),
              viewField(h, "Baud", "115200"),
              viewField(h, "Device", "vscope-devkit"),
              viewField(h, "Firmware", "0.4.7"),
            ],
          ),
          h.div(
            [...sx(h, appStyles.buttonRow)],
            [
              viewButton(h, "Reconnect", RuntimeStateLoaded({ status: "Reconnect requested" })),
              viewButton(h, "Forget device", RuntimeStateLoaded({ status: "Forget requested" })),
            ],
          ),
        ],
      ),
      h.section(
        [...sx(h, appStyles.section)],
        [
          h.h2([...sx(h, appStyles.sectionTitle)], ["Persistence"]),
          h.div(
            [...sx(h, appStyles.fieldGrid)],
            [
              viewField(h, "Snapshot folder", "~/.local/share/vscope"),
              viewField(h, "Retention", "Unlimited"),
            ],
          ),
        ],
      ),
    ],
  );

const viewPanelContent = (model: Model, h: ReturnType<typeof html<Message>>): Html =>
  Match.value(model.activePanel).pipe(
    Match.withReturnType<Html>(),
    Match.when("Controls", () => viewControlsPanel(model, h)),
    Match.when("Snapshots", () => viewSnapshotsPanel(model, h)),
    Match.when("Device", () => viewDevicePanel(model, h)),
    Match.exhaustive,
  );

const viewLeftPanel = (model: Model, h: ReturnType<typeof html<Message>>): Html =>
  h.aside(
    [...sx(h, appStyles.leftPanel)],
    [
      h.div(
        [...sx(h, appStyles.brandBar)],
        [
          h.div(
            [...sx(h, appStyles.brandRow)],
            [
              h.div(
                [],
                [
                  h.h1([...sx(h, appStyles.brandTitle)], [model.appName]),
                  h.p([...sx(h, appStyles.brandMeta)], [model.status]),
                ],
              ),
              viewStatusPill(h, "Ready"),
            ],
          ),
          viewTabs(model, h),
        ],
      ),
      viewPanelContent(model, h),
    ],
  );

const channelForLane = (model: Model, lane: number): Channel =>
  model.channels.find((channel) => channel.id === model.selectedSignals[lane]) ?? model.channels[0];

const buildPlotPath = (lane: number): string => {
  const points = Array.from({ length: 72 }, (_, index) => {
    const x = (index / 71) * 1000;
    const wave = Math.sin(index * 0.32 + lane * 0.8) * 34;
    const ripple = Math.sin(index * 0.91 + lane) * 9;
    const trend = ((index % 18) / 18) * 10;
    const y = 90 - (wave + ripple + trend + 46);
    return `${x.toFixed(1)},${Math.max(8, Math.min(92, y)).toFixed(1)}`;
  });

  return `M ${points.join(" L ")}`;
};

const viewSignalSelect = (model: Model, h: ReturnType<typeof html<Message>>, lane: number): Html =>
  h.select(
    [
      ...sx(h, appStyles.select),
      h.Attribute("value", model.selectedSignals[lane] ?? model.channels[0].id),
      h.OnChange((signalId) => SelectedSignal({ lane, signalId })),
    ],
    [
      ...model.channels.map((channel) =>
        h.option(
          [
            h.Key(channel.id),
            h.Attribute("value", channel.id),
            ...(channel.id === model.selectedSignals[lane] ? [h.Attribute("selected", "")] : []),
          ],
          [channel.label],
        ),
      ),
    ],
  );

const viewPlotLane = (model: Model, h: ReturnType<typeof html<Message>>, lane: number): Html => {
  const channel = channelForLane(model, lane);

  return h.section(
    [h.Key(`lane-${lane}`), ...sx(h, appStyles.plotLane)],
    [
      h.div(
        [...sx(h, appStyles.plotControl)],
        [
          h.div(
            [],
            [
              h.p(
                [...sx(h, appStyles.signalName), h.Style({ color: channel.color })],
                [channel.label],
              ),
              h.p(
                [...sx(h, appStyles.signalMeta)],
                [`${channel.min} to ${channel.max} ${channel.unit} · ${channel.frequencyHz} Hz`],
              ),
            ],
          ),
          viewSignalSelect(model, h, lane),
        ],
      ),
      h.div(
        [...sx(h, appStyles.plotArea)],
        [
          h.svg(
            [
              ...sx(h, appStyles.svg),
              h.ViewBox("0 0 1000 100"),
              h.Attribute("preserveAspectRatio", "none"),
              h.Role("img"),
              h.AriaLabel(`${channel.label} live plot`),
            ],
            [
              h.rect(
                [h.X("0"), h.Y("0"), h.Width("1000"), h.Height("100"), h.Fill(colors.plotBg)],
                [],
              ),
              ...[1, 2, 3, 4].map((tick) =>
                h.line(
                  [
                    h.Key(`h-${tick}`),
                    h.X1("0"),
                    h.X2("1000"),
                    h.Y1(String(tick * 20)),
                    h.Y2(String(tick * 20)),
                    h.Stroke(colors.plotGrid),
                    h.StrokeWidth("1"),
                  ],
                  [],
                ),
              ),
              ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((tick) =>
                h.line(
                  [
                    h.Key(`v-${tick}`),
                    h.X1(String(tick * 100)),
                    h.X2(String(tick * 100)),
                    h.Y1("0"),
                    h.Y2("100"),
                    h.Stroke(colors.plotGrid),
                    h.StrokeWidth("1"),
                  ],
                  [],
                ),
              ),
              h.path(
                [
                  h.D(buildPlotPath(lane)),
                  h.Fill("none"),
                  h.Stroke(channel.color),
                  h.StrokeWidth("2.4"),
                  h.Attribute("vector-effect", "non-scaling-stroke"),
                ],
                [],
              ),
            ],
          ),
        ],
      ),
    ],
  );
};

const viewGraphPane = (model: Model, h: ReturnType<typeof html<Message>>): Html =>
  h.main(
    [...sx(h, appStyles.graphPane)],
    [
      h.div(
        [...sx(h, appStyles.commandBar)],
        [
          h.div(
            [...sx(h, appStyles.commandGroup)],
            [
              viewButton(
                h,
                model.isRunning ? "Stop" : "Run",
                ToggledRun(),
                model.isRunning ? "danger" : "primary",
              ),
              viewButton(
                h,
                "Manual trigger",
                RuntimeStateLoaded({ status: "Manual trigger fired" }),
              ),
              viewButton(
                h,
                "Save snapshot",
                RuntimeStateLoaded({ status: "Snapshot saved locally" }),
              ),
            ],
          ),
          h.div(
            [...sx(h, appStyles.commandGroup)],
            [
              viewStatusPill(h, model.isRunning ? "Streaming 5 plots" : "Stopped"),
              viewStatusPill(h, "Downloadable"),
            ],
          ),
        ],
      ),
      h.div(
        [...sx(h, appStyles.graphStack)],
        [...[0, 1, 2, 3, 4].map((lane) => viewPlotLane(model, h, lane))],
      ),
    ],
  );

export const view = (model: Model): Document => {
  const h = html<Message>();

  return {
    title: model.appName,
    body: h.div(
      [...sx(h, appStyles.root)],
      [h.div([...sx(h, appStyles.layout)], [viewLeftPanel(model, h), viewGraphPane(model, h)])],
    ),
  };
};
