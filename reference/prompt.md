# vscope firmware integration

You are wiring this firmware project to [vscope](https://github.com/tomrford/vscope), a local host that plots variables over USB serial.

These files are the protocol for the installed vscope release. Do not invent a second protocol. Do not edit `vscope.c` or `vscope.h` unless the user asks.

## Files

- `vscope.c` and `vscope.h` belong in the firmware build.
- Implement the application hooks around them. Do not replace the packaged sources with copies from the internet.

## Required hooks

1. Implement `vscopeTxBytes` so it sends the given bytes on the USB serial interface that the host will open.
2. Register acquisition variables with `vscopeRegisterVar` before init. Each name is at most 16 characters. Each pointer must be a `volatile float`. The device is misconfigured unless at least 5 variables are registered. The catalog holds at most 32 variables.
3. Register writable live values with `vscopeRegisterRtBuffer` only if the firmware should accept host writes. These values are host-written. Do not treat them as a second acquisition path. The catalog holds at most 16 entries.
4. Call `vscopeInit(device_name, isr_khz, endianness)` once after registration. Registration is locked after that. `isr_khz` is the rate of the timer that calls `vscopeAcquire`. `endianness` is `VSCOPE_ENDIAN_LITTLE` or `VSCOPE_ENDIAN_BIG` and must match the MCU.
5. Pass every received serial byte buffer and a microsecond timestamp to `vscopeRxHandler`.
6. Call `vscopeAcquire` from a timer interrupt at `isr_khz`. Keep that call short.

The host plots 5 channels. Map interesting floats first. Names show up in the vscope UI.

## Host

After the firmware talks USB serial:

```bash
npx vscope
```

Use Node.js 24. Open the printed localhost URL, connect the serial port, then Run. MCP clients can use `http://127.0.0.1:5174/mcp` on the same port.

## Done when

- The firmware compiles with these sources.
- A USB serial connection reaches vscope.
- Registered variables appear and plot after Run.
