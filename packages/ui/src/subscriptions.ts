import { Effect, Schedule, Stream } from "effect";
import * as Subscription from "foldkit/subscription";

import { RuntimeClient, type RuntimeRpc } from "./client.ts";
import {
  ActiveDeviceChanged,
  AppChanged,
  DeviceConfigChanged,
  DeviceStatusReceived,
  RuntimeLinkDown,
  SnapshotsChanged,
  type Message,
  type Model,
} from "./model.ts";

const linkLost = "Runtime facet stream ended";

const liveFacet = <A, E>(
  open: (rpc: RuntimeRpc) => Stream.Stream<A, E, never>,
  toMessage: (value: A) => Message,
): Stream.Stream<Message, never, RuntimeClient> =>
  Stream.unwrap(RuntimeClient.pipe(Effect.map(open))).pipe(
    Stream.map(toMessage),
    // A live facet should never complete while the daemon is reachable.
    (stream) => Stream.concat(stream, Stream.fail(linkLost)),
    Stream.catchCause(() => Stream.concat(Stream.make(RuntimeLinkDown()), Stream.fail(linkLost))),
    // SubscriptionRefs replay their current value when this reopens.
    Stream.retry(Schedule.spaced("1 second")),
    Stream.catch(() => Stream.empty),
  );

export const subscriptions = Subscription.make<Model, Message, RuntimeClient>()((entry) => ({
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
}));
