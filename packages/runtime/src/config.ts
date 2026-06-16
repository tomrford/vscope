import nodeOs from "node:os";
import nodePath from "node:path";

import { Schema } from "effect";

export const DEFAULT_RUNTIME_HOST = "127.0.0.1";
export const DEFAULT_RUNTIME_PORT = 5174;

export const RuntimeEndpoint = {
  health: "/health",
  rpc: "/rpc",
  mcp: "/mcp",
  snapshots: "/snapshots",
} as const;

export const RuntimeConfigSchema = Schema.Struct({
  host: Schema.String.check(Schema.isMinLength(1)),
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  databasePath: Schema.String.check(Schema.isMinLength(1)),
  uiDistPath: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
});

export type RuntimeConfig = Schema.Schema.Type<typeof RuntimeConfigSchema>;

export const RuntimePathsSchema = Schema.Struct({
  dataDir: Schema.String.check(Schema.isMinLength(1)),
  databasePath: Schema.String.check(Schema.isMinLength(1)),
});

export type RuntimePaths = Schema.Schema.Type<typeof RuntimePathsSchema>;

export const makeRuntimeConfig = (
  options: Partial<RuntimeConfig> & Pick<RuntimeConfig, "databasePath">,
): RuntimeConfig =>
  Schema.decodeUnknownSync(RuntimeConfigSchema)({
    host: DEFAULT_RUNTIME_HOST,
    port: DEFAULT_RUNTIME_PORT,
    ...options,
  });

export function resolveRuntimePaths(env: NodeJS.ProcessEnv = process.env): RuntimePaths {
  const dataDir = resolveDataDir(env);
  return RuntimePathsSchema.make({
    dataDir,
    databasePath: nodePath.join(dataDir, "vscope.sqlite"),
  });
}

function resolveDataDir(env: NodeJS.ProcessEnv): string {
  switch (process.platform) {
    case "darwin":
      return nodePath.join(nodeOs.homedir(), "Library", "Application Support", "vscope");
    case "win32":
      return nodePath.join(
        env.APPDATA ?? nodePath.join(nodeOs.homedir(), "AppData", "Roaming"),
        "vscope",
      );
    default:
      return nodePath.join(
        env.XDG_DATA_HOME ?? nodePath.join(nodeOs.homedir(), ".local", "share"),
        "vscope",
      );
  }
}
