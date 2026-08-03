import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

// Generates the application-shell Service Worker with the built asset list
// precached, so an offline reload can boot the full shell (including the
// Wasm core and its Worker chunk). Data is never cached — shell only.
function shellServiceWorker(): Plugin {
  return {
    name: "neoseq-shell-service-worker",
    apply: "build",
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle)
        .filter((name) => !name.endsWith(".map"))
        .map((name) => `/${name}`);
      const urls = ["/", ...assets];
      const template = readFileSync(
        fileURLToPath(new URL("./sw-template.js", import.meta.url)),
        "utf8",
      );
      const version = createHash("sha256").update(JSON.stringify(urls)).digest("hex").slice(0, 12);
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: template
          .replace("__CACHE_NAME__", `neoseq-shell-${version}`)
          .replace("__PRECACHE__", JSON.stringify(urls)),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), shellServiceWorker()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  worker: {
    format: "es",
  },
});
