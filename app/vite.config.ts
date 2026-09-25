import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The new browser editor. In development Vite serves it and forwards API,
// kernel worker and WASM requests to the CodeCAD server (npm run dev, port
// 4317). The server only accepts changes whose Origin matches the host they
// were sent to, so the proxy presents them as coming from the server itself.
const server = process.env.CODECAD_SERVER ?? "http://127.0.0.1:4317";
const forward = {
  target: server,
  changeOrigin: true,
  configure: (proxy: {
    on(
      event: "proxyReq",
      listener: (request: {
        setHeader(name: string, value: string): void;
      }) => void,
    ): void;
  }) => proxy.on("proxyReq", (request) => request.setHeader("origin", server)),
};

export default defineConfig({
  root: import.meta.dirname,
  base: "/app/",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      "/api": forward,
      "/kernel.worker.js": forward,
      "/occt-wasm.wasm": forward,
    },
  },
});
