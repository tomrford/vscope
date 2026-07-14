# vscope

`vscope` is a local Node daemon and browser UI for debugging embedded devices that include the vscope firmware module.

The daemon owns the USB serial connection, device state, polling, settings and saved snapshots. The browser UI and HTTP MCP tools use the same command policy.

## Run vscope

You need Node.js 24 or later and a vscope-capable device connected over USB.

```bash
npx vscope
```

Open the listening URL printed in the terminal. The default is <http://127.0.0.1:5174>.

Use a different port for one run with:

```bash
npx vscope --port 6000
```

Keep the terminal process running while you use the UI or MCP endpoint. Press `Ctrl+C` to stop it.

`vscope` uses native USB serial and SQLite packages. If you install it and then change Node major versions, reinstall it so those packages match the active Node runtime.

## Add vscope firmware

The package includes the matching firmware reference implementation in [`reference/vscope.c`](reference/vscope.c) and [`reference/vscope.h`](reference/vscope.h). Copy both files into the firmware project, then:

1. Implement `vscopeTxBytes` for the device's USB serial transport.
2. Pass received serial bytes to `vscopeRxHandler`.
3. Register acquisition variables and RT buffer values before calling `vscopeInit`.
4. Call `vscopeAcquire` from the configured timer interrupt.

These files define the firmware protocol expected by this release.

## Use a device

1. Open the port picker, select the device serial port and select Connect.
2. Select Run to start live plotting.
3. Select Trigger while the device is running to acquire a high-resolution capture.
4. Save the snapshot when the status changes to `Capture ready`.

Timing, trigger and channel mapping changes are available while the device is halted. RT buffer writes, UI actions and MCP tools all go through the daemon.

The last successfully connected port is selected on the next launch. Select Reconnect after a connection error, or select another available port to disconnect the current device and connect the replacement.

The snapshot viewer opens saved captures at `/snapshots?ids=a,b`. It supports shared zoom, pan and cursor interactions across plots.

## Connect an MCP client

Keep `vscope` running and configure the client to use the streamable HTTP endpoint:

```text
http://127.0.0.1:5174/mcp
```

The MCP tools can inspect runtime state, list and connect devices, control acquisition, change device configuration and manage snapshots.

The service listens on localhost and has no authentication. Do not expose it outside the local machine.

## Architecture

```text
bin/vscope.js
  -> @vscope/runtime
       -> @vscope/serial
       -> @vscope/persistence
       -> @vscope/shared
       -> serves @vscope/ui

@vscope/ui
  -> @vscope/shared
  -> @vscope/liveplot
```

The private workspace packages divide the implementation by runtime concern:

| Package               | Role                                       |
| --------------------- | ------------------------------------------ |
| `@vscope/runtime`     | daemon, HTTP, RPC and MCP composition      |
| `@vscope/serial`      | firmware protocol and USB serial transport |
| `@vscope/persistence` | SQLite settings and snapshot storage       |
| `@vscope/shared`      | domain and wire schemas                    |
| `@vscope/liveplot`    | browser-safe plotting primitives           |
| `@vscope/ui`          | Foldkit browser UI                         |

The UI uses Effect RPC over WebSocket at `/rpc`. Snapshot metadata travels over RPC. Sample data uses the `f32le-interleaved-v1` binary format over plain HTTP.

Runtime endpoints:

```text
/health
/rpc
/mcp
/snapshots?ids=a,b
/snapshots/:id/samples
```

## Develop vscope

Use the repository Nix shell so Node and pnpm match the lockfile:

```bash
nix develop -c pnpm install
nix develop -c pnpm run check
```

Run the UI development server with:

```bash
nix develop -c pnpm run dev:ui
```

Vite listens on `127.0.0.1:5173` and proxies runtime requests to `127.0.0.1:5174`.

The `reference/` directory contains the authoritative firmware protocol headers and source. The `.repos/` directory contains read-only external references managed by `grepo`.

## License

`vscope` is MIT licensed. Attribution and the upstream MIT license for the bundled liveplot code are in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
