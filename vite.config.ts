import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:47861",
      "/healthz": "http://127.0.0.1:47861",
    },
  },
  build: {
    outDir: "dist/web-client",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalizedId = id.replaceAll("\\", "/");
          if (/\/node_modules\/(?:react|react-dom|scheduler)\//.test(normalizedId)) {
            return "react-runtime";
          }
          if (normalizedId.includes("/node_modules/lucide-react/")) {
            return "lucide-react";
          }
        },
      },
    },
  },
});
