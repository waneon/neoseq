import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const syncOrigin = process.env.NEOSEQ_SYNC_ORIGIN ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 4174,
    strictPort: true,
    proxy: {
      "/v1": { target: syncOrigin },
    },
  },
});
