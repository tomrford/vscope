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

The public package is `vscope`. Internal implementation lives in private pnpm workspace packages under `packages/*`, with `bin/vscope.js` and the root package providing the published CLI surface.

Keep package boundaries tied to real runtime concerns: `@vscope/runtime` composes the daemon, `@vscope/shared` defines wire/domain schemas, `@vscope/serial` owns protocol and serial transport, `@vscope/persistence` owns SQLite storage, `@vscope/liveplot` owns browser-safe plotting primitives, and `@vscope/ui` owns the Foldkit browser shell.

The server command layer is the shared contract. UI actions and MCP tools should dispatch through the same runtime path, so agent control and human control observe the same rules and state transitions.

Snapshot plots are browser routes backed by persisted daemon data. Live scope is lower resolution and optimized for control feedback; high-resolution captures live on the device first, then download into local persistence for later inspection and comparison.

Snapshot capture during a slow sample download is currently serialized only by the dispatch lock — there is no in-flight pending flag, so the `captureSnapshot` permission stays enabled while a download runs. If this proves a problem (e.g. confusing UI affordance or a need to early-return), add an explicit pending/in-flight signal then; not worth it pre-emptively.

## Current Constraints

- Keep the package publishable as `vscope`; the root CLI remains the only public command surface.
- Keep localhost-only assumptions unless an auth story is added.
- The Nix dev shell uses Node 26 and an overridden pnpm wrapper to avoid the known bad Node 24.15.0 wrapper path.

## Tooling

- Always use `nix develop -c` to run commands (pnpm version and node versions may differ).
- Toolchain uses `pnpm` since vscope is a node-only app relying on native support for serial and sqlite.
