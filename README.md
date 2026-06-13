# vscope

Local daemon + browser UI for the vscope embedded debug interface.

Status: the npm package name is reserved. The published package is a placeholder CLI while the runtime is built.

## Target

```text
npx vscope
  -> starts one local Node process
  -> serves a browser UI on 127.0.0.1
  -> exposes REST/SSE for the UI
  -> exposes HTTP MCP for agent control
  -> talks to devices over USB serial
```

The product remains the same as the Python app: an embedded debug interface with a stored high-resolution virtual scope and live read/write RT buffers. High-resolution captures are stored on the device, downloaded as snapshots, persisted locally, and plotted or compared later. Live scope is lower resolution and optimized for control feedback, not oscilloscope-grade acquisition.

## Successor Shape

The earlier attempts each had useful parts:

| Source           | Keep                                               | Drop                                        |
| ---------------- | -------------------------------------------------- | ------------------------------------------- |
| `vscope_py`      | product behavior, firmware/protocol reference      | PyQt desktop shell                          |
| `v2scope`        | Svelte UI ideas, live plot engine, protocol work   | Tauri/Rust host split                       |
| `v3scope`        | Effect runtime, serial service, SQLite persistence | Electron shell and native ABI rebuild split |
| `cantraceviewer` | chartGPU snapshot interaction patterns             | unrelated CAN-specific surface              |

The new architecture keeps one authoritative runtime in the local daemon. The browser UI holds presentation state only: selected route, form drafts, paused live view, plot viewport, and a synced projection of the server snapshot.

## Architecture

```text
Browser
  Foldkit UI
    POST /api/dispatch
    GET  /api/snapshot
    GET  /api/events
    GET  /snapshots?ids=...

Node daemon
  CLI
  HTTP server
  HTTP MCP server
  App runtime
  Protocol codec
  Serial port service
  SQLite persistence
  Snapshot store

Device
  onboard vscope firmware module
```

Rules:

- Server owns device state, polling, consensus, command policy, and persistence.
- UI never talks to serial directly.
- MCP tools mirror the same command/request layer as the UI.
- Snapshot plots are browser routes backed by persisted snapshot data.
- Non-localhost bind requires an auth story before it ships.

## Package Plan

Only one public npm package is planned: `vscope`.

Do not create private workspace packages just to mirror conceptual layers. Start with one package and normal source directories:

```text
bin/
  vscope.js
src/
  cli/
  server/
  runtime/
  protocol/
  serial/
  persistence/
  mcp/
  ui/
  plot-live/
```

Add private workspace packages only when a boundary earns its cost. Likely candidates:

| Package              | Condition                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `packages/ui`        | Foldkit/Vite build isolation is cleaner than a root build                                         |
| `packages/plot-live` | live plot engine is reused or tested independently                                                |
| `packages/shared`    | schemas/protocol must be imported by both daemon and browser without dragging server dependencies |

Avoid separate `core`, `contracts`, `protocol`, `serial`, `persistence`, and `server` packages until real build, dependency, or test isolation requires them.

## Runtime Plan

1. Port protocol bytes/codecs and command contracts into `src/protocol` and `src/runtime`, with tests.
2. Port the headless runtime from `v3scope`: serial service, device registry, polling, command policy, settings, saved ports, snapshots.
3. Add SQLite persistence with migrations and a conservative recovery policy. Do not wipe the DB for transient startup failures.
4. Serve REST and SSE from one local HTTP server. Prove dispatch/snapshot flows with curl and mock serial.
5. Add HTTP MCP at `/mcp` using the same command/request layer.
6. Build the Foldkit UI shell: devices, scope controls, snapshot library, settings.
7. Port live plotting from `v2scope`.
8. Add chartGPU snapshot routes and compare view.
9. Replace the placeholder npm package with the runnable daemon.

## Commands

```bash
nix develop -c pnpm install
nix develop -c pnpm run check
nix develop -c pnpm run pack:dry
```

Current `check` validates only the placeholder CLI. Broaden it as implementation lands.

## Open Decisions

- Default local port.
- Snapshot route shape: `/snapshots/:id` or `/snapshots?ids=...`.
- Whether the first real workspace split is `packages/ui`.
- Auth/token behavior for any non-localhost bind.
- Final native dependency story for `serialport` and `better-sqlite3` in the published package.

## License

MIT.
