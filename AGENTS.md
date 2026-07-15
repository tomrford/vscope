# AGENTS.md

`vscope` is a public npm package that starts a local Node.js daemon and serves a browser UI for embedded-device debugging.

## Runtime

`npx vscope` starts one local process that:

- serves the UI on localhost
- talks to vscope-capable devices over USB serial
- owns device state, polling, command policy, persistence and snapshot storage
- exposes WebSocket Effect RPC with NDJSON serialization for the browser UI
- exposes plain HTTP endpoints for health checks and snapshot samples
- exposes HTTP MCP tools for agent control
- lets users inspect host-maintained RT buffer values and saved high-resolution scope snapshots

RT buffer values are host-written only. Firmware does not mutate them, so the connect-time read and write echoes are authoritative. The runtime does not poll them periodically.

The browser is a presentation layer. It may hold route, draft form, paused-view and viewport state. It must not become the authority for device state or serial behaviour.

## Firmware

`reference/vscope.c` and `reference/vscope.h` define the firmware protocol for the current release. Treat these files and the matching host protocol code as the authoritative contract.

## Architecture

The root `vscope` package and `bin/vscope.js` provide the only public command surface. Private workspace packages divide the implementation by runtime concern:

- `@vscope/runtime` composes the daemon
- `@vscope/shared` defines domain and wire schemas
- `@vscope/serial` owns the protocol and serial transport
- `@vscope/persistence` owns SQLite storage
- `@vscope/liveplot` owns browser-safe plotting primitives
- `@vscope/ui` owns the Foldkit browser shell

The server command layer is the shared contract. UI actions and MCP tools dispatch through the same runtime path, so agent and human control use the same rules and state transitions.

The runtime owns one active serial device. Connecting a port closes any current device first. A successful connection saves that exact port path as the next selection. The runtime does not infer device identity from USB metadata.

Snapshot plots are browser routes backed by saved daemon data. Live scope is lower resolution and provides control feedback. High-resolution captures live on the device first, then download into local storage for inspection and comparison.

The dispatch lock serializes snapshot capture during a slow sample download. There is no in-flight pending flag, so the `captureSnapshot` permission stays enabled while a download runs.

Serial requests use FIFO admission. Snapshot pages are queued one at a time. Status and frame polls waiting on the current page run before the next page.

## Constraints

- keep the package publishable as `vscope`
- keep the runtime on localhost unless the security model changes
- use Node.js 26 and the matching pnpm wrapper from the Nix development shell
- keep `noUncheckedIndexedAccess` enabled for core packages through the root TypeScript configuration
- keep `@vscope/ui` and `@vscope/liveplot` covered by `pnpm run typecheck` while their package configurations leave `noUncheckedIndexedAccess` off

## Tooling

- use `nix develop -c` for all repository commands
- use pnpm because vscope depends on native Node.js support for serial and SQLite
