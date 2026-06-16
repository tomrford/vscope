import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";

import { DEFAULT_RUNTIME_PORT, makeRuntimeConfig, resolveRuntimePaths } from "./config";
import { runRuntimeServer } from "./server";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { readonly version?: string };

const uiDistPath = fileURLToPath(new URL("./ui", import.meta.url));

export async function main(argv: ReadonlyArray<string> = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(argv);

  if (parsed.help) {
    printHelp();
    return;
  }

  if (parsed.version) {
    console.log(packageJson.version ?? "0.0.0");
    return;
  }

  const paths = resolveRuntimePaths();
  const config = makeRuntimeConfig({
    databasePath: paths.databasePath,
    ...(parsed.port === undefined ? {} : { port: parsed.port, portOverride: true }),
    uiDistPath,
  });

  console.log(`vscope ${packageJson.version ?? "0.0.0"}`);
  if (config.portOverride) {
    console.log(`Runtime: http://${config.host}:${config.port}`);
    console.log(`MCP:     http://${config.host}:${config.port}/mcp`);
  } else {
    console.log(`Runtime: http://${config.host}:<persisted>`);
    console.log(`MCP:     http://${config.host}:<persisted>/mcp`);
  }
  console.log(`Data:    ${paths.dataDir}`);

  await Effect.runPromise(runRuntimeServer(config));
}

type CliArgs = {
  readonly help: boolean;
  readonly version: boolean;
  readonly port: number | undefined;
};

function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  let port: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      return { help: true, version: false, port: undefined };
    }
    if (arg === "--version" || arg === "-v") {
      return { help: false, version: true, port: undefined };
    }
    if (arg === "--port" || arg === "-p") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--port requires a value.");
      }
      port = parsePort(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--port=")) {
      port = parsePort(arg.slice("--port=".length));
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return { help: false, version: false, port };
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function printHelp(): void {
  console.log(`vscope ${packageJson.version ?? "0.0.0"}

Usage:
  vscope [--port <port>]
  vscope --help
  vscope --version

Options:
  -p, --port <port>   Override the persisted server port for this run.
  -h, --help          Show this help.
  -v, --version       Show the version.

Defaults:
  host: 127.0.0.1
  port: ${DEFAULT_RUNTIME_PORT}
`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
