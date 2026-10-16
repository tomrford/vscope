# vscope

Local daemon and browser UI for embedded-device debugging.

## Commands

Use Node.js 24 and the pnpm version pinned in `package.json`.
Node.js 26.4 and later can stall serialport callbacks on Windows; see [upstream issue #3148](https://github.com/serialport/node-serialport/issues/3148).

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

## Reference sources

Clone upstream sources into `.repos/` (gitignored) only when needed.

- Effect: https://github.com/Effect-TS/effect-smol at the tag matching `effect` in `package.json`; see `.agents/skills/effect-ts`.
- liveline: https://github.com/benjitaylor/liveline, origin of `packages/liveplot` (snapshot in `THIRD_PARTY_NOTICES.md`).
