import { Effect, Schedule, Schema, Stream } from "effect";
import * as Subscription from "foldkit/subscription";

import { RuntimeClient, type RuntimeRpc } from "./client.ts";
import {
  ActiveDeviceChanged,
  AppChanged,
  DeviceConfigChanged,
  DeviceStatusReceived,
  FrameReceived,
  RuntimeLinkDown,
  SystemThemeChanged,
  resolvedTheme,
  SnapshotsChanged,
  type Message,
  type Model,
} from "./model.ts";
import { ingestLiveFrame, resetLivePlot, setLivePlotTheme } from "./liveplot.ts";
import { routeSnapshotIds } from "./route.ts";
import {
  configureSnapshotPlots,
  setSnapshotPlotTheme,
  snapshotChannelLabels,
} from "./snapshotplot.ts";

const linkLost = "Runtime facet stream ended";

const frameDependencies = (model: Model) => {
  const active = model.activeDevice;
  const channelCount = active?.info?.channelCount ?? model.config?.channelMap.length ?? 0;
  const channelMap = model.config?.channelMap ?? [];
  const variables = active?.variables ?? [];
  return {
    devicePath: active?.connected === true ? active.path : null,
    labels: Array.from({ length: channelCount }, (_, channel) => {
      const variable = channelMap[channel];
      return variable === undefined ? `CH${channel}` : (variables[variable] ?? `CH${channel}`);
    }),
    mapping: Array.from({ length: channelCount }, (_, channel) => channelMap[channel] ?? -1),
    windowSeconds: model.app?.settings.liveView.bufferDurationSeconds ?? 30,
  };
};

const SnapshotViewDependency = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  durationSeconds: Schema.Finite,
  triggerTimeSeconds: Schema.Finite,
  sampleRateHz: Schema.NullOr(Schema.Finite),
  channelCount: Schema.Int,
  channelLabels: Schema.Array(Schema.String),
});

const snapshotViewDependencies = (model: Model) => ({
  entries:
    model.route._tag === "SnapshotsRoute"
      ? routeSnapshotIds(model.route).flatMap((id) => {
          const record = model.snapshots.find((snapshot) => snapshot.id === id);
          if (!record) return [];
          return [
            {
              id,
              label: record.label,
              durationSeconds: record.totalDurationSeconds,
              triggerTimeSeconds: record.preTriggerSeconds,
              sampleRateHz: record.sampleRateHz,
              channelCount: record.sample.channelCount,
              channelLabels: snapshotChannelLabels(record),
            },
          ];
        })
      : [],
});

const liveFacet = <A, E>(
  open: (rpc: RuntimeRpc) => Stream.Stream<A, E, never>,
  toMessage: (value: A) => Message,
): Stream.Stream<Message, never, RuntimeClient> =>
  Stream.unwrap(RuntimeClient.pipe(Effect.map(open))).pipe(
    Stream.map(toMessage),
    // A live facet should never complete while the daemon is reachable.
    (stream) => Stream.concat(stream, Stream.fail(linkLost)),
    Stream.catch(() => Stream.concat(Stream.make(RuntimeLinkDown()), Stream.fail(linkLost))),
    // SubscriptionRefs replay their current value when this reopens.
    Stream.retry(Schedule.spaced("1 second")),
    Stream.catch(() => Stream.empty),
  );

export const subscriptions = Subscription.make<Model, Message, RuntimeClient>()((entry) => ({
  systemTheme: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () => {
        const query = globalThis.matchMedia("(prefers-color-scheme: dark)");
        return Stream.concat(
          Stream.make(SystemThemeChanged({ dark: query.matches })),
          Stream.fromEventListener<MediaQueryListEvent>(query, "change").pipe(
            Stream.map((event) => SystemThemeChanged({ dark: event.matches })),
          ),
        );
      },
    },
  ),
  plotTheme: entry(
    { theme: Schema.Literals(["light", "dark"]) },
    {
      modelToDependencies: (model) => ({ theme: resolvedTheme(model) }),
      dependenciesToStream: ({ theme }) =>
        Stream.fromEffect(
          Effect.sync(() => {
            setLivePlotTheme(theme);
            setSnapshotPlotTheme(theme);
          }),
        ).pipe(Stream.drain),
    },
  ),
  app: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        liveFacet(
          (rpc) => rpc["runtime.app"](),
          (app) => AppChanged({ app }),
        ),
    },
  ),
  activeDevice: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        liveFacet(
          (rpc) => rpc["device.active"](),
          (device) => ActiveDeviceChanged({ device }),
        ),
    },
  ),
  deviceConfig: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        liveFacet(
          (rpc) => rpc["device.config"](),
          (config) => DeviceConfigChanged({ config }),
        ),
    },
  ),
  deviceStatus: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        liveFacet(
          (rpc) => rpc["device.status"](),
          (status) => DeviceStatusReceived({ status }),
        ),
    },
  ),
  snapshots: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        liveFacet(
          (rpc) => rpc["snapshots.index"](),
          (snapshots) => SnapshotsChanged({ snapshots }),
        ),
    },
  ),
  // Pushes the viewer layout into the snapshotplot store whenever the route
  // or the matching records change; the canvases render from that store.
  snapshotView: entry(
    { entries: Schema.Array(SnapshotViewDependency) },
    {
      modelToDependencies: snapshotViewDependencies,
      dependenciesToStream: ({ entries }) =>
        Stream.fromEffect(Effect.sync(() => configureSnapshotPlots(entries))).pipe(Stream.drain),
    },
  ),
  frames: entry(
    {
      devicePath: Schema.NullOr(Schema.String),
      labels: Schema.Array(Schema.String),
      mapping: Schema.Array(Schema.Int),
      windowSeconds: Schema.Finite,
    },
    {
      modelToDependencies: frameDependencies,
      dependenciesToStream: ({ devicePath, labels, mapping, windowSeconds }) =>
        devicePath === null
          ? Stream.fromEffect(
              Effect.sync(resetLivePlot).pipe(Effect.as(FrameReceived({ frame: null }))),
            )
          : Stream.unwrap(RuntimeClient.pipe(Effect.map((rpc) => rpc["device.frames"]()))).pipe(
              Stream.tap((frame) =>
                Effect.sync(() =>
                  ingestLiveFrame({
                    path: devicePath,
                    labels,
                    mapping,
                    values: frame?.values ?? null,
                    windowSeconds,
                  }),
                ),
              ),
              // The canvas receives every frame above. Foldkit only needs a
              // compact cadence for latest-value labels and DevTools history.
              Stream.throttle({
                cost: () => 1,
                units: 4,
                duration: "1 second",
                strategy: "enforce",
              }),
              Stream.map((frame) => FrameReceived({ frame })),
              Stream.retry(Schedule.spaced("1 second")),
              Stream.catch(() => Stream.empty),
            ),
    },
  ),
}));
