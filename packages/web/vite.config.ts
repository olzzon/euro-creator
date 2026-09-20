import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In dev the API runs separately; in production the API serves this build.
    proxy: { "/api": { target: "http://localhost:5174", changeOrigin: true } },
  },
  build: { outDir: "dist", sourcemap: true },
});
