import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Use 127.0.0.1 (not "localhost") so the proxy never resolves to IPv6 ::1,
// where the API - bound to 0.0.0.0 (IPv4) - isn't listening. That mismatch
// causes intermittent ECONNREFUSED on both the REST and WebSocket proxy.
const API_TARGET = process.env.OPENNAS_API_TARGET ?? "http://127.0.0.1:4174";

// During dev, Vite serves the UI on :5173 and proxies the API + WS to Fastify,
// so the browser sees a single origin (which keeps WebAuthn rpID/origin happy).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  optimizeDeps: {
    esbuildOptions: {
      // noVNC (the VM console) ships top-level await; es2022 is the baseline
      // that supports it. This target applies during dev-mode pre-bundling -
      // build.target alone does not affect the dev server's esbuild transform.
      target: "es2022",
    },
  },
  server: {
    // Bind all interfaces (IPv4 + IPv6) so the browser's websocket - Vite's HMR
    // and our /api/ws - never lands on an address Vite isn't listening on.
    // (Default "localhost" binds IPv6 ::1 only, which breaks WS when the browser
    // resolves localhost to 127.0.0.1.)
    host: true,
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: API_TARGET,
        changeOrigin: true,
        ws: true,
      },
      // Installed third-party app content is served by the API (the SDK at
      // /app-sdk/opennas.js lives in public/, so it doesn't need proxying).
      "/app-content": {
        target: API_TARGET,
        changeOrigin: true,
      },
      // Public share links are served by the API. This has to be a RegExp: a
      // plain "/s" key is a *prefix* match, so it also swallowed "/src/..." -
      // every module in the dev server's graph - and the app never mounted.
      "^/s/": {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    // noVNC (the VM console) ships top-level await; es2022 is the baseline that
    // supports it (Chrome 89+, Firefox 89+, Safari 15+, Edge 89+ - fine for a
    // modern admin UI).
    target: "es2022",
  },
});