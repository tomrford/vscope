import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assert, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  DEVICE_SETUP_FILES,
  DeviceSetupError,
  formatDeviceSetupOutput,
  resolveVscopePackageRoot,
  runDeviceSetup,
} from "./device-setup";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

describe("device-setup", () => {
  it.effect("writes the packaged firmware sources into ./vscope", () =>
    withTempDir((cwd) =>
      Effect.gen(function* () {
        const result = yield* runDeviceSetup({ cwd, force: false });

        expect(result.written).toEqual([...DEVICE_SETUP_FILES]);
        expect(result.unchanged).toEqual([]);
        expect(result.directory).toBe(path.join(cwd, "vscope"));

        for (const name of DEVICE_SETUP_FILES) {
          expect(fs.readFileSync(path.join(result.directory, name))).toEqual(
            fs.readFileSync(path.join(repoRoot, "reference", name)),
          );
        }

        expect(formatDeviceSetupOutput(result)).toContain("Give vscope/prompt.md to an agent");
        expect(formatDeviceSetupOutput(result)).toContain("vscopeTxBytes");
      }),
    ),
  );

  it.effect("is idempotent when the files already match this release", () =>
    withTempDir((cwd) =>
      Effect.gen(function* () {
        yield* runDeviceSetup({ cwd, force: false });
        const result = yield* runDeviceSetup({ cwd, force: false });

        expect(result.written).toEqual([]);
        expect(result.unchanged).toEqual([...DEVICE_SETUP_FILES]);
        expect(formatDeviceSetupOutput(result)).toContain("already present");
      }),
    ),
  );

  it.effect("refuses to overwrite a different file unless --force is set", () =>
    withTempDir((cwd) =>
      Effect.gen(function* () {
        const directory = path.join(cwd, "vscope");
        fs.mkdirSync(directory);
        fs.writeFileSync(path.join(directory, "vscope.c"), "stale firmware\n");

        const failure = yield* runDeviceSetup({ cwd, force: false }).pipe(Effect.flip);
        assert.instanceOf(failure, DeviceSetupError);
        expect(failure.reason).toContain("already exists and differs");
        expect(fs.readFileSync(path.join(directory, "vscope.c"), "utf8")).toBe("stale firmware\n");
        expect(fs.existsSync(path.join(directory, "vscope.h"))).toBe(false);

        const result = yield* runDeviceSetup({ cwd, force: true });
        expect(result.written).toContain("vscope.c");
        expect(fs.readFileSync(path.join(directory, "vscope.c"))).toEqual(
          fs.readFileSync(path.join(repoRoot, "reference", "vscope.c")),
        );
      }),
    ),
  );

  it.effect("fills in missing files when the others already match", () =>
    withTempDir((cwd) =>
      Effect.gen(function* () {
        yield* runDeviceSetup({ cwd, force: false });
        fs.rmSync(path.join(cwd, "vscope", "prompt.md"));

        const result = yield* runDeviceSetup({ cwd, force: false });
        expect(result.written).toEqual(["prompt.md"]);
        expect(result.unchanged).toEqual(["vscope.c", "vscope.h"]);
        expect(fs.readFileSync(path.join(cwd, "vscope", "prompt.md"))).toEqual(
          fs.readFileSync(path.join(repoRoot, "reference", "prompt.md")),
        );
      }),
    ),
  );

  it.effect("fails when the packaged reference files are missing", () =>
    withTempDir((cwd) =>
      Effect.gen(function* () {
        const packageRoot = path.join(cwd, "pkg");
        fs.mkdirSync(packageRoot);
        fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "vscope" }));

        const failure = yield* runDeviceSetup({
          cwd: path.join(cwd, "project"),
          force: false,
          packageRoot,
        }).pipe(Effect.flip);

        assert.instanceOf(failure, DeviceSetupError);
        expect(failure.reason).toContain("Failed to read");
      }),
    ),
  );

  it("walks up from the CLI to the published vscope package root", () => {
    expect(resolveVscopePackageRoot(fileURLToPath(new URL(".", import.meta.url)))).toBe(repoRoot);
    expect(resolveVscopePackageRoot(path.join(os.tmpdir(), "vscope-missing-package"))).toBeUndefined();
  });
});

function withTempDir<A, E, R>(
  run: (cwd: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.scoped(
    Effect.acquireRelease(
      Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), "vscope-device-setup-"))),
      (cwd) => Effect.sync(() => fs.rmSync(cwd, { recursive: true, force: true })),
    ).pipe(Effect.flatMap(run)),
  );
}
