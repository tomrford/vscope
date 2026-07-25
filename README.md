# vscope

`vscope` is a local browser-based oscilloscope for embedded firmware. One Node.js process manages the USB serial connection, browser UI, settings, snapshots and MCP tools.

## Requirements

You need:

- Node.js 24 or later
- a USB serial device running the matching vscope firmware

## Start vscope

Run:

```bash
npx vscope
```

Open the URL shown in the terminal. The default is <http://127.0.0.1:5174>.

To use another port for one run:

```bash
npx vscope --port 6000
```

Keep the terminal open while you use vscope. Press `Ctrl+C` to stop it.

vscope stores settings and snapshots in your operating system's application data directory. It uses native USB serial and SQLite packages. Reinstall vscope after changing your Node.js major version so these packages match the active runtime.

## Add the firmware

The npm package includes the matching [`reference/vscope.c`](reference/vscope.c) and [`reference/vscope.h`](reference/vscope.h) files. Add both files to your firmware project.

1. Implement `vscopeTxBytes` for your USB serial transport.
2. Register acquisition variables with `vscopeRegisterVar`. Register writable real-time values with `vscopeRegisterRtBuffer` if you need them.
3. Call `vscopeInit` once after registering variables.
4. Pass received serial bytes and a microsecond timestamp to `vscopeRxHandler`.
5. Call `vscopeAcquire` from a timer interrupt at the rate passed to `vscopeInit`.

These files define the firmware protocol for this release.

## Work with a device

1. Open the port picker, choose a serial port and select Connect.
2. Select Run to start live plotting.
3. Stop the device before changing the timebase or channel map. Trigger settings remain editable
   while the device is running.
4. Select Trigger while the device is running to acquire a high-resolution capture.
5. Select Save snapshot. It becomes available when the device holds a new capture.

vscope selects the last successfully connected port when it starts. You can reconnect after a connection error or choose another port.

Open saved captures from Snapshots. You can select several captures to compare them with shared zoom, pan and cursor controls.

Activity lists runtime warnings and errors. Clear the list after you have dealt with them.

## Connect an MCP client

Keep vscope running and configure your MCP client to use:

```text
http://127.0.0.1:5174/mcp
```

The endpoint uses the same port as the browser UI. MCP tools can inspect runtime state, manage the device connection, control acquisition, change device settings and manage snapshots.

vscope listens only on localhost and does not use authentication. Do not expose it outside your local machine.

## Develop vscope

Use the Nix development shell so Node.js and pnpm match the repository:

```bash
nix develop -c pnpm install
nix develop -c pnpm run check
```

After the check has built the runtime, start it in one terminal:

```bash
nix develop -c node bin/vscope.js
```

Start the UI development server in another terminal:

```bash
nix develop -c pnpm run dev:ui
```

The development UI runs at <http://127.0.0.1:5173> and connects to the runtime at <http://127.0.0.1:5174>.

## Earlier implementation

An earlier Python implementation is available at [`tomrford/vscope_py`](https://github.com/tomrford/vscope_py).

## License

vscope is MIT licensed. Attribution for adapted plotting code is in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
