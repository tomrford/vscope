# vscope

Local daemon and browser UI for embedded-device debugging.

## Commands

Use pnpm and the toolchain requirements in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm run dev:ui
pnpm run check
```

Run `check` before handoff.

## Structure

- `bin/vscope.js` is the CLI entry point.
- `packages/` contains the runtime, UI, and supporting workspace packages.
- `reference/vscope.c` and `reference/vscope.h` define the firmware protocol.
