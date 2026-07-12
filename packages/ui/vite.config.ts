import { foldkit } from "@foldkit/vite-plugin";
import stylex from "@stylexjs/unplugin/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: process.env.VITEST ? [] : [stylex(), foldkit({ devToolsMcpPort: 9988 })],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/health": "http://127.0.0.1:5174",
      "/mcp": "http://127.0.0.1:5174",
      // The RPC route is a websocket upgrade, not plain HTTP.
      "/rpc": { target: "http://127.0.0.1:5174", ws: true },
      // Only sample downloads go to the daemon; /snapshots itself is a UI route.
      "^/snapshots/.+/samples$": "http://127.0.0.1:5174",
    },
  },
  build: {
    outDir: "../../dist/ui",
    emptyOutDir: true,
  },
});
