import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, Option, Schema } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { DEFAULT_RUNTIME_PORT, makeRuntimeConfig, resolveRuntimePaths } from "./config";
import { writeDeviceSetup } from "./device-setup";
import { runRuntimeServer } from "./server";

const PackageJson = Schema.Struct({
  version: Schema.optionalKey(Schema.String),
});

const packageJson = Schema.decodeUnknownSync(PackageJson)(
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")),
);
const packageVersion = packageJson.version ?? "0.0.0";

const uiDistPath = fileURLToPath(new URL("./ui", import.meta.url));

const deviceSetup = Command.make(
  "device-setup",
  {
    force: Flag.boolean("force").pipe(
      Flag.withDescription("Overwrite existing files in ./vscope."),
    ),
  },
  Effect.fn("device-setup")(function* ({ force }) {
    const directory = writeDeviceSetup(force);
    yield* Console.log(`Wrote ${directory}`);
    yield* Console.log(`See ${path.join(directory, "guide.md")}`);
  }),
).pipe(Command.withDescription("Write the matching firmware sources into ./vscope."));

const vscope = Command.make(
  "vscope",
  {
    port: Flag.integer("port").pipe(
      Flag.withAlias("p"),
      Flag.filterMap(
        (value) => (value >= 1 && value <= 65535 ? Option.some(value) : Option.none()),
        (value) => `Invalid port: ${value}`,
      ),
      Flag.optional,
      Flag.withDescription("Override the persisted server port for this run."),
    ),
  },
  Effect.fn("vscope")(function* ({ port }) {
    const paths = resolveRuntimePaths();
    const config = makeRuntimeConfig({
      version: packageVersion,
      databasePath: paths.databasePath,
      port: Option.getOrElse(port, () => DEFAULT_RUNTIME_PORT),
      portOverride: Option.isSome(port),
      uiDistPath,
    });

    yield* Console.log(`vscope ${packageVersion}`);
    yield* Console.log(`Data:    ${paths.dataDir}`);
    return yield* runRuntimeServer(config);
  }),
).pipe(
  Command.withDescription("Local daemon and browser UI for vscope-capable devices."),
  Command.withSubcommands([deviceSetup]),
);

NodeRuntime.runMain(
  Command.run(vscope, { version: packageVersion }).pipe(Effect.provide(NodeServices.layer)),
);
