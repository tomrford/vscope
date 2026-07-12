# AGENTS.md

`vscope` is a public npm package that starts a local Node daemon and serves a browser UI for embedded-device debugging.

## Runtime

`npx vscope` starts one local process that:

- serves the UI on localhost;
- talks to vscope-capable devices over USB serial;
- owns device state, polling, command policy, persistence, and snapshot storage;
- exposes WebSocket Effect RPC with NDJSON serialization for the browser UI;
- exposes plain HTTP endpoints for health checks and snapshot samples;
- exposes HTTP MCP tools for agent control;
- lets users inspect host-maintained RT buffer values and persisted high-resolution scope snapshots.

RT buffer values are host-written only: firmware never mutates them, so the connect-time read and write echoes are authoritative and the runtime does not poll them periodically.

The browser is a presentation layer. It may hold route, draft form, paused-view, and viewport state, but it must not become the authority for device state or serial behavior.

## Reference Repos

- `vscope_py` is the product, protocol, firmware-behaviour, and virtual-scope reference.
- `v2scope` is a reference for UI, live plotting, and protocol behaviour.
- `v3scope` is a reference for the Effect runtime, serial service, and SQLite persistence shape.
- `cantraceviewer` is a reference for chartGPU snapshot inspection and comparison interactions.

## Architecture

The public package is `vscope`. Internal implementation lives in private pnpm workspace packages under `packages/*`, with `bin/vscope.js` and the root package providing the published CLI surface.

Package boundaries follow runtime concerns: `@vscope/runtime` composes the daemon, `@vscope/shared` defines wire and domain schemas, `@vscope/serial` owns protocol and serial transport, `@vscope/persistence` owns SQLite storage, `@vscope/liveplot` owns browser-safe plotting primitives, and `@vscope/ui` owns the Foldkit browser shell.

The server command layer is the shared contract. UI actions and MCP tools dispatch through the same runtime path, so agent and human control observe the same rules and state transitions.

Snapshot plots are browser routes backed by persisted daemon data. Live scope is lower resolution and optimized for control feedback; high-resolution captures live on the device first, then download into local persistence for later inspection and comparison.

Snapshot capture during a slow sample download is serialized only by the dispatch lock. There is no in-flight pending flag, so the `captureSnapshot` permission stays enabled while a download runs.

Serial requests use FIFO admission. Snapshot pages are queued one at a time, so status and frame polls waiting on the current page run before the following page.

## Current Constraints

- Keep the package publishable as `vscope`; the root CLI remains the only public command surface.
- The runtime is localhost-only and has no authentication layer.
- The Nix dev shell uses Node 26 and an overridden pnpm wrapper to avoid the known bad Node 24.15.0 wrapper path.
- `noUncheckedIndexedAccess` is enabled for the core packages through the root tsconfig. `@vscope/ui` and `@vscope/liveplot` keep package tsconfigs with the flag off and are still covered by `pnpm run typecheck`.

## Tooling

- Always use `nix develop -c` to run commands (pnpm version and node versions may differ).
- Toolchain uses `pnpm` since vscope is a node-only app relying on native support for serial and sqlite.
