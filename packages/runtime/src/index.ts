import { Data, Effect, Schema } from "effect";

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

export class RuntimeNotImplementedError extends Data.TaggedError("RuntimeNotImplementedError")<{
  readonly reason: string;
}> {}

export const makeRuntimeConfig = (
  options: Partial<RuntimeConfig> & Pick<RuntimeConfig, "databasePath">,
): RuntimeConfig =>
  Schema.decodeUnknownSync(RuntimeConfigSchema)({
    host: DEFAULT_RUNTIME_HOST,
    port: DEFAULT_RUNTIME_PORT,
    ...options,
  });

export const startRuntime = (
  _config: RuntimeConfig,
): Effect.Effect<never, RuntimeNotImplementedError> =>
  Effect.fail(
    new RuntimeNotImplementedError({
      reason: "Runtime server wiring is not implemented yet.",
    }),
  );
