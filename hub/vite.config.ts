import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.CORE_BASE_URL ?? "http://localhost:8787",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
        // The core token stays on the dev-server side: the browser never
        // holds it, the proxy attaches it to every forwarded call.
        headers: process.env.CORE_AUTH_TOKEN
          ? { authorization: `Bearer ${process.env.CORE_AUTH_TOKEN}` }
          : undefined,
      },
    },
  },
});
