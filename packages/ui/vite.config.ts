import { foldkit } from "@foldkit/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [foldkit({ devToolsMcpPort: 9988 })],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/health": "http://127.0.0.1:5174",
      "/mcp": "http://127.0.0.1:5174",
      "/rpc": "http://127.0.0.1:5174",
      "/snapshots": "http://127.0.0.1:5174",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
