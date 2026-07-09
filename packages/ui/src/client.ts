import { makeRuntimeRpcClient, runtimeRpcSocketUrl } from "@vscope/shared";
import { Context, Effect, Layer } from "effect";

export type RuntimeRpc = Effect.Success<ReturnType<typeof makeRuntimeRpcClient>>;

export class RuntimeClient extends Context.Service<RuntimeClient, RuntimeRpc>()(
  "@vscope/ui/RuntimeClient",
) {}

export const RuntimeClientLive: Layer.Layer<RuntimeClient> = Layer.effect(
  RuntimeClient,
  Effect.sync(() => runtimeRpcSocketUrl(globalThis.location.href)).pipe(
    Effect.flatMap(makeRuntimeRpcClient),
  ),
);
