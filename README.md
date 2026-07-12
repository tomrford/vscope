# vscope

Local daemon + browser UI for the vscope embedded debug interface.

`vscope` runs one local Node process that owns the device connection, persistence, browser UI assets, app RPC surface, and streamable HTTP MCP endpoint. The browser UI is a Foldkit SPA and never talks to serial devices directly.

`vscope` is a Node CLI and depends on native packages for USB serial and SQLite. Install and run it with the same Node major version. If you change Node versions after installing, reinstall `vscope` so native dependencies are rebuilt for the active Node runtime.

The live scope UI supports device connection, run, stop, trigger, timing, trigger settings, channel mapping, RT buffer writes, and snapshot capture. The snapshot viewer compares captures at `/snapshots?ids=a,b` with a shared x-viewport and x-cursor across channel plots. UI actions and MCP tools use the same runtime command layer.

## Architecture

```text
bin/vscope.js
  -> @vscope/runtime
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
| `@vscope/persistence` | SQLite storage for settings, snapshot metadata, and snapshot samples |
| `@vscope/liveplot`    | Browser-safe live plotting engine                                    |
| `@vscope/ui`          | Foldkit SPA, built by Vite                                           |
| `@vscope/runtime`     | Node composition root for HTTP/RPC, MCP, persistence, and serial I/O |

The runtime is the source of truth. It reads persistence on startup, owns long-lived serial connections, applies user commands, persists settings and snapshots, and emits shared app-state/events to the UI. MCP tools use the same runtime command layer as the UI.

## Wire Shape

The UI/runtime boundary is typed through `@vscope/shared`. Control and state traffic uses Effect RPC over a WebSocket at `/rpc`, with NDJSON serialization for streaming responses.

Snapshot metadata travels over RPC. Sample data is served from `/snapshots/:id/samples` as `application/octet-stream` in `f32le-interleaved-v1` format. The response headers provide the snapshot ID, sample format, channel count, sample count, and byte length.

Operational endpoints live in `@vscope/runtime`:

```text
/health
/rpc                         WebSocket Effect RPC with NDJSON serialization
/mcp                         streamable HTTP MCP
/snapshots?ids=a,b           snapshot viewer and comparison UI
/snapshots/:id/samples       binary snapshot samples with metadata headers
```

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

During UI development, Vite runs on `127.0.0.1:5173`. It proxies `/health`, `/mcp`, the `/rpc` WebSocket, and only paths matching `/snapshots/:id/samples` to the runtime at `127.0.0.1:5174`. The `/snapshots` path remains a UI route. The packaged runtime serves the built UI assets directly.

## Reference Material

The `reference/` directory contains the authoritative firmware protocol headers and source. The `.repos/` directory is managed by `grepo`; its entries are read-only external reference snapshots.

## License

MIT.
