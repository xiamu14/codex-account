import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiOrigin = "http://127.0.0.1:41739";

export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 41_740,
    proxy: {
      "/api": apiOrigin,
      "/assets/alignui.css": apiOrigin,
    },
  },
});
