# AGENTS.md

This repo is the successor to the existing vscope experiments. The goal is a single public npm package, `vscope`, that starts a local Node daemon and serves a browser UI for embedded-device debugging.

## End Goal

`npx vscope` starts one local process that:

- serves the UI on localhost;
- talks to vscope-capable devices over USB serial;
- owns device state, polling, command policy, persistence, and snapshot storage;
- exposes REST/SSE for the browser UI;
- exposes HTTP MCP tools for agent control;
- lets users inspect live RT buffers and persisted high-resolution scope snapshots.

The browser is a presentation layer. It may hold route, draft form, paused-view, and viewport state, but it must not become the authority for device state or serial behavior.

## Source Repos

- `vscope_py` is the product and protocol reference. Preserve the user-visible behavior, firmware expectations, and virtual-scope model; do not preserve the PyQt desktop shell.
- `v2scope` contributes UI ideas, live plotting work, and protocol exploration. Do not preserve the Tauri/Rust host split unless a concrete boundary later earns it.
- `v3scope` contributes the Effect-oriented runtime direction, serial service ideas, and SQLite persistence shape. Do not preserve the Electron shell or native rebuild complexity.
- `cantraceviewer` contributes chartGPU interaction patterns for snapshot inspection and comparison. Do not import CAN-specific UI surface or domain assumptions.

## Architecture Direction

Start as one package with ordinary source directories. Avoid private workspace packages until there is a real build, dependency, or test boundary. Likely future splits are UI build isolation, reusable live plotting, or shared schemas that must be imported without server dependencies.

The server command layer is the shared contract. UI actions and MCP tools should dispatch through the same runtime path, so agent control and human control observe the same rules and state transitions.

Snapshot plots are browser routes backed by persisted daemon data. Live scope is lower resolution and optimized for control feedback; high-resolution captures live on the device first, then download into local persistence for later inspection and comparison.

## Current Constraints

- Keep the package publishable as `vscope`; the placeholder CLI exists only until the daemon lands.
- Keep localhost-only assumptions unless an auth story is added.
- Preserve `minimumReleaseAge`, exact saves, and strict dependency-build policy.
- The Nix dev shell uses Node 26 and an overridden pnpm wrapper to avoid the known bad Node 24.15.0 wrapper path.
- Release publishing is GitHub Release driven, not raw tag-push driven.

## Package Closeout TODO

- [x] `@vscope/serial`: C-derived protocol/types, Effect serial transport, VScope device client, device manager, dense snapshot stream, and fake-firmware tests are in place.
- [ ] `@vscope/runtime`: build the daemon composition root over serial, persistence, and shared schemas; own device fan-out/fan-in policy, REST/SSE, and MCP command paths.
- [ ] `@vscope/shared`: define the runtime/UI/MCP wire contracts around the serial device model and persisted snapshot shapes.
- [ ] `@vscope/persistence`: align SQLite storage with runtime-owned settings, devices, downloaded snapshots, and comparison metadata.
- [ ] `@vscope/liveplot`: settle the reusable plotting core for live RT buffers and persisted high-resolution snapshot inspection.
- [ ] `@vscope/ui`: rebuild the browser shell against the runtime contract as a presentation layer only.
