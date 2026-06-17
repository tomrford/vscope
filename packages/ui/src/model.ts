import { Match, Schema } from "effect";
import type * as Command from "foldkit/command";
import { m } from "foldkit/message";

import { chartColors } from "./theme.stylex.ts";

export const PanelTab = Schema.Literals(["Controls", "Snapshots", "Device"]);
export type PanelTab = Schema.Schema.Type<typeof PanelTab>;

export const Channel = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  unit: Schema.String,
  color: Schema.String,
  min: Schema.Number,
  max: Schema.Number,
  frequencyHz: Schema.Number,
});
export type Channel = Schema.Schema.Type<typeof Channel>;

export const Snapshot = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  capturedAt: Schema.String,
  channels: Schema.Number,
  size: Schema.String,
});
export type Snapshot = Schema.Schema.Type<typeof Snapshot>;

export const Model = Schema.Struct({
  appName: Schema.String,
  status: Schema.String,
  isRunning: Schema.Boolean,
  activePanel: PanelTab,
  selectedSignals: Schema.Array(Schema.String),
  channels: Schema.Array(Channel),
  snapshots: Schema.Array(Snapshot),
});

export type Model = Schema.Schema.Type<typeof Model>;

export const RuntimeStateLoaded = m("RuntimeStateLoaded", {
  status: Schema.String,
});
export const SelectedPanel = m("SelectedPanel", {
  panel: PanelTab,
});
export const ToggledRun = m("ToggledRun");
export const SelectedSignal = m("SelectedSignal", {
  lane: Schema.Number,
  signalId: Schema.String,
});

export const Message = Schema.Union([
  RuntimeStateLoaded,
  SelectedPanel,
  ToggledRun,
  SelectedSignal,
]);
export type Message = Schema.Schema.Type<typeof Message>;

const demoChannels: ReadonlyArray<Channel> = [
  {
    id: "motor.current",
    label: "Motor current",
    unit: "A",
    color: chartColors[0],
    min: -2.4,
    max: 18.2,
    frequencyHz: 72,
  },
  {
    id: "bus.voltage",
    label: "Bus voltage",
    unit: "V",
    color: chartColors[1],
    min: 21.8,
    max: 24.7,
    frequencyHz: 48,
  },
  {
    id: "control.error",
    label: "Control error",
    unit: "deg",
    color: chartColors[2],
    min: -4.8,
    max: 5.2,
    frequencyHz: 38,
  },
  {
    id: "temperature.fet",
    label: "FET temperature",
    unit: "C",
    color: chartColors[3],
    min: 37.1,
    max: 61.6,
    frequencyHz: 16,
  },
  {
    id: "pwm.duty",
    label: "PWM duty",
    unit: "%",
    color: chartColors[4],
    min: 0,
    max: 93.4,
    frequencyHz: 91,
  },
  {
    id: "encoder.velocity",
    label: "Encoder velocity",
    unit: "rpm",
    color: "#0d9488",
    min: -120,
    max: 1840,
    frequencyHz: 64,
  },
];

const demoSnapshots: ReadonlyArray<Snapshot> = [
  {
    id: "snap-105",
    label: "Startup overshoot",
    capturedAt: "Today 14:06:18",
    channels: 5,
    size: "2.8 MB",
  },
  {
    id: "snap-104",
    label: "Thermal ramp",
    capturedAt: "Today 13:42:09",
    channels: 4,
    size: "1.9 MB",
  },
  {
    id: "snap-099",
    label: "Manual trigger capture",
    capturedAt: "Yesterday 18:21:44",
    channels: 5,
    size: "3.1 MB",
  },
];

export const init = (): readonly [Model, ReadonlyArray<Command.Command<Message>>] => [
  {
    appName: "vscope",
    status: "Connected to vscope-devkit",
    isRunning: true,
    activePanel: "Controls",
    selectedSignals: demoChannels.slice(0, 5).map((channel) => channel.id),
    channels: [...demoChannels],
    snapshots: [...demoSnapshots],
  },
  [],
];

const replaceAt = <A>(values: ReadonlyArray<A>, index: number, value: A): ReadonlyArray<A> =>
  values.map((entry, entryIndex) => (entryIndex === index ? value : entry));

export const update = (
  model: Model,
  message: Message,
): readonly [Model, ReadonlyArray<Command.Command<Message>>] =>
  Match.value(message).pipe(
    Match.withReturnType<readonly [Model, ReadonlyArray<Command.Command<Message>>]>(),
    Match.tagsExhaustive({
      RuntimeStateLoaded: ({ status }) => [{ ...model, status }, []],
      SelectedPanel: ({ panel }) => [{ ...model, activePanel: panel }, []],
      ToggledRun: () => [{ ...model, isRunning: !model.isRunning }, []],
      SelectedSignal: ({ lane, signalId }) => [
        {
          ...model,
          selectedSignals: replaceAt(model.selectedSignals, lane, signalId),
        },
        [],
      ],
    }),
  );
