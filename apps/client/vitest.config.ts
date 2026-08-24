import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./tests/component/setup.ts"],
    include: ["tests/component/**/*.test.{ts,tsx}"],
    css: false,
    // Verification runs these beside the Rust and Wasm builds, so a shared
    // runner can starve a test that is only ever waiting for a paint. The
    // budget is for the machine, not for the assertion.
    testTimeout: 20_000,
  },
});
