import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FILES = ["vscope.c", "vscope.h", "guide.md"] as const;

export function writeDeviceSetup(force: boolean): string {
  const sourceDir = fileURLToPath(new URL("../reference/", import.meta.url));
  const directory = path.join(process.cwd(), "vscope");

  fs.mkdirSync(directory, { recursive: true });

  for (const name of FILES) {
    const destination = path.join(directory, name);
    if (!force && fs.existsSync(destination)) {
      throw new Error(`${destination} already exists. Re-run with --force to overwrite.`);
    }
    fs.copyFileSync(path.join(sourceDir, name), destination);
  }

  return directory;
}
