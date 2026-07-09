import { makeRuntimeRpcClient } from "@vscope/shared";
import { Effect, Schedule, Schema, Stream } from "effect";
import * as Subscription from "foldkit/subscription";

import { DeviceStatusReceived, type Message, type Model } from "./model.ts";

const rpcUrl = Effect.sync(() => new URL("/rpc", globalThis.location.href).toString());

// The runtime polls the connected device at its configured stateHz and pushes
// every change onto the `device.status` stream. Subscribing here is what makes
// the UI reflect autonomous transitions — a trigger firing, a fault, a stop —
// instead of freezing on whatever the last request/response read returned.
//
// `Stream.unwrap` discharges the RPC client's scope; `retry` reconnects if the
// transport drops; `catchCause` collapses the transport error to `never` so the
// stream satisfies the subscription's no-error contract.
const liveDeviceStatus: Stream.Stream<Message, never, never> = Stream.unwrap(
  rpcUrl.pipe(
    Effect.flatMap(makeRuntimeRpcClient),
    Effect.map((rpc) => rpc["device.status"]()),
  ),
).pipe(
  Stream.map((status) => DeviceStatusReceived({ status })),
  Stream.retry(Schedule.spaced("2 seconds")),
  Stream.catchCause(() => Stream.empty),
);

const connectedDevicePath = (model: Model): string | null =>
  model.runtime.activeDevice?.connected === true ? model.runtime.activeDevice.path : null;

// Device-scoped: the feed runs only while a device is connected and restarts
// cleanly when the connected device changes. The frame plane will be the second
// device-scoped subscription once liveplot is wired.
export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  deviceStatus: entry(
    { devicePath: Schema.NullOr(Schema.String) },
    {
      modelToDependencies: (model) => ({ devicePath: connectedDevicePath(model) }),
      dependenciesToStream: ({ devicePath }) =>
        devicePath === null ? Stream.empty : liveDeviceStatus,
    },
  ),
}));
