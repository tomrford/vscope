import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Effect, Schema } from "effect";

export const DEVICE_SETUP_FILES = ["vscope.c", "vscope.h", "prompt.md"] as const;

export class DeviceSetupError extends Schema.TaggedErrorClass<DeviceSetupError>()(
  "DeviceSetupError",
  {
    reason: Schema.String,
  },
) {}

export type DeviceSetupFile = (typeof DEVICE_SETUP_FILES)[number];

export type DeviceSetupOptions = {
  readonly cwd: string;
  readonly force: boolean;
  readonly packageRoot?: string;
};

export type DeviceSetupResult = {
  readonly directory: string;
  readonly written: ReadonlyArray<DeviceSetupFile>;
  readonly unchanged: ReadonlyArray<DeviceSetupFile>;
};

export const DEVICE_SETUP_GUIDE = `Integration:
  1. Compile vscope.c with your firmware. Implement vscopeTxBytes for USB serial.
  2. Register at least 5 acquisition variables with vscopeRegisterVar before init.
  3. Register writable live values with vscopeRegisterRtBuffer if you need them.
  4. Call vscopeInit once after registration. Registration is locked after that.
  5. Pass received serial bytes and a microsecond timestamp to vscopeRxHandler.
  6. Call vscopeAcquire from a timer interrupt at the rate passed to vscopeInit.

Then run \`npx vscope\` and connect the serial port.`;

export function resolveVscopePackageRoot(startDir: string): string | undefined {
  let current = path.resolve(startDir);

  for (;;) {
    const packageJsonPath = path.join(current, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      const name = readPackageName(packageJsonPath);
      if (name === "vscope") {
        return current;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export const runDeviceSetup = Effect.fn("runDeviceSetup")(function* (
  options: DeviceSetupOptions,
) {
  const packageRoot =
    options.packageRoot ??
    resolveVscopePackageRoot(fileURLToPath(new URL(".", import.meta.url)));
  if (packageRoot === undefined) {
    return yield* new DeviceSetupError({
      reason: "Could not locate the installed vscope package.",
    });
  }

  const referenceDir = path.join(packageRoot, "reference");
  const directory = path.join(path.resolve(options.cwd), "vscope");
  const planned = yield* readReferenceFiles(referenceDir);
  const existing = yield* inspectTargetFiles(directory);

  if (existing.kind === "file") {
    return yield* new DeviceSetupError({
      reason: `${directory} exists and is not a directory.`,
    });
  }

  const conflicts = DEVICE_SETUP_FILES.filter((name) => {
    const current = existing.files[name];
    return current !== undefined && !current.equals(planned[name]) && !options.force;
  });
  if (conflicts[0] !== undefined) {
    return yield* new DeviceSetupError({
      reason: `${path.join(directory, conflicts[0])} already exists and differs from this vscope release. Re-run with --force to overwrite.`,
    });
  }

  yield* writeDirectory(directory);

  const written: Array<DeviceSetupFile> = [];
  const unchanged: Array<DeviceSetupFile> = [];

  for (const name of DEVICE_SETUP_FILES) {
    const current = existing.files[name];
    const next = planned[name];
    if (current !== undefined && current.equals(next)) {
      unchanged.push(name);
      continue;
    }

    yield* writeFile(path.join(directory, name), next);
    written.push(name);
  }

  return { directory, written, unchanged };
});

export function formatDeviceSetupOutput(result: DeviceSetupResult): string {
  const headline =
    result.written.length > 0
      ? `Wrote firmware sources to ${result.directory}`
      : `Firmware sources are already present in ${result.directory}`;

  return [
    headline,
    "",
    ...result.written.map((name) => `  wrote     ${name}`),
    ...result.unchanged.map((name) => `  unchanged ${name}`),
    "",
    "Give vscope/prompt.md to an agent if you want it to wire these files into the firmware.",
    "",
    DEVICE_SETUP_GUIDE,
  ].join("\n");
}

type PlannedFiles = Record<DeviceSetupFile, Buffer>;

type TargetInspection =
  | {
      readonly kind: "missing";
      readonly files: Partial<PlannedFiles>;
    }
  | {
      readonly kind: "directory";
      readonly files: Partial<PlannedFiles>;
    }
  | {
      readonly kind: "file";
    };

const readReferenceFiles = Effect.fn("readReferenceFiles")(function* (referenceDir: string) {
  return {
    "vscope.c": yield* readFile(path.join(referenceDir, "vscope.c")),
    "vscope.h": yield* readFile(path.join(referenceDir, "vscope.h")),
    "prompt.md": yield* readFile(path.join(referenceDir, "prompt.md")),
  };
});

const inspectTargetFiles = Effect.fn("inspectTargetFiles")(function* (directory: string) {
  const stats = yield* stat(directory);
  if (stats === undefined) {
    return { kind: "missing", files: {} } satisfies TargetInspection;
  }
  if (!stats.isDirectory()) {
    return { kind: "file" } satisfies TargetInspection;
  }

  const files: Partial<PlannedFiles> = {};
  for (const name of DEVICE_SETUP_FILES) {
    const target = path.join(directory, name);
    const targetStats = yield* stat(target);
    if (targetStats === undefined) {
      continue;
    }
    if (!targetStats.isFile()) {
      return yield* new DeviceSetupError({
        reason: `${target} exists and is not a file.`,
      });
    }
    files[name] = yield* readFile(target);
  }

  return { kind: "directory", files } satisfies TargetInspection;
});

const readFile = Effect.fn("readDeviceSetupFile")(function* (filePath: string) {
  return yield* Effect.try({
    try: () => fs.readFileSync(filePath),
    catch: (cause) =>
      new DeviceSetupError({
        reason: `Failed to read ${filePath}: ${describeCause(cause)}`,
      }),
  });
});

const writeFile = Effect.fn("writeDeviceSetupFile")(function* (filePath: string, contents: Buffer) {
  return yield* Effect.try({
    try: () => {
      fs.writeFileSync(filePath, contents);
    },
    catch: (cause) =>
      new DeviceSetupError({
        reason: `Failed to write ${filePath}: ${describeCause(cause)}`,
      }),
  });
});

const writeDirectory = Effect.fn("writeDeviceSetupDirectory")(function* (directory: string) {
  return yield* Effect.try({
    try: () => {
      fs.mkdirSync(directory, { recursive: true });
    },
    catch: (cause) =>
      new DeviceSetupError({
        reason: `Failed to create ${directory}: ${describeCause(cause)}`,
      }),
  });
});

const stat = Effect.fn("statDeviceSetupPath")(function* (filePath: string) {
  return yield* Effect.try({
    try: () => {
      try {
        return fs.statSync(filePath);
      } catch (cause) {
        if (isNodeErrno(cause) && cause.code === "ENOENT") {
          return undefined;
        }
        throw cause;
      }
    },
    catch: (cause) =>
      new DeviceSetupError({
        reason: `Failed to inspect ${filePath}: ${describeCause(cause)}`,
      }),
  });
});

function readPackageName(packageJsonPath: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    if (typeof parsed === "object" && parsed !== null && "name" in parsed) {
      return typeof parsed.name === "string" ? parsed.name : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isNodeErrno(cause: unknown): cause is NodeJS.ErrnoException {
  return cause instanceof Error && "code" in cause;
}
