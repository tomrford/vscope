import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Effect, Schema } from "effect";

import { parseArgs } from "./cli-args";
import { DEFAULT_RUNTIME_PORT, makeRuntimeConfig, resolveRuntimePaths } from "./config";
import { formatDeviceSetupOutput, runDeviceSetup } from "./device-setup";
import { runRuntimeServer } from "./server";

const PackageJson = Schema.Struct({
  version: Schema.optionalKey(Schema.String),
});

const packageJson = Schema.decodeUnknownSync(PackageJson)(
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")),
);
const packageVersion = packageJson.version ?? "0.0.0";

const uiDistPath = fileURLToPath(new URL("./ui", import.meta.url));

export async function main(argv: ReadonlyArray<string> = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(argv);

  switch (parsed.kind) {
    case "help":
      printHelp();
      return;
    case "version":
      console.log(packageVersion);
      return;
    case "device-setup":
      if (parsed.help) {
        printDeviceSetupHelp();
        return;
      }
      await Effect.runPromise(
        runDeviceSetup({ cwd: process.cwd(), force: parsed.force }).pipe(
          Effect.tap((result) => Effect.sync(() => console.log(formatDeviceSetupOutput(result)))),
          Effect.catchTag("DeviceSetupError", (error) => Effect.fail(new Error(error.reason))),
        ),
      );
      return;
    case "serve": {
      const paths = resolveRuntimePaths();
      const config = makeRuntimeConfig({
        version: packageVersion,
        databasePath: paths.databasePath,
        port: parsed.port ?? DEFAULT_RUNTIME_PORT,
        portOverride: parsed.port !== undefined,
        uiDistPath,
      });

      console.log(`vscope ${packageVersion}`);
      console.log(`Data:    ${paths.dataDir}`);

      await Effect.runPromise(runRuntimeServer(config));
      return;
    }
  }
}

function printHelp(): void {
  console.log(`vscope ${packageVersion}

Usage:
  vscope [--port <port>]
  vscope device-setup [--force]
  vscope --help
  vscope --version

Commands:
  device-setup        Write the matching firmware sources into ./vscope.

Options:
  -p, --port <port>   Override the persisted server port for this run.
      --force         Overwrite existing files written by device-setup.
  -h, --help          Show this help.
  -v, --version       Show the version.

Defaults:
  host: 127.0.0.1
  port: ${DEFAULT_RUNTIME_PORT}
`);
}

function printDeviceSetupHelp(): void {
  console.log(`vscope device-setup

Write the firmware sources for this vscope release into ./vscope.

Usage:
  vscope device-setup [--force]

Options:
      --force         Overwrite existing vscope.c, vscope.h, and prompt.md.
  -h, --help          Show this help.

The command writes:
  ./vscope/vscope.c
  ./vscope/vscope.h
  ./vscope/prompt.md
`);
}

// External boundary: JavaScript Promise rejections can contain any value.
main().catch((cause: unknown) => {
  console.error(cause);
  process.exitCode = 1;
});
