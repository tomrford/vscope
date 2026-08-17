import { defineConfig } from "vite";

export default defineConfig({
  root: import.meta.dirname,
  build: {
    emptyOutDir: true,
    outDir: "../../dist",
    rollupOptions: {
      external: [
        "@effect/platform-node",
        "@effect/sql-sqlite-node",
        "better-sqlite3",
        "effect",
        "effect/unstable/cli",
        "serialport",
      ],
      input: "src/cli.ts",
      output: {
        entryFileNames: "cli.js",
        format: "esm",
      },
    },
    ssr: true,
    target: "node24",
  },
});
