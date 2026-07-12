import "./base.css";

import { Effect, Layer } from "effect";
import { Runtime } from "foldkit";
import type { MakeRuntimeReturn } from "foldkit/runtime";

import { RuntimeClient, RuntimeClientLive } from "./client.ts";
import { Model, init, update, view } from "./main.ts";
import { Message, RouteChanged, UrlRequested } from "./model.ts";
import { subscriptions } from "./subscriptions.ts";

// In dev the StyleX styles are served by the plugin middleware and re-fetched
// on HMR; in build they are appended to the base.css asset instead.
if (import.meta.env.DEV) {
  void import("virtual:stylex:runtime");
}

const container = document.getElementById("root");

const program: MakeRuntimeReturn = {
  runtimeId: container?.id ?? "",
  start: (hmrModel) =>
    Effect.gen(function* () {
      const client = yield* RuntimeClient;
      const app = Runtime.makeProgram({
        Model,
        init,
        update,
        view,
        subscriptions,
        routing: {
          onUrlRequest: (request) => UrlRequested({ request }),
          onUrlChange: (url) => RouteChanged({ url }),
        },
        // Lets DevTools (and its MCP bridge) decode and dispatch Messages,
        // e.g. driving the UI without a physical device attached.
        devTools: { Message, excludeFromHistory: ["FrameReceived"] },
        // Foldkit provides this layer separately to commands and subscriptions,
        // so the effectful socket acquisition stays outside the program runtime.
        resources: Layer.succeed(RuntimeClient, client),
        container,
      });

      return yield* app.start(hmrModel);
    }).pipe(Effect.provide(RuntimeClientLive)),
};

Runtime.run(program);
