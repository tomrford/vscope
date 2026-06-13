# vscope

Local daemon + browser UI for the vscope embedded debug interface.

`vscope` runs one local Node process that owns the device connection, persistence, browser UI assets, app RPC surface, and streamable HTTP MCP endpoint. The browser UI is a Foldkit SPA and never talks to serial devices directly.

Status: the package boundaries are in place. The runnable runtime server is still a scaffold.

## Architecture

```text
bin/vscope.js
  -> @vscope/runtime (scaffold)
       -> @vscope/serial
       -> @vscope/persistence
       -> @vscope/shared
       -> serves @vscope/ui build
       -> serves RPC and MCP endpoints

@vscope/ui
  -> @vscope/shared
  -> @vscope/liveplot
```

Package boundaries:

| Package               | Role                                                                 |
| --------------------- | -------------------------------------------------------------------- |
| `@vscope/shared`      | Effect Schemas for domain and wire data shared by runtime and UI     |
| `@vscope/serial`      | Raw Effect wrapper around Node `serialport`                          |
| `@vscope/persistence` | SQLite settings, preferences, saved ports, and snapshot persistence  |
| `@vscope/liveplot`    | Browser-safe live plotting engine                                    |
| `@vscope/ui`          | Foldkit SPA, built by Vite                                           |
| `@vscope/runtime`     | Node composition root for HTTP/RPC, MCP, persistence, and serial I/O |

The runtime is the source of truth. It reads persistence on startup, owns long-lived serial connections, applies user commands, persists settings and snapshots, and emits shared app-state/events to the UI. MCP tools use the same runtime command layer as the UI.

## Wire Shape

The UI/runtime boundary is typed through `@vscope/shared`. Control/state traffic is intended to use Effect RPC over HTTP. Large snapshot samples are represented separately from snapshot metadata as `f32le-interleaved-v1` `Uint8Array` payloads, so a 40k-sample `Float32` capture can move as a binary/base64 wire payload rather than nested JSON arrays.

Operational endpoints live in `@vscope/runtime`:

```text
/health
/rpc
/mcp
/snapshots
```

The MCP endpoint is expected to use streamable HTTP.

## Development

```bash
nix develop -c pnpm install
nix develop -c pnpm run check
```

The Foldkit UI uses Vite for development and production asset builds:

```bash
nix develop -c pnpm run dev:ui
nix develop -c pnpm run build:ui
```

During UI development, Vite runs on `127.0.0.1:5173` and proxies `/health`, `/rpc`, `/mcp`, and `/snapshots` to the runtime port `127.0.0.1:5174`. Production runtime should serve the built UI assets directly.

Foldkit DevTools MCP is configured in `.codex/config.toml`; the Vite plugin exposes the relay on port `9988`.

## Reference Material

The `reference/` directory contains firmware and previous SQLite/runtime source snapshots for porting. The `grepo/` directory is managed by `grepo`; its entries are read-only external reference snapshots.

## License

MIT.
