# @vscope/serial

`@vscope/serial` is the host-side wire client and in-process device registry for VScope-capable firmware.

This package owns:

- C-derived frame encoding, parsing, message constants, and response decoding.
- Node `serialport` integration behind an injectable `SerialDriver`.
- One scoped `VScopeDevice` handle per opened serial path.
- Per-device half-duplex request serialization.
- Static metadata hydration, live frame reads, RT buffer commands, timing/state/trigger commands, and dense snapshot byte collection.
- In-process device registry events for opened, intentionally removed, and involuntarily lost devices.

The runtime owns:

- Port listing and the active-device connection lifecycle.
- UI and MCP command arbitration and permission policy.
- Periodic status and live-frame polling with WebSocket RPC streams.
- Persistence of app settings and snapshots as metadata and sample blobs.
- Mapping serial errors and events into shared runtime/UI/MCP wire contracts.

Device names are display labels. Serial paths are the uniqueness key for lookup, removal, and lifecycle events.

The C protocol has no request IDs. If a request times out, the device session is failed and must be reopened so a late firmware response cannot satisfy a later command.
