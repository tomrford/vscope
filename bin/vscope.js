#!/usr/bin/env node

import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const arg = process.argv[2];

if (arg === "--version" || arg === "-v") {
  console.log(packageJson.version);
  process.exit(0);
}

if (arg === "--help" || arg === "-h") {
  console.log(`vscope ${packageJson.version}

Usage:
  vscope [--help]
  vscope [--version]

The runnable daemon is not implemented in this placeholder release.
Follow development at https://github.com/tomrford/vscope`);
  process.exit(0);
}

console.error("vscope is reserved for the upcoming local daemon + browser UI.");
console.error("This placeholder release does not start the runtime yet.");
console.error("Follow development at https://github.com/tomrford/vscope");
process.exit(1);
