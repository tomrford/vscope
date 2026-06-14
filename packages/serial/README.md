# @vscope/serial

`@vscope/serial` is the host-side wire client and in-process device registry for VScope-capable firmware.

This package owns:

- C-derived frame encoding, parsing, message constants, and response decoding.
- Node `serialport` integration behind an injectable `SerialDriver`.
- One scoped `VScopeDevice` handle per opened serial path.
- Per-device half-duplex request serialization.
- Static metadata hydration, live frame reads, RT buffer commands, timing/state/trigger commands, and dense snapshot byte streaming.
- In-process device registry events for opened, intentionally removed, and involuntarily lost devices.

The runtime owns:

- Port filtering, saved-port preference, hot-plug polling, and reconnect policy.
- UI and MCP command arbitration, rate limits, and permission policy.
- Periodic live polling schedules and SSE/HTTP fan-out.
- Persistence of device settings, downloaded snapshots, and comparison metadata.
- Mapping serial errors and events into shared runtime/UI/MCP wire contracts.

Device names are display-oriented lookup labels. Paths remain the internal uniqueness key. If multiple opened devices report the same firmware name, name lookup resolves the first matching device; firmware used in multi-device deployments should provide distinct names.

The C protocol has no request IDs. If a request times out, the device session is failed and must be reopened so a late firmware response cannot satisfy a later command.
