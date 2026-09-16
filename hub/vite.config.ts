import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// The repo-root .env (CORE_BASE_URL, CORE_AUTH_TOKEN) is read here, on the
// dev-server side only. Nothing from it is exposed to the browser bundle:
// loadEnv with an empty prefix feeds the proxy, not import.meta.env.
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, resolve(__dirname, ".."), ""), ...process.env };
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        "/api": {
          target: env.CORE_BASE_URL ?? "http://localhost:8787",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ""),
          // The core token stays on the dev-server side: the browser never
          // holds it, the proxy attaches it to every forwarded call.
          headers: env.CORE_AUTH_TOKEN ? { authorization: `Bearer ${env.CORE_AUTH_TOKEN}` } : undefined,
        },
      },
    },
  };
});
