export type CliCommand =
  | {
      readonly kind: "help";
    }
  | {
      readonly kind: "version";
    }
  | {
      readonly kind: "serve";
      readonly port: number | undefined;
    }
  | {
      readonly kind: "device-setup";
      readonly help: boolean;
      readonly force: boolean;
    };

export function parseArgs(argv: ReadonlyArray<string>): CliCommand {
  if (argv[0] === "device-setup") {
    return parseDeviceSetupArgs(argv.slice(1));
  }

  let port: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { kind: "help" };
    }
    if (arg === "--version" || arg === "-v") {
      return { kind: "version" };
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
    throw unknownArgument(arg);
  }

  return { kind: "serve", port };
}

function parseDeviceSetupArgs(argv: ReadonlyArray<string>): CliCommand {
  let force = false;

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      return { kind: "device-setup", help: true, force: false };
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    throw unknownArgument(arg);
  }

  return { kind: "device-setup", help: false, force };
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function unknownArgument(arg: string): Error {
  return new Error(arg.startsWith("-") ? `Unknown option: ${arg}` : `Unknown command: ${arg}`);
}
