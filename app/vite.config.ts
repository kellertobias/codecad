import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";
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

// The mobile viewer lives at /p/<id>/view (and /s/<token> for view links)
// with its service worker at /p/sw.js (/s/sw.js), as the CodeCAD server
// serves it; the dev server maps them onto this build's pages.
const viewerRoutes: Plugin = {
  name: "codecad-viewer-routes",
  configureServer(server) {
    server.middlewares.use((request, _response, next) => {
      const path = request.url?.split("?")[0] ?? "";
      if (
        /^\/p\/[0-9a-f-]{36}\/view\/?$/.test(path) ||
        /^\/s\/[A-Za-z0-9_-]{32}\/?$/.test(path)
      )
        request.url = "/app/viewer.html";
      else if (path === "/p/sw.js" || path === "/s/sw.js")
        request.url = "/app/viewer-sw.js";
      next();
    });
  },
};

export default defineConfig({
  root: import.meta.dirname,
  base: "/app/",
  plugins: [react(), viewerRoutes],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        editor: join(import.meta.dirname, "index.html"),
        viewer: join(import.meta.dirname, "viewer.html"),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": forward,
      "/kernel.worker.js": forward,
      "/code-sandbox.js": forward,
      "/occt-wasm.wasm": forward,
    },
  },
});
